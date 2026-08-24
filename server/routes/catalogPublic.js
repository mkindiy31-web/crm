const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Public, unauthenticated — backs the shareable /o/:id page that anyone can be
// sent a link to. Deliberately whitelists fields rather than spreading `data`:
// the property owner's (seller's) name/phone must NEVER leak here — buyers are
// meant to go through the responsible manager, not contact the seller directly.
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.data, u.display_name AS manager_name, u.phone AS manager_phone
     FROM catalog_items c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.id = $1 AND c.archived_at IS NULL`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Об'єкт не знайдено" });

  const d = rows[0].data || {};
  res.json({
    id: req.params.id,
    title: d.title || '',
    propType: d.propType || '',
    rooms: d.rooms || '',
    area: d.area || '',
    floor: d.floor || '',
    totalFloors: d.totalFloors || '',
    price: d.price || '',
    status: d.status || 'available',
    district: d.district || '',
    address: d.address || '',
    description: d.description || '',
    photos: Array.isArray(d.photos) ? d.photos : [],
    managerName: rows[0].manager_name || '',
    managerPhone: rows[0].manager_phone || '',
  });
});

module.exports = router;
