const express = require('express');
const { pool } = require('../db');

const router = express.Router();

function rangeBounds(range) {
  const now = new Date();
  const since = new Date(now);
  let bucket = 'day';
  switch (range) {
    case 'day':      since.setDate(now.getDate() - 1);   bucket = 'hour'; break;
    case 'week':     since.setDate(now.getDate() - 7);   bucket = 'day';  break;
    case 'month':    since.setDate(now.getDate() - 30);  bucket = 'day';  break;
    case '6months':  since.setMonth(now.getMonth() - 6); bucket = 'week'; break;
    default:         since.setDate(now.getDate() - 7);   bucket = 'day';
  }
  return { since, bucket };
}

// Real-time funnel activity dashboard — always scoped to the calling manager
// (or admin's own account), consistent with how /api/clients and Аналітика work.
router.get('/timeseries', async (req, res) => {
  const range = ['day', 'week', 'month', '6months'].includes(req.query.range) ? req.query.range : 'week';
  const { since, bucket } = rangeBounds(range);

  const [leadsRes, stagesRes, tasksByTypeRes, tasksOverTimeRes] = await Promise.all([
    pool.query(
      `SELECT date_trunc($1, created_at) AS bucket, count(*)::int AS count
       FROM events WHERE manager_id = $2 AND type = 'lead_created' AND created_at >= $3
       GROUP BY 1 ORDER BY 1`,
      [bucket, req.user.id, since]
    ),
    pool.query(
      `SELECT (meta->>'toStage')::int AS stage, count(*)::int AS count
       FROM events WHERE manager_id = $1 AND type = 'stage_change' AND created_at >= $2
       GROUP BY 1`,
      [req.user.id, since]
    ),
    pool.query(
      `SELECT meta->>'taskType' AS type, count(*)::int AS count
       FROM events WHERE manager_id = $1 AND type = 'task_completed' AND created_at >= $2
       GROUP BY 1`,
      [req.user.id, since]
    ),
    pool.query(
      `SELECT date_trunc($1, created_at) AS bucket, count(*)::int AS count
       FROM events WHERE manager_id = $2 AND type = 'task_completed' AND created_at >= $3
       GROUP BY 1 ORDER BY 1`,
      [bucket, req.user.id, since]
    ),
  ]);

  res.json({
    range,
    bucket,
    since: since.toISOString(),
    totalLeads: leadsRes.rows.reduce((s, r) => s + r.count, 0),
    leadsOverTime: leadsRes.rows.map(r => ({ bucket: r.bucket, count: r.count })),
    stageArrivals: stagesRes.rows.filter(r => r.stage !== null),
    tasksByType: tasksByTypeRes.rows.filter(r => r.type !== null),
    tasksOverTime: tasksOverTimeRes.rows.map(r => ({ bucket: r.bucket, count: r.count })),
  });
});

module.exports = router;
