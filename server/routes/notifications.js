const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  const unacked = req.query.unacked === '1';
  const { rows } = await pool.query(
    `SELECT id, message, related_client_id, acked, created_at FROM notifications
     WHERE user_id = $1 ${unacked ? 'AND acked = false' : ''}
     ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
});

router.post('/:id/ack', async (req, res) => {
  await pool.query('UPDATE notifications SET acked = true WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  res.status(204).end();
});

module.exports = router;
