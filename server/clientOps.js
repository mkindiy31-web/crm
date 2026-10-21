const { normalizePhone } = require('./phone');
const { sendTelegramMessage } = require('./telegram');

// Pings both sides by Telegram the first time a phone turns out to be shared
// between two managers — the in-app toast/notification is easy to miss if the
// manager isn't staring at the CRM tab right then. Best-effort: a manager
// without Telegram configured (or a delivery failure) never blocks the save.
async function notifyCrossManagerDuplicate(pgClient, user, c, owner) {
  try {
    const { rows } = await pgClient.query(
      'SELECT id, tg_settings FROM users WHERE id = ANY($1::int[])',
      [[user.id, owner.manager_id]]
    );
    const settingsById = new Map(rows.map(r => [r.id, r.tg_settings || {}]));
    const phone = c.phone || c.phone2 || '';

    const mine = settingsById.get(user.id);
    if (mine?.enabled && mine.token && mine.chatId) {
      await sendTelegramMessage(mine.token, mine.chatId,
        `⚠️ Клієнт <b>${c.name}</b> (${phone}) вже є в базі у ${owner.display_name} — обидва тепер ведете його паралельно.`);
    }

    const theirs = settingsById.get(owner.manager_id);
    if (theirs?.enabled && theirs.token && theirs.chatId) {
      await sendTelegramMessage(theirs.token, theirs.chatId,
        `⚠️ ${user.displayName} також додав(ла) собі клієнта <b>${owner.data.name}</b> (${phone}) — обидва тепер ведете його паралельно.`);
    }
  } catch (err) {
    console.error('notifyCrossManagerDuplicate failed:', err);
  }
}

// Upserts a single client row for `user`. Runs inside the caller's transaction
// (pgClient is an already-open, already-BEGIN'd client) so callers can
// commit/rollback batches independently.
//
// A phone number is allowed to belong to more than one manager at once — each
// keeps their own independent card for the same person — but the first time a
// manager's phone turns out to collide with another manager's client, both
// sides get notified (in-app + Telegram) so nobody works a shared lead blind.
// Returns { duplicates: [...] }, listing every such collision on this save.
async function upsertClientAndNotify(pgClient, user, c) {
  const phoneNorm = normalizePhone(c.phone);
  const phone2Norm = normalizePhone(c.phone2);

  const { rows: ownRows } = await pgClient.query(
    'SELECT data FROM clients WHERE id = $1 AND manager_id = $2',
    [c.id, user.id]
  );
  const oldData = ownRows.length > 0 ? ownRows[0].data : null;

  const phones = [phoneNorm, phone2Norm].filter(Boolean);
  let matches = [];
  if (phones.length) {
    const { rows } = await pgClient.query(
      `SELECT c.id, c.data, c.manager_id, u.display_name FROM clients c
       JOIN users u ON u.id = c.manager_id
       WHERE c.manager_id != $1 AND c.archived_at IS NULL
         AND (c.phone_norm = ANY($2::text[]) OR c.phone2_norm = ANY($2::text[]))`,
      [user.id, phones]
    );
    matches = rows;
  }

  await pgClient.query(
    `INSERT INTO clients (id, manager_id, data, phone_norm, phone2_norm, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id, manager_id) DO UPDATE SET
       data = EXCLUDED.data, phone_norm = EXCLUDED.phone_norm,
       phone2_norm = EXCLUDED.phone2_norm, updated_at = now()`,
    [c.id, user.id, c, phoneNorm, phone2Norm]
  );

  await logClientEvents(pgClient, user.id, c, oldData);

  const duplicates = [];
  for (const m of matches) {
    const { rows: existingNotif } = await pgClient.query(
      `SELECT id FROM notifications
       WHERE user_id = $1 AND related_client_id = $2 AND acked = false`,
      [user.id, c.id]
    );
    if (existingNotif.length > 0) continue;

    const myName = user.displayName;
    await pgClient.query(
      `INSERT INTO notifications (user_id, message, related_client_id) VALUES ($1, $2, $3)`,
      [user.id, `⚠️ Клієнт "${c.name}" (${c.phone || c.phone2}) вже в роботі у ${m.display_name}`, c.id]
    );
    await pgClient.query(
      `INSERT INTO notifications (user_id, message, related_client_id) VALUES ($1, $2, $3)`,
      [m.manager_id, `⚠️ Клієнт "${m.data.name}" (${m.data.phone || m.data.phone2}) також взяв у роботу ${myName}`, m.id]
    );
    await notifyCrossManagerDuplicate(pgClient, user, c, m);

    duplicates.push({ clientName: c.name, otherManagerName: m.display_name });
  }

  return { duplicates };
}

// Derives funnel activity events for the real-time stats dashboard by diffing
// the old vs new client record. Best-effort — a logging failure must never
// break the actual client save, so errors are swallowed (just logged).
async function logClientEvents(pgClient, managerId, newData, oldData) {
  try {
    if (!oldData) {
      await pgClient.query(
        `INSERT INTO events (manager_id, type, client_id, meta) VALUES ($1, 'lead_created', $2, $3)`,
        [managerId, newData.id, JSON.stringify({ stage: newData.stage })]
      );
    } else if (oldData.stage !== newData.stage) {
      await pgClient.query(
        `INSERT INTO events (manager_id, type, client_id, meta) VALUES ($1, 'stage_change', $2, $3)`,
        [managerId, newData.id, JSON.stringify({ fromStage: oldData.stage, toStage: newData.stage })]
      );
    }

    const oldTasksById = new Map((oldData?.tasks || []).map(t => [t.id, t]));
    for (const t of (newData.tasks || [])) {
      const wasDone = oldTasksById.get(t.id)?.done;
      if (t.done && !wasDone) {
        await pgClient.query(
          `INSERT INTO events (manager_id, type, client_id, meta) VALUES ($1, 'task_completed', $2, $3)`,
          [managerId, newData.id, JSON.stringify({ taskType: t.type })]
        );
      }
    }
  } catch (err) {
    console.error('Failed to log funnel events:', err);
  }
}

module.exports = { upsertClientAndNotify };
