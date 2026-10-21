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
