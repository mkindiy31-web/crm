const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { normalizePhone } = require('../phone');
const { upsertClientAndNotify } = require('../clientOps');
const { sendTelegramMessage, getFilePath, downloadFileAsBase64, TASK_LABELS } = require('../telegram');
const { extractBuyers, extractTextUpdate } = require('../aiIntake');

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

// Finds the first Ukrainian-mobile-shaped phone number anywhere in free text,
// regardless of format (+380671234567, 380671234567, 0671234567, with spaces
// or dashes in between) — reuses the exact same normalizePhone() the rest of
// the app matches clients by, so a manager can type the number however they like.
function extractPhoneFromText(text) {
  const candidates = text.match(/\+?\d[\d\s\-()]{7,16}\d/g) || [];
  for (const cand of candidates) {
    const norm = normalizePhone(cand);
    if (norm && norm.length === 12 && norm.startsWith('380')) return norm;
  }
  return null;
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
            source: buyer.source || 'Instagram',
            stage: 1, // "Необхідний дзвінок" — stage 0 is the transfer inbox, not for organic new leads
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

  const phoneNorm = extractPhoneFromText(text);
  if (!phoneNorm) {
    await sendTelegramMessage(s.token, s.chatId,
      'Не знайшов номер телефону у повідомленні. Напишіть номер клієнта (в будь-якому форматі) і що змінилось — я оновлю картку. Або надішліть 1–10 фото-скріншотів переписки з покупцем.');
    return;
  }

  const existing = await findExistingClient(userId, phoneNorm);
  if (!existing) {
    await sendTelegramMessage(s.token, s.chatId,
      `❌ Клієнта з номером ${phoneNorm} не знайдено у вашій базі. Текстом можна оновлювати лише вже існуючих клієнтів.`);
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

      const result = await upsertClientAndNotify(client, reqUser, c);
      await client.query('COMMIT');

      if (result.blocked) {
        await sendTelegramMessage(s.token, s.chatId, `🚫 Не вдалося оновити — конфлікт з іншим менеджером.`);
      } else {
        await sendTelegramMessage(s.token, s.chatId, `✅ Оновлено картку: <b>${c.name}</b> (${c.phone || phoneNorm})${scheduledLine}`);
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
