const express = require('express');
const { pool } = require('../db');
const { requireIntegrationKey } = require('../integrationAuth');
const { siteToCrm } = require('../fieldMap');
const { normalizePhone } = require('../phone');
const leads = require('../leads');

const router = express.Router();
router.use(requireIntegrationKey);

// Lets the other side prove the key and the route both work before it sends
// anything that writes.
router.get('/ping', (req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

// Records an event id and reports whether it is the first time we see it.
// The primary key does the work: a retry after a timeout hits the conflict and
// returns false, so the caller can repeat safely without doubling a listing.
async function claimEvent(eventId, source, kind) {
  const { rowCount } = await pool.query(
    `INSERT INTO integration_events (event_id, source, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, source, kind]
  );
  return rowCount === 1;
}

function priceNum(price) {
  const n = parseFloat(String(price ?? '').replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

// The site pushes a listing here whenever one is saved there. Idempotent twice
// over: the event id guards against a repeat of the same push, and the upsert
// guards against the same listing arriving from a different event.
// Автор запису на сайті («Спетрук Сергій», «Леся Рудик») -> менеджер СРМ, у
// якого логін це прізвище. Лише однозначний збіг: два кандидати чи жодного дає
// null, і обʼєкт лишається нічиїм, а не чужим.
async function managerByAuthor(name) {
  const words = String(name || '').toLowerCase().match(/[\p{L}ʼ'’-]+/gu) || [];
  if (!words.length) return null;
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE active = true AND lower(username) = ANY($1::text[])',
    [words]
  );
  return rows.length === 1 ? rows[0].id : null;
}

router.post('/catalog', async (req, res) => {
  const body = req.body || {};
  const eventId = String(body.event_id || '').trim();
  if (!eventId) return res.status(400).json({ error: 'Відсутній event_id' });

  const { item, errors } = siteToCrm(body.post_id, body.fields);
  if (errors.length) return res.status(400).json({ error: 'Не вистачає полів', fields: errors });

  const fresh = await claimEvent(eventId, 'site', 'catalog_upsert');
  if (!fresh) return res.json({ ok: true, duplicate: true, id: item.id });

  const data = { ...item, createdByName: 'Сайт', createdAt: new Date().toISOString() };
  // Обʼєкт сайту належить тому, хто на сайті його автор: інакше він нічий, і
  // менеджер не бачить свого обʼєкта в боті й не може змінити ціну.
  const owner = await managerByAuthor(body.fields && body.fields.author_name);
  const { rows } = await pool.query(
    `INSERT INTO catalog_items (id, created_by, data, price_num)
     VALUES ($1, $4, $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET data = catalog_items.data || $2::jsonb,
           price_num = $3,
           created_by = COALESCE(catalog_items.created_by, $4),
           updated_at = now()
     RETURNING (xmax = 0) AS created`,
    [item.id, data, priceNum(item.price), owner]
  );

  res.json({ ok: true, duplicate: false, created: rows[0].created, id: item.id });
});

// A request from the site's form. It lands belonging to nobody and goes out to
// every manager at once; the card appears when one of them takes it.
router.post('/lead', async (req, res) => {
  const body = req.body || {};
  const eventId = String(body.event_id || '').trim();
  if (!eventId) return res.status(400).json({ error: 'Відсутній event_id' });

  const f = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const phone = String(f.phone || '').trim();
  const name = String(f.name || '').trim();
  if (!phone && !name) {
    return res.status(400).json({ error: 'Не вистачає полів', fields: ['phone або name'] });
  }

  const fresh = await claimEvent(eventId, 'site', 'lead');
  if (!fresh) return res.json({ ok: true, duplicate: true });

  const id = eventId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || Date.now().toString(36);
  const data = {
    name, phone,
    contact: String(f.contact || '').trim(),
    message: String(f.message || '').trim(),
    source: String(f.source || '').trim(),
    propertyTitle: String(f.property_title || '').trim(),
    propertyId: f.property_id ? Number(f.property_id) : null,
    at: new Date().toISOString(),
  };

  const { rows } = await pool.query(
    `INSERT INTO site_leads (id, data, phone_norm) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [id, data, normalizePhone(phone)]
  );
  if (!rows.length) return res.json({ ok: true, duplicate: true, id });

  const out = await leads.broadcast(rows[0]);
  res.json({ ok: true, id, sent: out.sent, managers: out.managers, known: out.dupes });
});

module.exports = { router, claimEvent, managerByAuthor };
