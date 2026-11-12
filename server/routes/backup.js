const express = require('express');
const { pool } = require('../db');
const dbBackup = require('../dbBackup');

// Обидва маршрути вже стоять за auth.requireAuth і auth.requireAdmin у index.js:
// дамп містить телефони клієнтів, хеші паролів і токен бота, тому менеджеру він
// не віддається навіть як число рядків.
const router = express.Router();

// Скільки чого в базі, без самого вмісту: цим живе рядок «останній бекап» у
// панелі, і цим можна переконатись, що бекап не порожній, нічого не завантажуючи.
// Express 4 не ловить відмову async-обробника: без try/catch одна нова таблиця
// поза списком бекапу клала б увесь сервер, а не лише цей маршрут.
router.get('/info', async (req, res) => {
  try {
    const pack = await dbBackup.packed(pool);
    res.json({ name: pack.name, bytes: pack.buf.length, rows: pack.rows, tables: pack.counts });
  } catch (err) {
    console.error('Backup info failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const pack = await dbBackup.packed(pool);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${pack.name}"`);
    res.setHeader('Content-Length', String(pack.buf.length));
    res.send(pack.buf);
  } catch (err) {
    console.error('Backup download failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
