// Monday morning: what the agency did last week, in one message to the owner.
//
// Every number comes from the table the CRM's own analytics reads — new clients
// and closed deals from `events`, listings from `catalog_items`, requests from
// `site_leads` — so the brief cannot drift away from what the interface shows.
// The commission formula and the id of the "Угода" stage come from stages.js
// for the same reason.
const auto = require('./automations');
const security = require('./security');
const { sendTelegramMessage, kyivNowParts } = require('./telegram');
const { DEAL_STAGE_ID, commissionOf } = require('./stages');
const { money } = require('./pult');

const KEY = 'weekly-owner';

// Monday 00:00 Kyiv of last week to Monday 00:00 Kyiv of this week.
// date_trunc('week', …) starts the week on Monday in Postgres, and the
// conversion back to timestamptz keeps the boundary honest across the DST
// change at the end of October.
async function weekBounds(pool) {
  const { rows } = await pool.query(
    `SELECT (date_trunc('week', now() AT TIME ZONE 'Europe/Kyiv') - interval '7 days')
              AT TIME ZONE 'Europe/Kyiv' AS lo,
            date_trunc('week', now() AT TIME ZONE 'Europe/Kyiv')
              AT TIME ZONE 'Europe/Kyiv' AS hi,
            to_char(date_trunc('week', now() AT TIME ZONE 'Europe/Kyiv') - interval '7 days',
                    'IYYY-"W"IW') AS week_key,
            to_char(date_trunc('week', now() AT TIME ZONE 'Europe/Kyiv') - interval '7 days',
                    'DD.MM') AS from_label,
            to_char(date_trunc('week', now() AT TIME ZONE 'Europe/Kyiv') - interval '1 day',
                    'DD.MM') AS to_label`
  );
  return rows[0];
}

