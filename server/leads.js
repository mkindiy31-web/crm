// A request from the site: who gets told, who ends up owning it.
//
// The request arrives belonging to nobody. Every manager with the bot on sees
// it at once, and the first to tap "Беру собі" gets the card. The rest are told
// who took it, so nobody calls the same person twice.

const { pool } = require('./db');
const { normalizePhone } = require('./phone');
const { sendTelegramMessage, sendTelegramKeyboard, answerCallbackQuery } = require('./telegram');

function leadText(lead, dupes) {
  const d = lead.data || {};
  const lines = ['<b>Нова заявка з сайту</b>'];
  if (d.name) lines.push(d.name + (d.phone ? ', ' + d.phone : ''));
  else if (d.phone) lines.push(d.phone);
  if (d.contact && d.contact !== d.phone) lines.push(d.contact);
  if (d.propertyTitle) lines.push('Дивилась: ' + d.propertyTitle);
  if (d.message) lines.push(d.message);
  if (d.source) lines.push('Форма: ' + d.source);

  if (dupes && dupes.length) {
    const who = dupes.map(x => x.display_name).join(', ');
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
  const now = new Date().toISOString();
  const card = {
    id,
    name: d.name || d.phone || 'Заявка з сайту',
    phone: d.phone || '',
    stage: 0,                  // 1. Новий лід
    source: 'сайт',
    budget: d.budget || '',
    need: d.message || d.propertyTitle || '',
    createdAt: now,
    tasks: [],
    notes: d.propertyTitle ? [{ at: now, text: 'Дивилась: ' + d.propertyTitle }] : [],
  };

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

  const card = await createCardFor(lead, userId);
  await ack('Твоя');
  await sendTelegramMessage(s.token, s.chatId,
    `Твоя. Картка в срм на етапі «1. Новий лід», джерело «сайт».\nРешті написав, що заявку взяв ти.`);
  await tellOthers(lead, userId, takerName);
  return true;
}

module.exports = {
  leadText, leadRows, broadcast, claimLead, createCardFor,
  whoHasPhone, managersWithBot, handleLeadCallback,
};
