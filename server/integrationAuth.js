const crypto = require('crypto');

// Server-to-server calls (the WordPress site, later the listing portals) carry a
// shared key in a header instead of a session cookie, the same way the Telegram
// webhook authenticates itself with a per-user secret_token.
//
// Both sides are hashed before comparing so neither the key nor its length leaks
// through response timing. The key itself is never logged and never echoed back.
function requireIntegrationKey(req, res, next) {
  const expected = process.env.INTEGRATION_KEY || '';
  if (!expected) {
    console.error('INTEGRATION_KEY is not set — integration endpoints refuse every call');
    return res.status(503).json({ error: 'Інтеграція не налаштована' });
  }

  const sha = value => crypto.createHash('sha256').update(String(value), 'utf8').digest();
  if (!crypto.timingSafeEqual(sha(req.get('X-Integration-Key') || ''), sha(expected))) {
    return res.status(401).json({ error: 'Доступ заборонено' });
  }

  next();
}

module.exports = { requireIntegrationKey };
