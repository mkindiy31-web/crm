// A request from the site: who gets told, who ends up owning it.
//
// The request arrives belonging to nobody. Every manager with the bot on sees
// it at once, and the first to tap "Беру собі" gets the card. The rest are told
// who took it, so nobody calls the same person twice.

const { pool } = require('./db');
const { normalizePhone } = require('./phone');
const { isoKyiv, dateUA, timeUA, addHistory, appendNote, stageLabel } = require('./cardFormat');
const { STAGES } = require('./stages');
const { sendTelegramMessage, sendTelegramKeyboard, answerCallbackQuery, crmLink } = require('./telegram');

// Текст іде в Telegram з parse_mode HTML: «<» чи «&» з форми без екранування
// ламали б усе повідомлення, і заявка до менеджерів не доходила б.
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Сторінка обʼєкта, з якої прийшла заявка: адреса від сайту, а без неї
// короткий `?p=<номер>`, який WordPress переводить на ту саму сторінку.
function propertyLink(d) {
  if (/^https:\/\//.test(d.propertyUrl || '')) return d.propertyUrl;
  const base = String(process.env.SITE_URL || '').replace(/\/+$/, '');
  return d.propertyId && /^https:\/\//.test(base) ? `${base}/?p=${d.propertyId}` : '';
}

function leadText(lead, dupes) {
  const d = lead.data || {};
  const lines = ['<b>Нова заявка з сайту</b>'];
  if (d.name) lines.push(esc(d.name) + (d.phone ? ', ' + esc(d.phone) : ''));
  else if (d.phone) lines.push(esc(d.phone));
  if (d.contact && d.contact !== d.phone) lines.push(esc(d.contact));
  if (d.propertyTitle) {
    const link = propertyLink(d);
    lines.push('Дивилась: ' + (link ? `<a href="${esc(link)}">${esc(d.propertyTitle)}</a>` : esc(d.propertyTitle)));
  }
  if (d.message) lines.push(esc(d.message));
  if (d.source) lines.push('Форма: ' + esc(d.source));

  if (dupes && dupes.length) {
    const who = dupes.map(x => esc(x.display_name)).join(', ');
    lines.push('', `Цей номер уже веде ${who}.`);
  }
  lines.push('', 'Ще нічия.');
  return lines.join('\n');
}

function leadRows(leadId) {
  return [
    [{ text: 'Беру собі', callback_data: `l:take:${leadId}` }],
    [{ text: 'Пропустити', callback_data: `l:skip:${leadId}` }],
  ];
}

async function managersWithBot() {
  const { rows } = await pool.query(
    `SELECT id, display_name, tg_settings FROM users
     WHERE active = true AND tg_settings->>'enabled' = 'true'
       AND coalesce(tg_settings->>'token', '') != ''
       AND coalesce(tg_settings->>'chatId', '') != ''`
  );
  return rows;
}

// Who already has this person. The CRM lets one phone belong to several
// managers on purpose, so this is shown, not blocked.
async function whoHasPhone(phoneNorm) {
  if (!phoneNorm) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.display_name FROM clients c
     JOIN users u ON u.id = c.manager_id
     WHERE c.archived_at IS NULL AND (c.phone_norm = $1 OR c.phone2_norm = $1)`,
    [phoneNorm]
  );
  return rows;
}

async function broadcast(lead) {
  const dupes = await whoHasPhone(lead.phone_norm);
  const text = leadText(lead, dupes);
  const rows = leadRows(lead.id);
  const managers = await managersWithBot();
  let sent = 0;
  for (const m of managers) {
    const s = m.tg_settings || {};
    const ok = await sendTelegramKeyboard(s.token, s.chatId, text, rows);
    if (ok) sent++;
  }
  return { sent, managers: managers.length, dupes: dupes.length };
}

// The first tap wins. The UPDATE itself decides it: only the row still free
// gets claimed, so two managers tapping at the same moment cannot both get a
// card, however close the taps are.
async function claimLead(leadId, userId) {
  const { rows } = await pool.query(
    `UPDATE site_leads SET taken_by = $2, taken_at = now()
     WHERE id = $1 AND taken_by IS NULL
     RETURNING *`,
    [leadId, userId]
  );
  if (rows.length) return { claimed: true, lead: rows[0] };

  const { rows: current } = await pool.query(
    `SELECT l.*, u.display_name FROM site_leads l
     LEFT JOIN users u ON u.id = l.taken_by WHERE l.id = $1`,
    [leadId]
  );
  return { claimed: false, lead: current[0] || null };
}

// The card appears only now, owned by whoever took the request.
async function createCardFor(lead, userId) {
  const d = lead.data || {};
  const id = 'lead-' + lead.id;
  const now = new Date();
  const { rows: who } = await pool.query('SELECT display_name FROM users WHERE id = $1', [userId]);
  // Поля й типи ті самі, що пише форма СРМ (crm.html, saveClient): що людина
  // написала у формі, стоїть у «Запиті клієнта», обʼєкт і контакт у нотатках.
  const extra = [
    d.propertyTitle ? 'Дивилась: ' + d.propertyTitle : '',
    d.contact && d.contact !== d.phone ? 'Контакт: ' + d.contact : '',
  ].filter(Boolean);
  const card = addHistory({
    id,
    name: d.name || d.phone || 'Заявка з сайту',
    phone: d.phone || '',
    phone2: '',
    stage: 0,                  // 1. Новий лід
    hot: false,
    source: 'сайт',
    clientRequest: String(d.message || '').trim(),
    notes: extra.join('\n'),
    date: dateUA(now),
    dateISO: isoKyiv(now),
    createdAt: now.toISOString(),
    responsibleManagerName: (who[0] && who[0].display_name) || '',
    tasks: [],
    history: [],
  }, 'created', 'Заявка з сайту' + (d.source ? ', форма «' + d.source + '»' : '') + ', взято в боті');

  await pool.query(
    `INSERT INTO clients (id, manager_id, data, phone_norm)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id, manager_id) DO UPDATE SET data = $3, updated_at = now()`,
    [id, userId, card, normalizePhone(card.phone)]
  );
  await pool.query('UPDATE site_leads SET client_id = $2 WHERE id = $1', [lead.id, id]);
  await pool.query(
    `INSERT INTO events (manager_id, type, client_id, meta)
     VALUES ($1, 'lead_created', $2, jsonb_build_object('source', 'сайт'))`,
    [userId, id]
  );
  return card;
}

// Номер уже в картці того, хто взяв заявку: друга картка не створюється, заявка
// дописується в наявну, етап лишається (обіцянка етапу 4, затверджено 15.11.2026).
// Картки інших менеджерів не чіпаються: один номер у кількох менеджерів дозволено.
async function ownCardByPhone(phoneNorm, userId) {
  if (!phoneNorm) return null;
  const { rows } = await pool.query(
    `SELECT id, data FROM clients
     WHERE manager_id = $1 AND archived_at IS NULL AND (phone_norm = $2 OR phone2_norm = $2)
     ORDER BY updated_at DESC LIMIT 1`,
    [userId, phoneNorm]
  );
  return rows[0] || null;
}

async function mergeIntoCard(lead, userId, row) {
  const d = lead.data || {};
  const now = new Date();
  const bits = [
    String(d.message || '').trim(),
    d.propertyTitle ? 'Дивилась: ' + d.propertyTitle : '',
    d.contact && d.contact !== d.phone ? 'Контакт: ' + d.contact : '',
  ].filter(Boolean);
  let card = row.data || {};
  if (bits.length) card = appendNote(card, `[заявка з сайту, ${dateUA(now)} ${timeUA(now)}]: ${bits.join('; ')}`);
  card = addHistory(card, 'info_updated',
    'Повторна заявка з сайту' + (d.source ? ', форма «' + d.source + '»' : '') + ', взято в боті');
  await pool.query('UPDATE clients SET data = $1, updated_at = now() WHERE id = $2 AND manager_id = $3',
    [card, row.id, userId]);
  await pool.query('UPDATE site_leads SET client_id = $2 WHERE id = $1', [lead.id, row.id]);
  return { id: row.id, ...card };
}

// Tells everyone else that the request is taken, so nobody calls twice.
async function tellOthers(lead, takerId, takerName) {
  const managers = await managersWithBot();
  const d = lead.data || {};
  const who = d.name || d.phone || 'заявку';
  for (const m of managers) {
    if (m.id === takerId) continue;
    const s = m.tg_settings || {};
    await sendTelegramMessage(s.token, s.chatId, `${who} взяв ${takerName}.`);
  }
}

async function handleLeadCallback(userId, s, data, cqId) {
  const ack = (text) => answerCallbackQuery(s.token, cqId, text).catch(() => {});
  const [, action, leadId] = data.split(':');

  if (action === 'skip') {
    await ack('Лишив спільною');
    return true;
  }
  if (action !== 'take') { await ack(); return true; }

  const { claimed, lead } = await claimLead(leadId, userId);
  if (!lead) { await ack('Заявки вже немає'); return true; }

  if (!claimed) {
    await ack('Заявку вже взяли');
    await sendTelegramMessage(s.token, s.chatId,
      `Цю заявку вже взяв ${lead.display_name || 'інший менеджер'}.`);
    return true;
  }

  const { rows } = await pool.query('SELECT display_name FROM users WHERE id = $1', [userId]);
  const takerName = rows[0] ? rows[0].display_name : 'менеджер';

  const own = await ownCardByPhone(lead.phone_norm || normalizePhone((lead.data || {}).phone), userId);
  const card = own ? await mergeIntoCard(lead, userId, own) : await createCardFor(lead, userId);
  await ack('Твоя');
  const text = own
    ? `Цей номер уже у твоїй картці «${esc(card.name || 'без імені')}», етап «${stageLabel(STAGES[card.stage]) || 'Новий лід'}». ` +
      'Дописав туди нову заявку, другої картки немає.\nРешті написав, що заявку взяв ти.'
    : 'Твоя. Картка в срм на етапі «Новий лід», джерело «сайт».\nРешті написав, що заявку взяв ти.';
  const crm = crmLink('kliient', card.id);
  if (crm) await sendTelegramKeyboard(s.token, s.chatId, text, [[{ text: 'Відкрити картку в срм', url: crm }]]);
  else await sendTelegramMessage(s.token, s.chatId, text);
  await tellOthers(lead, userId, takerName);
  return true;
}

module.exports = {
  leadText, leadRows, propertyLink, broadcast, claimLead, createCardFor, ownCardByPhone, mergeIntoCard,
  whoHasPhone, managersWithBot, handleLeadCallback,
};
