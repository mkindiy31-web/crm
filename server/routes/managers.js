const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { sendTelegramMessage } = require('../telegram');
const { advanceSourceFixQueue } = require('./telegramWebhook');
const { DEAL_STAGE_ID } = require('../stages');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, role, display_name, phone, active, created_at FROM users ORDER BY created_at ASC'
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { username, password, displayName, phone, role } = req.body || {};
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: "Вкажіть логін, пароль і ім'я" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль має бути не менше 6 символів' });
  }
  const finalRole = role === 'admin' ? 'admin' : 'manager';

  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, role, display_name, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, role, display_name, phone, active, created_at`,
      [username, hash, finalRole, displayName, (phone || '').trim() || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такий логін вже існує' });
    throw err;
  }
});

router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { active, phone, newPassword, role } = req.body || {};

  // Deactivating is manager-only and never allowed on your own account (self-lockout).
  if (typeof active === 'boolean') {
    if (id === req.user.id) return res.status(400).json({ error: 'Не можна змінити власний акаунт тут' });
    await pool.query("UPDATE users SET active = $1 WHERE id = $2 AND role = 'manager'", [active, id]);
  }
  // Phone is contact info shown on public catalog pages — admin can set their own
  // or any manager's, since it's harmless self-service info, not an access toggle.
  if (typeof phone === 'string') {
    if (id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Немає доступу' });
    await pool.query('UPDATE users SET phone = $1 WHERE id = $2', [phone.trim() || null, id]);
  }
  // Password reset — this whole route is already admin-only (mounted behind
  // auth.requireAdmin), and passwords are one-way hashed, so a reset is the
  // only recovery path when a manager forgets/loses theirs.
  if (typeof newPassword === 'string') {
    if (newPassword.length < 6) return res.status(400).json({ error: 'Пароль має бути не менше 6 символів' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
  }
  // Promote/demote between manager and admin — never on your own account,
  // so an admin can't accidentally lock themselves out.
  if (typeof role === 'string') {
    if (role !== 'admin' && role !== 'manager') return res.status(400).json({ error: 'Роль має бути admin або manager' });
    if (id === req.user.id) return res.status(400).json({ error: 'Не можна змінити власну роль' });
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  }
  if (typeof active !== 'boolean' && typeof phone !== 'string' && typeof newPassword !== 'string' && typeof role !== 'string') {
    return res.status(400).json({ error: 'Очікується поле active, phone, newPassword або role' });
  }
  res.status(204).end();
});

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'Не можна видалити власний акаунт' });

  await pool.query("DELETE FROM users WHERE id = $1 AND role = 'manager'", [id]);
  res.status(204).end();
});

// Read-only view of another manager's live pipeline, for the admin "watch in
// real time" dashboard. No write access — separate from the normal /api/clients
// and /api/owners routes, which are always scoped to req.user.id only.
router.get('/:id/clients', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query(
    'SELECT data FROM clients WHERE manager_id = $1 AND archived_at IS NULL ORDER BY updated_at DESC',
    [id]
  );
  res.json(rows.map(r => r.data));
});

router.get('/:id/owners', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query(
    'SELECT data FROM owners WHERE manager_id = $1 ORDER BY updated_at DESC',
    [id]
  );
  res.json(rows.map(r => r.data));
});

// Moves every property-owner record currently under the CALLING admin's own
// account to the target manager — for cleaning up owners added by mistake
// while logged in as admin (the "Власники квартир" section is scoped to
// req.user.id same as for any manager, so admin-added owners land on the
// admin's own account unless moved here).
router.post('/:id/claim-owners', async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!targetId) return res.status(400).json({ error: 'Вкажіть менеджера' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'Це і так ваш акаунт' });

  const { rows: targetRows } = await pool.query(
    'SELECT id, display_name FROM users WHERE id = $1 AND active = true',
    [targetId]
  );
  if (!targetRows.length) return res.status(404).json({ error: 'Менеджера не знайдено' });

  try {
    const { rowCount } = await pool.query(
      'UPDATE owners SET manager_id = $1, updated_at = now() WHERE manager_id = $2',
      [targetId, req.user.id]
    );
    res.json({ ok: true, moved: rowCount, toManagerName: targetRows[0].display_name });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'У менеджера вже є власник з таким самим id — передача перервана' });
    }
    throw err;
  }
});

// Read-only snapshot of who still hasn't fixed their "Звідки дізнався" —
// same filter as notify-missing-source below, but just reports, never
// queues or sends anything. Safe to call as often as you like.
router.get('/missing-source-report', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.data, u.display_name
     FROM clients c
     JOIN users u ON u.id = c.manager_id AND u.active = true
     WHERE c.archived_at IS NULL
       AND coalesce(c.data->>'cold', 'false') != 'true'
       AND coalesce(c.data->>'source', '') = ''
       AND coalesce((c.data->>'stage')::int, -1) IS DISTINCT FROM $1
     ORDER BY u.display_name`,
    [DEAL_STAGE_ID]
  );

  const byManager = new Map();
  for (const row of rows) {
    if (!byManager.has(row.display_name)) byManager.set(row.display_name, []);
    byManager.get(row.display_name).push(row.data?.name || 'Без імені');
  }
  const report = [...byManager.entries()].map(([manager, names]) => ({ manager, count: names.length, names }));

  res.json({ total: rows.length, report });
});

