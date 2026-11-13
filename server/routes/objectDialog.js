// The bot side of entering a listing: prompts, buttons and the draft row.
//
// All transitions live in ../objectIntake.js, which knows nothing about
// Telegram; this file only turns them into messages and back. Wording and the
// "КРОК n З 5" counter follow the screens the owner approved on 2026-10-31
// (_plan/design/_build/clean-bot-04-dodaty.html, clean-bot-05-*.html).

const { pool } = require('../db');
const oi = require('../objectIntake');
const { sendTelegramMessage, sendTelegramKeyboard, answerCallbackQuery } = require('../telegram');

// Counts come from the site's taxonomies (FIELDS.md, measured 2026-11-01).
// They are shown on the buttons so the manager sees where listings actually
// live. Until the site pushes them, they stay here as the known numbers.
const CHOICES = {
  type: [
    { label: 'Квартира', n: 34 },
    { label: 'Будинок', n: 10, siteLabel: 'Будинки' },
    { label: 'Земля', n: 2 },
    { label: 'Комерція', n: 1 },
  ],
  purpose: [
    { label: 'Продаж', n: 47 },
    { label: 'Оренда', n: 0 },
  ],
  district: [
    { label: 'Центр', n: 15 },
    { label: 'Озеро', n: 9 },
    { label: 'Бам', n: 8 },
    { label: 'За містом', n: 6 },
    { label: 'Пасічна', n: 5 },
    { label: 'Каскад', n: 4 },
    { label: 'Угорники', n: 0 },
    { label: 'Брати', n: 0 },
  ],
  condition: [
    { label: 'З ремонтом', n: 23 },
    { label: 'Без ремонту', n: 11 },
    { label: 'Будується', n: 9 },
    { label: 'Частковий', value: 'Частковий ремонт', n: 2 }, // термін сайту зветься повністю
  ],
};

// Only the first six districts are shown; the rest open behind "Інший район",
// as on the approved screen.
const DISTRICTS_SHOWN = 6;

// The counter the screens show covers the five answered steps, not photos.
const COUNTED = ['type', 'purpose', 'district', 'condition', 'specs'];

const QUESTION = {
  photos: 'Кидай фото обʼєкта, скільки є. Решта займе близько хвилини.\n<i>перше фото стане головним, порядок можна змінити потім</i>',
  type: 'Що це за обʼєкт?',
  purpose: 'Продаж чи оренда?',
  district: 'Район?',
  condition: 'Стан?',
  specs: 'Тепер одним рядком: ціна, площа, кімнати, поверх\n<i>наприклад: 55 тисяч, 62 метри, 2 кімнати, 4 з 9</i>',
  owner: 'Чий це обʼєкт? Імʼя і номер продавця одним рядком.\n<i>номер назовні не йде, він лише в срм</i>',
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function stepLabel(step) {
  const i = COUNTED.indexOf(step);
  return i === -1 ? '' : `<b>КРОК ${i + 1} З ${COUNTED.length}</b>\n`;
}

// ── draft row ───────────────────────────────────────────────────────────────

async function getDraft(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM pending_objects WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

async function createDraft(userId) {
  const id = uid();
  await pool.query(
    'INSERT INTO pending_objects (id, user_id, item_data, step) VALUES ($1, $2, $3, $4)',
    [id, userId, {}, 'photos']
  );
  return { id, user_id: userId, item_data: {}, step: 'photos', edit_field: null };
}

async function saveDraft(id, data, step, editField = null) {
  await pool.query(
    'UPDATE pending_objects SET item_data = $1, step = $2, edit_field = $3, updated_at = now() WHERE id = $4',
    [data, step, editField, id]
  );
}

async function dropDraft(id) {
  await pool.query('DELETE FROM pending_objects WHERE id = $1', [id]);
}

// ── keyboards ───────────────────────────────────────────────────────────────

function navRow(step, extra = []) {
  const row = [];
  if (oi.prevStep(step)) row.push({ text: 'Назад', callback_data: 'o:b' });
  row.push({ text: 'Скасувати', callback_data: 'o:c' });
  return extra.concat([row]);
}

// Число на кнопці: скільки таких обʼєктів зараз у срм. Порядок і назви кнопок
// з CHOICES (затверджений екран), числа живі, бо зашиті розходились із срм.
const CHOICE_FIELD = { type: 'propType', purpose: 'purpose', district: 'district', condition: 'condition' };
async function liveCounts(step) {
  const field = CHOICE_FIELD[step];
  if (!field) return null;
  try {
    const { rows } = await pool.query(
      `SELECT data->>'${field}' v, count(*)::int n FROM catalog_items
       WHERE archived_at IS NULL AND coalesce(data->>'status', 'available') = 'available'
       GROUP BY 1`);
    return new Map(rows.map(r => [r.v, r.n]));
  } catch { return null; } // без чисел кнопки однаково працюють
}

async function choiceRows(step) {
  const all = CHOICES[step] || [];
  const list = step === 'district' ? all.slice(0, DISTRICTS_SHOWN) : all;
  const live = await liveCounts(step);
  const count = c => (live ? live.get(c.value || c.label) || 0 : c.n);
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map((c, j) => ({
      text: count(c) > 0 ? `${c.label} · ${count(c)}` : c.label,
      callback_data: `o:p:${i + j}`,
    })));
  }
  if (step === 'district' && all.length > DISTRICTS_SHOWN) {
    rows.push([{ text: 'Інший район', callback_data: 'o:more' }]);
  }
  return rows;
}

