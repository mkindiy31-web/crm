const TASK_LABELS = {
  call: 'Дзвінок 📞',
  consultation: 'Консультація 💬',
  selection: 'Підбір 🔎',
  inspection: 'Огляд 🔍',
  registration: 'Оформлення 📝',
};

async function sendTelegramMessage(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Same as sendTelegramMessage but attaches an inline keyboard — `rows` is an
// array of button rows, each row an array of { text, callback_data }.
async function sendTelegramKeyboard(token, chatId, text, rows) {
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows },
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Dismisses the little loading spinner Telegram shows on an inline button
// after it's tapped — required on every callback_query, even just to hide it
// with no visible toast. `showAlert` pops the text as a blocking popup instead
// of the usual tiny toast, used for "this was already handled" type notices.
async function answerCallbackQuery(token, callbackQueryId, text, showAlert) {
  if (!token || !callbackQueryId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || undefined, show_alert: !!showAlert }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function setWebhook(token, url, secretToken) {
  if (!token || !url) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'] }),
    });
    const j = await r.json().catch(() => ({}));
    return !!j.ok;
  } catch {
    return false;
  }
}

// Re-registers every enabled manager's webhook on server startup, so a change
// to allowed_updates (like adding callback_query above) reaches already
// configured bots without each manager having to re-save their Telegram
// settings by hand. Cheap and idempotent — safe to run on every boot.
async function reRegisterAllWebhooks(pool) {
  const base = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  if (!base) return;
  const { rows: users } = await pool.query(
    `SELECT id, tg_settings FROM users
     WHERE active = true AND tg_settings->>'enabled' = 'true'
       AND coalesce(tg_settings->>'token', '') != '' AND coalesce(tg_settings->>'webhookSecret', '') != ''`
  );
  for (const user of users) {
    const s = user.tg_settings || {};
    const url = `${base}/api/telegram-webhook/${user.id}`;
    await setWebhook(s.token, url, s.webhookSecret).catch(() => {});
  }
}

async function deleteWebhook(token) {
  if (!token) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    return !!j.ok;
  } catch {
    return false;
  }
}

async function getFilePath(token, fileId) {
  const r = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = await r.json();
  if (!j.ok) throw new Error('getFile failed: ' + JSON.stringify(j));
  return j.result.file_path;
}

async function downloadFileAsBase64(token, filePath) {
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!r.ok) throw new Error('file download failed: ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString('base64');
}

async function checkAndNotifyAll(pool) {
  const { rows: users } = await pool.query(
    `SELECT id, tg_settings FROM users
     WHERE active = true AND tg_settings->>'enabled' = 'true'
       AND coalesce(tg_settings->>'token', '') != '' AND coalesce(tg_settings->>'chatId', '') != ''`
  );
  if (!users.length) return;
  const now = new Date();

  for (const user of users) {
    const s = user.tg_settings || {};
    const advanceMin = parseInt(s.advance) || 60;

    const { rows: clientRows } = await pool.query(
      'SELECT data FROM clients WHERE manager_id = $1 AND archived_at IS NULL',
      [user.id]
    );

    for (const row of clientRows) {
      const c = row.data;
      for (const t of (c.tasks || [])) {
        if (t.done || !t.time || !t.date || !t.id) continue;
        const taskDt = new Date(t.date + 'T' + t.time);
        const diffMin = (taskDt - now) / 60000;
        if (diffMin < advanceMin - 1 || diffMin > advanceMin + 1) continue;

        const { rows: existing } = await pool.query(
          'SELECT 1 FROM notified_tasks WHERE user_id = $1 AND task_id = $2',
          [user.id, t.id]
        );
        if (existing.length) continue;

        const label = TASK_LABELS[t.type] || t.type;
        const msg =
          `🔔 <b>Urban Estate Group — Нагадування</b>\n\n` +
          `👤 Клієнт: <b>${c.name}</b>\n` +
          `📌 Завдання: ${label}\n` +
          `🕐 Час: <b>${t.time}</b> (${t.date})\n` +
          (c.phone ? `📞 Телефон: ${c.phone}\n` : '') +
          `\n⏰ До початку: ~${Math.round(diffMin)} хв`;

        const ok = await sendTelegramMessage(s.token, s.chatId, msg);
        if (ok) {
          await pool.query(
            'INSERT INTO notified_tasks (user_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [user.id, t.id]
          );
        }
      }
    }

    // Personal to-do items (not tied to a client) get the same reminder treatment.
    // Ids are prefixed with "p" in notified_tasks so they can never collide with a
    // client task id (those come from clientOps.js's own id generator).
    const { rows: todoRows } = await pool.query(
      'SELECT id, text, due_date, due_time FROM personal_tasks WHERE user_id = $1 AND done = false AND due_date IS NOT NULL AND due_time IS NOT NULL',
      [user.id]
    );
    for (const t of todoRows) {
      const taskDt = new Date(t.due_date + 'T' + t.due_time);
      const diffMin = (taskDt - now) / 60000;
      if (diffMin < advanceMin - 1 || diffMin > advanceMin + 1) continue;

      const notifyId = `p${t.id}`;
      const { rows: existing } = await pool.query(
        'SELECT 1 FROM notified_tasks WHERE user_id = $1 AND task_id = $2',
        [user.id, notifyId]
      );
      if (existing.length) continue;

      const msg =
        `🔔 <b>Нагадування — особисте завдання</b>\n\n` +
        `📝 ${t.text}\n` +
        `🕐 Час: <b>${t.due_time}</b> (${t.due_date})\n` +
        `\n⏰ До початку: ~${Math.round(diffMin)} хв`;

      const ok = await sendTelegramMessage(s.token, s.chatId, msg);
      if (ok) {
        await pool.query(
          'INSERT INTO notified_tasks (user_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [user.id, notifyId]
        );
      }
    }
  }
}

