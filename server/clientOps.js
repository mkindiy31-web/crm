const { normalizePhone } = require('./phone');
const { sendTelegramMessage } = require('./telegram');

// Pings both sides by Telegram when a brand-new client is rejected for
// belonging to another manager — the in-app toast is easy to miss if the
// manager isn't staring at the CRM tab right then. Best-effort: a manager
// without Telegram configured (or a delivery failure) never blocks the save.
async function notifyBlockedDuplicate(pgClient, user, c, owner) {
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
        `🚫 Не додано: <b>${c.name}</b> (${phone})\nЦей клієнт вже в роботі у ${owner.display_name}.`);
    }

    const theirs = settingsById.get(owner.manager_id);
    if (theirs?.enabled && theirs.token && theirs.chatId) {
      await sendTelegramMessage(theirs.token, theirs.chatId,
        `👀 ${user.displayName} намагався(лась) додати вашого клієнта <b>${owner.data.name}</b> (${phone}) — не додано, картка лишилась вашою.`);
    }
  } catch (err) {
    console.error('notifyBlockedDuplicate failed:', err);
  }
}

// Upserts a single client row for `user`, enforcing that a phone number can only
// belong to ONE manager at a time. Runs inside the caller's transaction (pgClient
// is an already-open, already-BEGIN'd client) so callers can commit/rollback
// batches independently.
//
// Returns either:
//   { blocked: true, clientName, otherManagerName }   — brand-new client rejected,
//     phone already belongs to another manager's active client. Nothing written.
//   { blocked: false, duplicates: [...] }              — written normally. `duplicates`
//     is non-empty only for legacy overlaps on an already-existing own client
//     (phone matched another manager before this row existed), which we still
//     allow to save (so ongoing edits never get stuck) but keep notifying about.
async function upsertClientAndNotify(pgClient, user, c) {
  const phoneNorm = normalizePhone(c.phone);
  const phone2Norm = normalizePhone(c.phone2);

  const { rows: ownRows } = await pgClient.query(
    'SELECT data FROM clients WHERE id = $1 AND manager_id = $2',
    [c.id, user.id]
  );
  const isExistingOwnRow = ownRows.length > 0;
  const oldData = isExistingOwnRow ? ownRows[0].data : null;

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

  if (!isExistingOwnRow && matches.length > 0) {
    const owner = matches[0];
    await notifyBlockedDuplicate(pgClient, user, c, owner);
    return { blocked: true, clientName: c.name, otherManagerName: owner.display_name };
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

    duplicates.push({ clientName: c.name, otherManagerName: m.display_name });
  }

  return { blocked: false, duplicates };
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
