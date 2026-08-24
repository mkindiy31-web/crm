const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function seedAdmin() {
  const { rows } = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (rows.length > 0) return;

  const username = process.env.ADMIN_USER;
  const password = process.env.ADMIN_PASS;
  if (!username || !password) {
    console.warn('No admin account exists yet and ADMIN_USER/ADMIN_PASS are not set — skipping seed.');
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO users (username, password_hash, role, display_name) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING',
    [username, hash, 'admin', 'Адмін']
  );
  console.log(`Seeded admin account "${username}"`);
}

module.exports = { seedAdmin };
