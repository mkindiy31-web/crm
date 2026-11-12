// The bot as a control panel: listings, clients, and the actions a manager
// would otherwise open a laptop for.
//
// Every number here comes from the same tables crm.html reads, and every write
// goes through the same path a save in the CRM would take — the stage's own
// criterion is that an action from the menu gives the same result as the
// interface. A second copy of the logic would drift within a week.

const { pool } = require('./db');
const { STAGES, DEAL_STAGE_ID, commissionOf } = require('./stages');
const siteSync = require('./siteSync');
const { sendTelegramMessage, sendTelegramKeyboard, answerCallbackQuery } = require('./telegram');

const SHOWN = 3;            // три позиції в списку, решта за «Показати всі N»
// Строк живе в реєстрі автоматизацій: там його і міняють, тут лише значення
// за замовчуванням для викликів без явного числа.
const STALE_DAYS = require('./automations').REGISTRY['stale-nudge'].defaults.days;

function money(value, currency) {
  const n = parseFloat(value);
  if (!isFinite(n)) return '';
  const sign = currency === 'UAH' ? 'грн' : currency === 'EUR' ? '€' : '$';
  return n.toLocaleString('uk-UA').replace(/ /g, ' ') + ' ' + sign;
}

function daysSince(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (isNaN(then)) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── listings ────────────────────────────────────────────────────────────────

async function myObjects(userId) {
  const { rows } = await pool.query(
    `SELECT id, created_by, data, price_num, created_at, updated_at FROM catalog_items
     WHERE created_by = $1 AND archived_at IS NULL
     ORDER BY updated_at DESC`,
    [userId]
  );
  const forSale = rows.filter(r => (r.data.status || 'available') === 'available').length;
  return { total: rows.length, forSale, items: rows };
}

function objectLine(row, days = STALE_DAYS) {
  const d = row.data || {};
  const head = [d.propType, d.district].filter(Boolean).join(', ') || d.title || 'Обʼєкт';
  const specs = [
    d.area && d.area + ' м²',
    d.rooms && d.rooms + ' кімнати',
    d.floor && (d.totalFloors ? `${d.floor}/${d.totalFloors}` : d.floor),
  ].filter(Boolean).join(', ');
  const stale = daysSince(row.updated_at);
  const status = (d.status || 'available') !== 'available'
    ? (d.status === 'sold' ? 'продано' : 'заброньовано')
    : stale !== null && stale >= days ? `без руху ${stale} дн.` : 'у продажу';
  return { head, specs, price: money(d.price, d.currency), status };
}

function objectsText(list) {
  if (!list.total) return 'Обʼєктів за тобою поки немає. Напиши «обʼєкт», щоб завести перший.';
  const lines = [`У тебе ${list.total} обʼєктів, ${list.forSale} у продажу.`, ''];
  for (const row of list.items.slice(0, SHOWN)) {
    const o = objectLine(row);
    lines.push(`<b>${esc(o.head)}</b>${o.specs ? '\n' + esc(o.specs) : ''}`);
    lines.push(`${o.price}, ${o.status}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function objectsRows(list) {
  const rows = list.items.slice(0, SHOWN).map(r => {
    const o = objectLine(r);
    return [{ text: o.head, callback_data: `p:o:${r.id}` }];
  });
  if (list.total > SHOWN) rows.push([{ text: `Показати всі ${list.total}`, callback_data: 'p:o-all' }]);
  rows.push([{ text: 'Закрити', callback_data: 'p:close' }]);
  return rows;
}

async function objectCard(id) {
  const { rows } = await pool.query('SELECT * FROM catalog_items WHERE id = $1', [id]);
  return rows[0] || null;
}

function objectCardText(row) {
  const d = row.data || {};
  const o = objectLine(row);
  const lines = [`<b>${esc(o.head)}</b>`];
  if (o.specs) lines.push(esc(o.specs));
  if (d.condition) lines.push(esc(d.condition));
  lines.push(`${o.price}, ${o.status}`);
  const age = daysSince(row.created_at);
  if (age !== null) lines.push(`У срм ${age} дн.`);
  // Обʼєкт із сайту несе sitePostId, створений у СРМ дістає siteId від сайту.
  if (d.siteId || d.sitePostId) lines.push('На сайті так');
  else if (d.siteStatus === 'pending') lines.push('На сайт ще не пішов');
  const photos = (d.photos || []).length;
  if (photos) lines.push(`Фото ${photos}`);
  return lines.join('\n');
}

function objectCardRows(row) {
  const d = row.data || {};
  const onSale = (d.status || 'available') === 'available';
  return [
    [{ text: 'Змінити ціну', callback_data: `p:price:${row.id}` },
     onSale
       ? { text: 'Зняти з продажу', callback_data: `p:off:${row.id}` }
       : { text: 'Повернути в продаж', callback_data: `p:on:${row.id}` }],
    [{ text: 'Назад до списку', callback_data: 'p:o' }],
  ];
}

// ── clients ─────────────────────────────────────────────────────────────────

async function myClients(userId) {
  const { rows } = await pool.query(
    `SELECT id, manager_id, data, updated_at FROM clients
     WHERE manager_id = $1 AND archived_at IS NULL
     ORDER BY updated_at DESC`,
    [userId]
  );
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  const needToday = rows.filter(r => (r.data.tasks || []).some(t => !t.done && t.date && t.date <= today)).length;
  return { total: rows.length, needToday, items: rows, today };
}

function nextTask(c, today) {
  const open = (c.tasks || []).filter(t => !t.done && t.date);
  if (!open.length) return null;
  open.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const t = open[0];
  const when = t.date === today ? 'сьогодні' : t.date < today ? 'прострочено' : t.date;
  return { type: t.type || 'Дія', when, overdue: t.date < today };
}

function clientLine(row, today) {
  const c = row.data || {};
  const stage = STAGES[c.stage] ? STAGES[c.stage].name.replace(/^\d+\.\s*/, '') : '';
  const want = [c.clientRequest, (c.budgetMin || c.budgetMax) &&
    'до ' + money(c.budgetMax || c.budgetMin, 'USD')].filter(Boolean).join(', ');
  return { name: c.name || c.phone || 'Клієнт', want, stage, task: nextTask(c, today) };
}

function clientsText(list) {
  if (!list.total) return 'Клієнтів за тобою поки немає.';
  const lines = [`${list.total} активних, ${list.needToday} потребують дії сьогодні.`, ''];
  for (const row of list.items.slice(0, SHOWN)) {
    const c = clientLine(row, list.today);
    lines.push(`<b>${esc(c.name)}</b>${c.want ? '\n' + esc(c.want) : ''}`);
    lines.push(c.task ? `${esc(c.task.type)}, ${c.task.when}` : esc(c.stage));
    lines.push('');
  }
  return lines.join('\n').trim();
}

function clientsRows(list) {
  const rows = list.items.slice(0, SHOWN).map(r => {
    const c = clientLine(r, list.today);
    return [{ text: c.name, callback_data: `p:c:${r.id}` }];
  });
  if (list.total > SHOWN) rows.push([{ text: `Показати всіх ${list.total}`, callback_data: 'p:c-all' }]);
  rows.push([{ text: 'Закрити', callback_data: 'p:close' }]);
  return rows;
}

async function clientCard(id, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE id = $1 AND manager_id = $2', [id, userId]);
  return rows[0] || null;
}

function clientCardText(row, today) {
  const c = row.data || {};
  const lines = [`<b>${esc(c.name || 'Клієнт')}</b>${c.phone ? ', ' + esc(c.phone) : ''}`];
  if (c.clientRequest) lines.push(esc(c.clientRequest));
  if (c.budgetMin || c.budgetMax) {
    lines.push('Бюджет ' + [c.budgetMin, c.budgetMax].filter(Boolean)
      .map(v => money(v, 'USD')).join(' - '));
  }
  const stage = STAGES[c.stage];
  if (stage) lines.push('Етап: ' + stage.name.replace(/^\d+\.\s*/, ''));
  if (c.source) lines.push('Джерело: ' + esc(c.source));
  const task = nextTask(c, today);
  if (task) lines.push(`${esc(task.type)}: ${task.when}`);

  // Комісія показується на «Угоді»: саме там видно, заради чого дзвінок.
  if (c.stage === DEAL_STAGE_ID) {
    const comm = commissionOf(c);
    if (comm > 0) lines.push('Комісія: ' + money(Math.round(comm), 'USD'));
  }
  return lines.join('\n');
}

function clientCardRows(row) {
  const c = row.data || {};
  const rows = [];
  const next = STAGES[c.stage + 1];
  if (next) {
    rows.push([{ text: 'Далі по воронці: ' + next.name.replace(/^\d+\.\s*/, ''),
      callback_data: `p:stage:${row.id}` }]);
  }
  rows.push([
    { text: 'Поставити дзвінок', callback_data: `p:call:${row.id}` },
    { text: 'Дописати нотатку', callback_data: `p:note:${row.id}` },
  ]);
  rows.push([
    { text: 'Підібрати обʼєкт', callback_data: `p:match:${row.id}` },
    { text: 'Назад до списку', callback_data: 'p:c' },
  ]);
  return rows;
}

// ── matching ────────────────────────────────────────────────────────────────

// Listings that fit what this client asked for: inside the budget, and in the
// district they named if they named one. The whole catalog, not just mine:
// the agency's inventory is shared on purpose.
async function matchFor(client) {
  const max = parseFloat(client.budgetMax) || parseFloat(client.budgetMin) || 0;
  const params = [];
  let where = "archived_at IS NULL AND coalesce(data->>'status', 'available') = 'available'";
  if (max > 0) { params.push(max * 1.05); where += ` AND price_num <= $${params.length}`; }
  const district = (client.clientRequest || '').match(/Центр|Пасічн\p{L}*|Озер\p{L}*|Бам|Каскад|Угорник\p{L}*|Брат\p{L}*/iu);
  if (district) { params.push(district[0]); where += ` AND data->>'district' ILIKE $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT id, data, price_num FROM catalog_items WHERE ${where} ORDER BY price_num DESC LIMIT 5`,
    params
  );
  return rows;
}

// ── waiting state ───────────────────────────────────────────────────────────

async function setWaiting(userId, waiting, target) {
  await pool.query(
    `INSERT INTO pult_state (user_id, waiting, target, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET waiting = $2, target = $3, updated_at = now()`,
    [userId, waiting, target]
  );
}

async function getWaiting(userId) {
  const { rows } = await pool.query('SELECT * FROM pult_state WHERE user_id = $1', [userId]);
  return rows[0] && rows[0].waiting ? rows[0] : null;
}

async function clearWaiting(userId) {
  await pool.query('UPDATE pult_state SET waiting = NULL, target = NULL WHERE user_id = $1', [userId]);
}

// ── actions ─────────────────────────────────────────────────────────────────

// A manager owns the listings they entered and the clients on their own cards.
// An admin may act on any of them. The check runs BEFORE the write, and a
// refusal says why instead of failing silently.
async function mayTouchObject(userId, role, row) {
  if (!row) return 'Обʼєкта вже немає.';
  if (role === 'admin') return null;
  return row.created_by === userId ? null : 'Цей обʼєкт завів інший менеджер, зміни робить він.';
}

async function userRole(userId) {
  const { rows } = await pool.query('SELECT role, display_name FROM users WHERE id = $1', [userId]);
  return rows[0] || { role: 'manager', display_name: '' };
}

async function saveObject(row, data) {
  const price = parseFloat(String(data.price ?? '').replace(/[^\d.]/g, ''));
  await pool.query(
    'UPDATE catalog_items SET data = $1, price_num = $2, updated_at = now() WHERE id = $3',
    [data, isNaN(price) ? null : price, row.id]
  );
  // Той самий шлях, що й зі срм: інакше ціна в чаті розійдеться з сайтом.
  siteSync.pushListing(row.id, data).catch(err => console.error('pult: site push failed:', err));
}

async function showObjects(userId, s) {
  const list = await myObjects(userId);
  return sendTelegramKeyboard(s.token, s.chatId, objectsText(list), objectsRows(list));
}

async function showClients(userId, s) {
  const list = await myClients(userId);
  return sendTelegramKeyboard(s.token, s.chatId, clientsText(list), clientsRows(list));
}

async function handlePultCallback(userId, s, data, cqId) {
  const ack = (text) => answerCallbackQuery(s.token, cqId, text).catch(() => {});
  const parts = data.split(':');
  const action = parts[1];
  const id = parts.slice(2).join(':');
  const { role } = await userRole(userId);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });

  if (action === 'o') { await ack(); await showObjects(userId, s); return true; }
  if (action === 'c') {
    if (!id) { await ack(); await showClients(userId, s); return true; }
    const row = await clientCard(id, userId);
    await ack();
    if (!row) {
      await sendTelegramMessage(s.token, s.chatId, 'Цей клієнт не на твоїй картці.');
      return true;
    }
    await sendTelegramKeyboard(s.token, s.chatId, clientCardText(row, today), clientCardRows(row));
    return true;
  }

  if (action === 'o-all' || action === 'c-all') {
    await ack();
    const isObjects = action === 'o-all';
    const list = isObjects ? await myObjects(userId) : await myClients(userId);
    const lines = list.items.map((r, i) => {
      if (isObjects) {
        const o = objectLine(r);
        return `${i + 1}. ${o.head} ${o.price}, ${o.status}`;
      }
      const c = clientLine(r, list.today);
      return `${i + 1}. ${c.name}${c.want ? ' (' + c.want + ')' : ''} ${c.task ? c.task.type + ', ' + c.task.when : c.stage}`;
    });
    await sendTelegramKeyboard(s.token, s.chatId, esc(lines.join('\n')) || 'Порожньо',
      [[{ text: 'Закрити', callback_data: 'p:close' }]]);
    return true;
  }

  if (action === 'close') { await ack(); await clearWaiting(userId); return true; }

  if (action === 'o' || action === 'price' || action === 'off' || action === 'on') {
    // решта гілок обʼєкта нижче
  }

  if (action === 'price' || action === 'off' || action === 'on') {
    const row = await objectCard(id);
    const deny = await mayTouchObject(userId, role, row);
    if (deny) { await ack(deny); await sendTelegramMessage(s.token, s.chatId, deny); return true; }
    const d = row.data || {};

    if (action === 'price') {
      await ack();
      await setWaiting(userId, 'price', id);
      await sendTelegramMessage(s.token, s.chatId,
        `Зараз ${money(d.price, d.currency)}. Напиши нову ціну одним числом.`);
      return true;
    }

    const next = action === 'off' ? 'sold' : 'available';
    await saveObject(row, { ...d, status: next });
    await ack(next === 'sold' ? 'Знято' : 'У продажу');
    await sendTelegramMessage(s.token, s.chatId, next === 'sold'
      ? 'Зняв з продажу. З вітрини сайту обʼєкт зник.'
      : 'Повернув у продаж. На вітрині сайту знову є.');
    return true;
  }

  if (action === 'stage' || action === 'call' || action === 'note' || action === 'match') {
    const row = await clientCard(id, userId);
    if (!row) {
      await ack('Не твій клієнт');
      await sendTelegramMessage(s.token, s.chatId, 'Цей клієнт не на твоїй картці, рухати його може той, у кого він.');
      return true;
    }
    const c = row.data || {};

    if (action === 'stage') {
      const next = STAGES[c.stage + 1];
      if (!next) { await ack('Далі нікуди'); return true; }
      const updated = { ...c, stage: c.stage + 1 };
      await pool.query('UPDATE clients SET data = $1, updated_at = now() WHERE id = $2 AND manager_id = $3',
        [updated, id, userId]);
      await pool.query(
        `INSERT INTO events (manager_id, type, client_id, meta)
         VALUES ($1, 'stage_change', $2, jsonb_build_object('to', $3::int))`,
        [userId, id, c.stage + 1]);
      await ack(next.name);
      const line = next.id === DEAL_STAGE_ID && commissionOf(updated) > 0
        ? `\nКомісія: ${money(Math.round(commissionOf(updated)), 'USD')}` : '';
      await sendTelegramMessage(s.token, s.chatId,
        `${esc(c.name || 'Клієнт')} тепер на етапі «${next.name}».${line}`);
      return true;
    }

    if (action === 'match') {
      await ack();
      const found = await matchFor(c);
      if (!found.length) {
        await sendTelegramMessage(s.token, s.chatId, 'Під її запит зараз нічого немає.');
        return true;
      }
      const lines = found.map(r => {
        const o = objectLine(r);
        return `<b>${esc(o.head)}</b>${o.specs ? '\n' + esc(o.specs) : ''}\n${o.price}`;
      });
      await sendTelegramKeyboard(s.token, s.chatId,
        'Під її запит підходять:\n\n' + lines.join('\n\n'),
        [[{ text: 'Назад до картки', callback_data: `p:c:${id}` }]]);
      return true;
    }

    await ack();
    await setWaiting(userId, action, id);
    await sendTelegramMessage(s.token, s.chatId, action === 'call'
      ? 'Коли дзвонимо? Напиши дату й час, наприклад «завтра 14:00».'
      : 'Що дописати в картку?');
    return true;
  }

  await ack();
  return true;
}

// Text that answers a question the panel asked. Returns false when the bot was
// not waiting for anything, so the caller can route the message elsewhere.
async function handlePultText(userId, s, text) {
  const state = await getWaiting(userId);
  if (!state) return false;
  const { role } = await userRole(userId);

  if (state.waiting === 'price') {
    const n = parseFloat(String(text).replace(/[^\d.]/g, ''));
    if (!isFinite(n) || n <= 0) {
      await sendTelegramMessage(s.token, s.chatId, 'Не побачив числа. Напиши нову ціну, наприклад 84500.');
      return true;
    }
    const row = await objectCard(state.target);
    const deny = await mayTouchObject(userId, role, row);
    if (deny) { await clearWaiting(userId); await sendTelegramMessage(s.token, s.chatId, deny); return true; }
    const d = row.data || {};
    const was = d.price;
    await saveObject(row, { ...d, price: String(n) });
    await clearWaiting(userId);
    await sendTelegramKeyboard(s.token, s.chatId,
      `Ціна на сайті вже ${money(n, d.currency)}, було ${money(was, d.currency)}. Запис про зміну ліг у срм.`,
      [[{ text: `Повернути ${money(was, d.currency)}`, callback_data: `p:back-price:${state.target}:${was}` }]]);
    return true;
  }

  const row = await clientCard(state.target, userId);
  if (!row) { await clearWaiting(userId); await sendTelegramMessage(s.token, s.chatId, 'Картки вже немає.'); return true; }
  const c = row.data || {};

  if (state.waiting === 'note') {
    const notes = Array.isArray(c.notes) ? c.notes.slice() : [];
    notes.push({ at: new Date().toISOString(), text: String(text).trim() });
    await pool.query('UPDATE clients SET data = $1, updated_at = now() WHERE id = $2 AND manager_id = $3',
      [{ ...c, notes }, state.target, userId]);
    await clearWaiting(userId);
    await sendTelegramMessage(s.token, s.chatId, 'Дописав у картку.');
    return true;
  }

  if (state.waiting === 'call') {
    const tasks = Array.isArray(c.tasks) ? c.tasks.slice() : [];
    const when = parseWhen(String(text));
    tasks.push({ id: Date.now().toString(36), type: 'Дзвінок', date: when.date, time: when.time, done: false });
    await pool.query('UPDATE clients SET data = $1, updated_at = now() WHERE id = $2 AND manager_id = $3',
      [{ ...c, tasks }, state.target, userId]);
    await clearWaiting(userId);
    await sendTelegramMessage(s.token, s.chatId,
      `Поставив дзвінок на ${when.date}${when.time ? ' ' + when.time : ''}.`);
    return true;
  }

  await clearWaiting(userId);
  return true;
}

// "завтра 14:00", "12.11 10:30", "сьогодні" — the forms a manager actually types.
function parseWhen(text) {
  const kyivToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });

  // Дата шукається ПЕРШОЮ і вирізається з рядка. Інакше «12.11 10:30» віддає
  // час «12:11»: той самий роздільник, і регекс часу хапає дату.
  const dm = text.match(/(?<![\d.])(\d{1,2})[.\/](\d{1,2})(?![\d.])/);
  const rest = dm ? text.replace(dm[0], ' ') : text;

  const time = (rest.match(/(?<![\d:.])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d:.])/) || [])[0];
  const normTime = time ? time.replace('.', ':').padStart(5, '0') : '';

  if (dm) {
    const year = new Date().getFullYear();
    const iso = `${year}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
    return { date: iso, time: normTime };
  }
  if (/післязавтра/iu.test(text)) return { date: addDays(kyivToday, 2), time: normTime };
  if (/завтра/iu.test(text)) return { date: addDays(kyivToday, 1), time: normTime };
  return { date: kyivToday, time: normTime };
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  handlePultCallback, handlePultText, showObjects, showClients,
  mayTouchObject, parseWhen,
  SHOWN, STALE_DAYS,
  money, daysSince, esc,
  myObjects, objectLine, objectsText, objectsRows, objectCard, objectCardText, objectCardRows,
  myClients, clientLine, clientsText, clientsRows, clientCard, clientCardText, clientCardRows,
  nextTask, matchFor,
  setWaiting, getWaiting, clearWaiting,
};
