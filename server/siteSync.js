// Sending a listing from the CRM to the site.
//
// The mirror of the site's own bridge: there the site pushes here, here the CRM
// pushes there. Both carry the same INTEGRATION_KEY and both keep a queue,
// because neither side is always up — the site is on a shared host behind
// Cloudflare, the CRM on a Railway dyno that sleeps.

const crypto = require('crypto');
const { pool } = require('./db');

const SITE_TIMEOUT_MS = 8000;
// Одне фото сайт приймає довше: медіатека, знак, webp на спільному хостингу.
const PHOTO_TIMEOUT_MS = 60000;
// Minutes after the previous try, same ladder the site uses.
const BACKOFF = [1, 5, 30, 120, 360];

function siteConfigured() {
  return Boolean(process.env.SITE_URL && process.env.INTEGRATION_KEY);
}

// Everything the site needs; the site itself decides which meta key each one
// lands in, because those keys are its business and they differ from what its
// own form names them.
function toSitePayload(crmId, data) {
  const keep = [
    'title', 'description', 'address', 'price', 'currency', 'area', 'rooms',
    'floor', 'totalFloors', 'ownerPhone', 'propType', 'purpose', 'district',
    'condition', 'status',
  ];
  const item = {};
  for (const key of keep) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') item[key] = data[key];
  }
  return { crm_id: crmId, site_id: siteIdOf(crmId, data), item };
}

// Номер запису на сайті. Обʼєкт, створений у СРМ, дістає `siteId` у відповідь
// сайту; обʼєкт, що прийшов із сайту мостом, несе `sitePostId` і id виду
// `site-6885`. Без двох останніх сайт не впізнавав свій же запис і створював
// опублікований дубль (12.11.2026, обʼєкт 6885 -> дубль 8163).
// Запис, з якого обʼєкт прийшов, головніший за `siteId`: той міг лишитись від
// дубля і вести не туди.
function siteIdOf(crmId, data) {
  const fromSite = parseInt(data.sitePostId, 10);
  if (fromSite > 0) return fromSite;
  const m = /^site-(\d+)$/.exec(String(crmId));
  if (m) return parseInt(m[1], 10);
  const own = parseInt(data.siteId, 10);
  return own > 0 ? own : 0;
}

async function postToSite(payload, route = 'listing', timeoutMs = SITE_TIMEOUT_MS) {
  const url = String(process.env.SITE_URL).replace(/\/+$/, '') + '/wp-json/urban-crm/v1/' + route;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Integration-Key': process.env.INTEGRATION_KEY },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await r.text();
    if (r.status >= 400 && r.status < 500) {
      // The site understood and refused: repeating changes nothing.
      return { ok: false, permanent: true, error: `HTTP ${r.status} ${text.slice(0, 200)}` };
    }
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    let body = {};
    try { body = JSON.parse(text); } catch { /* site answered 200 with non-JSON */ }
    return { ok: true, postId: body.post_id || 0, status: body.status || '', url: body.url || '', id: body.id || 0 };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function enqueue(crmId, payload, error) {
  // Only the newest change per listing waits: an older price on its way is
  // already wrong by the time it would be sent.
  await pool.query("DELETE FROM site_queue WHERE crm_id = $1 AND status = 'pending'", [crmId]);
  await pool.query(
    `INSERT INTO site_queue (crm_id, payload, tries, status, last_error, next_try_at)
     VALUES ($1, $2, 1, 'pending', $3, now() + ($4 || ' minutes')::interval)`,
    [crmId, payload, error || null, String(BACKOFF[0])]
  );
}

async function rememberSiteId(crmId, postId) {
  if (!postId) return;
  await pool.query(
    `UPDATE catalog_items
     SET data = data || jsonb_build_object('siteId', $2::int, 'siteStatus', 'live'),
         updated_at = now()
     WHERE id = $1`,
    [crmId, postId]
  );
}

// Called right after a listing changes in the CRM. Never throws: a site that is
// down must not fail the save that just happened here.
// ── фото ───────────────────────────────────────────────────────────────────
// Фото в СРМ лежать як `data:image/…` (з бота і з форми СРМ) або адресою на
// сайті (47 перенесених з сайту, у них свої вкладення). Вантажаться лише
// перші, і кожне один раз: відбиток фото ключ, номер вкладення на сайті
// записується в `sitePhotos`, повтор черги чи зміна ціни фото не шле наново.
function isDataPhoto(p) {
  return typeof p === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p);
}
function photoKey(p) {
  return crypto.createHash('sha1').update(p).digest('hex').slice(0, 24);
}