async function collect(pool, bounds) {
  const cfg = await auto.getConfig(pool, 'stale-nudge');
  const { lo, hi } = bounds;

  const [objects, leadsNew, deals, siteLeads, stale, tasks] = await Promise.all([
    pool.query(
      `SELECT c.created_by AS user_id, u.display_name, count(*)::int n
       FROM catalog_items c LEFT JOIN users u ON u.id = c.created_by
       WHERE c.created_at >= $1 AND c.created_at < $2
       GROUP BY 1, 2`, [lo, hi]
    ),
    pool.query(
      `SELECT e.manager_id AS user_id, u.display_name, count(*)::int n
       FROM events e LEFT JOIN users u ON u.id = e.manager_id
       WHERE e.type = 'lead_created' AND e.created_at >= $1 AND e.created_at < $2
       GROUP BY 1, 2`, [lo, hi]
    ),
    pool.query(
      `SELECT DISTINCT ON (e.client_id, e.manager_id)
              e.manager_id AS user_id, u.display_name, c.data
       FROM events e
       LEFT JOIN users u ON u.id = e.manager_id
       LEFT JOIN clients c ON c.id = e.client_id AND c.manager_id = e.manager_id
       WHERE e.type = 'stage_change' AND (e.meta->>'toStage')::int = $3
         AND e.created_at >= $1 AND e.created_at < $2
       ORDER BY e.client_id, e.manager_id, e.created_at DESC`, [lo, hi, DEAL_STAGE_ID]
    ),
    pool.query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE taken_by IS NULL)::int free
       FROM site_leads WHERE created_at >= $1 AND created_at < $2`, [lo, hi]
    ),
    pool.query(
      `SELECT count(*)::int n FROM catalog_items
       WHERE archived_at IS NULL
         AND coalesce(data->>'status', 'available') = 'available'
         AND updated_at < now() - ($1 || ' days')::interval`, [String(cfg.days)]
    ),
    pool.query(
      `SELECT count(*)::int n FROM events
       WHERE type = 'task_completed' AND created_at >= $1 AND created_at < $2`, [lo, hi]
    ),
  ]);

  const byUser = new Map();
  const bump = (row, field, amount) => {
    const id = row.user_id || 0;
    if (!byUser.has(id)) {
      byUser.set(id, { name: row.display_name || 'Без менеджера', objects: 0, clients: 0, deals: 0 });
    }
    byUser.get(id)[field] += amount;
  };
  for (const row of objects.rows) bump(row, 'objects', row.n);
  for (const row of leadsNew.rows) bump(row, 'clients', row.n);
  for (const row of deals.rows) bump(row, 'deals', 1);

  let commission = 0;
  for (const row of deals.rows) commission += commissionOf(row.data || {});

  return {
    week: bounds,
    objects: objects.rows.reduce((s, r) => s + r.n, 0),
    clients: leadsNew.rows.reduce((s, r) => s + r.n, 0),
    deals: deals.rows.length,
    commission,
    siteLeads: siteLeads.rows[0],
    stale: stale.rows[0].n,
    staleDays: cfg.days,
    tasks: tasks.rows[0].n,
    people: [...byUser.values()].sort((a, b) => (b.deals - a.deals) || (b.objects - a.objects)),
  };
}

function briefText(d) {
  const lines = [`<b>Тиждень ${d.week.from_label} - ${d.week.to_label}</b>`, ''];

  lines.push(`Заведено обʼєктів: ${d.objects}`);
  lines.push(`Нових клієнтів: ${d.clients}`);
  if (d.deals) {
    lines.push(`Угод: ${d.deals}, комісія ${money(Math.round(d.commission), 'USD')}`);
  } else {
    lines.push('Угод: жодної');
  }
  if (d.tasks) lines.push(`Закрито дзвінків і показів: ${d.tasks}`);
  if (d.siteLeads.total) {
    lines.push(`Заявок із сайту: ${d.siteLeads.total}${d.siteLeads.free ? `, нічиїх ${d.siteLeads.free}` : ''}`);
  }
  if (d.stale) lines.push(`Обʼєктів без руху понад ${d.staleDays} дн.: ${d.stale}`);

  const active = d.people.filter(p => p.objects || p.clients || p.deals);
  if (active.length) {
    lines.push('', '<b>По менеджерах</b>');
    for (const p of active) {
      const parts = [];
      if (p.deals) parts.push(`угод ${p.deals}`);
      if (p.clients) parts.push(`клієнтів ${p.clients}`);
      if (p.objects) parts.push(`обʼєктів ${p.objects}`);
      lines.push(`${p.name}: ${parts.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// `now` is injectable so a probe does not have to wait for Monday.
async function checkAndSendWeeklyBrief(pool, now) {
  const cfg = await auto.getConfig(pool, KEY);
  const { hh, mm } = now || kyivNowParts();
  if (Number(hh) !== Number(cfg.hour) || Number(mm) !== Number(cfg.minute)) return { sent: 0, skipped: 0 };

  if (kyivWeekday() !== Number(cfg.weekday)) return { sent: 0, skipped: 0 };

  const { rows: admins } = await pool.query(
    `SELECT id, tg_settings FROM users
     WHERE active = true AND role = 'admin' AND tg_settings->>'enabled' = 'true'
       AND coalesce(tg_settings->>'token', '') != '' AND coalesce(tg_settings->>'chatId', '') != ''`
  );
  if (!admins.length) return { sent: 0, skipped: 0 };

  const bounds = await weekBounds(pool);
  let sent = 0, skipped = 0;
  let data = null;

  for (const admin of admins) {
    const dedup = `${bounds.week_key}:${admin.id}`;
    if (await auto.alreadySent(pool, KEY, dedup)) { skipped++; continue; }
    if (!data) data = await collect(pool, bounds);

    const s = admin.tg_settings || {};
    const ok = await sendTelegramMessage(s.token, s.chatId, briefText(data));
    if (!ok) continue;
    await auto.markSent(pool, KEY, dedup);
    sent++;
  }

  // One housekeeping slot a week is enough to keep the run log readable.
  // Раз на тиждень разом із логом прибираються й старі спроби входу: без цього
  // таблиця росте вічно, а користь від рядка місячної давнини нульова.
  const pruned = sent ? await auto.pruneLog(pool) : 0;
  if (sent) await security.pruneAttempts().catch(err => console.error('pruneAttempts failed:', err));

  return { sent, skipped, detail: { week: bounds.week_key, prunedLogRows: pruned } };
}

// 1 = Monday … 7 = Sunday, in Kyiv, whatever the server's own clock thinks.
function kyivWeekday() {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', weekday: 'short' })
    .format(new Date());
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[name] || 0;
}

module.exports = { KEY, checkAndSendWeeklyBrief, weekBounds, collect, briefText, kyivWeekday };
