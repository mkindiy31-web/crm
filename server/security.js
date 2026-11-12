const { pool } = require('./db');

// Заголовки відповіді ставляться своїм прошарком, без нової залежності:
// Railway поки недосяжний, і зайвий пакет при заливці означає СРМ, яка не
// піднялась. Усе, що тут є, читає `check-prelaunch.py`.
//
// CSP складено під наявний інтерфейс: crm.html і object.html не тягнуть жодного
// зовнішнього скрипта, зате сам браузер менеджера звертається до Anthropic
// (ключ КЛІЄНТА з localStorage) і до Telegram (тестове повідомлення), тому ці
// два хости стоять у connect-src. 'unsafe-inline' лишається, бо весь скрипт і
// стилі живуть у самих файлах; інакше інтерфейс просто перестане працювати.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://api.anthropic.com https://api.telegram.org",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Railway терминує TLS на своєму проксі, тому req.secure тут false: про https
  // знає лише заголовок від проксі (app.set('trust proxy', 1) вище в index.js).
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

// Підбір пароля. Вікно сповзаюче: лічильник завжди дивиться назад на
// WINDOW_MIN хвилин, тому блок сам спливає і власник не лишається замкненим.
// Рядки живуть у базі, а не в памʼяті процесу: перезапуск контейнера на Railway
// не має бути способом обнулити лічильник.
const WINDOW_MIN = 15;
const MAX_PER_USER = 7;
const MAX_PER_IP = 20;
const KEEP_DAYS = 30;

function clientIp(req) {
  return String(req.ip || req.connection?.remoteAddress || '').slice(0, 64);
}

async function tooManyAttempts(req, username) {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE username = $1) AS by_user,
       count(*) FILTER (WHERE ip = $2)       AS by_ip
     FROM login_attempts
     WHERE ok = false AND at > now() - ($3 || ' minutes')::interval`,
    [String(username || '').slice(0, 120), clientIp(req), String(WINDOW_MIN)]
  );
  const byUser = Number(rows[0]?.by_user || 0);
  const byIp = Number(rows[0]?.by_ip || 0);
  return byUser >= MAX_PER_USER || byIp >= MAX_PER_IP;
}

async function recordAttempt(req, username, ok) {
  await pool.query(
    'INSERT INTO login_attempts (username, ip, ok) VALUES ($1, $2, $3)',
    [String(username || '').slice(0, 120), clientIp(req), !!ok]
  );
  // Успішний вхід знімає свої ж хиби: людина згадала пароль, і наступна
  // помилка не має доламувати її до блоку.
  if (ok) {
    await pool.query('DELETE FROM login_attempts WHERE username = $1 AND ok = false',
      [String(username || '').slice(0, 120)]);
  }
}

async function pruneAttempts() {
  const { rowCount } = await pool.query(
    `DELETE FROM login_attempts WHERE at < now() - ($1 || ' days')::interval`,
    [String(KEEP_DAYS)]
  );
  return rowCount;
}

module.exports = {
  securityHeaders, tooManyAttempts, recordAttempt, pruneAttempts,
  WINDOW_MIN, MAX_PER_USER, MAX_PER_IP, CSP,
};
