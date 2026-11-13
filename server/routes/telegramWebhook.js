const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { normalizePhone } = require('../phone');
const { upsertClientAndNotify } = require('../clientOps');
const { sendTelegramMessage, sendTelegramKeyboard, answerCallbackQuery, getFilePath, downloadFileAsBase64, TASK_LABELS, addDaysISO, kyivTodayISO } = require('../telegram');
const { extractBuyers, extractTextUpdate, extractPersonalTodo, extractClientTaskByName, extractNewClientFromText, extractBudgetAndNeed, extractTaskFromText } = require('../aiIntake');
const { STAGES, DEAL_STAGE_ID } = require('../stages');
const { stageLabel } = require('../cardFormat');
const objectDialog = require('./objectDialog');
const objectIntake = require('../objectIntake');
const leads = require('../leads');
const pult = require('../pult');

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

// Same lead sources as the "Звідки дізнався" dropdown in the CRM itself
// (crm.html) — kept in sync by hand since this list rarely changes.
const SOURCE_OPTIONS = [
  { key: 'OLX', label: '🏠 OLX' },
  { key: 'DOM.RIA', label: '🏠 DOM.RIA' },
  { key: 'rieltor.ua', label: '🏠 rieltor.ua' },
  { key: 'Інстаграм', label: '📷 Інстаграм' },
  { key: 'Фейсбук', label: '📘 Фейсбук' },
  { key: 'Тредс', label: '🧵 Тредс' },
  { key: 'Тікток', label: '🎵 Тікток' },
  { key: 'Рекомендації', label: '🤝 Рекомендації' },
  { key: 'Банер', label: '🪧 Банер' },
  { key: 'Інше', label: '💬 Інше' },
];

// `cbPrefix` distinguishes which flow a tap should resume — 'src' for a
// brand-new client still in pending_intakes, 'fixsrc' for an existing
// client in pending_source_fixes that's just missing its source.
function sourceKeyboardRows(cbPrefix, id) {
  const rows = [];
  for (let i = 0; i < SOURCE_OPTIONS.length; i += 2) {
    const row = [SOURCE_OPTIONS[i], SOURCE_OPTIONS[i + 1]]
      .filter(Boolean)
      .map((opt, j) => ({ text: opt.label, callback_data: `${cbPrefix}:${id}:${i + j}` }));
    rows.push(row);
  }
  return rows;
}

async function sendSourcePrompt(s, row, isReminder) {
  const c = row.client_data;
  const prefix = isReminder
    ? '⏰ Нагадування — ще не заповнено.\n\n'
    : '🆕 Новий клієнт розпізнаний AI — ';
  const text = `${prefix}<b>${c.name}</b>${c.phone ? ' (' + c.phone + ')' : ''}\n\n📍 Звідки прийшов клієнт?`;
  await sendTelegramKeyboard(s.token, s.chatId, text, sourceKeyboardRows('src', row.id));
}

async function sendSourceFixPrompt(s, row, isReminder) {
  const prefix = isReminder ? '⏰ Нагадування — ще не заповнено.\n\n' : '📋 ';
  const text = `${prefix}У клієнта <b>${escapeHtmlTg(row.client_name)}</b> не вказано джерело.\n\n📍 Звідки прийшов клієнт?`;
  await sendTelegramKeyboard(s.token, s.chatId, text, sourceKeyboardRows('fixsrc', row.id));
}