async function syncPhotos(crmId, data) {
  const photos = Array.isArray(data.photos) ? data.photos : [];
  // Змішані чи лише адреси: галерею на сайті не чіпаємо, вона там своя.
  if (!photos.length || !photos.every(isDataPhoto)) return { ok: true, ids: null };
  const known = { ...(data.sitePhotos || {}) };
  const ids = [];
  for (const p of photos) {
    const key = photoKey(p);
    if (!known[key]) {
      const res = await postToSite(
        { crm_id: crmId, key, data: p.slice(p.indexOf(',') + 1) }, 'photo', PHOTO_TIMEOUT_MS);
      if (!res.ok || !res.id) return { ok: false, permanent: res.permanent, error: res.error || 'фото без номера' };
      known[key] = res.id;
      await pool.query(
        `UPDATE catalog_items SET data = data || jsonb_build_object('sitePhotos', $2::jsonb) WHERE id = $1`,
        [crmId, JSON.stringify(known)]
      );
    }
    ids.push(known[key]);
  }
  return { ok: true, ids };
}

// Логін менеджера (прізвище): сайт ставить його автором запису.
async function agentOf(crmId) {
  const { rows } = await pool.query(
    'SELECT u.username FROM catalog_items c JOIN users u ON u.id = c.created_by WHERE c.id = $1', [crmId]);
  return rows[0] ? rows[0].username : '';
}

async function sendListing(crmId, data) {
  const ph = await syncPhotos(crmId, data);
  const payload = toSitePayload(crmId, data);
  const agent = await agentOf(crmId);
  if (agent) payload.item.agent = agent;
  if (!ph.ok) return { res: ph, payload };
  if (ph.ids) payload.item.photoIds = ph.ids;
  return { res: await postToSite(payload), payload };
}

async function pushListing(crmId, data) {
  if (!siteConfigured()) return { ok: false, skipped: true };
  const { res, payload } = await sendListing(crmId, data);
  if (res.ok) {
    await rememberSiteId(crmId, res.postId);
    return res;
  }
  if (res.permanent) {
    console.error('siteSync: site refused listing', crmId, res.error);
    return res;
  }
  await enqueue(crmId, payload, res.error);
  return res;
}

async function drain(limit = 20) {
  if (!siteConfigured()) return { sent: 0, pending: 0, failed: 0, skipped: true };
  const { rows } = await pool.query(
    `SELECT * FROM site_queue WHERE status = 'pending' AND next_try_at <= now() ORDER BY id LIMIT $1`,
    [limit]
  );

  let sent = 0, pending = 0, failed = 0;
  for (const row of rows) {
    // Черга шле найсвіжіший стан обʼєкта, разом із фото, а не знімок на момент
    // збою: фото в знімку немає, вони вантажаться окремо.
    const { rows: cur } = await pool.query('SELECT data FROM catalog_items WHERE id = $1', [row.crm_id]);
    const res = cur[0]
      ? (await sendListing(row.crm_id, cur[0].data)).res
      : await postToSite(row.payload);
    if (res.ok) {
      await pool.query("UPDATE site_queue SET status = 'sent', last_error = NULL WHERE id = $1", [row.id]);
      await rememberSiteId(row.crm_id, res.postId);
      sent++;
      continue;
    }
    const tries = row.tries + 1;
    if (res.permanent || tries > BACKOFF.length) {
      await pool.query("UPDATE site_queue SET status = 'failed', tries = $2, last_error = $3 WHERE id = $1",
        [row.id, tries, res.error]);
      failed++;
      continue;
    }
    const wait = BACKOFF[Math.min(tries, BACKOFF.length - 1)];
    await pool.query(
      `UPDATE site_queue SET tries = $2, last_error = $3, next_try_at = now() + ($4 || ' minutes')::interval
       WHERE id = $1`,
      [row.id, tries, res.error, String(wait)]
    );
    pending++;
  }
  return { sent, pending, failed };
}

module.exports = { pushListing, drain, toSitePayload, siteIdOf, siteConfigured, syncPhotos, isDataPhoto, BACKOFF };
