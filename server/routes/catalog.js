const express = require('express');
const { pool } = require('../db');
const siteSync = require('../siteSync');
const automations = require('../automations');

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

// Скільки днів вільний обʼєкт без руху, якщо не менше строку автоматики
// «Обʼєкт без руху»; 0, коли рухався недавно, не «Вільно» чи автоматику вимкнено.
// Рухом рахується будь-яке збереження: воно оновлює updated_at.
function staleDaysOf(row, term) {
  if (!term || !row.updated_at) return 0;
  if (((row.data || {}).status || 'available') !== 'available') return 0;
  const days = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86400000);
  return days >= term ? days : 0;
}

async function staleTerm() {
  try {
    if (!(await automations.isEnabled(pool, 'stale-nudge'))) return 0;
    const cfg = await automations.getConfig(pool, 'stale-nudge');
    return parseInt(cfg.days, 10) > 0 ? parseInt(cfg.days, 10) : 0;
  } catch { return 0; }
}

function toItem(row, term = 0) {
  return {
    ...row.data,
    staleDays: staleDaysOf(row, term),
    // Куди веде «Відкрити на сайті»; порожньо, поки обʼєкт не на сайті чи не «Вільно».
    siteLink: siteSync.siteLinkOf(row.data.id, row.data),
    createdById: row.created_by,
    createdByName: row.created_by_name || row.data.createdByName || '',
    createdByPhone: row.created_by_phone || '',
  };
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.data, c.created_by, c.updated_at, u.display_name AS created_by_name, u.phone AS created_by_phone
     FROM catalog_items c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.archived_at IS NULL
     ORDER BY c.created_at DESC`
  );
  const term = await staleTerm();
  res.json(rows.map(r => toItem(r, term)));
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
  // The site is told after the answer goes out: a slow or sleeping site must
  // never hold up the save the manager just made.
  siteSync.pushListing(item.id, data).catch(err => console.error('siteSync push failed:', err));
});

router.put('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT data, created_by FROM catalog_items WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Об'єкт не знайдено" });

  const item = { ...(req.body || {}) };
  delete item.siteLink;
  delete item.staleDays; // рахується з updated_at при видачі, у даних не живе
  // Форма шле лише свої поля. Решта (номер і адреса на сайті, вкладення фото,
  // стан і призначення з бота) лишається: без неї зміна в срм створювала на
  // сайті новий запис замість оновити наявний.
  const data = { ...rows[0].data, ...item, id: req.params.id, createdByName: rows[0].data.createdByName };
  await pool.query(
    `UPDATE catalog_items SET data = $1, price_num = $2, updated_at = now() WHERE id = $3`,
    [data, priceNum(item.price), req.params.id]
  );
  res.json({ ...data, createdById: rows[0].created_by });
  siteSync.pushListing(req.params.id, data).catch(err => console.error('siteSync push failed:', err));
});

router.delete('/:id', async (req, res) => {
  const { rows } = await pool.query('DELETE FROM catalog_items WHERE id = $1 RETURNING data', [req.params.id]);
  res.status(204).end();
  // Видалений у срм обʼєкт не лишається на вітрині сайту (16.11.2026).
  if (rows.length) siteSync.withdrawListing(req.params.id, rows[0].data).catch(err => console.error('siteSync withdraw failed:', err));
});

module.exports = router;
module.exports.staleDaysOf = staleDaysOf;
module.exports.staleTerm = staleTerm;
