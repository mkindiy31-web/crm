require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const { pool, initSchema } = require('./db');
const { seedAdmin } = require('./seed');
const { checkAndNotifyAll, checkAndSendDailyDigest } = require('./telegram');
const auth = require('./auth');
const clientsRouter = require('./routes/clients');
const ownersRouter = require('./routes/owners');
const notificationsRouter = require('./routes/notifications');
const managersRouter = require('./routes/managers');
const telegramRouter = require('./routes/telegram');
const telegramWebhookRouter = require('./routes/telegramWebhook');
const teamRouter = require('./routes/team');
const catalogRouter = require('./routes/catalog');
const catalogPublicRouter = require('./routes/catalogPublic');
const statsRouter = require('./routes/stats');
const todosRouter = require('./routes/todos');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' })); // client cards carry inline base64 screenshots/photos
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

app.use(
  session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

app.use('/api', auth.router);
app.use('/api/clients', auth.requireAuth, clientsRouter);
app.use('/api/owners', auth.requireAuth, ownersRouter);
app.use('/api/notifications', auth.requireAuth, notificationsRouter);
app.use('/api/todos', auth.requireAuth, todosRouter);
app.use('/api/admin/managers', auth.requireAuth, auth.requireAdmin, managersRouter);
app.use('/api/telegram', auth.requireAuth, telegramRouter);
// Intentionally NOT behind auth.requireAuth — Telegram calls this directly with no
// session cookie. Each request authenticates itself via a per-user secret_token
// header, verified inside the router (see routes/telegramWebhook.js).
app.use('/api/telegram-webhook', telegramWebhookRouter);
app.use('/api/team', auth.requireAuth, teamRouter);
app.use('/api/catalog', auth.requireAuth, catalogRouter);
// Public, unauthenticated — backs the shareable single-property page (/o/:id).
// Intentionally not behind auth.requireAuth; the route itself only ever returns
// a whitelisted subset of fields (see routes/catalogPublic.js).
app.use('/api/public/catalog', catalogPublicRouter);
app.use('/api/stats', auth.requireAuth, statsRouter);

const CRM_HTML_PATH = path.join(__dirname, '..', 'crm.html');
const OBJECT_HTML_PATH = path.join(__dirname, '..', 'object.html');
app.get('/crm.html', (req, res) => res.sendFile(CRM_HTML_PATH));
app.get('/o/:id', (req, res) => res.sendFile(OBJECT_HTML_PATH));
app.get('/', (req, res) => res.redirect('/crm.html'));

const PORT = process.env.PORT || 3000;

async function start() {
  await initSchema();
  await seedAdmin();
  app.listen(PORT, () => console.log(`CRM server listening on port ${PORT}`));

  setInterval(() => {
    checkAndNotifyAll(pool).catch(err => console.error('Telegram reminder check failed:', err));
    checkAndSendDailyDigest(pool).catch(err => console.error('Telegram daily digest failed:', err));
  }, 60 * 1000);
  setTimeout(() => {
    checkAndNotifyAll(pool).catch(err => console.error('Telegram reminder check failed:', err));
  }, 5000);
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
