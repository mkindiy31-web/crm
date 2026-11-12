// Turning a finished draft into a real listing.
//
// Order and failure handling follow _plan/STATES.md: the CRM row is written
// first, and only then does the listing go to the site. A half-result is never
// left silent — whatever happens, the manager is told where the listing is.
//
// The site leg needs the CRM -> site direction of the bridge, which belongs to
// stage 3. Until it exists, a published listing lands in the CRM marked as
// waiting for the site, and the bot says exactly that.

const { pool } = require('../db');
const { sendTelegramMessage, sendTelegramKeyboard, getFilePath, downloadFileAsBase64 } = require('../telegram');
const { dropDraft, saveDraft } = require('./objectDialog');
const siteSync = require('../siteSync');

function priceNum(price) {
  const n = parseFloat(String(price ?? '').replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

// Built from the fields themselves: the manager can rewrite it on the site.
function buildTitle(data) {
  const bits = [
    data.propType,
    data.rooms && `${data.rooms} кімнати`,
    data.area && `${data.area} м²`,
    data.district,
  ].filter(Boolean);
  return bits.join(', ');
}

function buildDescription(data) {
  const bits = [];
  if (data.propType && data.district) bits.push(`${data.propType} у районі ${data.district}.`);
  if (data.area) bits.push(`Площа ${data.area} м².`);
  if (data.rooms) bits.push(`Кімнат: ${data.rooms}.`);
  if (data.floor) bits.push(`Поверх ${data.floor}${data.totalFloors ? ' з ' + data.totalFloors : ''}.`);
  if (data.condition) bits.push(`Стан: ${data.condition.toLowerCase()}.`);
  return bits.join(' ');
}

// Фото з бота приходять номерами файлів Telegram, а ті живуть лише в цьому
// боті: ні СРМ, ні сайт їх не покажуть. Тому перед записом кожне фото
// стягується і лягає в СРМ так само, як фото з форми СРМ (`data:image/jpeg`).
async function photosFromTelegram(token, list) {
  const out = [];
  let lost = 0;
  for (const p of list) {
    if (typeof p === 'string' && (p.startsWith('data:') || /^https?:\/\//.test(p))) { out.push(p); continue; }
    let got = null;
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        got = 'data:image/jpeg;base64,' + await downloadFileAsBase64(token, await getFilePath(token, p));
      } catch (err) {
        if (attempt) console.error('publishDraft: photo download failed:', err.message);
      }
    }
    if (got) out.push(got); else lost++;
  }
  return { photos: out, lost };
}

async function publishDraft(userId, s, draft) {
  const raw = draft.item_data || {};
  const id = 'bot-' + draft.id;

  await sendTelegramMessage(s.token, s.chatId,
    `Публікую: ${(raw.photos || []).length} фото і дані йдуть на сайт, це до хвилини.`);
  const got = await photosFromTelegram(s.token, raw.photos || []);
  const data = { ...raw, photos: got.photos };

  const item = {
    ...data,
    id,
    title: data.title || buildTitle(data),
    description: data.description || buildDescription(data),
    status: 'available',
    siteStatus: 'pending',          // picked up once the CRM -> site leg exists
    createdByName: 'Бот',
    createdAt: new Date().toISOString(),
    source: 'bot',
  };

  try {
    await pool.query(
      `INSERT INTO catalog_items (id, created_by, data, price_num)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET data = $3, price_num = $4, updated_at = now()`,
      [id, userId, item, priceNum(data.price)]
    );
  } catch (err) {
    console.error('publishDraft: catalog insert failed:', err);
    // The draft stays exactly where it was: nothing is lost, the manager can retry.
    await saveDraft(draft.id, data, 'confirm', null);
    await sendTelegramMessage(s.token, s.chatId,
      'Не зміг записати обʼєкт у срм. Нічого не втрачено, спробуй «Опублікувати» ще раз.');
    return false;
  }

  await dropDraft(draft.id);

  const photos = data.photos.length;
  const onSite = await siteSync.pushListing(id, item).catch(err => {
    console.error('publishDraft: site push failed:', err);
    return { ok: false };
  });

  const where = onSite.ok
    ? 'Обʼєкт на сайті і в срм.'
    : onSite.skipped
      ? 'Обʼєкт у срм. Канал до сайту ще не налаштований, тому на вітрину він не пішов.'
      : 'Обʼєкт у срм. Сайт зараз не відповідає, зміна в черзі і піде сама, щойно він повернеться.';

  const lostLine = got.lost ? `\n${got.lost} фото Telegram не віддав, на сайт і в срм вони не пішли.` : '';
  const rows = [[{ text: 'Мої обʼєкти', callback_data: 'o:mine' }]];
  if (onSite.ok && /^https:\/\//.test(onSite.url || '')) rows.unshift([{ text: 'Відкрити на сайті', url: onSite.url }]);
  await sendTelegramKeyboard(s.token, s.chatId,
    `${where}\nФото ${photos}, головне перше.${lostLine}`,
    rows);

  return true;
}

module.exports = { publishDraft, buildTitle, buildDescription };
