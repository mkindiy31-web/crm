const zlib = require('zlib');
const auto = require('./automations');
const { sendTelegramDocument, kyivNowParts } = require('./telegram');

const KEY = 'db-backup';

// Порядок має значення: users вставляється перший, бо на нього дивляться майже
// всі інші таблиці. Решта йде в порядку, у якому її можна заливати, не
// вимикаючи перевірок посилань.
const TABLES = [
  'users',
  'clients', 'owners', 'catalog_items',
  'notifications', 'notified_tasks', 'personal_tasks', 'events',
  'pending_intakes', 'pending_source_fixes', 'pending_objects', 'pult_state',
  'site_leads', 'site_queue', 'integration_events',
  'automations', 'automation_runs', 'automation_sent',
  'login_attempts',
];

// Сесії свідомо не бекапляться: відновлення бази не має повертати чужі входи,
// і найгірше, що станеться, це повторний вхід у кабінет.
const SKIP = ['session'];

// Телефони, хеші паролів і токен бота в дампі є, бо без них це не бекап. Тому
// файл іде лише в приватний чат адміна й віддається лише адміну, а в лог
// пишеться розмір, не вміст.
const MAX_SEND_BYTES = 45 * 1024 * 1024;

// Нова таблиця зʼявляється в schema.sql, і про неї легко забути тут: тоді
// бекап тихо неповний. Прогін питає базу і валиться на розбіжності.
async function unknownTables(pool) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const known = new Set([...TABLES, ...SKIP]);
  return rows.map(r => r.table_name).filter(t => !known.has(t)).sort();
}

async function dump(pool) {
  const unknown = await unknownTables(pool);
  if (unknown.length) {
    throw new Error(`Таблиці поза списком бекапу: ${unknown.join(', ')}`);
  }
  const tables = {};
  for (const t of TABLES) {
    const { rows } = await pool.query(`SELECT * FROM ${t}`);
    tables[t] = rows;
  }
  return {
    format: 'urban-crm-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    tables,
  };
}

function fileNameFor(d) {
  const day = (d || new Date()).toISOString().slice(0, 10);
  return `urban-crm-${day}.json.gz`;
}

async function packed(pool) {
  const data = await dump(pool);
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(data), 'utf8'));
  const counts = Object.fromEntries(Object.entries(data.tables).map(([t, rows]) => [t, rows.length]));
  return { buf, counts, rows: Object.values(counts).reduce((a, b) => a + b, 0), name: fileNameFor() };
}

async function checkAndSendBackup(pool, now) {
  const cfg = await auto.getConfig(pool, KEY);
  const { hh, mm } = now || kyivNowParts();
  if (Number(hh) !== Number(cfg.hour) || Number(mm) !== Number(cfg.minute)) return { sent: 0, skipped: 0 };

  const { rows: admins } = await pool.query(
    `SELECT id, tg_settings FROM users
     WHERE role = 'admin' AND active = true AND tg_settings->>'enabled' = 'true'`
  );
  if (!admins.length) return { sent: 0, skipped: 0 };

  const day = fileNameFor();
  let sent = 0, skipped = 0;
  let pack = null;

  for (const a of admins) {
    const s = a.tg_settings || {};
    if (!s.token || !s.chatId) { skipped += 1; continue; }
    // Дедуп до збирання дампу: інакше повторний тік у ту саму хвилину
    // піднімав би всю базу в памʼять заради нічого.
    if (!(await auto.markSent(pool, KEY, `${a.id}:${day}`))) { skipped += 1; continue; }
    if (!pack) pack = await packed(pool);
    if (pack.buf.length > MAX_SEND_BYTES) {
      throw new Error(`Бекап ${pack.buf.length} байт більший за ліміт Telegram`);
    }
    const ok = await sendTelegramDocument(s.token, s.chatId, pack.name, pack.buf,
      `Бекап бази, ${pack.rows} рядків у ${TABLES.length} таблицях`);
    if (ok) {
      sent += 1;
    } else {
      skipped += 1;
      // Невдале надсилання не має лишати позначку: інакше за цей день бекап
      // не піде вже ніколи.
      await pool.query('DELETE FROM automation_sent WHERE key = $1 AND dedup_key = $2',
        [KEY, `${a.id}:${day}`]);
    }
  }
  return { sent, skipped, detail: pack ? { bytes: pack.buf.length, rows: pack.rows } : {} };
}

// Відновлення свідомо все або нічого: одна транзакція, спершу порожньо, далі
// вставка в порядку посилань, і в кінці лічильники SERIAL ставляться на
// максимум вставленого, інакше наступний запис конфліктує з відновленим id.
async function restore(pool, data, { quiet = false } = {}) {
  if (!data || data.format !== 'urban-crm-backup') throw new Error('Це не бекап СРМ');
  const missing = TABLES.filter(t => !(t in (data.tables || {})));
  if (missing.length) throw new Error(`У бекапі немає таблиць: ${missing.join(', ')}`);

  // Лічильник зводиться лише там, де id справді SERIAL: у clients, owners і
  // catalog_items id текстовий, і COALESCE(MAX(id), 1) там падає на типах.
  // Список беремо з самої бази, щоб нова таблиця підхопилась без зміни коду.
  const { rows: serial } = await pool.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'id'
       AND column_default LIKE 'nextval%'`
  );
  const serialTables = new Set(serial.map(r => r.table_name));

  const client = await pool.connect();
  const counts = {};
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      const rows = data.tables[t] || [];
      counts[t] = 0;
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO ${t} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${ph})`,
          cols.map(c => row[c])
        );
        counts[t] += 1;
      }
      if (serialTables.has(t)) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${t}', 'id'),
                         GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 1), 1))`
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (!quiet) console.log('Відновлено рядків:', Object.values(counts).reduce((a, b) => a + b, 0));
  return counts;
}

module.exports = { KEY, TABLES, SKIP, dump, packed, restore, unknownTables, fileNameFor, checkAndSendBackup };
