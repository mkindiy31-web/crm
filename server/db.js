const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Railway's internal private-network Postgres host (*.railway.internal) and a local
// Postgres don't need/support SSL; the public proxy host (*.proxy.rlwy.net) does.
const url = process.env.DATABASE_URL || '';
const needsSsl = url && !url.includes('localhost') && !url.includes('.railway.internal');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

module.exports = { pool, initSchema };
