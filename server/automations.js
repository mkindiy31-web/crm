// Single registry for everything the server does on a timer. Three jobs it has:
//   1. a switch per automation, so the agency can turn one off without a deploy
//   2. a run log that answers "did it work, when, and how much did it send"
//   3. a generic dedup table, so nothing is sent twice for the same event
//
// Rows in `automations` are optional on purpose: an automation with no row is
// enabled with its default params. Introducing the registry therefore cannot
// silently switch off the reminders that worked before it existed.
const REGISTRY = {
  'reminders': {
    title: 'Нагадування про задачі',
    note: 'Дзвінок чи показ за стільки хвилин, скільки стоїть у налаштуваннях менеджера',
    defaults: {},
  },
  'evening-digest': {
    title: 'Розклад на завтра, 21:00',
    note: 'Особисті задачі менеджера на наступний день',
    defaults: {},
  },
  'morning-brief': {
    title: 'Ранковий зріз, 8:30',
    note: 'Прострочене, сьогоднішні дії, нічиї заявки, обʼєкти без руху',
    defaults: {},
  },
  'client-task-digest': {
    title: 'Задачі по клієнтах',
    note: 'Зведення задач по клієнтах менеджера',
    defaults: {},
  },
  'source-fix-reminder': {
    title: 'Нагадування заповнити джерело',
    note: 'Клієнт без поля «Звідки дізнався» після кнопки адміна «Нагадати заповнити»',
    defaults: {},
  },
  'intake-reminder': {
    title: 'Нагадування про незавершене заведення',
    note: 'Діалог заведення клієнта стоїть понад годину',
    defaults: {},
  },
  'site-queue': {
    title: 'Черга вигрузки на сайт',
    note: 'Обʼєкт зі СРМ доїжджає до сайту, з повторами при недоступності',
    defaults: {},
  },
  'db-backup': {
    title: 'Бекап бази',
    note: 'Раз на добу: усі таблиці в один файл, gzip, документом у чат адміна',
    defaults: { hour: 3, minute: 30 },
  },
  'stale-nudge': {
    title: 'Обʼєкт без руху',
    note: 'Раз на добу: обʼєкти менеджера, яких ніхто не торкався довше за строк',
    defaults: { days: 30, hour: 10, minute: 0, limit: 5 },
  },
  'weekly-owner': {
    title: 'Щотижневий зріз власнику',
    note: 'Понеділок: що зробила агенція за минулий тиждень',
    defaults: { weekday: 1, hour: 9, minute: 0 },
  },
};

const LOG_KEEP_DAYS = 90;

function keys() {
  return Object.keys(REGISTRY);
}

function known(key) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, key);
}

// Enabled unless a row says otherwise. An unknown key is never enabled, so a
// typo in a scheduler call fails loudly in the log instead of running blind.
async function isEnabled(pool, key) {
  if (!known(key)) return false;
  const { rows } = await pool.query('SELECT enabled FROM automations WHERE key = $1', [key]);
  if (!rows.length) return true;
  return rows[0].enabled !== false;
}

async function getConfig(pool, key) {
  if (!known(key)) return {};
  const base = REGISTRY[key].defaults;
  const { rows } = await pool.query('SELECT params FROM automations WHERE key = $1', [key]);
  const stored = (rows.length && rows[0].params) || {};
  return Object.assign({}, base, stored);
}

async function logRun(pool, key, result) {
  const r = result || {};
  await pool.query(
    'INSERT INTO automation_runs (key, sent, skipped, error, detail) VALUES ($1, $2, $3, $4, $5)',
    [key, Number(r.sent) || 0, Number(r.skipped) || 0, r.error || null,
      r.detail ? JSON.stringify(r.detail) : null]
  );
}

// Wraps one automation call. Returns the automation's own result, or null when
// it was switched off. The log stays readable: a run that did nothing writes
// no row, otherwise every minute of every day would leave seven of them.
async function run(pool, key, fn) {
  if (!(await isEnabled(pool, key))) return null;
  try {
    const result = await fn();
    // typeof on purpose: siteSync.drain reports `skipped: true` when the site
    // is not configured, and Number(true) would write a log row every minute.
    const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
    const sent = num(result && result.sent);
    const skipped = num(result && result.skipped);
    if (sent || skipped) await logRun(pool, key, result);
    return result;
  } catch (err) {
    await logRun(pool, key, { error: String((err && err.message) || err) }).catch(() => {});
    throw err;
  }
}

async function alreadySent(pool, key, dedupKey) {
  const { rows } = await pool.query(
    'SELECT 1 FROM automation_sent WHERE key = $1 AND dedup_key = $2', [key, dedupKey]
  );
  return rows.length > 0;
}

