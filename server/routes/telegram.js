const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { sendTelegramMessage, setWebhook, deleteWebhook } = require('../telegram');

const router = express.Router();

// Назовні не йде ні секрет webhook, ні сам токен бота: з токеном у браузері
// будь-який XSS у СРМ стає повним доступом до чату агенції. Інтерфейсу
// достатньо знати, що токен збережений.
function stripSecret(settings) {
  const { webhookSecret, token, ...rest } = settings;
  return { ...rest, tokenSet: !!(token && String(token).trim()) };
}

router.get('/settings', async (req, res) => {
  const { rows } = await pool.query('SELECT tg_settings FROM users WHERE id = $1', [req.user.id]);
  res.json(stripSecret(rows[0]?.tg_settings || {}));
});

router.put('/settings', async (req, res) => {
  const { token, chatId, advance, enabled } = req.body || {};
  const { rows } = await pool.query('SELECT tg_settings FROM users WHERE id = $1', [req.user.id]);
  const prev = rows[0]?.tg_settings || {};

  // Порожнє поле означає «не міняти»: інтерфейс більше не отримує токен,
  // тому не може надіслати його назад при кожному збереженні.
  const nextToken = (token || '').trim() || (prev.token || '');
  const settings = {
    token: nextToken,
    chatId: (chatId || '').trim(),
    advance: advance || '60',
    enabled: !!enabled,
    webhookSecret: prev.webhookSecret || crypto.randomBytes(32).toString('hex'),
  };

  let webhookWarning = null;
  const tokenChanged = prev.token && prev.token !== nextToken;
  if (tokenChanged && prev.token) {
    await deleteWebhook(prev.token);
  }
  if (settings.enabled && settings.token && settings.chatId) {
    const base = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    if (!base) {
      webhookWarning = 'PUBLIC_BASE_URL не налаштований на сервері — прийом скріншотів у Telegram не працюватиме';
    } else {
      const url = `${base}/api/telegram-webhook/${req.user.id}`;
      const ok = await setWebhook(settings.token, url, settings.webhookSecret);
      if (!ok) webhookWarning = 'Не вдалося зареєструвати webhook у Telegram — перевірте токен бота';
    }
  } else if (prev.token && !tokenChanged) {
    await deleteWebhook(settings.token || prev.token);
  }

  await pool.query('UPDATE users SET tg_settings = $1 WHERE id = $2', [JSON.stringify(settings), req.user.id]);
  const response = stripSecret(settings);
  if (webhookWarning) response.webhookWarning = webhookWarning;
  res.json(response);
});

// Повідомлення в чат шле сервер: раніше це робив сам інтерфейс, і для цього
// йому віддавали токен бота.
router.post('/send', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Немає тексту' });
  const { rows } = await pool.query('SELECT tg_settings FROM users WHERE id = $1', [req.user.id]);
  const s = rows[0]?.tg_settings || {};
  if (!s.enabled || !s.token || !s.chatId) {
    return res.status(400).json({ ok: false, error: 'Telegram не налаштований' });
  }
  const ok = await sendTelegramMessage(s.token, s.chatId, text.slice(0, 4000));
  res.status(ok ? 200 : 502).json({ ok });
});

router.post('/test', async (req, res) => {
  const { rows } = await pool.query('SELECT tg_settings FROM users WHERE id = $1', [req.user.id]);
  const s = rows[0]?.tg_settings || {};
  if (!s.token || !s.chatId) {
    return res.status(400).json({ ok: false, error: 'Спочатку вкажіть токен і Chat ID' });
  }
  const ok = await sendTelegramMessage(
    s.token,
    s.chatId,
    '✅ <b>Urban Estate Group</b> — тест сповіщення!\n\nЦе повідомлення підтверджує, що зв\'язок з ботом налаштований правильно.'
  );
  res.json({ ok });
});

module.exports = router;
