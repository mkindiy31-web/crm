const express = require('express');
const { pool } = require('../db');
const { normalizePhone } = require('../phone');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT data FROM owners WHERE manager_id = $1 ORDER BY updated_at DESC',
    [req.user.id]
  );
  res.json(rows.map(r => r.data));
});

router.put('/', async (req, res) => {
  const owners = Array.isArray(req.body?.owners) ? req.body.owners : [];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM owners WHERE manager_id = $1', [req.user.id]);

    for (const o of owners) {
      if (!o || !o.id) continue;
      const phoneNorm = normalizePhone(o.phone);
      await client.query(
        'INSERT INTO owners (id, manager_id, data, phone_norm) VALUES ($1, $2, $3, $4)',
        [o.id, req.user.id, o, phoneNorm]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json({ ok: true });
});

module.exports = router;
