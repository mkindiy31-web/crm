// Once a day: the listings nobody has touched for longer than the agreed term.
//
// The bot's own lists already mark such a listing ("без руху 34 дн."), but a
// mark only works for a manager who opens the list. This is the push half, and
// it is deliberately quiet: one message per manager per day, and one reminder
// per listing per standstill. Touch the listing — price, status, a note — and
// its updated_at changes, which both restarts the term and re-arms the
// reminder, because the dedup key carries that timestamp.
const auto = require('./automations');
const { sendTelegramKeyboard, kyivNowParts } = require('./telegram');
const { objectLine, esc } = require('./pult');

const KEY = 'stale-nudge';
const SCAN = 50;   // скільком обʼєктам менеджера дивимось у вічі за один прогін

function dedupKeyFor(row) {
  const moved = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  return `${row.id}:${moved}`;
}

function nudgeText(items, days) {
  const lines = [
    '<b>Обʼєкти без руху</b>',
    `Ніхто не торкався їх понад ${days} дн. Ціна, фото або статус.`,
    '',
  ];
  for (const row of items) {
    const o = objectLine(row, days);
    lines.push(`<b>${esc(o.head)}</b>${o.specs ? '\n' + esc(o.specs) : ''}`);
    lines.push(`${o.price}, ${o.status}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function nudgeRows(items) {
  const rows = items.map(row => {
    const o = objectLine(row);
    return [{ text: o.head, callback_data: `p:o:${row.id}` }];
  });
  rows.push([{ text: 'Приховати', callback_data: 'p:close' }]);
  return rows;
}

// `now` is injectable so a probe can run the whole thing at any hour without
// waiting for 10:00.
async function checkAndNudgeStale(pool, now) {
  const cfg = await auto.getConfig(pool, KEY);
  const { hh, mm } = now || kyivNowParts();
  if (Number(hh) !== Number(cfg.hour) || Number(mm) !== Number(cfg.minute)) return { sent: 0, skipped: 0 };

  const { rows: users } = await pool.query(
    `SELECT id, tg_settings FROM users
     WHERE active = true AND tg_settings->>'enabled' = 'true'
       AND coalesce(tg_settings->>'token', '') != '' AND coalesce(tg_settings->>'chatId', '') != ''`
  );

  let sent = 0, skipped = 0, objects = 0;
  for (const user of users) {
    const s = user.tg_settings || {};

    const { rows: items } = await pool.query(
      `SELECT id, created_by, data, price_num, created_at, updated_at FROM catalog_items
       WHERE created_by = $1 AND archived_at IS NULL
         AND coalesce(data->>'status', 'available') = 'available'
         AND updated_at < now() - ($2 || ' days')::interval
       ORDER BY updated_at ASC LIMIT ${SCAN}`,
      [user.id, String(cfg.days)]
    );
    if (!items.length) continue;

    const fresh = [];
    for (const row of items) {
      if (await auto.alreadySent(pool, KEY, dedupKeyFor(row))) { skipped++; continue; }
      fresh.push(row);
    }
    if (!fresh.length) continue;

    // Beyond the limit nothing is marked, so the rest comes up tomorrow
    // instead of arriving as one unreadable wall today.
    const show = fresh.slice(0, Number(cfg.limit) || 5);
    const ok = await sendTelegramKeyboard(s.token, s.chatId, nudgeText(show, cfg.days), nudgeRows(show));
    if (!ok) continue;

    for (const row of show) await auto.markSent(pool, KEY, dedupKeyFor(row));
    sent += 1;
    objects += show.length;
  }

  return { sent, skipped, detail: { objects, days: cfg.days } };
}

module.exports = { KEY, checkAndNudgeStale, dedupKeyFor, nudgeText, nudgeRows };
