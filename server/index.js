require('dotenv').config();
const path = require('path');
const express = require('express');
// До будь-якого файлу маршрутів: загортає їхні async-обробники.
const asyncErrors = require('./asyncErrors');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const { pool, initSchema } = require('./db');
const siteSync = require('./siteSync');
const { seedAdmin } = require('./seed');
const auto = require('./automations');
const { checkAndNudgeStale } = require('./staleNudge');
const { checkAndSendWeeklyBrief } = require('./weeklyBrief');
const { checkAndSendBackup } = require('./dbBackup');
const { checkAndNotifyAll, checkAndSendDailyDigest, checkAndSendMorningBrief, checkAndSendClientTaskDigest, reRegisterAllWebhooks } = require('./telegram');
const auth = require('./auth');
const clientsRouter = require('./routes/clients');
const ownersRouter = require('./routes/owners');
const notificationsRouter = require('./routes/notifications');
const managersRouter = require('./routes/managers');
const telegramRouter = require('./routes/telegram');
const { router: telegramWebhookRouter, checkAndRemindPendingIntakes, checkAndRemindSourceFixes } = require('./routes/telegramWebhook');
const { router: integrationRouter } = require('./routes/integration');
const teamRouter = require('./routes/team');
const catalogRouter = require('./routes/catalog');
const catalogPublicRouter = require('./routes/catalogPublic');
const statsRouter = require('./routes/stats');
const automationsRouter = require('./routes/automations');
const backupRouter = require('./routes/backup');
const todosRouter = require('./routes/todos');

const app = express();
app.set('trust proxy', 1);

const security = require('./security');
app.use(security.securityHeaders);
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
app.use('/api/admin/automations', auth.requireAuth, auth.requireAdmin, automationsRouter);
app.use('/api/admin/backup', auth.requireAuth, auth.requireAdmin, backupRouter);
app.use('/api/telegram', auth.requireAuth, telegramRouter);
// Intentionally NOT behind auth.requireAuth — Telegram calls this directly with no
// session cookie. Each request authenticates itself via a per-user secret_token
// header, verified inside the router (see routes/telegramWebhook.js).
app.use('/api/telegram-webhook', telegramWebhookRouter);
// Intentionally NOT behind auth.requireAuth either — the site and, later, the
// listing portals call this machine to machine with no session. Every request
// authenticates itself with the shared INTEGRATION_KEY header, checked inside
// the router (see integrationAuth.js).
app.use('/api/integration', integrationRouter);
app.use('/api/team', auth.requireAuth, teamRouter);
app.use('/api/catalog', auth.requireAuth, catalogRouter);
// Public, unauthenticated — backs the shareable single-property page (/o/:id).
// Intentionally not behind auth.requireAuth; the route itself only ever returns
// a whitelisted subset of fields (see routes/catalogPublic.js).
app.use('/api/public/catalog', catalogPublicRouter);
app.use('/api/stats', auth.requireAuth, statsRouter);

const CRM_HTML_PATH = path.join(__dirname, '..', 'crm.html');
const OBJECT_HTML_PATH = path.join(__dirname, '..', 'object.html');
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.get('/crm.html', (req, res) => res.sendFile(CRM_HTML_PATH));
app.get('/o/:id', (req, res) => res.sendFile(OBJECT_HTML_PATH));
app.get('/', (req, res) => res.redirect('/crm.html'));
app.use(asyncErrors.errorHandler);

const PORT = process.env.PORT || 3000;

async function start() {
  await initSchema();
  await seedAdmin();
  app.listen(PORT, () => console.log(`CRM server listening on port ${PORT}`));

  // Every timed job goes through auto.run: it honours the switch in the
  // `automations` table and writes the run log. Nothing is scheduled twice —
  // one minute tick, one place.
  const tick = () => {
    const jobs = [
      ['reminders', () => checkAndNotifyAll(pool), 'Telegram reminder check failed'],
      ['evening-digest', () => checkAndSendDailyDigest(pool), 'Telegram daily digest failed'],
      ['intake-reminder', () => checkAndRemindPendingIntakes(pool), 'Pending intake reminder check failed'],
      ['morning-brief', () => checkAndSendMorningBrief(pool), 'Morning brief failed'],
      ['stale-nudge', () => checkAndNudgeStale(pool), 'Stale listing nudge failed'],
      ['weekly-owner', () => checkAndSendWeeklyBrief(pool), 'Weekly owner brief failed'],
      ['db-backup', () => checkAndSendBackup(pool), 'Database backup failed'],
      ['client-task-digest', () => checkAndSendClientTaskDigest(pool), 'Client task digest failed'],
      ['source-fix-reminder', () => checkAndRemindSourceFixes(pool), 'Source fix reminder check failed'],
      // `failed` їде в skipped не для краси: інакше прогін, де все до сайту
      // не доїхало, не лишає в лозі жодного рядка.
      ['site-queue', () => siteSync.drain().then(r => ({
        sent: r.sent, skipped: r.failed || 0,
        detail: { pending: r.pending, failed: r.failed, notConfigured: !!r.skipped },
      })), 'Site queue drain failed'],
    ];
    for (const [key, fn, label] of jobs) {
      auto.run(pool, key, fn).catch(err => console.error(`${label}:`, err));
    }
  };
  setInterval(tick, 60 * 1000);
  setTimeout(() => {
    auto.run(pool, 'reminders', () => checkAndNotifyAll(pool))
      .catch(err => console.error('Telegram reminder check failed:', err));
  }, 5000);
  reRegisterAllWebhooks(pool).catch(err => console.error('Webhook re-registration failed:', err));
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