function kyivNowParts() {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  return {
    hh: parts.find(p => p.type === 'hour').value,
    mm: parts.find(p => p.type === 'minute').value,
  };
}

function kyivTodayISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
}

function addDaysISO(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Once a day at 21:00 Kyiv time, sends each manager a numbered summary of
// tomorrow's personal to-do items (client tasks already get their own
// per-item reminders via checkAndNotifyAll, so this stays scoped to the
// to-do list as asked). Dedup reuses notified_tasks with a per-day synthetic
// key ("digest-YYYY-MM-DD") — same table the per-task reminders already use,
// just a task_id shape that can never collide with a real task/todo id.
async function checkAndSendDailyDigest(pool) {
  const { hh, mm } = kyivNowParts();
  if (hh !== '21' || mm !== '00') return;

  const tomorrowISO = addDaysISO(kyivTodayISO(), 1);
  const digestKey = `digest-${tomorrowISO}`;

  const { rows: users } = await pool.query(
    `SELECT id, tg_settings FROM users
     WHERE active = true AND tg_settings->>'enabled' = 'true'
       AND coalesce(tg_settings->>'token', '') != '' AND coalesce(tg_settings->>'chatId', '') != ''`
  );
  if (!users.length) return;

  for (const user of users) {
    const s = user.tg_settings || {};

    const { rows: existing } = await pool.query(
      'SELECT 1 FROM notified_tasks WHERE user_id = $1 AND task_id = $2',
      [user.id, digestKey]
    );
    if (existing.length) continue;

    // Marked as sent right away (even if the list turns out empty) so this
    // user isn't rechecked every minute for the rest of the day.
    await pool.query(
      'INSERT INTO notified_tasks (user_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [user.id, digestKey]
    );

    const { rows: todos } = await pool.query(
      `SELECT text, due_time FROM personal_tasks
       WHERE user_id = $1 AND done = false AND due_date = $2
       ORDER BY due_time ASC NULLS LAST`,
      [user.id, tomorrowISO]
    );
    if (!todos.length) continue;

    const lines = todos.map((t, i) => `${i + 1}. ${t.text}${t.due_time ? ' — ' + t.due_time : ''}`);
    const msg = `📅 <b>Розклад на завтра</b>\n\n${lines.join('\n')}`;
    await sendTelegramMessage(s.token, s.chatId, msg);
  }
}

module.exports = {
  sendTelegramMessage,
  sendTelegramKeyboard,
  answerCallbackQuery,
  checkAndNotifyAll,
  checkAndSendDailyDigest,
  setWebhook,
  deleteWebhook,
  reRegisterAllWebhooks,
  getFilePath,
  downloadFileAsBase64,
  TASK_LABELS,
  addDaysISO,
  kyivTodayISO,
};
