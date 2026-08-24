const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, role, display_name, phone, active, created_at FROM users ORDER BY created_at ASC'
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { username, password, displayName, phone } = req.body || {};
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: "Вкажіть логін, пароль і ім'я" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль має бути не менше 6 символів' });
  }

  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, role, display_name, phone)
       VALUES ($1, $2, 'manager', $3, $4)
       RETURNING id, username, role, display_name, phone, active, created_at`,
      [username, hash, displayName, (phone || '').trim() || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такий логін вже існує' });
    throw err;
  }
});

router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { active, phone } = req.body || {};

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
  if (typeof active !== 'boolean' && typeof phone !== 'string') {
    return res.status(400).json({ error: 'Очікується поле active або phone' });
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

module.exports = router;
