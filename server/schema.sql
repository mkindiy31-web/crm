CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager')),
  display_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

CREATE TABLE IF NOT EXISTS clients (
  id TEXT NOT NULL,
  manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  phone_norm TEXT,
  phone2_norm TEXT,
  archived_at TIMESTAMPTZ,
  archive_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, manager_id)
);
CREATE INDEX IF NOT EXISTS idx_clients_manager ON clients(manager_id);
CREATE INDEX IF NOT EXISTS idx_clients_phone_norm ON clients(phone_norm);
CREATE INDEX IF NOT EXISTS idx_clients_phone2_norm ON clients(phone2_norm);

CREATE TABLE IF NOT EXISTS owners (
  id TEXT NOT NULL,
  manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  phone_norm TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, manager_id)
);
CREATE INDEX IF NOT EXISTS idx_owners_manager ON owners(manager_id);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  related_client_id TEXT,
  acked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unacked ON notifications(user_id, acked);

CREATE TABLE IF NOT EXISTS notified_tasks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, task_id)
);

-- Shared property listings catalog — unlike clients/owners this is NOT scoped to
-- manager_id in queries: every manager and admin sees and can manage the same
-- pool of listings, like a real agency's shared inventory.
CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  data JSONB NOT NULL,
  price_num NUMERIC,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_catalog_price ON catalog_items(price_num);
CREATE INDEX IF NOT EXISTS idx_catalog_archived ON catalog_items(archived_at);

-- Personal to-do list per manager/admin — not tied to a client, for things
-- like "renew license", "call landlord about parking" etc. Separate from the
-- client `tasks` array in clients.data, which is always client-scoped.
CREATE TABLE IF NOT EXISTS personal_tasks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  due_date TEXT,
  due_time TEXT,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_personal_tasks_user ON personal_tasks(user_id, done);

-- Funnel activity log for the real-time stats dashboard. Derived by diffing
-- old vs new client data on every save (see clientOps.js), so it captures
-- events from every save path (manual edits, drag-drop, AI-intake) for free.
-- Starts accumulating from deployment — not backfilled from existing history.
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'lead_created' | 'stage_change' | 'task_completed'
  client_id TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_manager_created ON events(manager_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

-- A client recognized by AI screenshot analysis in Telegram, held here until
-- the manager answers the two mandatory follow-up questions (lead source via
-- button, then budget + what they're looking for as free text) — only then
-- does it become a real row in `clients`. `step` tracks which question is
-- outstanding; `prompted_at`/`last_reminded_at` drive the hourly nag if the
-- manager leaves it unanswered.
CREATE TABLE IF NOT EXISTS pending_intakes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_data JSONB NOT NULL,
  step TEXT NOT NULL DEFAULT 'source', -- 'source' | 'details'
  prompted_at TIMESTAMPTZ,
  last_reminded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_intakes_user ON pending_intakes(user_id, created_at);

-- Every call that writes carries an event id from the caller. The primary key
-- makes a repeat harmless: the second insert conflicts, the route answers 200
-- and writes nothing, so a retry after a timeout cannot create a second listing.
CREATE TABLE IF NOT EXISTS integration_events (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL, -- 'site' | 'bot' | portal slug
  kind TEXT NOT NULL,   -- 'catalog_upsert' | 'lead' | ...
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_integration_events_created ON integration_events(created_at);

-- A listing the manager is entering through the bot, step by step, held here
-- until it is published or dropped. Separate from pending_intakes (clients):
-- different fields, and a different life — an intake nags hourly, a listing
-- draft waits as long as it takes. `step` is the state the dialog is in,
-- `edit_field` the single field being redone from the confirm screen.
CREATE TABLE IF NOT EXISTS pending_objects (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_data JSONB NOT NULL,
  step TEXT NOT NULL DEFAULT 'photos',
  edit_field TEXT,
  prompted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_objects_user ON pending_objects(user_id, created_at);

-- Changes waiting to reach the site: a price edit, a listing taken off the
-- market, a listing the bot just published. The site is a shared host behind
-- Cloudflare and is not always there, and losing a price change costs more
-- than a few minutes of delay. Only the newest change per listing is kept
-- pending: an older price on its way is not worth sending.
CREATE TABLE IF NOT EXISTS site_queue (
  id SERIAL PRIMARY KEY,
  crm_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  tries SMALLINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
  last_error TEXT,
  next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_queue_due ON site_queue(status, next_try_at);
CREATE INDEX IF NOT EXISTS idx_site_queue_crm ON site_queue(crm_id);

-- A request from the site's form, before anyone takes it. It stays here,
-- belonging to nobody, until a manager taps "Беру собі" in the bot: only then
-- does a row appear in `clients`, owned by that manager. A card per manager
-- would be seven cards for one request.
CREATE TABLE IF NOT EXISTS site_leads (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  phone_norm TEXT,
  taken_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  taken_at TIMESTAMPTZ,
  client_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_leads_open ON site_leads(taken_by, created_at);
CREATE INDEX IF NOT EXISTS idx_site_leads_phone ON site_leads(phone_norm);

-- What the bot is waiting for from this manager right now: a new price, a note,
-- a call time. One row per manager, because one person answers one question at
-- a time. Separate from pending_objects, which holds a whole listing being
-- entered step by step.
CREATE TABLE IF NOT EXISTS pult_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  waiting TEXT,   -- 'price' | 'note' | 'call'
  target TEXT,    -- catalog_items.id or clients.id
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every job that runs on a timer has a row here once somebody touches its
-- switch. No row means enabled with the defaults from automations.js, so the
-- registry could be added without silently stopping reminders that already ran.
CREATE TABLE IF NOT EXISTS automations (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Run log. Only runs that sent something, skipped something or failed land
-- here: seven automations tick every minute, and a row per tick would bury
-- the one line somebody is looking for.
CREATE TABLE IF NOT EXISTS automation_runs (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  detail JSONB
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_key ON automation_runs(key, ran_at DESC);

-- "This exact thing was already sent." The primary key is the guard, so two
-- parallel workers cannot both decide to send: the second insert returns
-- nothing. Listing nudges put the listing's updated_at into the key, which is
-- what re-arms them after the listing finally moves.
CREATE TABLE IF NOT EXISTS automation_sent (
  key TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, dedup_key)
);

-- Спроби входу. Лічильник живе в базі, а не в памʼяті процесу: перезапуск
-- контейнера не має бути способом обнулити підбір пароля. Вікно сповзаюче,
-- тому блок спливає сам і власник не лишається замкненим.
CREATE TABLE IF NOT EXISTS login_attempts (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  ip TEXT NOT NULL,
  ok BOOLEAN NOT NULL DEFAULT false,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, at DESC);

-- An EXISTING client missing its "source" field, queued for the same
-- button-based fix-it flow as new-client intake (see pending_intakes above)
-- — triggered by the admin's "Нагадати заповнити" action instead of being
-- created automatically. One row per client; deleted once the manager taps
-- a source button.
CREATE TABLE IF NOT EXISTS pending_source_fixes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  prompted_at TIMESTAMPTZ,
  last_reminded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_source_fixes_user ON pending_source_fixes(user_id, created_at);
