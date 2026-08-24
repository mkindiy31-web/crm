const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Shared property catalog — every manager and admin sees AND can manage the
// same pool of listings (a real agency's shared inventory): any authenticated
// manager or admin may edit/delete any item, not just whoever added it.
// "responsible manager" (created_by) is kept purely as informational
// provenance, shown on the card, with no access-control effect.

function priceNum(price) {
  const n = parseFloat(String(price ?? '').replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

function toItem(row) {
  return {
    ...row.data,
    createdById: row.created_by,
    createdByName: row.created_by_name || row.data.createdByName || '',
    createdByPhone: row.created_by_phone || '',
  };
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.data, c.created_by, u.display_name AS created_by_name, u.phone AS created_by_phone
     FROM catalog_items c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.archived_at IS NULL
     ORDER BY c.created_at DESC`
  );
  res.json(rows.map(toItem));
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.data, c.created_by, u.display_name AS created_by_name, u.phone AS created_by_phone
     FROM catalog_items c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.id = $1 AND c.archived_at IS NULL`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Об'єкт не знайдено" });
  res.json(toItem(rows[0]));
});

router.post('/', async (req, res) => {
  const item = req.body || {};
  if (!item.id) return res.status(400).json({ error: 'Відсутній id' });
  if (!item.title && !item.address) return res.status(400).json({ error: "Вкажіть назву або адресу об'єкта" });

  const data = { ...item, createdByName: req.user.displayName, createdAt: item.createdAt || new Date().toISOString() };
  await pool.query(
    `INSERT INTO catalog_items (id, created_by, data, price_num) VALUES ($1, $2, $3, $4)`,
    [item.id, req.user.id, data, priceNum(item.price)]
  );
  res.status(201).json({ ...data, createdById: req.user.id });
});

router.put('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT data, created_by FROM catalog_items WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Об'єкт не знайдено" });

  const item = req.body || {};
  const data = { ...item, id: req.params.id, createdByName: rows[0].data.createdByName };
  await pool.query(
    `UPDATE catalog_items SET data = $1, price_num = $2, updated_at = now() WHERE id = $3`,
    [data, priceNum(item.price), req.params.id]
  );
  res.json({ ...data, createdById: rows[0].created_by });
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM catalog_items WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

module.exports = router;