function escapeHtmlTg(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendDetailsPrompt(s, row, isReminder) {
  const c = row.client_data;
  const prefix = isReminder ? '⏰ Нагадування — ' : `✅ Джерело: ${c.source}\n`;
  await sendTelegramMessage(s.token, s.chatId,
    `${prefix}Напишіть одним повідомленням: який бюджет і що шукає клієнт <b>${c.name}</b>?\n\n(наприклад: "шукає 2-кімнатну в центрі, бюджет 60-70 тисяч")`);
}

async function sendTaskPrompt(s, row, isReminder) {
  const c = row.client_data;
  const prefix = isReminder ? '⏰ Нагадування — ' : '✅ Прийнято\n';
  await sendTelegramMessage(s.token, s.chatId,
    `${prefix}Останній крок: яке перше завдання поставити для <b>${c.name}</b>?\n\n(наприклад: "подзвонити завтра о 15:00" або "зателефонувати ввечері")`);
}

// Sends the next outstanding question for this manager's oldest unfinished
// intake, if one hasn't already been sent — client cards queue up one at a
// time per manager so two screenshot batches never produce overlapping
// prompts. A no-op when the oldest pending row is already waiting on an
// answer (prompted_at set) or there's nothing pending at all.
async function advancePendingIntakeQueue(userId) {
  const { rows: userRows } = await pool.query(
    'SELECT tg_settings FROM users WHERE id = $1 AND active = true',
    [userId]
  );
  const s = userRows[0]?.tg_settings || {};
  if (!s.enabled || !s.token || !s.chatId) return;

  const { rows } = await pool.query(
    'SELECT * FROM pending_intakes WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
    [userId]
  );
  const row = rows[0];
  if (!row || row.prompted_at) return;

  if (row.step === 'source') await sendSourcePrompt(s, row, false);
  else if (row.step === 'details') await sendDetailsPrompt(s, row, false);
  else await sendTaskPrompt(s, row, false);

  await pool.query('UPDATE pending_intakes SET prompted_at = now() WHERE id = $1', [row.id]);
}

// Both 'details' (budget/need) and 'task' (first task) steps expect a plain
// text reply as the very next message — this finds whichever one is
// currently active so the webhook router knows to treat the manager's next
// message as an answer instead of routing it through the normal command
// parsing (processTextUpdate etc).
async function getActiveTextStepIntake(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM pending_intakes WHERE user_id = $1 AND step IN ('details', 'task') ORDER BY created_at ASC LIMIT 1",
    [userId]
  );
  return rows[0] || null;
}

// Handles a tap on one of the source buttons sent by sendSourcePrompt — moves
// the pending intake from step 'source' to 'details' and prompts the budget/
// need question next. Silently no-ops (just dismisses the spinner) if the
// row is already gone — e.g. a stale button tapped after the intake already
// completed some other way.
async function handleSourceSelection(userId, pendingId, idx, callbackQueryId, token) {
  const opt = SOURCE_OPTIONS[idx];
  if (!opt) { await answerCallbackQuery(token, callbackQueryId, 'Помилка вибору'); return; }

  const { rows } = await pool.query(
    "SELECT * FROM pending_intakes WHERE id = $1 AND user_id = $2 AND step = 'source'",
    [pendingId, userId]
  );
  const row = rows[0];
  if (!row) { await answerCallbackQuery(token, callbackQueryId, 'Вже оброблено', true); return; }

  const updatedData = { ...row.client_data, source: opt.key };
  await pool.query(
    "UPDATE pending_intakes SET client_data = $1, step = 'details', prompted_at = NULL WHERE id = $2",
    [updatedData, pendingId]
  );
  await answerCallbackQuery(token, callbackQueryId, `Обрано: ${opt.key}`);
  await advancePendingIntakeQueue(userId);
}