function summaryText(data) {
  const lines = ['Зібрав ось це:', ''];
  const typeLine = [data.propType, data.purpose && data.purpose.toLowerCase()].filter(Boolean).join(', ');
  if (typeLine) lines.push(`<b>Тип</b> ${typeLine}`);
  if (data.district) lines.push(`<b>Район</b> ${data.district}`);
  const size = [data.area && `${data.area} м²`, data.rooms && `${data.rooms} кімнати`].filter(Boolean).join(', ');
  if (size) lines.push(`<b>Площа</b> ${size}`);
  if (data.floor) lines.push(`<b>Поверх</b> ${data.floor}${data.totalFloors ? ' з ' + data.totalFloors : ''}`);
  if (data.condition) lines.push(`<b>Стан</b> ${data.condition}`);
  if (data.price) {
    const sign = data.currency === 'UAH' ? 'грн' : data.currency === 'EUR' ? '€' : '$';
    lines.push(`<b>Ціна</b> ${Number(data.price).toLocaleString('uk-UA').replace(/ /g, ' ')} ${sign}`);
  }
  if (data.ownerName || data.ownerPhone) {
    lines.push(`<b>Власник</b> ${[data.ownerName, data.ownerPhone].filter(Boolean).join(', ')}`);
  }
  const photos = (data.photos || []).length;
  lines.push(`<b>Фото</b> ${photos}${photos ? ', головне перше' : ''}`);
  const missing = oi.missingRequired(data);
  if (missing.length) lines.push('', `Бракує: ${missing.join(', ')}`);
  return lines.join('\n');
}

function confirmRows(data) {
  const rows = [];
  if (!oi.missingRequired(data).length) {
    rows.push([{ text: 'Опублікувати на сайт', callback_data: 'o:pub' }]);
  }
  rows.push([
    { text: 'Змінити поле', callback_data: 'o:e' },
    { text: 'Лишити чернеткою', callback_data: 'o:drf' },
  ]);
  return rows;
}

function editRows() {
  const fields = [
    ['Тип', 'type'], ['Продаж чи оренда', 'purpose'], ['Район', 'district'],
    ['Стан', 'condition'], ['Ціна і площа', 'specs'], ['Власник', 'owner'],
    ['Фото', 'photos'],
  ];
  const rows = [];
  for (let i = 0; i < fields.length; i += 2) {
    rows.push(fields.slice(i, i + 2).map(([label, step]) => ({
      text: label, callback_data: `o:ef:${step}`,
    })));
  }
  rows.push([{ text: 'Назад до зведення', callback_data: 'o:back-confirm' }]);
  return rows;
}

// ── prompting ───────────────────────────────────────────────────────────────

