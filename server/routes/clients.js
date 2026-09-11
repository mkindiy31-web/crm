const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { upsertClientAndNotify } = require('../clientOps');
const { normalizePhone } = require('../phone');

const router = express.Router();

function historyEntry(text) {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    type: 'manager_change',
    text,
    result: '',
    date: now.toLocaleDateString('uk-UA'),
    time: now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
  };
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT data FROM clients WHERE manager_id = $1 AND archived_at IS NULL ORDER BY updated_at DESC',
    [req.user.id]
  );
  res.json(rows.map(r => r.data));
});

router.get('/archive', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT data, archived_at, archive_reason FROM clients
     WHERE manager_id = $1 AND archived_at IS NOT NULL ORDER BY archived_at DESC`,
    [req.user.id]
  );
  res.json(rows.map(r => ({
    ...r.data,
    archivedAt: r.archived_at,
    archiveReason: r.archive_reason,
  })));
});

router.delete('/archive', async (req, res) => {
  await pool.query('DELETE FROM clients WHERE manager_id = $1 AND archived_at IS NOT NULL', [req.user.id]);
  res.status(204).end();
});

router.put('/', async (req, res) => {
  const clients = Array.isArray(req.body?.clients) ? req.body.clients : [];
  const client = await pool.connect();
  const duplicates = [];
  const blocked = [];

  try {
    await client.query('BEGIN');

    for (const c of clients) {
      if (!c || !c.id) continue;
      const result = await upsertClientAndNotify(client, req.user, c);
      if (result.blocked) {
        blocked.push({ clientId: c.id, clientName: result.clientName, otherManagerName: result.otherManagerName });
      } else {
        duplicates.push(...result.duplicates);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json({ ok: true, duplicates, blocked });
});

router.post('/:id/archive', async (req, res) => {
  const { reason } = req.body || {};
  await pool.query(
    'UPDATE clients SET archived_at = now(), archive_reason = $1 WHERE id = $2 AND manager_id = $3',
    [reason || 'Не вказано', req.params.id, req.user.id]
  );
  res.status(204).end();
});

router.post('/:id/restore', async (req, res) => {
  await pool.query(
    'UPDATE clients SET archived_at = NULL, archive_reason = NULL WHERE id = $1 AND manager_id = $2',
    [req.params.id, req.user.id]
  );
  res.status(204).end();
});

router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id = $1 AND manager_id = $2', [req.params.id, req.user.id]);
  res.status(204).end();
});

// Transfer a client to another manager. A manager can only transfer their
// own clients; an admin can transfer anyone's.
router.post('/:id/transfer', async (req, res) => {
  const targetId = parseInt(req.body?.toManagerId, 10);
  if (!targetId) return res.status(400).json({ error: 'Вкажіть менеджера' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'Клієнт уже у вас' });

  // Purely informational — a note about an agreed referral %, shown in the
  // client's history/card. Never factored into calcCommission or any other
  // calculation, just recorded as text so managers remember the arrangement.
  let splitPercent = null;
  if (req.body?.splitPercent !== undefined && req.body?.splitPercent !== null && req.body?.splitPercent !== '') {
    const n = parseFloat(req.body.splitPercent);
    if (!Number.isNaN(n) && n > 0 && n <= 100) splitPercent = n;
  }

  const { rows: targetRows } = await pool.query(
    'SELECT id, display_name FROM users WHERE id = $1 AND active = true',
    [targetId]
  );
  if (!targetRows.length) return res.status(404).json({ error: 'Менеджера не знайдено' });

  const isAdmin = req.user.role === 'admin';
  const whereClause = isAdmin ? 'id = $1' : 'id = $1 AND manager_id = $2';
  const params = isAdmin ? [req.params.id] : [req.params.id, req.user.id];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(`SELECT * FROM clients WHERE ${whereClause}`, params);
    if (!existingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Клієнта не знайдено' });
    }
    const row = existingRows[0];

    const { rows: conflictRows } = await client.query(
      'SELECT 1 FROM clients WHERE id = $1 AND manager_id = $2',
      [row.id, targetId]
    );
    if (conflictRows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'У цього менеджера вже є клієнт з таким id' });
    }

    // A phone can only belong to one manager at a time (same rule as new-client
    // creation) — block the transfer if the target manager already has this
    // person as an active client, instead of silently creating a duplicate.
    const phones = [row.phone_norm, row.phone2_norm].filter(Boolean);
    if (phones.length) {
      const { rows: dupRows } = await client.query(
        `SELECT data->>'name' AS name FROM clients
         WHERE manager_id = $1 AND archived_at IS NULL
           AND (phone_norm = ANY($2::text[]) OR phone2_norm = ANY($2::text[]))`,
        [targetId, phones]
      );
      if (dupRows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `У менеджера "${targetRows[0].display_name}" вже є клієнт з таким номером телефону ("${dupRows[0].name}") — передача заблокована, щоб не створювати дубль`,
        });
      }
    }

    const transferNote = `🔀 Клієнта передано: ${req.user.displayName} → ${targetRows[0].display_name}` +
      (splitPercent ? ` (умова: ${splitPercent}% лишається за ${req.user.displayName})` : '');

    const updatedData = {
      ...row.data,
      stage: 0,
      transferredFrom: req.user.displayName,
      transferredAt: new Date().toISOString(),
      isNewTransfer: true,
      responsibleManagerName: targetRows[0].display_name,
      transferSplitNote: splitPercent ? `${splitPercent}% лишається за ${req.user.displayName}` : null,
      history: [historyEntry(transferNote), ...(row.data.history || [])],
    };

    await client.query(
      'UPDATE clients SET manager_id = $1, data = $2, updated_at = now() WHERE id = $3 AND manager_id = $4',
      [targetId, updatedData, row.id, row.manager_id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, toManagerName: targetRows[0].display_name });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