// Returns true when this call is the one that claimed the event. A second call
// with the same pair gets false from the database itself, not from a prior
// SELECT, so two workers cannot both decide to send.
async function markSent(pool, key, dedupKey) {
  const { rows } = await pool.query(
    `INSERT INTO automation_sent (key, dedup_key) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING dedup_key`, [key, dedupKey]
  );
  return rows.length > 0;
}

async function pruneLog(pool, days = LOG_KEEP_DAYS) {
  const { rowCount } = await pool.query(
    `DELETE FROM automation_runs WHERE ran_at < now() - ($1 || ' days')::interval`, [String(days)]
  );
  return rowCount || 0;
}

// Shape for the admin screen: one line per automation, with the switch, the
// params actually in force and the last run.
async function list(pool) {
  const { rows: stored } = await pool.query(
    `SELECT a.key, a.enabled, a.params, a.updated_at, u.display_name AS updated_by
     FROM automations a LEFT JOIN users u ON u.id = a.updated_by`
  );
  const byKey = new Map(stored.map(r => [r.key, r]));

  const { rows: runs } = await pool.query(
    `SELECT DISTINCT ON (key) key, ran_at, sent, skipped, error
     FROM automation_runs ORDER BY key, ran_at DESC`
  );
  const lastByKey = new Map(runs.map(r => [r.key, r]));

  return keys().map(key => {
    const row = byKey.get(key);
    const last = lastByKey.get(key) || null;
    return {
      key,
      title: REGISTRY[key].title,
      note: REGISTRY[key].note,
      enabled: row ? row.enabled !== false : true,
      params: Object.assign({}, REGISTRY[key].defaults, (row && row.params) || {}),
      defaults: REGISTRY[key].defaults,
      changedAt: (row && row.updated_at) || null,
      changedBy: (row && row.updated_by) || null,
      lastRun: last && { at: last.ran_at, sent: last.sent, skipped: last.skipped, error: last.error },
    };
  });
}

const INT_RANGE = {
  days: [1, 365],
  hour: [0, 23],
  minute: [0, 59],
  limit: [1, 20],
  weekday: [1, 7],
};

// Only params the automation actually declares are accepted, and only as whole
// numbers inside their range: a string in `days` would make the SQL interval
// throw once a day at 10:00 and nowhere else.
function validateParams(key, params) {
  if (!known(key)) return { error: 'Невідома автоматизація' };
  const allowed = REGISTRY[key].defaults;
  const clean = {};
  for (const [name, value] of Object.entries(params || {})) {
    if (!Object.prototype.hasOwnProperty.call(allowed, name)) {
      return { error: `Параметра «${name}» у цієї автоматизації немає` };
    }
    const range = INT_RANGE[name];
    const n = Number(value);
    if (!range || !Number.isInteger(n) || n < range[0] || n > range[1]) {
      return { error: `«${name}»: ціле число від ${range ? range[0] : 0} до ${range ? range[1] : 0}` };
    }
    clean[name] = n;
  }
  return { params: clean };
}

async function setState(pool, key, { enabled, params }, userId) {
  if (!known(key)) return { error: 'Невідома автоматизація' };
  const current = await getConfig(pool, key);
  let merged = current;
  if (params !== undefined) {
    const checked = validateParams(key, params);
    if (checked.error) return checked;
    merged = Object.assign({}, current, checked.params);
  }
  const { rows: existing } = await pool.query('SELECT enabled FROM automations WHERE key = $1', [key]);
  const nextEnabled = enabled === undefined
    ? (existing.length ? existing[0].enabled !== false : true)
    : enabled !== false;

  const onlyParams = {};
  for (const name of Object.keys(REGISTRY[key].defaults)) onlyParams[name] = merged[name];

  await pool.query(
    `INSERT INTO automations (key, enabled, params, updated_at, updated_by)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (key) DO UPDATE SET enabled = $2, params = $3, updated_at = now(), updated_by = $4`,
    [key, nextEnabled, JSON.stringify(onlyParams), userId || null]
  );
  return { key, enabled: nextEnabled, params: onlyParams };
}

async function history(pool, key, limit = 20) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const { rows } = await pool.query(
    `SELECT ran_at, sent, skipped, error, detail FROM automation_runs
     WHERE key = $1 ORDER BY ran_at DESC LIMIT $2`, [key, n]
  );
  return rows;
}

module.exports = {
  REGISTRY, LOG_KEEP_DAYS, keys, known, isEnabled, getConfig, run, logRun,
  alreadySent, markSent, pruneLog, list, setState, validateParams, history,
};