async function prompt(s, draft, prefix = '') {
  const step = draft.step;
  const data = draft.item_data || {};

  if (step === 'confirm') {
    return sendTelegramKeyboard(s.token, s.chatId, prefix + summaryText(data), confirmRows(data));
  }
  if (step === 'edit') {
    return sendTelegramKeyboard(s.token, s.chatId, prefix + 'Що міняємо?', editRows());
  }

  const text = prefix + stepLabel(step) + (QUESTION[step] || '');
  if (oi.BUTTON_STEPS.includes(step)) {
    return sendTelegramKeyboard(s.token, s.chatId, text, navRow(step, await choiceRows(step)));
  }
  if (step === 'owner') {
    return sendTelegramKeyboard(s.token, s.chatId, text,
      navRow(step, [[{ text: 'Пропустити', callback_data: 'o:sk' }]]));
  }
  if (step === 'photos') {
    return sendTelegramKeyboard(s.token, s.chatId, text, [[{ text: 'Скасувати', callback_data: 'o:c' }]]);
  }
  return sendTelegramKeyboard(s.token, s.chatId, text, navRow(step));
}

// After an edit the dialog goes straight back to the summary, not onward
// through the remaining steps.
async function advance(s, draft, data, prefix = '') {
  const editing = draft.edit_field;
  const next = editing ? 'confirm' : oi.nextStep(draft.step);
  await saveDraft(draft.id, data, next, null);
  return prompt(s, { ...draft, item_data: data, step: next, edit_field: null }, prefix);
}

// ── entry points ────────────────────────────────────────────────────────────

async function startObject(userId, s) {
  const existing = await getDraft(userId);
  if (existing && !oi.isTerminal(existing.step)) {
    return sendTelegramKeyboard(s.token, s.chatId,
      'У тебе вже є незакінчений обʼєкт. Продовжити його чи почати новий?',
      [[{ text: 'Продовжити', callback_data: 'o:cont' }, { text: 'Почати новий', callback_data: 'o:new' }]]);
  }
  const draft = await createDraft(userId);
  return prompt(s, draft);
}

async function handlePhotos(userId, s, fileIds) {
  const draft = await getDraft(userId);
  if (!draft || oi.isTerminal(draft.step)) return false;

  const r = oi.addPhotos(draft.item_data || {}, fileIds);
  const tail = r.dropped
    ? ` Більше ${oi.MAX_OBJECT_PHOTOS} не беру, ${r.dropped} не прийняв.`
    : '';

  // Photos arriving mid-dialog are added to the batch, but do not move the step.
  if (draft.step !== 'photos') {
    await saveDraft(draft.id, r.data, draft.step, draft.edit_field);
    await sendTelegramMessage(s.token, s.chatId, `Дописав до пачки, тепер ${r.total} фото.${tail}`);
    return true;
  }

  await advance(s, draft, r.data, `Прийняв ${r.total} фото, стискаю і ставлю знак.\n\n`);
  return true;
}

async function handleText(userId, s, text) {
  const draft = await getDraft(userId);
  if (!draft || oi.isTerminal(draft.step)) return false;
  const step = draft.step;

  if (oi.BUTTON_STEPS.includes(step)) {
    await prompt(s, draft, 'Тут чекаю вибір кнопкою.\n\n');
    return true;
  }

  if (step === 'specs') {
    const parsed = oi.parseSpecs(text);
    if (!parsed.price) {
      await prompt(s, draft, 'Не побачив ціни в цьому рядку.\n\n');
      return true;
    }
    await advance(s, draft, { ...draft.item_data, ...parsed });
    return true;
  }

  if (step === 'owner') {
    await advance(s, draft, { ...draft.item_data, ...oi.parseOwner(text) });
    return true;
  }

  if (step === 'photos') {
    await prompt(s, draft, 'Спершу фото.\n\n');
    return true;
  }

  await prompt(s, draft);
  return true;
}

