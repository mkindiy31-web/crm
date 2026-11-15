// Аркуш фото обʼєкта з номерами для бота: менеджер бачить фото і обирає номер кнопкою
// («Змінити головне», «Прибрати фото», екран 16.11.2026). Одна картинка на десять фото.

const sharp = require('sharp');

const COLS = 5;
const PER_SHEET = 10;
const TILE_W = 216;
const TILE_H = 162;
const GAP = 6;
const LOAD_TIMEOUT_MS = 8000;

async function photoBuffer(p) {
  if (typeof p !== 'string') return null;
  const m = /^data:image\/[a-z]+;base64,(.+)$/s.exec(p);
  if (m) return Buffer.from(m[1], 'base64');
  if (!/^https?:\/\//.test(p)) return null;
  try {
    const r = await fetch(p, { signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

function badge(n, main) {
  const w = String(n).length > 1 ? 40 : 30;
  const fill = main ? '#1f7a4d' : 'rgba(15,20,25,0.72)';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="28">` +
    `<rect width="${w}" height="28" rx="6" fill="${fill}"/>` +
    `<text x="${w / 2}" y="20" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" ` +
    `fill="#fff" text-anchor="middle">${n}</text></svg>`);
}

async function tile(p) {
  const buf = await photoBuffer(p);
  if (buf) {
    try {
      return await sharp(buf).rotate().resize(TILE_W, TILE_H, { fit: 'cover' }).jpeg().toBuffer();
    } catch { /* зіпсоване фото: сіра клітинка з номером */ }
  }
  return sharp({ create: { width: TILE_W, height: TILE_H, channels: 3, background: '#c9d6e0' } }).jpeg().toBuffer();
}

// page 0: фото 1-10, page 1: 11-20 і так далі. Номери на аркуші це номери фото в обʼєкті.
async function photoSheet(photos, page = 0) {
  const list = (Array.isArray(photos) ? photos : []).slice(page * PER_SHEET, page * PER_SHEET + PER_SHEET);
  if (!list.length) return null;
  const rows = Math.ceil(list.length / COLS);
  const cols = Math.min(COLS, list.length);
  const width = cols * TILE_W + (cols + 1) * GAP;
  const height = rows * TILE_H + (rows + 1) * GAP;
  const tiles = await Promise.all(list.map(tile));
  const layers = [];
  tiles.forEach((img, i) => {
    const left = GAP + (i % COLS) * (TILE_W + GAP);
    const top = GAP + Math.floor(i / COLS) * (TILE_H + GAP);
    const n = page * PER_SHEET + i + 1;
    layers.push({ input: img, left, top });
    layers.push({ input: badge(n, n === 1), left: left + 6, top: top + 6 });
  });
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(layers).jpeg({ quality: 82 }).toBuffer();
}

module.exports = { photoSheet, PER_SHEET };