// Finds every active, non-cold client across all managers with no "source"
// ("Звідки дізнався") set, queues each one in pending_source_fixes, and kicks
// off the same button-based fix-it flow used for new-client intake — one
// client at a time per manager, with hourly reminders (see
// checkAndRemindSourceFixes) until each is answered. Best-effort per
// manager — a manager without Telegram configured is just skipped, never
// blocks the others.
router.post('/notify-missing-source', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id AS client_id, c.manager_id, c.data, u.tg_settings, u.display_name
     FROM clients c
     JOIN users u ON u.id = c.manager_id AND u.active = true
     WHERE c.archived_at IS NULL
       AND coalesce(c.data->>'cold', 'false') != 'true'
       AND coalesce(c.data->>'source', '') = ''
       AND coalesce((c.data->>'stage')::int, -1) IS DISTINCT FROM $1
       AND NOT EXISTS (
         SELECT 1 FROM pending_source_fixes psf
         WHERE psf.user_id = c.manager_id AND psf.client_id = c.id
       )`,
    [DEAL_STAGE_ID]
  );

  const byManager = new Map();
  for (const row of rows) {
    if (!byManager.has(row.manager_id)) {
      byManager.set(row.manager_id, { tgSettings: row.tg_settings, displayName: row.display_name, clients: [] });
    }
    byManager.get(row.manager_id).clients.push({ id: row.client_id, name: row.data?.name || 'Без імені' });
  }

  let notified = 0;
  let skippedNoTelegram = 0;
  for (const [managerId, info] of byManager) {
    const s = info.tgSettings || {};
    if (!s.enabled || !s.token || !s.chatId) { skippedNoTelegram++; continue; }

    for (const c of info.clients) {
      await pool.query(
        'INSERT INTO pending_source_fixes (user_id, client_id, client_name) VALUES ($1, $2, $3)',
        [managerId, c.id, c.name]
      );
    }
    await sendTelegramMessage(s.token, s.chatId,
      `⚠️ <b>Заповніть джерело клієнтів</b>\n\nУ вас ${info.clients.length} клієнт${info.clients.length === 1 ? '' : (info.clients.length < 5 ? 'и' : 'ів')} без вказаного "Звідки дізнався". Зараз запитаю по черзі — просто натискайте кнопку.`);
    await advanceSourceFixQueue(managerId);
    notified++;
  }

  res.json({
    ok: true,
    totalClientsMissing: rows.length,
    managersWithGaps: byManager.size,
    notified,
    skippedNoTelegram,
  });
});

// Finds every active, non-cold, non-closed-deal client across all managers
// with no pending task (same definition as the "⚠️ Без задач" badges
// elsewhere: no tasks array, or every task in it already done), and pings
// each affected manager on Telegram with their own list. A plain text nudge
// rather than an interactive flow — unlike a single source value, a task
// needs a type/date/time, which doesn't fit a one-tap button.
router.post('/notify-missing-tasks', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.data, c.manager_id, u.tg_settings, u.display_name
     FROM clients c
     JOIN users u ON u.id = c.manager_id AND u.active = true
     WHERE c.archived_at IS NULL
       AND coalesce(c.data->>'cold', 'false') != 'true'
       AND coalesce((c.data->>'stage')::int, -1) IS DISTINCT FROM $1
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(c.data->'tasks', '[]'::jsonb)) t
         WHERE t->>'done' = 'false'
       )`,
    [DEAL_STAGE_ID]
  );

  const byManager = new Map();
  for (const row of rows) {
    if (!byManager.has(row.manager_id)) {
      byManager.set(row.manager_id, { tgSettings: row.tg_settings, displayName: row.display_name, names: [] });
    }
    byManager.get(row.manager_id).names.push(row.data?.name || 'Без імені');
  }

  let notified = 0;
  let skippedNoTelegram = 0;
  for (const info of byManager.values()) {
    const s = info.tgSettings || {};
    if (!s.enabled || !s.token || !s.chatId) { skippedNoTelegram++; continue; }
    const shown = info.names.slice(0, 20);
    const list = shown.map((n, i) => `${i + 1}. ${n}`).join('\n');
    const more = info.names.length > shown.length ? `\n...і ще ${info.names.length - shown.length}` : '';
    const msg =
      `⚠️ <b>Поставте завдання клієнтам</b>\n\n` +
      `У вас ${info.names.length} клієнт${info.names.length === 1 ? '' : (info.names.length < 5 ? 'и' : 'ів')} без жодного активного завдання:\n${list}${more}\n\n` +
      `📍 Відкрийте картку кожного і заплануйте наступний крок (дзвінок, огляд тощо).`;
    const ok = await sendTelegramMessage(s.token, s.chatId, msg);
    if (ok) notified++;
  }

  res.json({
    ok: true,
    totalClientsMissing: rows.length,
    managersWithGaps: byManager.size,
    notified,
    skippedNoTelegram,
  });
});

module.exports = router;
