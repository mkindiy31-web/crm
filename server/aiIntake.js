const { normalizePhone } = require('./phone');

const TASK_TYPES = ['call', 'consultation', 'inspection', 'registration'];
const MAX_STR = 2000;

// A name that is really just a phone number (digits/+/spaces/dashes) is a sign the
// model split one buyer's phone-as-message into a fake second identity — treat it
// as the phone field instead of a name.
function looksLikePhone(str) {
  const digits = (str.match(/\d/g) || []).length;
  return digits >= 7 && /^[\d+\s\-()]+$/.test(str);
}

function kyivToday() {
  const now = new Date();
  const isoDate = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' }); // YYYY-MM-DD
  const weekday = now.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', weekday: 'long' });
  return { isoDate, weekday };
}

function clip(v) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, MAX_STR);
}

function sanitizeAppointment(raw) {
  const out = { hasAppointment: false, appointmentType: '', appointmentDate: '', appointmentTime: '' };
  const wantsAppointment = raw.hasAppointment === true || raw.hasAppointment === 'true';
  const type = clip(raw.appointmentType);
  const date = clip(raw.appointmentDate);
  const time = clip(raw.appointmentTime);
  const validType = TASK_TYPES.includes(type);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const validTime = /^\d{2}:\d{2}$/.test(time);

  if (wantsAppointment && validType && validDate && validTime) {
    out.hasAppointment = true;
    out.appointmentType = type;
    out.appointmentDate = date;
    out.appointmentTime = time;
  }
  return out;
}

function sanitizeBuyer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const buyer = {
    name: clip(raw.name),
    phone: clip(raw.phone),
    source: clip(raw.source),
    notes: clip(raw.notes),
    ...sanitizeAppointment(raw),
  };

  if (buyer.name && looksLikePhone(buyer.name)) {
    if (!buyer.phone) buyer.phone = buyer.name;
    buyer.name = '';
  }

  if (!buyer.name && !buyer.phone && !buyer.notes) return null;
  return buyer;
}

// images: [{ base64, mediaType }]
async function extractBuyers(images) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не налаштований на сервері');
  if (!images.length) return [];

  const { isoDate, weekday } = kyivToday();

  const content = images.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.base64 },
  }));

  content.push({
    type: 'text',
    text: `Це ${images.length > 1 ? images.length + ' скріншотів' : 'скріншот'} переписки з потенційними покупцями нерухомості (Instagram/Facebook директ або SMS). Сьогодні ${isoDate} (${weekday}) за київським часом.

Проаналізуй всі зображення разом. У переписці може бути ОДИН або ДЕКІЛЬКА різних потенційних покупців — визнач кожного окремо за іменем профілю/аватаркою учасника розмови З БОКУ КЛІЄНТА (не за твоєю стороною діалогу).

ВАЖЛИВО — не плоди зайвих покупців: якщо це один діалог з одним співрозмовником (одна аватарка/ім'я профілю зліва), то це ОДНА людина, навіть якщо в якийсь момент вона надіслала номер телефону окремим повідомленням — цей номер належить ТІЙ САМІЙ людині, а не є окремим покупцем. Не створюй окремий об'єкт лише тому, що номер телефону прийшов окремим повідомленням у тому ж діалозі. Один діалог = один покупець, якщо не видно явно іншого імені/аватарки співрозмовника.

Поверни ТІЛЬКИ JSON-масив, без пояснень, один об'єкт на кожного унікального покупця:
[
  {
    "name": "Ім'я та прізвище або ім'я профілю",
    "phone": "номер телефону якщо є в переписці, інакше порожньо",
    "source": "Instagram або Facebook або Рекомендація або Сайт або Дзвінок або Інше",
    "notes": "короткий зміст переписки — що хоче клієнт, бюджет, район, деталі",
    "hasAppointment": true або false — чи домовились про конкретний дзвінок/зустріч/огляд,
    "appointmentType": "call" (дзвінок) або "consultation" (консультація) або "inspection" (огляд) або "registration" (оформлення) — тільки якщо hasAppointment true,
    "appointmentDate": "YYYY-MM-DD — переведи відносні дати (завтра, в п'ятницю тощо) у конкретну дату відносно сьогодні, тільки якщо hasAppointment true",
    "appointmentTime": "HH:MM 24-годинний формат, тільки якщо hasAppointment true"
  }
]
Якщо покупців не знайдено — поверни порожній масив []. Якщо поле невідоме — залиш порожнім рядком.`,
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.AI_INTAKE_MODEL || 'claude-haiku-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || response.statusText);
  }

  const data = await response.json();
  const raw = data.content[0].text.trim();
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.map(sanitizeBuyer).filter(Boolean);
}

// A plain-text Telegram message meant to update ONE existing client, e.g.
// "+380671234567 клієнт передумав, хоче зустрітись завтра о 15:00". Cheaper
// text-only call (no images) using the same model/appointment logic as the
// screenshot pipeline, so "завтра", "на обід" etc. resolve the same way.
async function extractTextUpdate(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не налаштований на сервері');

  const { isoDate, weekday } = kyivToday();

  const prompt = `Це текстове повідомлення від менеджера з нерухомості з оновленням по вже існуючому клієнту. Сьогодні ${isoDate} (${weekday}) за київським часом.

Повідомлення: "${clip(text)}"

Витягни коротке резюме нової інформації (без номера телефону — його вже витягнуто окремо) та визнач, чи йдеться про конкретну заплановану дію. Поверни ТІЛЬКИ JSON, без пояснень:
{
  "notes": "коротке резюме нової інформації з повідомлення, українською",
  "hasAppointment": true або false — чи йдеться про конкретний запланований дзвінок/зустріч/огляд/оформлення,
  "appointmentType": "call" (дзвінок) або "consultation" (консультація) або "inspection" (огляд/зустріч) або "registration" (оформлення) — тільки якщо hasAppointment true,
  "appointmentDate": "YYYY-MM-DD — переведи відносні дати (сьогодні/завтра/післязавтра/дні тижня) у конкретну дату відносно сьогодні, тільки якщо hasAppointment true",
  "appointmentTime": "HH:MM 24-годинний формат — переведи орієнтовний час (наприклад 'на обід'→13:00, 'зранку'→10:00, 'ввечері'→18:00) у конкретний час, тільки якщо hasAppointment true"
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.AI_INTAKE_MODEL || 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || response.statusText);
  }

  const data = await response.json();
  const raw = data.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { notes: clip(text), ...sanitizeAppointment({}) };

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { notes: clip(text), ...sanitizeAppointment({}) };
  }

  return {
    notes: clip(parsed.notes) || clip(text),
    ...sanitizeAppointment(parsed || {}),
  };
}

module.exports = { extractBuyers, extractTextUpdate, TASK_TYPES };
