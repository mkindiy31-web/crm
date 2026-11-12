// Admin screen for the timers: what runs, what is switched off, what it did
// last time. Managers have no business here, so the whole router sits behind
// requireAdmin in index.js.
const express = require('express');
const { pool } = require('../db');
const auto = require('../automations');

const router = express.Router();

router.get('/', async (req, res) => {
  res.json(await auto.list(pool));
});

router.put('/:key', async (req, res) => {
  const { key } = req.params;
  if (!auto.known(key)) return res.status(404).json({ error: 'Невідома автоматизація' });

  const { enabled, params } = req.body || {};
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Вимикач приймає лише true або false' });
  }

  const result = await auto.setState(pool, key, { enabled, params }, req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.get('/:key/log', async (req, res) => {
  const { key } = req.params;
  if (!auto.known(key)) return res.status(404).json({ error: 'Невідома автоматизація' });
  res.json(await auto.history(pool, key, req.query.limit));
});

module.exports = router;
