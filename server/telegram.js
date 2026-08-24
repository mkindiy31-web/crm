const TASK_LABELS = {
  call: 'Дзвінок 📞',
  consultation: 'Консультація 💬',
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

async function setWebhook(token, url, secretToken) {
  if (!token || !url) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ['message'] }),
    });
    const j = await r.json().catch(() => ({}));
    return !!j.ok;
  } catch {
    return false;
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
          `🔔 <b>KVADRAT CRM — Нагадування</b>\n\n` +
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
  }
}

module.exports = {
  sendTelegramMessage,
  checkAndNotifyAll,
  setWebhook,
  deleteWebhook,
  getFilePath,
  downloadFileAsBase64,
  TASK_LABELS,
};