// Same queue-of-one-at-a-time idea as advancePendingIntakeQueue, but for
// EXISTING clients queued via the admin's "Нагадати заповнити" action
// (pending_source_fixes) — only one question each, so there's no 'step'.
async function advanceSourceFixQueue(userId) {
  const { rows: userRows } = await pool.query(
    'SELECT tg_settings FROM users WHERE id = $1 AND active = true',
    [userId]
  );
  const s = userRows[0]?.tg_settings || {};
  if (!s.enabled || !s.token || !s.chatId) return;

  // Skip (and clear out) any queued row whose client no longer needs asking —
  // deleted/archived, already got a source some other way, or the deal
  // closed while it sat in the queue (don't bother a manager about a client
  // that already reached "Угода").
  for (;;) {
    const { rows } = await pool.query(
      'SELECT * FROM pending_source_fixes WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
      [userId]
    );
    const row = rows[0];
    if (!row) return;
    if (row.prompted_at) return; // already waiting on an answer

    const { rows: clientRows } = await pool.query(
      'SELECT data FROM clients WHERE id = $1 AND manager_id = $2 AND archived_at IS NULL',
      [row.client_id, userId]
    );
    const clientData = clientRows[0]?.data;
    if (!clientData || clientData.source || clientData.stage === DEAL_STAGE_ID) {
      await pool.query('DELETE FROM pending_source_fixes WHERE id = $1', [row.id]);
      continue;
    }

    await sendSourceFixPrompt(s, row, false);
    await pool.query('UPDATE pending_source_fixes SET prompted_at = now() WHERE id = $1', [row.id]);
    return;
  }
}

