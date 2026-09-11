const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, text, due_date, due_time, done, created_at, completed_at
     FROM personal_tasks WHERE user_id = $1
     ORDER BY done ASC, (due_date IS NULL), due_date ASC, due_time ASC, created_at ASC`,
    [req.user.id]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { text, dueDate, dueTime } = req.body || {};
  const clean = (text || '').trim();
  if (!clean) return res.status(400).json({ error: 'Текст завдання не може бути порожнім' });

  const { rows } = await pool.query(
    `INSERT INTO personal_tasks (user_id, text, due_date, due_time)
     VALUES ($1, $2, $3, $4)
     RETURNING id, text, due_date, due_time, done, created_at, completed_at`,
    [req.user.id, clean.slice(0, 500), (dueDate || '').trim() || null, (dueTime || '').trim() || null]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { done, text, dueDate, dueTime } = req.body || {};

  if (typeof done === 'boolean') {
    await pool.query(
      'UPDATE personal_tasks SET done = $1, completed_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2 AND user_id = $3',
      [done, id, req.user.id]
    );
  }
  if (typeof text === 'string' || typeof dueDate === 'string' || typeof dueTime === 'string') {
    const fields = [];
    const vals = [];
    let i = 1;
    if (typeof text === 'string') { fields.push(`text = $${i++}`); vals.push(text.trim().slice(0, 500)); }
    if (typeof dueDate === 'string') { fields.push(`due_date = $${i++}`); vals.push(dueDate.trim() || null); }
    if (typeof dueTime === 'string') { fields.push(`due_time = $${i++}`); vals.push(dueTime.trim() || null); }
    vals.push(id, req.user.id);
    await pool.query(
      `UPDATE personal_tasks SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = $${i}`,
      vals
    );
  }
  res.status(204).end();
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM personal_tasks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.status(204).end();
});

module.exports = router;
