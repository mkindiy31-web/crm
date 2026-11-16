// The bot as a control panel: listings, clients, and the actions a manager
// would otherwise open a laptop for.
//
// Every number here comes from the same tables crm.html reads, and every write
// goes through the same path a save in the CRM would take — the stage's own
// criterion is that an action from the menu gives the same result as the
// interface. A second copy of the logic would drift within a week.

const { pool } = require('./db');
const { STAGES, DEAL_STAGE_ID, commissionOf } = require('./stages');
const { addHistory, appendNote, stageLabel, dateUA, timeUA, objectStatusLabel, roomsLabel, areaLabel, genitiveName, firstNameOf, isFemaleName, accusativeFirst } = require('./cardFormat');
const siteSync = require('./siteSync');
const { sendTelegramMessage, sendTelegramKeyboard, sendTelegramPhoto, answerCallbackQuery, taskWord, crmLink, taskWhenWord } = require('./telegram');
const crypto = require('crypto');

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

// Строк «без руху» той самий, що в нагадуванні й у срм: з автоматики «Обʼєкт без руху».
// Вимкнена автоматика прибирає позначку і тут. Оновлюється на вході в пульт.
let staleTerm = STALE_DAYS;
async function refreshStaleTerm() {
  try {
    const auto = require('./automations');
    if (!(await auto.isEnabled(pool, 'stale-nudge'))) { staleTerm = Infinity; return staleTerm; }
    const d = parseInt((await auto.getConfig(pool, 'stale-nudge')).days, 10);
    staleTerm = d > 0 ? d : STALE_DAYS;
  } catch { /* лишається попередній строк */ }
  return staleTerm;
}

function objectLine(row, days = staleTerm) {
  const d = row.data || {};
  const head = [d.propType, d.district].filter(Boolean).join(', ') || d.title || 'Обʼєкт';
  const specs = [
    d.area && areaLabel(d.area),
    d.rooms && roomsLabel(d.rooms),
    d.floor && (d.totalFloors ? `${d.floor}/${d.totalFloors}` : d.floor),
  ].filter(Boolean).join(', ');
  const stale = daysSince(row.updated_at);
  const word = objectStatusLabel(d.status).toLowerCase();
  const status = (d.status || 'available') === 'available' && stale !== null && stale >= days
    ? `${word}, без руху ${stale} дн.` : word;
  return { head, specs, price: money(d.price, d.currency), status };
}