// Handles a tap on one of the source buttons sent by sendSourceFixPrompt —
// writes the chosen source directly onto the already-existing client (unlike
// handleSourceSelection, which only touches the pending_intakes staging row),
// since this client is already a real row in `clients`.
async function handleSourceFixSelection(userId, fixId, idx, callbackQueryId, token) {
  const opt = SOURCE_OPTIONS[idx];
  if (!opt) { await answerCallbackQuery(token, callbackQueryId, 'Помилка вибору'); return; }

  const { rows } = await pool.query(
    'SELECT * FROM pending_source_fixes WHERE id = $1 AND user_id = $2',
    [fixId, userId]
  );
  const fixRow = rows[0];
  if (!fixRow) { await answerCallbackQuery(token, callbackQueryId, 'Вже оброблено', true); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: clientRows } = await client.query(
      'SELECT data FROM clients WHERE id = $1 AND manager_id = $2',
      [fixRow.client_id, userId]
    );
    if (clientRows.length) {
      const c = { ...clientRows[0].data, source: opt.key };
      if (!c.history) c.history = [];
      c.history.unshift({ id: uid(), type: 'info_updated', text: `Джерело вказано через Telegram: ${opt.key}`, result: '', date: todayUA(), time: nowTimeUA() });
      await client.query('UPDATE clients SET data = $1, updated_at = now() WHERE id = $2 AND manager_id = $3', [c, fixRow.client_id, userId]);
    }
    await client.query('DELETE FROM pending_source_fixes WHERE id = $1', [fixId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await answerCallbackQuery(token, callbackQueryId, `Обрано: ${opt.key}`);
  await advanceSourceFixQueue(userId);
}

// Same nag idea as checkAndRemindPendingIntakes, for the source-fix queue —
// re-sends the manager's currently-active, already-prompted client once a
// day until they tap a source. Daily rather than hourly: this is a data-
// quality cleanup, not a blocking "client isn't in the CRM yet" situation,
// so it shouldn't nag as aggressively.
async function checkAndRemindSourceFixes(pool) {
  const { rows } = await pool.query(`
    SELECT psf.*, u.tg_settings AS tg_settings FROM pending_source_fixes psf
    JOIN users u ON u.id = psf.user_id AND u.active = true
    WHERE psf.prompted_at IS NOT NULL
      AND COALESCE(psf.last_reminded_at, psf.prompted_at) <= now() - interval '1 day'
  `);
  for (const row of rows) {
    const s = row.tg_settings || {};
    if (!s.enabled || !s.token || !s.chatId) continue;
    await sendSourceFixPrompt(s, row, true);
    await pool.query('UPDATE pending_source_fixes SET last_reminded_at = now() WHERE id = $1', [row.id]);
  }
}

// Handles the manager's free-text answer to "який бюджет і що шукає клієнт?"
// Parses budget/need via AI (best-effort), stores it on the staged client,
// then moves on to the final mandatory step (first task) instead of saving
// yet. Any text at all completes this step — a parsing miss just means the
// budget comes back empty, never blocks the manager a second time.
async function handleDetailsAnswer(userId, row, text) {
  let info = { clientRequest: text.trim(), budgetMin: 0, budgetMax: 0 };
  try {
    info = await extractBudgetAndNeed(text);
  } catch (err) {
    console.error('extractBudgetAndNeed failed, using raw text:', err.message);
  }

  const updatedData = {
    ...row.client_data,
    clientRequest: info.clientRequest || row.client_data.clientRequest || '',
    budgetMin: info.budgetMin || '',
    budgetMax: info.budgetMax || '',
  };
  await pool.query(
    "UPDATE pending_intakes SET client_data = $1, step = 'task', prompted_at = NULL WHERE id = $2",
    [updatedData, row.id]
  );
  await advancePendingIntakeQueue(userId);
}

// Handles the manager's free-text answer to "яке перше завдання поставити?"
// — the last mandatory step. Parses type/date/time via AI (extractTaskFromText
// always returns a usable date, defaulting to tomorrow, so this never blocks
// on a vague answer), attaches the task, and only now actually writes the
// client into `clients`.
async function finalizePendingIntake(userId, row, text) {
  const { rows: userRows } = await pool.query(
    'SELECT id, display_name, tg_settings FROM users WHERE id = $1 AND active = true',
    [userId]
  );
  const user = userRows[0];
  if (!user) return;
  const s = user.tg_settings || {};
  const reqUser = { id: user.id, displayName: user.display_name };

  const taskInfo = await extractTaskFromText(text);
  const task = { id: uid(), type: taskInfo.type, date: taskInfo.date, time: taskInfo.time, note: taskInfo.note, done: false };
  const c = { ...row.client_data, tasks: [task] };

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsertClientAndNotify(client, reqUser, c);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await pool.query('DELETE FROM pending_intakes WHERE id = $1', [row.id]);

    const budgetLine = (c.budgetMin || c.budgetMax)
      ? `\n💰 Бюджет: ${[c.budgetMin, c.budgetMax].filter(Boolean).join('–')} $`
      : '';
    const taskLabel = TASK_LABELS[task.type] || task.type;
    await sendTelegramMessage(s.token, s.chatId,
      `✅ Клієнта остаточно додано в CRM: <b>${c.name}</b> (${c.phone})\n📍 Джерело: ${c.source}${budgetLine}\n🏠 Потреба: ${c.clientRequest || '—'}\n📌 Завдання: ${taskLabel} — ${task.date}${task.time ? ' ' + task.time : ''}`);
  } catch (err) {
    console.error('finalizePendingIntake failed:', err);
    await sendTelegramMessage(s.token, s.chatId, '❌ Помилка збереження клієнта: ' + (err.message || 'невідома помилка'));
  }

  await advancePendingIntakeQueue(userId);
}

// Run on the same 60s interval as the other Telegram checks (see index.js) —
// re-sends the manager's currently-active, already-prompted question once an
// hour until they answer it. Rows still waiting in the queue behind the active
// one are untouched (prompted_at IS NULL for those), so a manager only ever
// gets nagged about the one question actually blocking them right now.
async function checkAndRemindPendingIntakes(pool) {
  const { rows } = await pool.query(`
    SELECT pi.*, u.tg_settings AS tg_settings FROM pending_intakes pi
    JOIN users u ON u.id = pi.user_id AND u.active = true
    WHERE pi.prompted_at IS NOT NULL
      AND COALESCE(pi.last_reminded_at, pi.prompted_at) <= now() - interval '1 hour'
  `);
  let sent = 0, skipped = 0;
  for (const row of rows) {
    const s = row.tg_settings || {};
    if (!s.enabled || !s.token || !s.chatId) { skipped++; continue; }
    if (row.step === 'source') await sendSourcePrompt(s, row, true);
    else if (row.step === 'details') await sendDetailsPrompt(s, row, true);
    else await sendTaskPrompt(s, row, true);
    await pool.query('UPDATE pending_intakes SET last_reminded_at = now() WHERE id = $1', [row.id]);
    sent++;
  }

  return { sent, skipped };
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

    const pendingNew = [];
    const updated = [];
    const scheduled = [];

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
            source: '',
            stage: 1, // "Зателефонувати" — stage 0 is the transfer inbox, not for organic new leads
            hot: false,
            propType: '', rooms: '', budgetMin: '', budgetMax: '', district: '', area: '', floor: '',
            timeline: '', payment: '', purpose: '',
            clientRequest: '',
            notes: buyer.notes || '',
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

        if (isNew) {
          // Held back from `clients` until the manager answers the mandatory
          // source + budget/need questions (see advancePendingIntakeQueue) —
          // an existing client just gets its note/appointment applied now,
          // same as before, since it already has that info filled in.
          await client.query(
            "INSERT INTO pending_intakes (id, user_id, client_data, step) VALUES ($1, $2, $3, 'source')",
            [c.id, userId, c]
          );
          await client.query('COMMIT');
          pendingNew.push(c.name);
        } else {
          await upsertClientAndNotify(client, reqUser, c);
          await client.query('COMMIT');
          updated.push(c.name || buyer.name || buyer.phone);
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
    if (pendingNew.length) lines.push(`🆕 Розпізнано нових клієнтів (${pendingNew.length}): ${pendingNew.join(', ')}\n📋 Зараз запитаю джерело/бюджет/потребу/завдання по кожному — без цього картка не потрапить в CRM.`);
    if (updated.length) lines.push(`🔁 Доповнено нотатками (${updated.length}): ${updated.join(', ')}`);
    if (scheduled.length) lines.push(`📅 Заплановано: ${scheduled.join('; ')}`);
    await sendTelegramMessage(s.token, s.chatId, lines.join('\n'));

    if (pendingNew.length) await advancePendingIntakeQueue(userId);
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

  let todo = { task: text.trim(), dueDate: '', dueTime: '', repeatDays: 1 };
  try {
    todo = await extractPersonalTodo(text);
  } catch (err) {
    console.error('extractPersonalTodo failed, storing raw text:', err.message);
  }

  // A "next N days" / "every day for a week" request — one row per day so
  // each shows up on its own date in the to-do list and calendar, instead of
  // one task that would only ever appear once.
  if (todo.repeatDays > 1) {
    const startDate = todo.dueDate || kyivTodayISO();
    const dates = Array.from({ length: todo.repeatDays }, (_, i) => addDaysISO(startDate, i));
    for (const d of dates) {
      await pool.query(
        'INSERT INTO personal_tasks (user_id, text, due_date, due_time) VALUES ($1, $2, $3, $4)',
        [userId, todo.task.slice(0, 500), d, todo.dueTime || null]
      );
    }
    await sendTelegramMessage(
      s.token, s.chatId,
      `✅ Додано в мій to-do список на ${todo.repeatDays} дні поспіль:\n📝 ${todo.task}\n📅 ${dates[0]} — ${dates[dates.length - 1]}${todo.dueTime ? ' щодня о ' + todo.dueTime : ''}`
    );
    return;
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
    source: '',
    stage: 1, // "Зателефонувати" — organic new lead, same as the AI-screenshot path
    hot: false,
    propType: '', rooms: '', budgetMin: '', budgetMax: '', district: '', area: '', floor: '',
    timeline: '', payment: '', purpose: '',
    clientRequest: '',
    notes: info.notes || '',
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

  // Same mandatory gate as the AI-screenshot path (see advancePendingIntakeQueue)
  // — held in pending_intakes until source + budget/need are answered, instead
  // of going straight into `clients`.
  try {
    await pool.query(
      "INSERT INTO pending_intakes (id, user_id, client_data, step) VALUES ($1, $2, $3, 'source')",
      [c.id, userId, c]
    );
    await sendTelegramMessage(s.token, s.chatId,
      `🆕 Розпізнано нового клієнта: <b>${c.name}</b> (${c.phone})${scheduledLine}\n📋 Зараз запитаю джерело/бюджет/потребу/завдання — без цього картка не потрапить в CRM.`);
    await advancePendingIntakeQueue(userId);
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
        stageLine = `\n↪️ Етап: ${stageLabel(STAGES[info.newStageId]) || info.newStageName}`;
      }

      await upsertClientAndNotify(client, reqUser, c);
      await client.query('COMMIT');

      await sendTelegramMessage(s.token, s.chatId, `✅ Оновлено картку: <b>${c.name}</b>${stageLine}${scheduledLine}`);
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
        stageLine = `\n↪️ Етап: ${stageLabel(STAGES[info.newStageId]) || info.newStageName}`;
      }

      await upsertClientAndNotify(client, reqUser, c);
      await client.query('COMMIT');

      await sendTelegramMessage(s.token, s.chatId, `✅ Оновлено картку: <b>${c.name}</b> (${c.phone || phoneNorm})${stageLine}${scheduledLine}`);
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

function scheduleFlush(key, userId, settings) {
  const entry = pendingBatches.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pendingBatches.delete(key);
    if (key.startsWith('obj:')) {
      objectDialog.handlePhotos(userId, settings, entry.fileIds)
        .catch(err => console.error('objectDialog.handlePhotos error:', err));
      return;
    }
    processBatch(userId, entry.fileIds).catch(err => console.error('AI intake processBatch error:', err));
  }, DEBOUNCE_MS);
}

// Listing photos have their own, larger cap: a flat is photographed from every
// room, and the ten-photo limit for client screenshots would cut the batch
// without saying so.
function photoCapFor(key) {
  return key.startsWith('obj:') ? objectIntake.MAX_OBJECT_PHOTOS : MAX_PHOTOS;
}

const MENU_ROWS = [
  [{ text: 'Додати обʼєкт', callback_data: 'o:start' }, { text: 'Мої обʼєкти', callback_data: 'o:mine' }],
  [{ text: 'Мої клієнти', callback_data: 'o:clients' }, { text: 'Задачі на день', callback_data: 'o:today' }],
];

// Managers type the apostrophe four different ways depending on the keyboard:
// the proper ʼ, a straight ', a curly ’ or nothing at all. All of them mean the
// same word, and a miss here sends the message down the wrong branch entirely.
const OBJ_WORD = 'об[\u02bc\u2019\u0027\u0060\u00b4]?\u0454кт';
const NEW_OBJECT_RE = new RegExp(
  `(?<![\\p{L}\\d])(?:(?:додати|додай|новий|заведи|завести)\\s+)?${OBJ_WORD}(?![\\p{L}\\d])`,
  'iu'
);

function looksLikeNewObject(text) {
  return NEW_OBJECT_RE.test(String(text || ''));
}

async function handleCommand(userId, s, text) {
  const cmd = text.trim().split(/[\s@]/)[0].toLowerCase();
  if (cmd === '/obyekt' || cmd === '/object') return objectDialog.startObject(userId, s);
  if (cmd === '/start' || cmd === '/menu' || cmd === '/help') {
    return sendTelegramKeyboard(s.token, s.chatId,
      'Я веду обʼєкти і клієнтів Urban Estate. Обирай, з чого почати.', MENU_ROWS);
  }
  return sendTelegramKeyboard(s.token, s.chatId, 'Такої команди не знаю. Ось що вмію.', MENU_ROWS);
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

    if (update.callback_query) {
      const cq = update.callback_query;
      if (String(cq.message?.chat?.id) !== String(s.chatId)) return;
      if ((cq.data || '').startsWith('p:')) {
        pult.handlePultCallback(userId, s, cq.data, cq.id)
          .catch(err => console.error('handlePultCallback error:', err));
        return;
      }
      if ((cq.data || '').startsWith('l:')) {
        leads.handleLeadCallback(userId, s, cq.data, cq.id)
          .catch(err => console.error('handleLeadCallback error:', err));
        return;
      }
      if ((cq.data || '').startsWith('o:')) {
        objectDialog.handleCallback(userId, s, cq.data, cq.id)
          .catch(err => console.error('objectDialog.handleCallback error:', err));
        return;
      }
      const data = cq.data || '';
      const mNew = /^src:(.+):(\d+)$/.exec(data);
      const mFix = /^fixsrc:(.+):(\d+)$/.exec(data);
      if (mNew) {
        handleSourceSelection(userId, mNew[1], parseInt(mNew[2], 10), cq.id, s.token)
          .catch(err => console.error('handleSourceSelection error:', err));
      } else if (mFix) {
        handleSourceFixSelection(userId, parseInt(mFix[1], 10), parseInt(mFix[2], 10), cq.id, s.token)
          .catch(err => console.error('handleSourceFixSelection error:', err));
      } else {
        answerCallbackQuery(s.token, cq.id).catch(() => {});
      }
      return;
    }

    const msg = update.message;
    if (!msg || String(msg.chat?.id) !== String(s.chatId)) return;

    if (!Array.isArray(msg.photo) || !msg.photo.length) {
      if (!msg.text) return;

      // Commands used to be dropped here, which is why /start did nothing.
      if (msg.text.startsWith('/')) {
        handleCommand(userId, s, msg.text).catch(err => console.error('handleCommand error:', err));
        return;
      }

      // A listing being entered owns the conversation until it ends.
      const objectDraft = await objectDialog.getDraft(userId);
      if (objectDraft && !objectIntake.isTerminal(objectDraft.step)) {
        objectDialog.handleText(userId, s, msg.text).catch(err => console.error('objectDialog.handleText error:', err));
        return;
      }
      // Пульт чекає відповіді (нову ціну, нотатку, час дзвінка): вона має
      // перевагу над розпізнаванням фраз, інакше «84500» піде в інший шлях.
      if (await pult.handlePultText(userId, s, msg.text)) return;

      if (looksLikeNewObject(msg.text)) {
        objectDialog.startObject(userId, s).catch(err => console.error('startObject error:', err));
        return;
      }

      const pendingStep = await getActiveTextStepIntake(userId);
      if (pendingStep?.step === 'details') {
        handleDetailsAnswer(userId, pendingStep, msg.text).catch(err => console.error('handleDetailsAnswer error:', err));
      } else if (pendingStep?.step === 'task') {
        finalizePendingIntake(userId, pendingStep, msg.text).catch(err => console.error('finalizePendingIntake error:', err));
      } else {
        processTextUpdate(userId, msg.text).catch(err => console.error('processTextUpdate error:', err));
      }
      return;
    }

    const largest = msg.photo[msg.photo.length - 1];
    const objectDraftForPhotos = await objectDialog.getDraft(userId);
    const toObject = objectDraftForPhotos && !objectIntake.isTerminal(objectDraftForPhotos.step);
    const key = `${toObject ? 'obj' : 'cli'}:${userId}:${msg.media_group_id || 'single-' + msg.message_id}`;
    let entry = pendingBatches.get(key);
    if (!entry) {
      entry = { userId, timer: null, fileIds: [] };
      pendingBatches.set(key, entry);
    }
    if (entry.fileIds.length < photoCapFor(key)) entry.fileIds.push(largest.file_id);
    scheduleFlush(key, userId, s);
  } catch (err) {
    console.error('Telegram webhook error:', err);
  }
});

module.exports = { router, checkAndRemindPendingIntakes, checkAndRemindSourceFixes, advanceSourceFixQueue };