async function handleCallback(userId, s, data, cqId) {
  const ack = (text) => answerCallbackQuery(s.token, cqId, text).catch(() => {});
  const parts = data.split(':');
  const action = parts[1];
  const arg = parts[2];

  // Menu buttons work whether or not a draft exists.
  if (action === 'start') { await ack(); await startObject(userId, s); return true; }
  if (action === 'mine' || action === 'clients' || action === 'today') {
    await ack();
    const pult = require('./../pult');
    if (action === 'mine') await pult.showObjects(userId, s);
    else if (action === 'clients') await pult.showClients(userId, s);
    else await sendTelegramMessage(s.token, s.chatId, 'Зріз дня приходить сам о 8:30.');
    return true;
  }

  const draft = await getDraft(userId);
  if (!draft) { await ack('Чернетки вже немає'); return true; }
  const item = draft.item_data || {};

  if (action === 'cont') { await ack(); await prompt(s, draft); return true; }

  if (action === 'new') {
    await ack();
    await dropDraft(draft.id);
    const fresh = await createDraft(userId);
    await prompt(s, fresh);
    return true;
  }

  if (action === 'p') {
    const all = CHOICES[draft.step] || [];
    const choice = all[parseInt(arg, 10)];
    if (!choice) { await ack(); return true; }
    await ack(choice.label);
    await advance(s, draft, oi.applyChoice(item, draft.step, choice));
    return true;
  }

  if (action === 'more') {
    await ack();
    const rest = (CHOICES.district || []).slice(DISTRICTS_SHOWN);
    const rows = rest.map((c, i) => [{ text: c.label, callback_data: `o:p:${DISTRICTS_SHOWN + i}` }]);
    await sendTelegramKeyboard(s.token, s.chatId, 'Інші райони:', navRow('district', rows));
    return true;
  }

  if (action === 'b') {
    await ack();
    const back = oi.prevStep(draft.step);
    if (!back) { await prompt(s, draft); return true; }
    const cleared = oi.clearStep(item, back);
    await saveDraft(draft.id, cleared, back, null);
    await prompt(s, { ...draft, item_data: cleared, step: back, edit_field: null });
    return true;
  }

  if (action === 'c') {
    await ack();
    await sendTelegramKeyboard(s.token, s.chatId,
      `Скасувати обʼєкт? Фото (${(item.photos || []).length}) теж зникнуть.`,
      [[{ text: 'Так, скасувати', callback_data: 'o:cy' }, { text: 'Ні, продовжити', callback_data: 'o:cn' }]]);
    return true;
  }

  if (action === 'cy') {
    await ack('Скасовано');
    await dropDraft(draft.id);
    await sendTelegramMessage(s.token, s.chatId, 'Скасував, нічого не лишилось.');
    return true;
  }

  if (action === 'cn') { await ack(); await prompt(s, draft); return true; }

  if (action === 'e') {
    await ack();
    await saveDraft(draft.id, item, 'edit', null);
    await prompt(s, { ...draft, step: 'edit' });
    return true;
  }

  if (action === 'ef') {
    await ack();
    const target = arg;
    const cleared = oi.clearStep(item, target);
    await saveDraft(draft.id, cleared, target, target);
    await prompt(s, { ...draft, item_data: cleared, step: target, edit_field: target });
    return true;
  }

  if (action === 'back-confirm') {
    await ack();
    await saveDraft(draft.id, item, 'confirm', null);
    await prompt(s, { ...draft, step: 'confirm' });
    return true;
  }

  if (action === 'sk') {
    await ack();
    await advance(s, draft, item);
    return true;
  }

  if (action === 'drf') {
    await ack('Лишив чернеткою');
    await saveDraft(draft.id, item, 'draft', null);
    await sendTelegramMessage(s.token, s.chatId,
      'Лишив чернеткою. Напиши «обʼєкт», щоб продовжити з того самого місця.');
    return true;
  }

  if (action === 'pub') {
    await ack('Публікую');
    const { publishDraft } = require('./objectPublish');
    await publishDraft(userId, s, draft);
    return true;
  }

  await ack();
  return true;
}

module.exports = {
  CHOICES,
  COUNTED,
  QUESTION,
  startObject,
  handlePhotos,
  handleText,
  handleCallback,
  getDraft,
  createDraft,
  saveDraft,
  dropDraft,
  summaryText,
  stepLabel,
  choiceRows,
  confirmRows,
};
