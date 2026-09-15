const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { normalizePhone } = require('../phone');
const { upsertClientAndNotify } = require('../clientOps');
const { sendTelegramMessage, getFilePath, downloadFileAsBase64, TASK_LABELS } = require('../telegram');
const { extractBuyers, extractTextUpdate, extractPersonalTodo, extractClientTaskByName, extractNewClientFromText } = require('../aiIntake');
const { STAGES } = require('../stages');

const router = express.Router();

// Mounted WITHOUT auth.requireAuth in index.js — Telegram has no session cookie.
// Every request is instead authenticated per-:userId via the secret_token header
// (see verifySecret below) plus a chat-id match, both checked before any work runs.

const DEBOUNCE_MS = 2000;
const MAX_PHOTOS = 10;
const pendingBatches = new Map(); // key -> { userId, timer, fileIds: [] }
const seenUpdateIds = new Set(); // small in-memory dedup, capped
const MAX_SEEN = 2000;

function rememberUpdateId(id) {
  if (seenUpdateIds.has(id)) return true;
  seenUpdateIds.add(id);
  if (seenUpdateIds.size > MAX_SEEN) {
    const first = seenUpdateIds.values().next().value;
    seenUpdateIds.delete(first);
  }
  return false;
}

function verifySecret(headerVal, expected) {
  if (!headerVal || !expected) return false;
  const a = Buffer.from(headerVal);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function removeOlderPendingTasksServer(tasks, type, newDate) {
  return tasks.filter(t => {
    if (t.done || t.type !== type) return true;
    return t.date >= newDate;
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function todayUA() {
  return new Date().toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function nowTimeUA() {
  return new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function mergeBuyersByPhone(buyers) {
  const merged = [];
  const byPhone = new Map();
  for (const b of buyers) {
    const norm = normalizePhone(b.phone);
    if (!norm) { merged.push(b); continue; }
    if (byPhone.has(norm)) {
      const existing = byPhone.get(norm);
      existing.notes = [existing.notes, b.notes].filter(Boolean).join('; ');
      if (!existing.hasAppointment && b.hasAppointment) {
        existing.hasAppointment = true;
        existing.appointmentType = b.appointmentType;
        existing.appointmentDate = b.appointmentDate;
        existing.appointmentTime = b.appointmentTime;
      }
    } else {
      const copy = { ...b };
      byPhone.set(norm, copy);
      merged.push(copy);
    }
  }
  return merged;
}

async function findExistingClient(userId, phoneNorm) {
  if (!phoneNorm) return null;
  const { rows } = await pool.query(
    `SELECT id, data FROM clients
     WHERE manager_id = $1 AND archived_at IS NULL
       AND (phone_norm = $2 OR phone2_norm = $2)
     ORDER BY updated_at DESC LIMIT 1`,
    [userId, phoneNorm]
  );
  return rows[0] || null;
}

// Case-insensitive substring match on the client's name, scoped to this
// manager's active (non-archived) clients. Used when a Telegram message names
// a client instead of giving their phone number — deliberately returns every
// match rather than guessing, so the caller can ask for a phone number when
// the name is ambiguous instead of silently updating the wrong person.
async function findClientsByName(userId, name) {
  const { rows } = await pool.query(
    `SELECT id, data FROM clients
     WHERE manager_id = $1 AND archived_at IS NULL AND data->>'name' ILIKE $2
     ORDER BY updated_at DESC LIMIT 6`,
    [userId, `%${name}%`]
  );
  return rows;
}

// Finds a phone number anywhere in free text, regardless of format
// (+380671234567, 380671234567, 0671234567, with spaces or dashes in between)
// — reuses the exact same normalizePhone() the rest of the app matches clients
// by, so a manager can type the number however they like. Also flags a
// digit-run that clearly LOOKS like an attempted phone number but has the wrong
// digit count (a typo) — e.g. one digit too many — as `invalidCandidate`, so the
// caller can say "that number looks wrong" instead of silently falling through
// to a name search (a wrong phone number should never be guessed/auto-corrected:
// digits could be missing or extra anywhere, and guessing risks attaching the
// wrong number to a client).
//
// Ukrainian numbers (local shorthand or +380) are matched by exact digit count,
// same as before. Foreign numbers are accepted too, but only when written with
// an explicit leading "+" — that's the one unambiguous signal that the digits
// are a full international number rather than some other unrelated number the
// manager typed (an address, a budget, a date range, etc).
function extractPhoneFromText(text) {
  const candidates = text.match(/\+?\d[\d\s\-()]{7,16}\d/g) || [];
  let invalidCandidate = null;
  for (const cand of candidates) {
    const norm = normalizePhone(cand);
    const isUkrainian = norm && norm.length === 12 && norm.startsWith('380');
    const isExplicitForeign = norm && !isUkrainian && cand.trim().startsWith('+') && norm.length >= 8 && norm.length <= 15;
    if (isUkrainian || isExplicitForeign) {
      return { valid: norm, invalidCandidate: null };
    }
    const digitsOnly = cand.replace(/\D/g, '');
    if (!invalidCandidate && digitsOnly.length >= 9 && digitsOnly.length <= 13) {
      invalidCandidate = digitsOnly;
    }
  }
  return { valid: null, invalidCandidate };
}

async function processBatch(userId, fileIds) {
  const { rows } = await pool.query(
    'SELECT id, display_name, tg_settings FROM users WHERE id = $1 AND active = true',
    [userId]
  );
  const user = rows[0];
  if (!user) return;
  const s = user.tg_settings || {};
  const reqUser = { id: user.id, displayName: user.display_name };

  try {
    const images = [];
    for (const fileId of fileIds.slice(0, MAX_PHOTOS)) {
      const filePath = await getFilePath(s.token, fileId);
      const base64 = await downloadFileAsBase64(s.token, filePath);
      images.push({ base64, mediaType: 'image/jpeg' });
    }

    const buyers = mergeBuyersByPhone(await extractBuyers(images));

    if (!buyers.length) {
      await sendTelegramMessage(s.token, s.chatId, '🤔 Не вдалося розпізнати покупців на скріншотах. Спробуйте надіслати чіткіші фото переписки.');
      return;
    }

    const created = [];
    const updated = [];
    const scheduled = [];
    const skipped = [];

    for (const buyer of buyers) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const phoneNorm = normalizePhone(buyer.phone);
        const existing = phoneNorm ? await findExistingClient(userId, phoneNorm) : null;

        let c;
        let isNew = false;
        if (existing) {
          c = { ...existing.data };
          const noteLine = `[AI Telegram, ${todayUA()} ${nowTimeUA()}]: ${buyer.notes || '(без деталей)'}`;
          c.notes = c.notes ? c.notes + '\n\n' + noteLine : noteLine;
          if (!c.history) c.history = [];
          c.history.unshift({ id: uid(), type: 'ai_note', text: 'Додано нотатку з AI-аналізу скріншотів Telegram', result: '', date: todayUA(), time: nowTimeUA() });
        } else {
          isNew = true;
          c = {
            id: uid(),
            name: buyer.name || 'Без імені',
            phone: buyer.phone || '',
            phone2: '',
            source: buyer.source || 'Інстаграм',
            stage: 1, // "Зателефонувати" — stage 0 is the transfer inbox, not for organic new leads
            hot: false,
            propType: '', rooms: '', budgetMin: '', budgetMax: '', district: '', area: '', floor: '',
            timeline: '', payment: '', purpose: '',
            clientRequest: buyer.notes || '',
            notes: '',
            date: todayUA(),
            dateISO: isoToday(),
            createdAt: new Date().toISOString(),
            responsibleManagerName: reqUser.displayName,
            tasks: [],
            history: [{ id: uid(), type: 'created', text: 'Клієнта додано через AI-аналіз скріншотів з Telegram', result: '', date: todayUA(), time: nowTimeUA() }],
          };
        }

        if (buyer.hasAppointment) {
          if (!c.tasks) c.tasks = [];
          c.tasks = removeOlderPendingTasksServer(c.tasks, buyer.appointmentType, buyer.appointmentDate);
          c.tasks.push({ id: uid(), type: buyer.appointmentType, date: buyer.appointmentDate, time: buyer.appointmentTime, done: false });
        }

        const result = await upsertClientAndNotify(client, reqUser, c);
        await client.query('COMMIT');

        if (result.blocked) {
          skipped.push(`${c.name} — вже в роботі у ${result.otherManagerName}`);
        } else {
          if (isNew) created.push(c.name);
          else updated.push(c.name || buyer.name || buyer.phone);
          if (buyer.hasAppointment) {
            scheduled.push(`${c.name} — ${TASK_LABELS[buyer.appointmentType] || buyer.appointmentType} ${buyer.appointmentDate} ${buyer.appointmentTime}`);
          }
        }
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('AI intake: failed to save buyer', err);
      } finally {
        client.release();
      }
    }

    const lines = [`🤖 <b>AI-аналіз завершено</b>`, ''];
    if (created.length) lines.push(`🆕 Нові клієнти (${created.length}): ${created.join(', ')}`);
    if (updated.length) lines.push(`🔁 Доповнено нотатками (${updated.length}): ${updated.join(', ')}`);
    if (scheduled.length) lines.push(`📅 Заплановано: ${scheduled.join('; ')}`);
    if (skipped.length) lines.push(`🚫 Пропущено (вже в іншого менеджера): ${skipped.join('; ')}`);
    await sendTelegramMessage(s.token, s.chatId, lines.join('\n'));
  } catch (err) {
    console.error('AI intake batch failed:', err);
    await sendTelegramMessage(s.token, s.chatId, '❌ Помилка аналізу скріншотів: ' + (err.message || 'невідома помилка'));
  }
}

// Only messages that explicitly ask for a to-do get turned into one — otherwise
// every random "привіт" or stray thought sent to the bot would silently become
// a task. Two ways to trigger:
//  1. A standalone word that already implies "remember this for me" — "нагадай",
//     "напомни", "todo" — no other word needed.
//  2. An add-ish verb root PLUS a task-ish noun root ANYWHERE in the message
//     (not necessarily adjacent) — e.g. "добав мені завдання..." or "постав
//     задачу, зателефонувати ..." both match even though the exact phrase
//     "додай завдання" isn't there. Word roots, not whole words, so
//     conjugations (додай/додати/додала, завдання/завдань) match without
//     listing every form.
const TODO_STANDALONE_TRIGGERS = ['нагадай', 'напомни', 'to-do', 'todo', 'то ду', 'туду'];
const TODO_VERB_ROOTS = ['додай', 'додати', 'добав', 'постав', 'запиш'];
const TODO_NOUN_ROOTS = ['завдан', 'задач', 'список'];

function looksLikeTodoRequest(text) {
  const t = text.toLowerCase();
  if (TODO_STANDALONE_TRIGGERS.some(trigger => t.includes(trigger))) return true;
  return TODO_VERB_ROOTS.some(v => t.includes(v)) && TODO_NOUN_ROOTS.some(n => t.includes(n));
}

// A plain text message with no client phone number in it — treated as a
// personal to-do, not tied to any client (e.g. "додай завдання: продовжити
// ліцензію в пʼятницю"), but ONLY when it explicitly asks for that (see
// looksLikeTodoRequest above). Uses AI to pull out a clean task line plus an
// optional due date/time when the message mentions one; falls back to storing
// the raw text (no date) if ANTHROPIC_API_KEY isn't configured on this server.
async function processPersonalTodo(userId, text) {
  const { rows } = await pool.query(
    'SELECT tg_settings FROM users WHERE id = $1 AND active = true',
    [userId]
  );
  const user = rows[0];
  if (!user) return;
  const s = user.tg_settings || {};

  let todo = { task: text.trim(), dueDate: '', dueTime: '' };
  try {
    todo = await extractPersonalTodo(text);
  } catch (err) {
    console.error('extractPersonalTodo failed, storing raw text:', err.message);
  }

  await pool.query(
    'INSERT INTO personal_tasks (user_id, text, due_date, due_time) VALUES ($1, $2, $3, $4)',
    [userId, todo.task.slice(0, 500), todo.dueDate || null, todo.dueTime || null]
  );

  const when = todo.dueDate
    ? `\n📅 На: ${todo.dueDate}${todo.dueTime ? ' ' + todo.dueTime : ''}`
    : '\n📋 Без дати — у списку "На потім"';
  await sendTelegramMessage(s.token, s.chatId, `✅ Додано в мій to-do список:\n📝 ${todo.task}${when}`);
}

// Matches "клієнт"/"клієнту"/"клієнта"/"клієнтові" etc. — a message naming a
// client by role-word takes the by-name path even without the word "завдання",
// e.g. "нагадай подзвонити клієнту Марку о 15:00".
const CLIENT_MENTION_RE = /клієнт/i;

function looksLikeClientMention(text) {
  return CLIENT_MENTION_RE.test(text);
}

// Only a phone number found alongside one of these phrases creates a brand
// new client — otherwise an unrecognized number could silently spawn a
// duplicate/junk client from an unrelated message that happens to contain a
// number-shaped string.
const NEW_CLIENT_TRIGGERS = [
  'додай клієнта', 'додати клієнта', 'новий клієнт', 'нового клієнта',
  'внеси клієнта', 'внеси нового клієнта', 'додай нового',
  'add client', 'new client',
];

function looksLikeNewClientRequest(text) {
  const t = text.toLowerCase();
  return NEW_CLIENT_TRIGGERS.some(trigger => t.includes(trigger));
}

// A phone number in the text that matches NO existing client, sent alongside
// an explicit "add a new client" phrase (see looksLikeNewClientRequest) —
// creates a fresh client card, same shape as the AI-screenshot intake path,
// landing in stage 1 ("Зателефонувати") like any other organic new lead.
async function processNewClientFromText(userId, phoneNorm, text) {
  const { rows } = await pool.query(
    'SELECT id, display_name, tg_settings FROM users WHERE id = $1 AND active = true',
    [userId]
  );
  const user = rows[0];
  if (!user) return;
  const s = user.tg_settings || {};
  const reqUser = { id: user.id, displayName: user.display_name };

  let info;
  try {
    info = await extractNewClientFromText(text);
  } catch (err) {
    await sendTelegramMessage(s.token, s.chatId, '❌ Помилка обробки повідомлення: ' + (err.message || 'невідома помилка'));
    return;
  }

  const c = {
    id: uid(),
    name: info.name || 'Без імені',
    phone: phoneNorm.replace(/^380/, '0'),
    phone2: '',
    source: 'Telegram',
    stage: 1, // "Зателефонувати" — organic new lead, same as the AI-screenshot path
    hot: false,
    propType: '', rooms: '', budgetMin: '', budgetMax: '', district: '', area: '', floor: '',
    timeline: '', payment: '', purpose: '',
    clientRequest: info.notes || '',
    notes: '',
    date: todayUA(),
    dateISO: isoToday(),
    createdAt: new Date().toISOString(),
    responsibleManagerName: reqUser.displayName,
    tasks: [],
    history: [{ id: uid(), type: 'created', text: 'Клієнта додано текстовим повідомленням у Telegram', result: '', date: todayUA(), time: nowTimeUA() }],
  };

  let scheduledLine = '';
  if (info.hasAppointment) {
    c.tasks.push({ id: uid(), type: info.appointmentType, date: info.appointmentDate, time: info.appointmentTime, done: false });
    scheduledLine = `\n📅 Заплановано: ${TASK_LABELS[info.appointmentType] || info.appointmentType} — ${info.appointmentDate} ${info.appointmentTime}`;
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await upsertClientAndNotify(client, reqUser, c);
      await client.query('COMMIT');

      if (result.blocked) {
        await sendTelegramMessage(s.token, s.chatId, `🚫 Клієнт з номером ${c.phone} вже в роботі у ${result.otherManagerName}.`);
      } else {
        await sendTelegramMessage(s.token, s.chatId, `✅ Додано нового клієнта: <b>${c.name}</b> (${c.phone})${scheduledLine}`);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('processNewClientFromText failed:', err);
    await sendTelegramMessage(s.token, s.chatId, '❌ Помилка обробки повідомлення: ' + (err.message || 'невідома помилка'));
  }
}

// A plain text message that names a client instead of giving their phone
// number, e.g. "додай завдання клієнту Марку подзвонити завтра о 15:00".
// Looks the client up by name among this manager's active clients: attaches
// the task to their card if exactly one match, otherwise asks the manager to
// disambiguate (by phone number) rather than guessing and updating the wrong person.
async function processClientTaskByName(userId, text) {
  const { rows } = await pool.query(
    'SELECT id, display_name, tg_settings FROM users WHERE id = $1 AND active = true',
    [userId]
  );
  const user = rows[0];
  if (!user) return;
  const s = user.tg_settings || {};
  const reqUser = { id: user.id, displayName: user.display_name };

  let info;
  try {
    info = await extractClientTaskByName(text);
  } catch (err) {
    await sendTelegramMessage(s.token, s.chatId, '❌ Помилка обробки повідомлення: ' + (err.message || 'невідома помилка'));
    return;
  }

  if (!info.clientName) {
    await sendTelegramMessage(s.token, s.chatId,
      'Не зрозумів, якого клієнта ви маєте на увазі. Напишіть його ім\'я чіткіше, або вкажіть номер телефону замість імені.\n\nЯкщо це не по конкретному клієнту — просто приберіть слово "клієнт" з повідомлення, і воно піде в особистий to-do список.');
    return;
  }

  const matches = await findClientsByName(userId, info.clientName);

  if (matches.length === 0) {
    await sendTelegramMessage(s.token, s.chatId,
      `❌ Клієнта на ім'я "${info.clientName}" не знайдено у вашій базі. Перевірте ім'я або вкажіть номер телефону.`);
    return;
  }

  if (matches.length > 1) {
    const list = matches.map(m => `• ${m.data.name}${m.data.phone ? ' — ' + m.data.phone : ''}`).join('\n');
    await sendTelegramMessage(s.token, s.chatId,
      `Знайшов декілька клієнтів на ім'я "${info.clientName}":\n${list}\n\nНапишіть номер телефону потрібного клієнта, щоб я оновив саме його картку.`);
    return;
  }

  const existing = matches[0];

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = { ...existing.data };
      const noteLine = `[Telegram, ${todayUA()} ${nowTimeUA()}]: ${info.notes || '(без деталей)'}`;
      c.notes = c.notes ? c.notes + '\n\n' + noteLine : noteLine;
      if (!c.history) c.history = [];
      c.history.unshift({ id: uid(), type: 'ai_note', text: 'Оновлено з повідомлення в Telegram (за іменем)', result: '', date: todayUA(), time: nowTimeUA() });

      let scheduledLine = '';
      if (info.hasAppointment) {
        if (!c.tasks) c.tasks = [];
        c.tasks = removeOlderPendingTasksServer(c.tasks, info.appointmentType, info.appointmentDate);
        c.tasks.push({ id: uid(), type: info.appointmentType, date: info.appointmentDate, time: info.appointmentTime, done: false });
        scheduledLine = `\n📅 Заплановано: ${TASK_LABELS[info.appointmentType] || info.appointmentType} — ${info.appointmentDate} ${info.appointmentTime}`;
      }

      let stageLine = '';
      if (info.newStageId != null && info.newStageId !== c.stage) {
        const fromName = STAGES.find(st => st.id === c.stage)?.name || '?';
        c.stage = info.newStageId;
        c.history.unshift({ id: uid(), type: 'stage_change', text: `Етап: ${fromName} → ${info.newStageName}`, result: '', date: todayUA(), time: nowTimeUA() });
        stageLine = `\n↪️ Етап: ${info.newStageName}`;
      }

      const result = await upsertClientAndNotify(client, reqUser, c);
      await client.query('COMMIT');

      if (result.blocked) {
        await sendTelegramMessage(s.token, s.chatId, `🚫 Не вдалося оновити — конфлікт з іншим менеджером.`);
      } else {
        await sendTelegramMessage(s.token, s.chatId, `✅ Оновлено картку: <b>${c.name}</b>${stageLine}${scheduledLine}`);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('processClientTaskByName failed:', err);
    await sendTelegramMessage(s.token, s.chatId, '❌ Помилка обробки повідомлення: ' + (err.message || 'невідома помилка'));
  }
}

// A plain text message updating ONE existing client, e.g. "+380671234567
// клієнт передумав, хоче зустрітись завтра о 15:00". Finds the client by the
// phone number in the message (any format), appends the note, and schedules
// a task if the message describes a concrete agreed call/meeting.
async function processTextUpdate(userId, text) {
  const { rows } = await pool.query(
    'SELECT id, display_name, tg_settings FROM users WHERE id = $1 AND active = true',
    [userId]
  );
  const user = rows[0];
  if (!user) return;
  const s = user.tg_settings || {};
  const reqUser = { id: user.id, displayName: user.display_name };

  const phoneResult = extractPhoneFromText(text);
  const phoneNorm = phoneResult.valid;
  if (!phoneNorm) {
    if (phoneResult.invalidCandidate) {
      await sendTelegramMessage(s.token, s.chatId,
        `⚠️ Номер "${phoneResult.invalidCandidate}" не схожий на правильний український мобільний (${phoneResult.invalidCandidate.length} цифр — має бути 9 чи 10). Перевірте номер і напишіть ще раз.`);
      return;
    }
    if (looksLikeClientMention(text)) {
      await processClientTaskByName(userId, text);
    } else if (looksLikeTodoRequest(text)) {
      await processPersonalTodo(userId, text);
    } else {
      await sendTelegramMessage(s.token, s.chatId,
        'Не знайшов номер телефону клієнта у повідомленні.\n\n' +
        '📞 Щоб оновити картку клієнта — напишіть його номер і що нового, або назвіть клієнта на ім\'я (наприклад "додай завдання клієнту Марку подзвонити завтра о 15:00").\n' +
        '✅ Щоб додати особисте завдання — почніть з "додай завдання..." (наприклад: "додай завдання зателефонувати в п\'ятницю").\n' +
        '📸 Або надішліть 1–10 фото-скріншотів переписки з покупцем.');
    }
    return;
  }

  const existing = await findExistingClient(userId, phoneNorm);
  if (!existing) {
    if (looksLikeNewClientRequest(text)) {
      await processNewClientFromText(userId, phoneNorm, text);
      return;
    }
    await sendTelegramMessage(s.token, s.chatId,
      `❌ Клієнта з номером ${phoneNorm} не знайдено у вашій базі.\n\nЩоб додати його як нового — напишіть "додай клієнта" разом із номером (наприклад: "додай клієнта ${phoneNorm.replace(/^380/, '0')} Марк, шукає 1-кімнатну").`);
    return;
  }

  try {
    const info = await extractTextUpdate(text);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = { ...existing.data };
      const noteLine = `[Telegram, ${todayUA()} ${nowTimeUA()}]: ${info.notes || '(без деталей)'}`;
      c.notes = c.notes ? c.notes + '\n\n' + noteLine : noteLine;
      if (!c.history) c.history = [];
      c.history.unshift({ id: uid(), type: 'ai_note', text: 'Оновлено з повідомлення в Telegram', result: '', date: todayUA(), time: nowTimeUA() });

      let scheduledLine = '';
      if (info.hasAppointment) {
        if (!c.tasks) c.tasks = [];
        c.tasks = removeOlderPendingTasksServer(c.tasks, info.appointmentType, info.appointmentDate);
        c.tasks.push({ id: uid(), type: info.appointmentType, date: info.appointmentDate, time: info.appointmentTime, done: false });
        scheduledLine = `\n📅 Заплановано: ${TASK_LABELS[info.appointmentType] || info.appointmentType} — ${info.appointmentDate} ${info.appointmentTime}`;
      }

      let stageLine = '';
      if (info.newStageId != null && info.newStageId !== c.stage) {
        const fromName = STAGES.find(st => st.id === c.stage)?.name || '?';
        c.stage = info.newStageId;
        c.history.unshift({ id: uid(), type: 'stage_change', text: `Етап: ${fromName} → ${info.newStageName}`, result: '', date: todayUA(), time: nowTimeUA() });
        stageLine = `\n↪️ Етап: ${info.newStageName}`;
      }

      const result = await upsertClientAndNotify(client, reqUser, c);
      await client.query('COMMIT');

      if (result.blocked) {
        await sendTelegramMessage(s.token, s.chatId, `🚫 Не вдалося оновити — конфлікт з іншим менеджером.`);
      } else {
        await sendTelegramMessage(s.token, s.chatId, `✅ Оновлено картку: <b>${c.name}</b> (${c.phone || phoneNorm})${stageLine}${scheduledLine}`);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Text update failed:', err);
    await sendTelegramMessage(s.token, s.chatId, '❌ Помилка обробки повідомлення: ' + (err.message || 'невідома помилка'));
  }
}

function scheduleFlush(key, userId) {
  const entry = pendingBatches.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pendingBatches.delete(key);
    processBatch(userId, entry.fileIds).catch(err => console.error('AI intake processBatch error:', err));
  }, DEBOUNCE_MS);
}

router.post('/:userId', async (req, res) => {
  res.sendStatus(200); // ack immediately, minimize Telegram retries

  const userId = parseInt(req.params.userId, 10);
  if (!userId) return;

  try {
    const { rows } = await pool.query(
      'SELECT tg_settings FROM users WHERE id = $1 AND active = true',
      [userId]
    );
    const s = rows[0]?.tg_settings || {};
    if (!s.enabled || !s.token || !s.chatId || !s.webhookSecret) return;

    const headerSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (!verifySecret(headerSecret, s.webhookSecret)) return;

    const update = req.body;
    if (!update || typeof update.update_id !== 'number') return;
    if (rememberUpdateId(update.update_id)) return;

    const msg = update.message;
    if (!msg || String(msg.chat?.id) !== String(s.chatId)) return;

    if (!Array.isArray(msg.photo) || !msg.photo.length) {
      if (msg.text && !msg.text.startsWith('/')) {
        processTextUpdate(userId, msg.text).catch(err => console.error('processTextUpdate error:', err));
      }
      return;
    }

    const largest = msg.photo[msg.photo.length - 1];
    const key = `${userId}:${msg.media_group_id || 'single-' + msg.message_id}`;
    let entry = pendingBatches.get(key);
    if (!entry) {
      entry = { userId, timer: null, fileIds: [] };
      pendingBatches.set(key, entry);
    }
    if (entry.fileIds.length < MAX_PHOTOS) entry.fileIds.push(largest.file_id);
    scheduleFlush(key, userId);
  } catch (err) {
    console.error('Telegram webhook error:', err);
  }
});

module.exports = router;
