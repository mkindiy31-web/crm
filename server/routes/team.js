const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Lightweight roster any authenticated user can read — used for "transfer to
// another manager" pickers. Deliberately separate from /api/admin/managers,
// which is admin-only and returns more detail.
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, display_name, role FROM users WHERE active = true AND id != $1 ORDER BY display_name ASC',
    [req.user.id]
  );
  res.json(rows);
});

module.exports = router;