function objectsText(list) {
  if (!list.total) return 'Обʼєктів за тобою поки немає. Напиши «обʼєкт», щоб завести перший.';
  const lines = [`У тебе ${list.total} ${forms(list.total, 'обʼєкт', 'обʼєкти', 'обʼєктів')}, вільно ${list.forSale}.`, ''];
  for (const row of list.items.slice(0, SHOWN)) {
    const o = objectLine(row);
    lines.push(`<b>${esc(o.head)}</b>${o.specs ? '\n' + esc(o.specs) : ''}`);
    lines.push(`${o.price}, ${o.status}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Кнопка обʼєкта несе площу й ціну: дві «Квартира, Центр» інакше однакові.
function objectButton(row) {
  const o = objectLine(row);
  const text = [o.head, areaLabel((row.data || {}).area), o.price].filter(Boolean).join(' · ');
  return { text, callback_data: `p:o:${row.id}` };
}

function objectsRows(list) {
  const rows = list.items.slice(0, SHOWN).map(r => [objectButton(r)]);
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
  // Що обʼєкт на сайті, тепер каже кнопка «На сайті» під карткою.
  const photos = (d.photos || []).length;
  if (needsPhotos(row)) lines.push('Без фото, на сайті поки немає');
  else if (!(d.siteId || d.sitePostId) && d.siteStatus === 'pending') lines.push('На сайт ще не пішов');
  if (photos) lines.push(`Фото ${photos}`);
  return lines.join('\n');
}

// Обʼєкт без жодного фото, якого ще немає на сайті: картка пропонує «Додати фото».
// Обʼєкт із фото має «Фото · N»: додати, змінити головне, прибрати (екран 16.11.2026).
function needsPhotos(row) {
  const d = row.data || {};
  return !(d.photos || []).length && !siteSync.siteIdOf(row.id, d);
}

function objectCardRows(row) {
  const d = row.data || {};
  const onSale = (d.status || 'available') === 'available';
  const rows = [
    [{ text: 'Змінити ціну', callback_data: `p:price:${row.id}` },
     onSale
       ? { text: 'Зняти з продажу', callback_data: `p:off:${row.id}` }
       : { text: 'Повернути в продаж', callback_data: `p:on:${row.id}` }],
  ];
  // Дороги з картки: сторінка на сайті (лише в опублікованого і «Вільно») і
  // та сама картка в срм.
  const links = [];
  const photoCount = (d.photos || []).length;
  if (needsPhotos(row)) links.push({ text: 'Додати фото', callback_data: `p:ph:${row.id}` });
  else if (photoCount) links.push({ text: `Фото · ${photoCount}`, callback_data: `p:fo:${row.id}` });
  const site = siteSync.siteLinkOf(row.id, d);
  if (/^https:\/\//.test(site)) links.push({ text: 'На сайті', url: site });
  const crm = crmLink('obyekt', row.id);
  if (crm) links.push({ text: 'У срм', url: crm });
  if (links.length) rows.push(links);
  rows.push([{ text: 'Назад до списку', callback_data: 'p:o' }]);
  return rows;
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
  // Дії потребує задача на сьогодні чи прострочена, а також новий лід без
  // жодної задачі: заявку взяли, а дзвінка ще не поставили.
  const needToday = rows.filter(r => {
    const open = (r.data.tasks || []).filter(t => !t.done);
    if (open.some(t => t.date && t.date <= today)) return true;
    return Number(r.data.stage) === 0 && !open.length;
  }).length;
  return { total: rows.length, needToday, items: rows, today };
}

function nextTask(c, today) {
  const open = (c.tasks || []).filter(t => !t.done && t.date);
  if (!open.length) return null;
  open.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const t = open[0];
  // Тип словом і дата «14.11», як у ранковому зведенні: ключ «call» і ISO-дату
  // менеджер бачити не мав би.
  const dm = String(t.date).split('-').reverse().slice(0, 2).join('.');
  const when = (t.date === today ? 'сьогодні' : t.date < today ? 'прострочено' : dm) + (t.time ? ' о ' + t.time : '');
  return { id: t.id, type: taskWord(t.type), when, overdue: t.date < today };
}

function clientLine(row, today) {
  const c = row.data || {};
  const stage = stageLabel(STAGES[c.stage]);
  const want = [c.clientRequest, (c.budgetMin || c.budgetMax) &&
    'до ' + money(c.budgetMax || c.budgetMin, 'USD')].filter(Boolean).join(', ');
  return { name: c.name || c.phone || 'Клієнт', want, stage, task: nextTask(c, today) };
}

function clientsText(list) {
  if (!list.total) return 'Клієнтів за тобою поки немає.';
  const lines = [`${list.total} ${forms(list.total, 'активний', 'активні', 'активних')}, ${list.needToday} ${forms(list.needToday, 'потребує', 'потребують', 'потребують')} дії сьогодні.`, ''];
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
  if (stage) lines.push('Етап: ' + stageLabel(stage));
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

function clientCardRows(row, today = kyivNow().date) {
  const c = row.data || {};
  const rows = [];
  if (row.archived_at) {
    return [[{ text: 'Повернути у воронку', callback_data: `p:rs:${row.id}` }], [{ text: 'Назад до списку', callback_data: 'p:c' }]];
  }
  // Ті самі «Виконано» і «Перенести», що в «Задачах на день», під найближчою задачею.
  const task = nextTask(c, today);
  if (task && task.id) {
    rows.push([
      { text: 'Виконано', callback_data: `p:td:${row.id}:${task.id}` },
      { text: 'Перенести', callback_data: `p:tr:${row.id}:${task.id}` },
    ]);
  }
  const next = STAGES[c.stage + 1];
  if (next) {
    rows.push([{ text: 'Далі по воронці: ' + stageLabel(next),
      callback_data: `p:stage:${row.id}` }]);
  }
  // Будь-який етап і відмова, як у срм (екран 16.11.2026, etap-bot.html).
  rows.push([
    { text: 'Інший етап', callback_data: `p:sl:${row.id}` },
    { text: 'Відмова', callback_data: `p:ar:${row.id}` },
  ]);
  rows.push([
    { text: 'Поставити дзвінок', callback_data: `p:call:${row.id}` },
    { text: 'Дописати нотатку', callback_data: `p:note:${row.id}` },
  ]);
  const match = { text: 'Підібрати обʼєкт', callback_data: `p:match:${row.id}` };
  const back = { text: 'Назад до списку', callback_data: 'p:c' };
  const crm = crmLink('kliient', row.id);
  if (crm) {
    rows.push([match, { text: 'У срм', url: crm }]);
    rows.push([back]);
  } else {
    rows.push([match, back]);
  }
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
// 1 обʼєкт, 2 обʼєкти, 5 обʼєктів, 11 обʼєктів, 21 обʼєкт
function forms(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

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
  await refreshStaleTerm();
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
  await refreshStaleTerm();

  if (action === 'o' && !id) { await ack(); await showObjects(userId, s); return true; }
  if (action === 'c') {
    if (!id) { await ack(); await showClients(userId, s); return true; }
    const row = await clientCard(id, userId);
    await ack();
    if (!row) {
      await sendTelegramMessage(s.token, s.chatId, 'Цей клієнт не на твоїй картці.');
      return true;
    }
    await sendTelegramKeyboard(s.token, s.chatId, clientCardText(row, today), clientCardRows(row, today));
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
  if (TASK_ACTIONS.has(action)) return handleTaskAction(userId, s, action, parts, ack);

  if (action === 'ph') {
    const row = await objectCard(id);
    const deny = await mayTouchObject(userId, role, row);
    if (deny) { await ack(deny); await sendTelegramMessage(s.token, s.chatId, deny); return true; }
    await ack();
    await setWaiting(userId, 'photos', id);
    await sendTelegramKeyboard(s.token, s.chatId, 'Кидай фото, скільки є. Перше стане головним.',
      [[{ text: 'Скасувати', callback_data: `p:ph-x:${id}` }]]);
    return true;
  }

  if (action === 'ph-x') {
    await ack();
    await clearWaiting(userId);
    const row = await objectCard(id);
    if (row) await sendTelegramKeyboard(s.token, s.chatId, objectCardText(row), objectCardRows(row));
    return true;
  }

  if (action === 'o') {
    const row = await objectCard(id);
    if (!row) {
      await ack();
      await sendTelegramMessage(s.token, s.chatId, 'Цього обʼєкта вже немає в срм.');
      return true;
    }
    // Дивитись картку може кожен: підбір веде і на чужі обʼєкти, база спільна.
    // Змінити ціну чи зняти з продажу далі може лише той, хто завів.
    await ack();
    // Альбом, кинутий на картці свого обʼєкта з фото, бот спершу питає, куди його (екран 16.11.2026).
    if ((row.data?.photos || []).length && !(await mayTouchObject(userId, role, row))) await setWaiting(userId, 'card', id);
    else await clearWaiting(userId);
    await sendTelegramKeyboard(s.token, s.chatId, objectCardText(row), objectCardRows(row));
    return true;
  }

  if (['fo', 'fm', 'fr', 'fmk', 'frk', 'fry', 'fa', 'fs'].includes(action)) {
    return handlePhotoAction(userId, s, role, action, parts, ack);
  }

  if (action === 'back-price') {
    const [objId, was] = [parts[2], parts.slice(3).join(':')];
    const row = await objectCard(objId);
    const deny = await mayTouchObject(userId, role, row);
    if (deny) { await ack(deny); await sendTelegramMessage(s.token, s.chatId, deny); return true; }
    const d = row.data || {};
    if (!(parseFloat(was) > 0)) { await ack(); return true; }
    await saveObject(row, { ...d, price: String(was) });
    await ack(money(was, d.currency));
    await sendTelegramKeyboard(s.token, s.chatId,
      `Повернув ціну ${money(was, d.currency)}. На сайті теж.`,
      [[{ text: 'Назад до картки', callback_data: `p:o:${objId}` }]]);
    return true;
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

    // «Зняти з продажу» це власник передумав, а не угода: окремий статус «Знято».
    const next = action === 'off' ? 'withdrawn' : 'available';
    await saveObject(row, { ...d, status: next });
    await ack(objectStatusLabel(next));
    const backToCard = { text: 'Назад до картки', callback_data: `p:o:${id}` };
    await sendTelegramKeyboard(s.token, s.chatId, next === 'withdrawn'
      ? 'Зняв з продажу, статус «Знято». З вітрини сайту обʼєкт зник.'
      : 'Повернув у продаж, статус «Вільно». На вітрині сайту знову є.',
      next === 'withdrawn'
        ? [[{ text: 'Повернути в продаж', callback_data: `p:on:${id}` }, backToCard]]
        : [[backToCard]]);
    return true;
  }

  if (STAGE_ACTIONS.has(action)) return handleStageAction(userId, s, action, parts, ack);
  if (action === 'stage' || action === 'call' || action === 'note' || action === 'match') {
    const row = await clientCard(id, userId);
    if (!row) {
      await ack('Не твій клієнт');
      await sendTelegramMessage(s.token, s.chatId, 'Цей клієнт не на твоїй картці, рухати його може той, у кого він.');
      return true;
    }
    const c = row.data || {};
    if (row.archived_at) { await ack(); await archivedReply(s, row); return true; }

    if (action === 'stage') {
      const next = STAGES[c.stage + 1];
      if (!next) { await ack('Далі нікуди'); return true; }
      const updated = await setStage(userId, row, c.stage + 1, 'з бота');
      await ack(stageLabel(next));
      const line = next.id === DEAL_STAGE_ID && commissionOf(updated) > 0
        ? `\nКомісія: ${money(Math.round(commissionOf(updated)), 'USD')}` : '';
      await sendTelegramKeyboard(s.token, s.chatId,
        `${esc(c.name || 'Клієнт')} тепер на етапі «${stageLabel(next)}».${line}`,
        [[{ text: 'Назад до картки', callback_data: `p:c:${id}` }]]);
      return true;
    }

    if (action === 'match') {
      await ack();
      const found = await matchFor(c);
      const who = genitiveName(c.name);
      const backToCard = [{ text: 'Назад до картки', callback_data: `p:c:${id}` }];
      if (!found.length) {
        await sendTelegramKeyboard(s.token, s.chatId, `Під запит ${esc(who)} зараз нічого немає.`, [backToCard]);
        return true;
      }
      const lines = found.map(r => {
        const o = objectLine(r);
        return `<b>${esc(o.head)}</b>${o.specs ? '\n' + esc(o.specs) : ''}\n${o.price}`;
      });
      await sendTelegramKeyboard(s.token, s.chatId,
        `Під запит ${esc(who)} підходять:\n\n` + lines.join('\n\n'),
        [...found.map(r => [objectButton(r)]), backToCard]);
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

// ── етап і відмова (екран 16.11.2026, etap-bot.html) ──────────────────────

const STAGE_ACTIONS = new Set(['sl', 'sg', 'ar', 'rs']);
// Ті самі причини, що у вікні архіву в срм (crm.html, arch-reason), без значків.
const ARCHIVE_REASONS = ['Вже придбав в іншому місці', 'Плани змінилися', 'Не відповідає на дзвінки',
  'Бюджет не підходить', 'Відклав покупку', 'Перейшов до конкурентів', 'Інша причина'];
const backToCardBtn = id => ({ text: 'Назад до картки', callback_data: `p:c:${id}` });

function who(c) { return firstNameOf(c.name) || c.name || 'Клієнт'; }

async function archivedReply(s, row) {
  const c = row.data || {};
  await sendTelegramKeyboard(s.token, s.chatId,
    `${esc(who(c))} в архіві${row.archive_reason ? ': «' + esc(row.archive_reason) + '»' : ''}.`,
    [[{ text: 'Повернути у воронку', callback_data: `p:rs:${row.id}` }, { text: 'Мої клієнти', callback_data: 'p:c' }]]);
}

// Як changeStageImmediate() у срм: запис в історії, подія для статистики, а на «Угоді»
// відкриті завдання знімаються (onEnteredDealStage). Один шлях для «Далі» і «Інший етап».
async function setStage(userId, row, to, via) {
  const c = row.data || {};
  const target = STAGES[to];
  let updated = addHistory({ ...c, stage: to }, 'stage_change',
    `Етап: ${STAGES[c.stage]?.name} → ${target.name} (${via})`);
  if (target.id === DEAL_STAGE_ID && (updated.tasks || []).some(t => !t.done)) {
    updated = addHistory({ ...updated, tasks: updated.tasks.filter(t => t.done) }, 'stage_change',
      'Відкриті завдання знято, угоду закрито');
  }
  await pool.query('UPDATE clients SET data = $1, updated_at = now() WHERE id = $2 AND manager_id = $3',
    [updated, row.id, userId]);
  await pool.query(
    `INSERT INTO events (manager_id, type, client_id, meta)
     VALUES ($1, 'stage_change', $2, jsonb_build_object('fromStage', $3::int, 'toStage', $4::int))`,
    [userId, row.id, c.stage, to]); // ключі ті самі, що в clientOps: їх читають зріз і статистика
  return updated;
}

function stageRows(row) {
  const cur = (row.data || {}).stage;
  const btns = STAGES.filter(st => st.id !== cur)
    .map(st => ({ text: stageLabel(st), callback_data: `p:sg:${row.id}:${st.id}` }));
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([backToCardBtn(row.id)]);
  return rows;
}

function reasonRows(id) {
  const b = i => ({ text: ARCHIVE_REASONS[i], callback_data: `p:ar:${id}:${i}` });
  return [[b(0)], [b(1), b(4)], [b(2), b(3)], [b(5), b(6)], [backToCardBtn(id)]];
}

async function handleStageAction(userId, s, action, parts, ack) {
  const id = parts[2];
  const row = await clientCard(id, userId);
  if (!row) {
    await ack('Не твій клієнт');
    await sendTelegramMessage(s.token, s.chatId, 'Цей клієнт не на твоїй картці, рухати його може той, у кого він.');
    return true;
  }
  await ack();
  const c = row.data || {};

  if (action === 'rs') {
    if (row.archived_at) {
      await pool.query('UPDATE clients SET archived_at = NULL, archive_reason = NULL WHERE id = $1 AND manager_id = $2', [id, userId]);
    }
    const st = STAGES[c.stage];
    await sendTelegramKeyboard(s.token, s.chatId,
      `${esc(who(c))} знову у воронці${st ? ' на етапі «' + esc(stageLabel(st)) + '»' : ''}.`,
      [[{ text: 'Картка клієнта', callback_data: `p:c:${id}` }, { text: 'Мої клієнти', callback_data: 'p:c' }]]);
    return true;
  }
  if (row.archived_at) { await archivedReply(s, row); return true; }

  if (action === 'sl') {
    const st = STAGES[c.stage];
    await sendTelegramKeyboard(s.token, s.chatId,
      `${esc(who(c))} зараз на етапі «${esc(st ? stageLabel(st) : '?')}». Куди перенести?`, stageRows(row));
    return true;
  }

  if (action === 'sg') {
    const to = Number(parts[3]);
    if (!STAGES[to]) return true;
    if (to === c.stage) {
      await sendTelegramKeyboard(s.token, s.chatId,
        `${esc(who(c))} уже на етапі «${esc(stageLabel(STAGES[to]))}».`, [[backToCardBtn(id)]]);
      return true;
    }
    const from = c.stage;
    const updated = await setStage(userId, row, to, 'з бота');
    const comm = to === DEAL_STAGE_ID && commissionOf(updated) > 0
      ? `\nКомісія: ${money(Math.round(commissionOf(updated)), 'USD')}` : '';
    const btns = [backToCardBtn(id)];
    if (STAGES[from]) btns.unshift({ text: `Повернути «${stageLabel(STAGES[from])}»`, callback_data: `p:sg:${id}:${from}` });
    await sendTelegramKeyboard(s.token, s.chatId,
      `${esc(who(c))} тепер на етапі «${esc(stageLabel(STAGES[to]))}». У срм теж.${comm}`, [btns]);
    return true;
  }

  if (action === 'ar') {
    if (parts[3] === undefined) {
      const verb = isFemaleName(c.name) ? 'відмовилась' : 'відмовився';
      const she = isFemaleName(c.name) ? 'Вона піде' : firstNameOf(c.name) ? 'Він піде' : 'Клієнт піде';
      await sendTelegramKeyboard(s.token, s.chatId,
        `Чому ${esc(who(c))} ${verb}? ${she} в архів срм, звідти можна повернути.`, reasonRows(id));
      return true;
    }
    const reason = ARCHIVE_REASONS[Number(parts[3])];
    if (!reason) return true;
    // Той самий запис, що кнопка архіву в срм (POST /api/clients/:id/archive).
    await pool.query('UPDATE clients SET archived_at = now(), archive_reason = $1 WHERE id = $2 AND manager_id = $3',
      [reason, id, userId]);
    await clearWaiting(userId);
    const open = (c.tasks || []).some(t => !t.done && t.date);
    const acc = accusativeFirst(c.name);
    const head = acc ? `Переніс ${esc(acc)} в архів` : `Переніс в архів <b>${esc(c.name || 'клієнта')}</b>`;
    await sendTelegramKeyboard(s.token, s.chatId,
      `${head}: «${esc(reason)}».${open ? ` ${isFemaleName(c.name) ? 'Її' : 'Його'} задачі зникли із «Задач на день».` : ''}`,
      [[{ text: 'Повернути у воронку', callback_data: `p:rs:${id}` }, { text: 'Мої клієнти', callback_data: 'p:c' }]]);
    return true;
  }
  return true;
}

// ── задачі на день: виконано і перенести (екран 16.11.2026) ───────────────

const TASK_ACTIONS = new Set(['t', 'td', 'tr', 'tm', 'tn', 'tq', 'tl']);
// Підпис типу так, як його пише срм в історії картки (TASK_TYPES у crm.html).
const CRM_TASK_LABEL = {
  call: 'Призначено дзвінок', consultation: 'Запланована консультація', selection: 'Запланований підбір',
  inspection: 'Запланований огляд', registration: 'Заплановане оформлення',
};
// «Закрив дзвінок», «закрив консультацію»: знахідний відмінок.
const TASK_ACC = { call: 'дзвінок', consultation: 'консультацію', selection: 'підбір', inspection: 'огляд', registration: 'оформлення' };
const QUICK = { h1: 'Через годину', t1: 'Завтра 10:00', t2: 'Післязавтра 10:00' };

function taskAcc(type) { return TASK_ACC[type] || taskWord(type).toLowerCase(); }
function crmTaskLabel(type) { return CRM_TASK_LABEL[type] || taskWord(type); }
function dmy(iso) { return String(iso || '').split('-').reverse().join('.'); }

// «Оксані», «Андрію»: давальний відмінок першого слова імені. Що правилом певно
// не відмінюється, дає null, і бот пише повне імʼя після двокрапки.
const DATIVE_EXCEPTIONS = { 'ігор': 'Ігорю', 'любов': 'Любові', 'лев': 'Леву' };
function dativeName(name) {
  const w = String(name == null ? '' : name).trim().split(/\s+/)[0] || '';
  if (!/^[А-ЩЬЮЯҐЄІЇа-щьюяґєіїʼ'’-]{2,}$/u.test(w) || /^клієнт/iu.test(w)) return null;
  const low = w.toLowerCase();
  if (DATIVE_EXCEPTIONS[low]) return DATIVE_EXCEPTIONS[low];
  const caps = w === w.toUpperCase();
  const cut = (n, end) => w.slice(0, w.length - n) + (caps ? end.toUpperCase() : end);
  if (/ія$/u.test(low)) return cut(1, 'ї');
  if (/я$/u.test(low)) return cut(1, 'і');
  if (/га$/u.test(low)) return cut(2, 'зі');
  if (/ка$/u.test(low)) return cut(2, 'ці');
  if (/ха$/u.test(low)) return cut(2, 'сі');
  if (/а$/u.test(low)) return cut(1, 'і');
  if (/о$/u.test(low)) return cut(1, 'у');
  if (/[йь]$/u.test(low)) return cut(1, 'ю');
  if (/[бвдзклмнпрстфхцжчшг]$/u.test(low)) return cut(0, 'у');
  return null;
}

// «дзвінок Оксані», «огляд для Оксани»; без певного відмінка «дзвінок: Оксана Дмитришин».
function taskOf(type, c) {
  const name = c.name || c.phone || 'клієнт';
  if (type === 'call') { const d = dativeName(c.name); return d ? `дзвінок ${d}` : `дзвінок: ${name}`; }
  const g = genitiveName(c.name);
  return g !== 'клієнта' ? `${taskAcc(type)} для ${g}` : `${taskAcc(type)}: ${name}`;
}

function whenPhrase(when, today) {
  const day = taskWhenWord(when.date, today);
  return day + (when.time ? `, ${when.time}` : '');
}

const toTasks = { text: 'Назад до задач', callback_data: 'p:tl' };

function taskCardText(c, task, today) {
  const lines = [`<b>${esc(taskWord(task.type))}</b>, ${esc(c.name || 'Клієнт')}${c.phone ? ', ' + esc(c.phone) : ''}`];
  const when = whenPhrase(task, today);
  if (task.date < today) lines.push(`Було на ${when}, прострочено`);
  else lines.push(when.charAt(0).toUpperCase() + when.slice(1));
  if (task.note) lines.push(esc(task.note));
  const stage = STAGES[c.stage];
  if (stage) lines.push('Етап: ' + stageLabel(stage));
  return lines.join('\n');
}

function timeRows(prefix, back) {
  return [
    [{ text: QUICK.h1, callback_data: `${prefix}:h1` }, { text: QUICK.t1, callback_data: `${prefix}:t1` }],
    [{ text: QUICK.t2, callback_data: `${prefix}:t2` }, { text: 'Інший час', callback_data: `${prefix}:x` }],
    [back],
  ];
}

function quickWhen(opt) {
  if (opt === 'h1') return kyivPlusMinutes(60);
  const today = kyivNow().date;
  if (opt === 't1') return { date: addDays(today, 1), time: '10:00' };
  if (opt === 't2') return { date: addDays(today, 2), time: '10:00' };
  return null;
}

async function saveClient(id, userId, data) {
  await pool.query('UPDATE clients SET data = $1, updated_at = now() WHERE id = $2 AND manager_id = $3',
    [data, id, userId]);
}

// Задача з кнопки старого повідомлення могла вже змінитись у срм: бот каже
// це словами і веде до свіжого списку, а не мовчить.
async function findTask(userId, s, cid, tid) {
  const row = await clientCard(cid, userId);
  if (!row) {
    await sendTelegramKeyboard(s.token, s.chatId, 'Цей клієнт уже не на твоїй картці.', [[toTasks]]);
    return null;
  }
  const c = row.data || {};
  const task = (c.tasks || []).find(t => String(t.id) === String(tid));
  if (!task) {
    await sendTelegramKeyboard(s.token, s.chatId, 'Цієї задачі вже немає: її прибрали в срм.', [[toTasks]]);
    return null;
  }
  return { row, c, task };
}

async function moveTask(userId, s, row, c, task, when) {
  const today = kyivNow().date;
  const was = `${dmy(task.date)}${task.time ? ' ' + task.time : ''}`;
  const tasks = (c.tasks || []).map(t => t.id === task.id ? { ...t, date: when.date, time: when.time || '' } : t);
  const updated = addHistory({ ...c, tasks }, 'task_added',
    `Перенесено завдання: ${crmTaskLabel(task.type)}, ${was} → ${dmy(when.date)}${when.time ? ' ' + when.time : ''} (з бота)`);
  await saveClient(row.id, userId, updated);
  // Нагадування за N хвилин до задачі ставить позначку з id задачі; без цього
  // перенесена задача вже не нагадала б.
  await pool.query('DELETE FROM notified_tasks WHERE user_id = $1 AND task_id = $2', [userId, String(task.id)]);
  await clearWaiting(userId);
  await sendTelegramKeyboard(s.token, s.chatId,
    `Переніс ${esc(taskOf(task.type, c))} на ${whenPhrase(when, today)}. У срм теж.`, [[toTasks]]);
}

async function addTask(userId, s, row, c, type, when) {
  const today = kyivNow().date;
  const tasks = Array.isArray(c.tasks) ? c.tasks.slice() : [];
  tasks.push({ id: Date.now().toString(36), type, date: when.date, time: when.time || '', done: false });
  const updated = addHistory({ ...c, tasks }, 'task_added',
    `Додано завдання: ${crmTaskLabel(type)}, ${dmy(when.date)}${when.time ? ' о ' + when.time : ''} (з бота)`);
  await saveClient(row.id, userId, updated);
  await clearWaiting(userId);
  await sendTelegramKeyboard(s.token, s.chatId,
    `Поставив ${esc(taskOf(type, c))} на ${whenPhrase(when, today)}. У срм теж.`, [[toTasks]]);
}

async function handleTaskAction(userId, s, action, parts, ack) {
  await ack();
  const today = kyivNow().date;
  if (action === 'tl') {
    await clearWaiting(userId);
    await require('./telegram').sendDayBrief(pool, userId, s);
    return true;
  }
  const cid = parts[2];

  if (action === 'tn' || action === 'tq') {
    const type = TASK_ACC[parts[3]] ? parts[3] : 'call';
    const row = await clientCard(cid, userId);
    if (!row) { await sendTelegramKeyboard(s.token, s.chatId, 'Цей клієнт уже не на твоїй картці.', [[toTasks]]); return true; }
    const c = row.data || {};
    if (action === 'tn') {
      await sendTelegramKeyboard(s.token, s.chatId, `На коли поставити ${esc(taskOf(type, c))}?`,
        timeRows(`p:tq:${cid}:${type}`, toTasks));
      return true;
    }
    const opt = parts[4];
    if (opt === 'x') {
      await setWaiting(userId, 'tnew', `${cid}|${type}`);
      await sendTelegramMessage(s.token, s.chatId, 'Напиши дату й час, наприклад «завтра 14:00».');
      return true;
    }
    const when = quickWhen(opt);
    if (when) await addTask(userId, s, row, c, type, when);
    return true;
  }

  const found = await findTask(userId, s, cid, parts[3]);
  if (!found) return true;
  const { row, c, task } = found;
  if (task.done && action !== 't') {
    await sendTelegramKeyboard(s.token, s.chatId, 'Цю задачу вже закрили.', [[toTasks]]);
    return true;
  }

  if (action === 't') {
    if (task.done) {
      await sendTelegramKeyboard(s.token, s.chatId, 'Цю задачу вже закрили.', [[toTasks]]);
      return true;
    }
    await sendTelegramKeyboard(s.token, s.chatId, taskCardText(c, task, today), [
      [{ text: 'Виконано', callback_data: `p:td:${cid}:${task.id}` }, { text: 'Перенести', callback_data: `p:tr:${cid}:${task.id}` }],
      [{ text: 'Картка клієнта', callback_data: `p:c:${cid}` }, toTasks],
    ]);
    return true;
  }

  if (action === 'td') {
    // Як closeTaskResult() у срм: done, doneAt, запис в історії; і подія для статистики, як у clientOps.
    const tasks = (c.tasks || []).map(t => t.id === task.id ? { ...t, done: true, result: '', doneAt: dateUA() } : t);
    const updated = addHistory({ ...c, tasks }, 'task_done',
      `Виконано: ${crmTaskLabel(task.type)} (${dmy(task.date)}), з бота`);
    await saveClient(row.id, userId, updated);
    await pool.query(
      `INSERT INTO events (manager_id, type, client_id, meta) VALUES ($1, 'task_completed', $2, $3)`,
      [userId, row.id, JSON.stringify({ taskType: task.type })]);
    const done = taskOf(task.type, c);
    await sendTelegramKeyboard(s.token, s.chatId,
      `Закрив ${esc(done)}. У картці в срм теж. Наступний крок поставити?`, [
        [{ text: 'Дзвінок', callback_data: `p:tn:${cid}:call` }, { text: 'Огляд', callback_data: `p:tn:${cid}:inspection` }],
        [toTasks],
      ]);
    return true;
  }

  if (action === 'tr') {
    await sendTelegramKeyboard(s.token, s.chatId, `На коли перенести ${esc(taskOf(task.type, c))}?`,
      timeRows(`p:tm:${cid}:${task.id}`, { text: 'Назад', callback_data: `p:t:${cid}:${task.id}` }));
    return true;
  }

  if (action === 'tm') {
    const opt = parts[4];
    if (opt === 'x') {
      await setWaiting(userId, 'tmove', `${cid}|${task.id}`);
      await sendTelegramMessage(s.token, s.chatId, 'Напиши дату й час, наприклад «завтра 14:00».');
      return true;
    }
    const when = quickWhen(opt);
    if (when) await moveTask(userId, s, row, c, task, when);
    return true;
  }
  return true;
}

// Текст після «Інший час»: переносить ту саму задачу або ставить нову після «Виконано».
async function taskTimeText(userId, s, state, text) {
  const [cid, ref] = String(state.target).split('|');
  const when = await whenOrAsk(s, text);
  if (!when) return true;
  if (state.waiting === 'tnew') {
    const row = await clientCard(cid, userId);
    if (!row) { await clearWaiting(userId); await sendTelegramKeyboard(s.token, s.chatId, 'Цей клієнт уже не на твоїй картці.', [[toTasks]]); return true; }
    await addTask(userId, s, row, row.data || {}, TASK_ACC[ref] ? ref : 'call', when);
    return true;
  }
  const found = await findTask(userId, s, cid, ref);
  if (!found) { await clearWaiting(userId); return true; }
  if (found.task.done) {
    await clearWaiting(userId);
    await sendTelegramKeyboard(s.token, s.chatId, 'Цю задачу вже закрили.', [[toTasks]]);
    return true;
  }
  await moveTask(userId, s, found.row, found.c, found.task, when);
  return true;
}

// Text that answers a question the panel asked. Returns false when the bot was
// not waiting for anything, so the caller can route the message elsewhere.
// «Додати фото» чекає альбому пів години: пізніші фото вже не про цей обʼєкт,
// а скріншоти клієнтів, і мають іти своїм шляхом.
const PHOTO_WAIT_MS = 30 * 60 * 1000;

// ── фото обʼєкта з фото (екран 16.11.2026) ─────────────────────────────────

function objectName(row) {
  const d = row.data || {};
  const head = [d.propType, d.district].filter(Boolean).join(', ') || d.title || 'Обʼєкт';
  return d.area ? `${head} · ${areaLabel(d.area)}` : head;
}

// Відбиток фото в кнопці: між показом номерів і натиском фото могли змінитись.
function photoTag(p) {
  return crypto.createHash('sha1').update(String(p)).digest('hex').slice(0, 6);
}

// Розбір скріншотів клієнта живе у вебхуку; він реєструє його тут, щоб альбом,
// який менеджер назвав скріншотами, пішов туди без кругового require.
let screenshotHandler = null;
function setScreenshotHandler(fn) { screenshotHandler = fn; }

async function sitePhrase(rowId, data) {
  const res = await siteSync.pushListing(rowId, data).catch(err => {
    console.error('pult: site push failed:', err);
    return { ok: false };
  });
  if (res.ok) return 'На сайті оновив.';
  if (res.skipped) return 'Канал до сайту ще не налаштований.';
  if (res.noPhotos) return '';
  return 'Сайт зараз не відповідає, зміна в черзі і дійде сама.';
}

async function saveObjectPhotos(row, photos) {
  const data = { ...(row.data || {}), photos };
  await pool.query('UPDATE catalog_items SET data = $1, updated_at = now() WHERE id = $2', [data, row.id]);
  return data;
}

async function showPhotos(userId, s, row) {
  const { photoSheet, PER_SHEET } = require('./photoSheet');
  const photos = row.data?.photos || [];
  const more = photos.length > PER_SHEET ? `\nНа аркуші перші ${PER_SHEET}, решта у «Змінити головне» за кнопкою «Ще».` : '';
  const text = `У «${esc(objectName(row))}» ${photos.length} фото, головне перше. Нові можна просто кинути сюди.${more}`;
  const rows = [
    [{ text: 'Змінити головне', callback_data: `p:fm:${row.id}` }, { text: 'Прибрати фото', callback_data: `p:fr:${row.id}` }],
    [{ text: 'Назад до картки', callback_data: `p:o:${row.id}` }],
  ];
  await setWaiting(userId, 'photos', row.id);
  const sheet = await photoSheet(photos, 0).catch(err => { console.error('pult: photo sheet failed:', err); return null; });
  if (sheet && await sendTelegramPhoto(s.token, s.chatId, sheet, text, rows)) return;
  await sendTelegramKeyboard(s.token, s.chatId, text, rows);
}

// Номери кнопками по пʼять у ряд; сторінка це десяток фото, як на аркуші.
async function pickNumber(s, row, kind, page) {
  const { photoSheet, PER_SHEET } = require('./photoSheet');
  const photos = row.data?.photos || [];
  const from = page * PER_SHEET;
  const nums = [];
  for (let i = from; i < Math.min(photos.length, from + PER_SHEET); i++) {
    if (kind === 'fm' && i === 0) continue; // перше вже головне
    nums.push({ text: String(i + 1), callback_data: `p:${kind}k:${row.id}:${i + 1}:${photoTag(photos[i])}` });
  }
  const rows = [];
  for (let i = 0; i < nums.length; i += 5) rows.push(nums.slice(i, i + 5));
  const nav = [];
  if (from + PER_SHEET < photos.length) nav.push({ text: 'Ще', callback_data: `p:${kind}:${row.id}:${page + 1}` });
  nav.push({ text: 'Назад', callback_data: `p:fo:${row.id}` });
  rows.push(nav);
  const text = kind === 'fm' ? 'Яке фото зробити головним?' : 'Яке фото прибрати?';
  if (page > 0) {
    const sheet = await photoSheet(photos, page).catch(() => null);
    if (sheet && await sendTelegramPhoto(s.token, s.chatId, sheet, text, rows)) return;
  }
  await sendTelegramKeyboard(s.token, s.chatId, text, rows);
}

async function handlePhotoAction(userId, s, role, action, parts, ack) {
  if (action === 'fs') {
    const state = await getWaiting(userId);
    await ack();
    await clearWaiting(userId);
    if (!state || state.waiting !== 'album') return true;
    const fileIds = String(state.target).split('|')[1].split(',').filter(Boolean);
    if (screenshotHandler) await screenshotHandler(userId, fileIds);
    return true;
  }
  const id = parts[2];
  const row = await objectCard(id);
  const deny = await mayTouchObject(userId, role, row);
  if (deny) { await ack(deny); await sendTelegramMessage(s.token, s.chatId, deny); return true; }
  const photos = Array.isArray(row.data?.photos) ? row.data.photos : [];
  const back = { text: 'Назад до картки', callback_data: `p:o:${id}` };

  if (action === 'fa') {
    const state = await getWaiting(userId);
    await ack();
    if (!state || state.waiting !== 'album' || String(state.target).split('|')[0] !== id) {
      await sendTelegramKeyboard(s.token, s.chatId, 'Ці фото вже не чекають. Кинь їх ще раз.', [[back]]);
      return true;
    }
    const fileIds = String(state.target).split('|')[1].split(',').filter(Boolean);
    await appendPhotos(userId, s, row, fileIds);
    return true;
  }
  if (action === 'fo') { await ack(); await showPhotos(userId, s, row); return true; }
  if (action === 'fm' || action === 'fr') {
    await ack();
    await pickNumber(s, row, action, parseInt(parts[3], 10) || 0);
    return true;
  }

  // Номер із відбитком: фото на цьому місці мусить бути те саме, що й на аркуші.
  const k = parseInt(parts[3], 10);
  const tag = parts[4];
  if (!(k >= 1 && k <= photos.length) || photoTag(photos[k - 1]) !== tag) {
    await ack();
    await sendTelegramKeyboard(s.token, s.chatId, 'Фото тим часом змінились. Відкрий «Фото» ще раз.',
      [[{ text: `Фото · ${photos.length}`, callback_data: `p:fo:${id}` }, back]]);
    return true;
  }

  if (action === 'fmk') {
    const next = [photos[k - 1], ...photos.filter((_, i) => i !== k - 1)];
    const data = await saveObjectPhotos(row, next);
    const site = await sitePhrase(id, data);
    await ack('Головне фото ' + k);
    await sendTelegramKeyboard(s.token, s.chatId, `Головне тепер фото ${k}. ${site}`.trim(),
      [[{ text: `Фото · ${next.length}`, callback_data: `p:fo:${id}` }, back]]);
    return true;
  }
  if (action === 'frk') {
    await ack();
    if (photos.length === 1 && siteSync.siteIdOf(id, row.data || {})) {
      await sendTelegramKeyboard(s.token, s.chatId,
        'Це останнє фото, без нього обʼєкт не стоїть на вітрині сайту. Спершу додай інше.',
        [[{ text: `Фото · 1`, callback_data: `p:fo:${id}` }, back]]);
      return true;
    }
    await sendTelegramKeyboard(s.token, s.chatId, `Прибрати фото ${k}?`,
      [[{ text: 'Так, прибрати', callback_data: `p:fry:${id}:${k}:${tag}` }, { text: 'Ні', callback_data: `p:fo:${id}` }]]);
    return true;
  }
  if (action === 'fry') {
    if (photos.length === 1 && siteSync.siteIdOf(id, row.data || {})) { await ack(); return true; }
    const next = photos.filter((_, i) => i !== k - 1);
    const data = await saveObjectPhotos(row, next);
    const site = await sitePhrase(id, data);
    await ack('Прибрав');
    await sendTelegramKeyboard(s.token, s.chatId, `Прибрав фото ${k}, лишилось ${next.length}. ${site}`.trim(),
      [[{ text: `Фото · ${next.length}`, callback_data: `p:fo:${id}` }, back]]);
    return true;
  }
  await ack();
  return true;
}

async function photoWaiting(userId) {
  const state = await getWaiting(userId);
  if (!state || state.waiting !== 'photos') return null;
  if (Date.now() - new Date(state.updated_at).getTime() > PHOTO_WAIT_MS) {
    await clearWaiting(userId);
    return null;
  }
  return state;
}

// Пачка фото після «Додати фото». false, якщо пульт фото не чекає: тоді пачка
// йде далі, в обʼєкт, що додається, чи в розбір скріншотів.
async function handlePultPhotos(userId, s, fileIds) {
  const card = await getWaiting(userId);
  if (card && card.waiting === 'card') {
    if (Date.now() - new Date(card.updated_at).getTime() > PHOTO_WAIT_MS) { await clearWaiting(userId); return false; }
    // Почата чернетка обʼєкта важливіша за картку, з якої менеджер пішов «Додати обʼєкт».
    const { rows: dr } = await pool.query('SELECT step FROM pending_objects WHERE user_id = $1 LIMIT 1', [userId]);
    const { isTerminal } = require('./objectIntake');
    if (dr.length && !isTerminal(dr[0].step)) return false;
    const row = await objectCard(card.target);
    if (!row) { await clearWaiting(userId); return false; }
    await setWaiting(userId, 'album', `${row.id}|${fileIds.join(',')}`);
    await sendTelegramKeyboard(s.token, s.chatId, `Додати ці ${fileIds.length} фото до «${esc(objectName(row))}»?`, [
      [{ text: 'Додати до обʼєкта', callback_data: `p:fa:${row.id}` }],
      [{ text: 'Це скріншоти клієнта', callback_data: 'p:fs' }],
    ]);
    return true;
  }
  const state = await photoWaiting(userId);
  if (!state) return false;
  const { role } = await userRole(userId);
  const row = await objectCard(state.target);
  const deny = await mayTouchObject(userId, role, row);
  if (deny) { await clearWaiting(userId); await sendTelegramMessage(s.token, s.chatId, deny); return true; }
  return appendPhotos(userId, s, row, fileIds);
}

async function appendPhotos(userId, s, row, fileIds) {
  const { photosFromTelegram } = require('./routes/objectPublish');
  const { MAX_OBJECT_PHOTOS } = require('./objectIntake');
  const d = row.data || {};
  const have = Array.isArray(d.photos) ? d.photos : [];
  const got = await photosFromTelegram(s.token, fileIds.slice(0, Math.max(0, MAX_OBJECT_PHOTOS - have.length)));
  if (!got.photos.length) {
    await sendTelegramKeyboard(s.token, s.chatId, 'Telegram не віддав фото. Кинь їх ще раз.',
      [[{ text: 'Скасувати', callback_data: `p:ph-x:${row.id}` }]]);
    return true;
  }
  const data = { ...d, photos: have.concat(got.photos) };
  await pool.query('UPDATE catalog_items SET data = $1, updated_at = now() WHERE id = $2', [data, row.id]);
  await clearWaiting(userId);
  if (have.length) {
    // Обʼєкт уже з фото: нові в кінець, головне те саме (екран 16.11.2026).
    const site = await sitePhrase(row.id, data);
    const lostMore = got.lost ? ` ${got.lost} фото Telegram не віддав.` : '';
    await sendTelegramKeyboard(s.token, s.chatId,
      `Додав ${got.photos.length} фото, тепер ${data.photos.length}. ${site}${lostMore}`.replace(/\s+$/, ''),
      [[{ text: `Фото · ${data.photos.length}`, callback_data: `p:fo:${row.id}` },
        { text: 'Назад до картки', callback_data: `p:o:${row.id}` }]]);
    return true;
  }

  const res = await siteSync.pushListing(row.id, data).catch(err => {
    console.error('pult: site push failed:', err);
    return { ok: false };
  });
  const fresh = (await objectCard(row.id)) || { ...row, data };
  const where = res.ok
    ? 'Обʼєкт пішов на сайт.'
    : res.skipped
      ? 'Канал до сайту ще не налаштований, тому на вітрину обʼєкт не пішов.'
      : 'Сайт зараз не відповідає, обʼєкт у черзі і піде сам, щойно сайт повернеться.';
  const lost = got.lost ? ` ${got.lost} фото Telegram не віддав.` : '';
  const buttons = [];
  const site = siteSync.siteLinkOf(fresh.id, fresh.data || {});
  if (res.ok && /^https:\/\//.test(site)) buttons.push({ text: 'На сайті', url: site });
  buttons.push({ text: 'Назад до картки', callback_data: `p:o:${row.id}` });
  await sendTelegramKeyboard(s.token, s.chatId,
    `Додав ${got.photos.length} фото, головне перше. ${where}${lost}`, [buttons]);
  return true;
}

async function handlePultText(userId, s, text) {
  const state = await getWaiting(userId);
  if (!state) return false;
  const { role } = await userRole(userId);

  if (state.waiting === 'card') { await clearWaiting(userId); return false; }
  if (state.waiting === 'album') {
    const objId = String(state.target).split('|')[0];
    await sendTelegramKeyboard(s.token, s.chatId, 'Спершу скажи, куди фото: до обʼєкта чи це скріншоти клієнта.', [
      [{ text: 'Додати до обʼєкта', callback_data: `p:fa:${objId}` }],
      [{ text: 'Це скріншоти клієнта', callback_data: 'p:fs' }],
    ]);
    return true;
  }

  if (state.waiting === 'photos') {
    if (!(await photoWaiting(userId))) return false;
    await sendTelegramKeyboard(s.token, s.chatId, 'Тут чекаю фото. Кидай фото або тисни «Скасувати».',
      [[{ text: 'Скасувати', callback_data: `p:ph-x:${state.target}` }]]);
    return true;
  }

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

  if (state.waiting === 'tmove' || state.waiting === 'tnew') return taskTimeText(userId, s, state, text);

  const row = await clientCard(state.target, userId);
  if (!row) { await clearWaiting(userId); await sendTelegramMessage(s.token, s.chatId, 'Картки вже немає.'); return true; }
  const c = row.data || {};

  if (state.waiting === 'note') {
    // Нотатки в СРМ одне текстове поле; рядок з датою, як у AI-нотатках бота.
    const updated = addHistory(appendNote(c, `[бот, ${dateUA()} ${timeUA()}]: ${String(text).trim()}`),
      'notes_updated', 'Нотатки оновлено з бота');
    await pool.query('UPDATE clients SET data = $1, updated_at = now() WHERE id = $2 AND manager_id = $3',
      [updated, state.target, userId]);
    await clearWaiting(userId);
    await sendTelegramKeyboard(s.token, s.chatId, 'Дописав у картку.',
      [[{ text: 'Назад до картки', callback_data: `p:c:${state.target}` }]]);
    return true;
  }

  if (state.waiting === 'call') {
    const when = await whenOrAsk(s, text);
    if (!when) return true; // бот уже пояснив, і стан лишився: наступний текст теж про час
    const tasks = Array.isArray(c.tasks) ? c.tasks.slice() : [];
    // Тип завдання ключем із TASK_TYPES у СРМ ('call'), а не підписом.
    tasks.push({ id: Date.now().toString(36), type: 'call', date: when.date, time: when.time, done: false });
    const [y, m, d] = when.date.split('-');
    const updated = addHistory({ ...c, tasks }, 'task_added',
      `Додано завдання: Призначено дзвінок, ${d}.${m}.${y}${when.time ? ' о ' + when.time : ''} (з бота)`);
    await pool.query('UPDATE clients SET data = $1, updated_at = now() WHERE id = $2 AND manager_id = $3',
      [updated, state.target, userId]);
    await clearWaiting(userId);
    await sendTelegramKeyboard(s.token, s.chatId,
      `Поставив дзвінок на ${d}.${m}${when.time ? ' о ' + when.time : ''}. Він уже в картці в срм.`,
      [[{ text: 'Назад до картки', callback_data: `p:c:${state.target}` }]]);
    return true;
  }

  await clearWaiting(userId);
  return true;
}

// Зараз за Києвом: дата і час, від них рахуються «через годину» і перевірка
// минулого. Сервер стоїть в UTC, тому годинник сервера тут не годиться.
function kyivNow() {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return { date: p.slice(0, 10), time: p.slice(11, 16) };
}

// Хвилини від зараз за Києвом: «через годину» о 23:30 дає завтра 00:30.
function kyivPlusMinutes(minutes) {
  const now = kyivNow();
  const [h, m] = now.time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const day = Math.floor(total / 1440);
  const rest = total - day * 1440;
  return { date: addDays(now.date, day),
    time: `${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}` };
}

// «понеділок» містить «неділ», тому неділя лише без «по» перед нею.
const WEEKDAYS = [/(?<!по)неділ/iu, /понеділ/iu, /вівтор/iu, /серед/iu, /четвер/iu, /п[ʼ'’]?ятниц/iu, /субот/iu];

// "завтра 14:00", "12.11 10:30", "через годину", "в понеділок", "сьогодні" —
// the forms a manager actually types. null, коли дати в тексті не видно:
// тоді бот перепитує, а не ставить «сьогодні» мовчки.
function parseWhen(text) {
  const now = kyivNow();
  const t = String(text);

  const rel = t.match(/через\s+(?:(\d{1,2})\s*)?(годин\p{L}*|год\b|хвилин\p{L}*|хв\b|пів\s*години)/iu);
  if (rel) {
    const n = rel[1] ? Number(rel[1]) : 1;
    const minutes = /пів/iu.test(rel[2]) ? 30 : /^х/iu.test(rel[2]) ? n : n * 60;
    return kyivPlusMinutes(minutes);
  }

  // Дата шукається ПЕРШОЮ і вирізається з рядка. Інакше «12.11 10:30» віддає
  // час «12:11»: той самий роздільник, і регекс часу хапає дату.
  const dm = t.match(/(?<![\d.])(\d{1,2})[.\/](\d{1,2})(?![\d.])/);
  const rest = dm ? t.replace(dm[0], ' ') : t;

  const time = (rest.match(/(?<![\d:.])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d:.])/) || [])[0];
  const normTime = time ? time.replace('.', ':').padStart(5, '0') : '';

  if (dm) {
    const day = Number(dm[1]), month = Number(dm[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let year = Number(now.date.slice(0, 4));
    let iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // «05.01» у листопаді це січень наступного року; «12.11» у листопаді це минуле,
    // і бот так і скаже, а не перекине на рік уперед.
    if ((new Date(now.date) - new Date(iso)) / 86400000 > 90) iso = `${year + 1}` + iso.slice(4);
    return { date: iso, time: normTime };
  }
  if (/післязавтра/iu.test(t)) return { date: addDays(now.date, 2), time: normTime };
  if (/завтра/iu.test(t)) return { date: addDays(now.date, 1), time: normTime };
  const wd = WEEKDAYS.findIndex(re => re.test(t));
  if (wd >= 0) {
    const todayWd = new Date(now.date + 'T00:00:00Z').getUTCDay();
    return { date: addDays(now.date, ((wd - todayWd + 7) % 7) || 7), time: normTime };
  }
  if (/сьогодні/iu.test(t) || normTime) return { date: now.date, time: normTime };
  return null;
}

// Чому цей час не годиться, або '' коли годиться. Минулого бот не ставить:
// задача, поставлена одразу простроченою, лише засмічує ранкове зведення.
function pastReason(when) {
  const now = kyivNow();
  const dm = when.date.split('-').reverse().slice(0, 2).join('.');
  if (when.date < now.date) return `${dm} уже минуло. Напиши дату, що ще попереду.`;
  if (when.date === now.date && when.time && when.time <= now.time) {
    return `Сьогодні ${when.time} уже минуло. Напиши час, що ще попереду.`;
  }
  return '';
}

// Розібраний час або null після пояснення менеджеру, що не так.
async function whenOrAsk(s, text) {
  const when = parseWhen(text);
  if (!when) {
    await sendTelegramMessage(s.token, s.chatId, 'Не побачив дати. Напиши, наприклад, «завтра 14:00», «20.11 10:30» або «через годину».');
    return null;
  }
  const why = pastReason(when);
  if (why) { await sendTelegramMessage(s.token, s.chatId, why); return null; }
  return when;
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  handlePultCallback, handlePultText, handlePultPhotos, showObjects, showClients, needsPhotos, PHOTO_WAIT_MS,
  setScreenshotHandler, photoTag,
  mayTouchObject, parseWhen, pastReason, dativeName, kyivNow,
  SHOWN, STALE_DAYS,
  money, daysSince, esc,
  myObjects, objectLine, objectsText, objectsRows, objectButton, objectCard, objectCardText, objectCardRows,
  myClients, clientLine, clientsText, clientsRows, clientCard, clientCardText, clientCardRows,
  nextTask, matchFor,
  setWaiting, getWaiting, clearWaiting, refreshStaleTerm,
};
