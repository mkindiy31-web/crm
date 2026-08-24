const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Введіть логін і пароль' });

  const { rows } = await pool.query(
    'SELECT id, username, password_hash, role, display_name, active FROM users WHERE username = $1',
    [username]
  );
  const user = rows[0];
  if (!user || !user.active) return res.status(401).json({ error: 'Невірний логін або пароль' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Невірний логін або пароль' });

  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username, role: user.role, displayName: user.display_name });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Не авторизовано' });
  const { rows } = await pool.query(
    'SELECT id, username, role, display_name, active FROM users WHERE id = $1',
    [req.session.userId]
  );
  const user = rows[0];
  if (!user || !user.active) return res.status(401).json({ error: 'Не авторизовано' });
  res.json({ id: user.id, username: user.username, role: user.role, displayName: user.display_name });
});

async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Не авторизовано' });
  const { rows } = await pool.query(
    'SELECT id, username, role, display_name, active FROM users WHERE id = $1',
    [req.session.userId]
  );
  const user = rows[0];
  if (!user || !user.active) return res.status(401).json({ error: 'Не авторизовано' });
  req.user = { id: user.id, username: user.username, role: user.role, displayName: user.display_name };
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Доступ заборонено' });
  next();
}

module.exports = { router, requireAuth, requireAdmin };
