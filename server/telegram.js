const automations = require('./automations');

// One place for the API host, so a run can point the bot at a local stub and
// count what was really sent. Production never sets it; the default stands.
const API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

const { DEAL_STAGE_ID } = require('./stages');

const TASK_LABELS = {
  call: 'Дзвінок 📞',
  consultation: 'Консультація 💬',
  selection: 'Підбір 🔎',
  inspection: 'Огляд 🔍',
  registration: 'Оформлення 📝',
};

// Тип задачі словом, як у ранковому зведенні: службовий ключ («call») менеджер
// бачити не мав би, а значок у зведенні лише шум.
function taskWord(type) {
  return String(TASK_LABELS[type] || type || 'Дія').replace(/\s*\p{Extended_Pictographic}\uFE0F?/gu, '').trim();
}

async function sendTelegramMessage(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`${API}/bot${token}/sendMessage`, {
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
// Файл у чат: бекап бази йде саме так, бо іншого сховища в СРМ немає, а чат
// власника це місце, де файл точно не загубиться. multipart складає сам Node:
// FormData і Blob глобальні з Node 18, тому пакет для цього не потрібен.
async function sendTelegramDocument(token, chatId, filename, buffer, caption) {
  if (!token || !chatId || !buffer) return false;
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', String(caption).slice(0, 1000));
    form.append('document', new Blob([buffer], { type: 'application/gzip' }), filename);
    const r = await fetch(`${API}/bot${token}/sendDocument`, { method: 'POST', body: form });
    return r.ok;
  } catch {
    return false;
  }
}

async function sendTelegramKeyboard(token, chatId, text, rows) {
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`${API}/bot${token}/sendMessage`, {
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
    const r = await fetch(`${API}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || undefined, show_alert: !!showAlert }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// The command list the user sees in the chat's menu button. Only commands that
// actually do something are listed: an entry that answers "ще роблю" is worse
// than no entry.
const BOT_COMMANDS = [
  { command: 'start', description: 'Меню' },
  { command: 'obyekt', description: 'Додати обʼєкт' },
];

async function setMyCommands(token, commands = BOT_COMMANDS) {
  if (!token) return false;
  try {
    const r = await fetch(`${API}/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function setWebhook(token, url, secretToken) {
  if (!token || !url) return false;
  try {
    const r = await fetch(`${API}/bot${token}/setWebhook`, {
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
    await setMyCommands(s.token).catch(() => {});
  }
}

async function deleteWebhook(token) {
  if (!token) return false;
  try {
    const r = await fetch(`${API}/bot${token}/deleteWebhook`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    return !!j.ok;
  } catch {
    return false;
  }
}

async function getFilePath(token, fileId) {
  const r = await fetch(`${API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = await r.json();
  if (!j.ok) throw new Error('getFile failed: ' + JSON.stringify(j));
  return j.result.file_path;
}

async function downloadFileAsBase64(token, filePath) {
  const r = await fetch(`${API}/file/bot${token}/${filePath}`);
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
  if (!users.length) return { sent: 0 };
  const now = new Date();
  let sent = 0;

  for (const user of users) {
    const s = user.tg_settings || {};
    const advanceMin = parseInt(s.advance) || 60;

    const { rows: clientRows } = await pool.query(
      'SELECT data FROM clients WHERE manager_id = $1 AND archived_at IS NULL',
      [user.id]
    );

    for (const row of clientRows) {
      const c = row.data;
      if (c.stage === DEAL_STAGE_ID) continue; // deal already closed — nothing left to chase
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
          (t.note ? `📝 ${t.note}\n` : '') +
          `\n⏰ До початку: ~${Math.round(diffMin)} хв`;

        const ok = await sendTelegramMessage(s.token, s.chatId, msg);
        if (ok) {
          sent++;
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
        sent++;
        await pool.query(
          'INSERT INTO notified_tasks (user_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [user.id, notifyId]
        );
      }
    }
  }

  return { sent };
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
// At 8:30 Kyiv time, what today actually holds: overdue first, then today's
// calls and viewings, then requests from the site nobody has taken yet.
// Deduped the same way as the evening digest, with a key that cannot collide
// with a real task id.
async function checkAndSendMorningBrief(pool) {
  const { hh, mm } = kyivNowParts();
  if (hh !== '08' || mm !== '30') return { sent: 0, skipped: 0 };

  const today = kyivTodayISO();
  const key = `morning-${today}`;
  // Same term the nudge and the bot's lists use, so the manager never sees two
  // different numbers for the same thing.
  const { days: staleDays } = await automations.getConfig(pool, 'stale-nudge');

  const { rows: users } = await pool.query(
    `SELECT id, tg_settings FROM users
     WHERE active = true AND tg_settings->>'enabled' = 'true'
       AND coalesce(tg_settings->>'token', '') != '' AND coalesce(tg_settings->>'chatId', '') != ''`
  );
  if (!users.length) return { sent: 0, skipped: 0 };
  let sent = 0, skipped = 0;

  const { rows: freeLeads } = await pool.query(
    'SELECT count(*)::int n FROM site_leads WHERE taken_by IS NULL'
  );

  for (const user of users) {
    const s = user.tg_settings || {};

    const { rows: seen } = await pool.query(
      'SELECT 1 FROM notified_tasks WHERE user_id = $1 AND task_id = $2', [user.id, key]
    );
    if (seen.length) { skipped++; continue; }

    const { rows: clients } = await pool.query(
      'SELECT id, data FROM clients WHERE manager_id = $1 AND archived_at IS NULL', [user.id]
    );

    const due = [];
    const late = [];
    for (const row of clients) {
      const c = row.data || {};
      for (const task of c.tasks || []) {
        if (task.done || !task.date) continue;
        const who = c.name || c.phone || 'Клієнт';
        const what = `${taskWord(task.type)}: ${who}${task.time ? ', ' + task.time : ''}`;
        if (task.date < today) late.push(what);
        else if (task.date === today) due.push(what);
      }
    }

    const { rows: stale } = await pool.query(
      `SELECT count(*)::int n FROM catalog_items
       WHERE created_by = $1 AND archived_at IS NULL
         AND coalesce(data->>'status', 'available') = 'available'
         AND updated_at < now() - ($2 || ' days')::interval`,
      [user.id, String(staleDays)]
    );

    const mark = () => pool.query(
      'INSERT INTO notified_tasks (user_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [user.id, key]
    );

    if (!due.length && !late.length && !freeLeads[0].n && !stale[0].n) {
      await mark();
      continue;
    }

    const lines = ['<b>Ранок, 8:30</b>'];
    if (late.length) {
      lines.push('', `<b>Прострочено ${late.length}</b>`);
      for (const x of late.slice(0, 5)) lines.push(x);
    }
    if (due.length) {
      lines.push('', '<b>Сьогодні</b>');
      for (const x of due.slice(0, 8)) lines.push(x);
    }
    if (freeLeads[0].n) lines.push('', `Нічиїх заявок із сайту: ${freeLeads[0].n}`);
    if (stale[0].n) lines.push(`Обʼєкти без руху понад ${staleDays} днів: ${stale[0].n}`);

    const rows = [[{ text: 'Мої клієнти', callback_data: 'p:c' }]];
    if (stale[0].n) rows.push([{ text: 'Показати обʼєкти', callback_data: 'p:o' }]);
    rows.push([{ text: 'Приховати до завтра', callback_data: 'p:close' }]);

    const ok = await sendTelegramKeyboard(s.token, s.chatId, lines.join('\n'), rows);
    if (ok) { sent++; await mark(); }
  }

  return { sent, skipped };
}

async function checkAndSendDailyDigest(pool) {
  const { hh, mm } = kyivNowParts();
  if (hh !== '21' || mm !== '00') return { sent: 0, skipped: 0 };

  const tomorrowISO = addDaysISO(kyivTodayISO(), 1);
  const digestKey = `digest-${tomorrowISO}`;

  const { rows: users } = await pool.query(
    `SELECT id, tg_settings FROM users
     WHERE active = true AND tg_settings->>'enabled' = 'true'
       AND coalesce(tg_settings->>'token', '') != '' AND coalesce(tg_settings->>'chatId', '') != ''`
  );
  if (!users.length) return { sent: 0, skipped: 0 };
  let sent = 0, skipped = 0;

  for (const user of users) {
    const s = user.tg_settings || {};

    const { rows: existing } = await pool.query(
      'SELECT 1 FROM notified_tasks WHERE user_id = $1 AND task_id = $2',
      [user.id, digestKey]
    );
    if (existing.length) { skipped++; continue; }

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
    if (await sendTelegramMessage(s.token, s.chatId, msg)) sent++;
  }

  return { sent, skipped };
}

// Once a day at 10:00 Kyiv time, sends each manager a numbered list of their
// 3 nearest client tasks (by date+time, overdue ones included first since
// they're the most urgent) — separate from checkAndSendDailyDigest, which
// only covers the personal to-do list. Same notified_tasks dedup pattern,
// its own key shape so it can never collide with the to-do digest or a real
// task id.
async function checkAndSendClientTaskDigest(pool) {
  const { hh, mm } = kyivNowParts();
  if (hh !== '10' || mm !== '00') return;

  const digestKey = `client-digest-${kyivTodayISO()}`;

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

    await pool.query(
      'INSERT INTO notified_tasks (user_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [user.id, digestKey]
    );

    const { rows: clientRows } = await pool.query(
      'SELECT data FROM clients WHERE manager_id = $1 AND archived_at IS NULL',
      [user.id]
    );

    const upcoming = [];
    for (const row of clientRows) {
      const c = row.data;
      if (c.stage === DEAL_STAGE_ID) continue; // deal already closed — nothing left to chase
      for (const t of (c.tasks || [])) {
        if (t.done || !t.date) continue;
        upcoming.push({ clientName: c.name, type: t.type, date: t.date, time: t.time || '' });
      }
    }
    if (!upcoming.length) continue;

    upcoming.sort((a, b) => (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00')));
    const nearest = upcoming.slice(0, 3);

    const lines = nearest.map((t, i) => {
      const label = TASK_LABELS[t.type] || t.type;
      return `${i + 1}. ${t.clientName} — ${label}${t.time ? ' о ' + t.time : ''} (${t.date})`;
    });
    const msg = `🔔 <b>Найближчі завдання клієнтів</b>\n\n${lines.join('\n')}`;
    await sendTelegramMessage(s.token, s.chatId, msg);
  }
}

module.exports = {
  sendTelegramDocument,
  sendTelegramMessage,
  sendTelegramKeyboard,
  answerCallbackQuery,
  checkAndNotifyAll,
  checkAndSendDailyDigest,
  checkAndSendClientTaskDigest,
  setWebhook,
  deleteWebhook,
  reRegisterAllWebhooks,
  getFilePath,
  downloadFileAsBase64,
  TASK_LABELS,
  taskWord,
  addDaysISO,
  kyivTodayISO,
  kyivNowParts,
  setMyCommands,
  BOT_COMMANDS,
  checkAndSendMorningBrief,
};
