const { normalizePhone } = require('./phone');
const { STAGES, findStageIdByName } = require('./stages');

const TASK_TYPES = ['call', 'consultation', 'selection', 'inspection', 'registration'];
const MAX_STR = 2000;
const STAGE_NAMES_LIST = STAGES.map(s => `"${s.name}"`).join(', ');

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

// Safety net against the model hallucinating a placeholder instead of an
// empty string when the message only refers to the client by pronoun
// ("цей клієнт", "його") — treats those the same as no name at all.
const NAME_PLACEHOLDER_RE = /^(невідом|невказан|не\s*вказан|клієнт|цей|цього|його|її|н\/?д|n\/?a|unknown)\b/i;
function sanitizeClientName(name) {
  const clean = clip(name);
  if (!clean || NAME_PLACEHOLDER_RE.test(clean)) return '';
  return clean;
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
    "source": "OLX або DOM.RIA або rieltor.ua або Інстаграм або Фейсбук або Тікток або Рекомендації або Банер або Інше",
    "notes": "короткий зміст переписки — що хоче клієнт, бюджет, район, деталі",
    "hasAppointment": true або false — чи домовились про конкретний дзвінок/зустріч/огляд,
    "appointmentType": "call" (дзвінок) або "consultation" (консультація) або "selection" (підбір варіантів) або "inspection" (огляд) або "registration" (оформлення) — тільки якщо hasAppointment true,
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

Витягни коротке резюме нової інформації (без номера телефону — його вже витягнуто окремо), визнач, чи йдеться про конкретну заплановану дію, і чи просять перенести клієнта на інший етап воронки продажів. Етапи воронки (тільки ці назви, більше жодних): ${STAGE_NAMES_LIST}. Поверни ТІЛЬКИ JSON, без пояснень:
{
  "notes": "коротке резюме нової інформації з повідомлення, українською",
  "hasAppointment": true або false — чи йдеться про конкретний запланований дзвінок/зустріч/огляд/оформлення,
  "appointmentType": "call" (дзвінок) або "consultation" (консультація) або "selection" (підбір варіантів) або "inspection" (огляд/зустріч) або "registration" (оформлення) — тільки якщо hasAppointment true,
  "appointmentDate": "YYYY-MM-DD — переведи відносні дати (сьогодні/завтра/післязавтра/дні тижня) у конкретну дату відносно сьогодні, тільки якщо hasAppointment true",
  "appointmentTime": "HH:MM 24-годинний формат — переведи орієнтовний час (наприклад 'на обід'→13:00, 'зранку'→10:00, 'ввечері'→18:00) у конкретний час, тільки якщо hasAppointment true",
  "hasStageChange": true або false — чи просять перенести/змінити етап клієнта у воронці,
  "newStageName": "ТОЧНА назва етапу зі списку вище — тільки якщо hasStageChange true"
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
  const emptyResult = { notes: clip(text), newStageId: null, newStageName: '', ...sanitizeAppointment({}) };
  if (!jsonMatch) return emptyResult;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return emptyResult;
  }

  const wantsStageChange = parsed.hasStageChange === true || parsed.hasStageChange === 'true';
  const newStageId = wantsStageChange ? findStageIdByName(parsed.newStageName) : null;

  return {
    notes: clip(parsed.notes) || clip(text),
    newStageId,
    newStageName: newStageId != null ? clip(parsed.newStageName) : '',
    ...sanitizeAppointment(parsed || {}),
  };
}

// A plain-text Telegram message that names a client instead of giving their
// phone number, e.g. "додай завдання клієнту Марку подзвонити завтра о 15:00".
// Pulls out the name so the caller can look the client up by it, plus the same
// appointment shape as extractTextUpdate.
async function extractClientTaskByName(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не налаштований на сервері');

  const { isoDate, weekday } = kyivToday();

  const prompt = `Це повідомлення від менеджера з нерухомості боту — завдання по конкретному клієнту, якого названо ІМ'ЯМ (не номером телефону). Сьогодні ${isoDate} (${weekday}) за київським часом.

Повідомлення: "${clip(text)}"

Витягни ім'я клієнта — ТІЛЬКИ якщо в повідомленні дійсно назване власне ім'я людини (наприклад "Марку", "Вікторія", "Іван Петренко"). Якщо клієнта позначено лише займенником без імені (наприклад "цього клієнта", "його", "її") — clientName має бути порожнім рядком, НЕ вигадуй і не підставляй слова-заглушки типу "невказано".

Також визнач, чи йдеться про перенесення клієнта на інший етап воронки продажів. Етапи воронки (тільки ці назви, більше жодних): ${STAGE_NAMES_LIST}.

Поверни ТІЛЬКИ JSON, без пояснень:
{
  "clientName": "ім'я клієнта, як згадано в повідомленні, або порожній рядок",
  "notes": "коротке резюме завдання, українською",
  "hasAppointment": true або false — чи йдеться про конкретний запланований дзвінок/зустріч/огляд/оформлення,
  "appointmentType": "call" (дзвінок) або "consultation" (консультація) або "selection" (підбір варіантів) або "inspection" (огляд/зустріч) або "registration" (оформлення) — тільки якщо hasAppointment true,
  "appointmentDate": "YYYY-MM-DD — переведи відносні дати (сьогодні/завтра/післязавтра/дні тижня) у конкретну дату відносно сьогодні, тільки якщо hasAppointment true",
  "appointmentTime": "HH:MM 24-годинний формат — переведи орієнтовний час (наприклад 'на обід'→13:00) у конкретний, тільки якщо hasAppointment true",
  "hasStageChange": true або false — чи просять перенести/змінити етап клієнта у воронці,
  "newStageName": "ТОЧНА назва етапу зі списку вище — тільки якщо hasStageChange true"
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
  const emptyResult = { clientName: '', notes: clip(text), newStageId: null, newStageName: '', ...sanitizeAppointment({}) };
  if (!jsonMatch) return emptyResult;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return emptyResult;
  }

  const wantsStageChange = parsed.hasStageChange === true || parsed.hasStageChange === 'true';
  const newStageId = wantsStageChange ? findStageIdByName(parsed.newStageName) : null;

  return {
    clientName: sanitizeClientName(parsed.clientName),
    notes: clip(parsed.notes) || clip(text),
    newStageId,
    newStageName: newStageId != null ? clip(parsed.newStageName) : '',
    ...sanitizeAppointment(parsed || {}),
  };
}

// A plain-text Telegram message that gives a phone number NOT already in the
// manager's client base, explicitly asking to add it as a new client (e.g.
// "додай клієнта 0671234567 Марк, шукає 1-кімнатну"). The phone itself is
// extracted separately by the caller (regex) — this only pulls the name,
// request summary, and optional first appointment.
async function extractNewClientFromText(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не налаштований на сервері');

  const { isoDate, weekday } = kyivToday();

  const prompt = `Це повідомлення від менеджера з нерухомості боту — прохання додати НОВОГО клієнта (номер телефону вже витягнуто окремо, ігноруй його). Сьогодні ${isoDate} (${weekday}) за київським часом.

Повідомлення: "${clip(text)}"

Витягни ім'я нового клієнта (якщо назване), коротке резюме запиту клієнта, і чи йдеться про конкретну заплановану дію з датою й часом. Поверни ТІЛЬКИ JSON, без пояснень:
{
  "name": "ім'я клієнта, як згадано в повідомленні, або порожній рядок якщо не назване",
  "notes": "коротке резюме запиту клієнта (що шукає, бюджет тощо), українською",
  "hasAppointment": true або false,
  "appointmentType": "call" (дзвінок) або "consultation" (консультація) або "selection" (підбір варіантів) або "inspection" (огляд/зустріч) або "registration" (оформлення) — тільки якщо hasAppointment true,
  "appointmentDate": "YYYY-MM-DD — переведи відносні дати у конкретну дату відносно сьогодні, тільки якщо hasAppointment true",
  "appointmentTime": "HH:MM 24-годинний формат, тільки якщо hasAppointment true"
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
  const emptyResult = { name: '', notes: clip(text), ...sanitizeAppointment({}) };
  if (!jsonMatch) return emptyResult;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return emptyResult;
  }

  return {
    name: sanitizeClientName(parsed.name),
    notes: clip(parsed.notes) || clip(text),
    ...sanitizeAppointment(parsed || {}),
  };
}

// A plain-text Telegram message with NO client phone number in it — treated as
// a personal to-do item instead (e.g. "продовжити ліцензію на CRM в п'ятницю",
// "подзвонити орендодавцю про паркінг завтра вранці"). Same model/date-parsing
// approach as extractTextUpdate, but returns a to-do shape, not a client update.
async function extractPersonalTodo(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не налаштований на сервері');

  const { isoDate, weekday } = kyivToday();

  const prompt = `Це повідомлення від менеджера з нерухомості боту-нагадувачу — особиста справа "для себе", НЕ повʼязана з конкретним клієнтом (номера телефону клієнта в ньому немає). Сьогодні ${isoDate} (${weekday}) за київським часом.

Повідомлення: "${clip(text)}"

Перетвори це на короткий пункт to-do списку та, якщо в повідомленні згадана дата чи день (сьогодні/завтра/післязавтра/день тижня/конкретне число), визнач її. Час (година) потрібен, лише якщо він явно згаданий — інакше залиш порожнім, це нормально для to-do без точного часу.

Також визнач, чи це завдання потрібно повторити кожен день протягом кількох днів поспіль (наприклад "на наступні 4 дні", "кожен день цього тижня", "щодня 3 дні"). Якщо так — вкажи кількість днів у repeatDays і дату ПЕРШОГО повторення в date (якщо початкова дата не вказана явно — почни з сьогодні). Якщо завдання разове — repeatDays = 1. Поверни ТІЛЬКИ JSON, без пояснень:
{
  "task": "короткий, чіткий опис справи українською, без зайвих слів",
  "hasDate": true або false — чи згадана в повідомленні дата/день (true також якщо це повторюване завдання),
  "date": "YYYY-MM-DD — дата виконання (або дата першого повторення, якщо repeatDays > 1), відносно сьогодні, тільки якщо hasDate true",
  "hasTime": true або false — чи згадана конкретна година,
  "time": "HH:MM 24-годинний формат, тільки якщо hasTime true",
  "repeatDays": число — скільки днів поспіль повторити це завдання (1, якщо воно разове)
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
  if (!jsonMatch) return { task: clip(text), dueDate: '', dueTime: '', repeatDays: 1 };

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { task: clip(text), dueDate: '', dueTime: '', repeatDays: 1 };
  }

  const date = clip(parsed.date);
  const time = clip(parsed.time);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const validTime = /^\d{2}:\d{2}$/.test(time);
  const repeatDaysRaw = parseInt(parsed.repeatDays, 10);
  const repeatDays = Number.isFinite(repeatDaysRaw) && repeatDaysRaw >= 1 && repeatDaysRaw <= 60 ? repeatDaysRaw : 1;

  return {
    task: clip(parsed.task) || clip(text),
    dueDate: (parsed.hasDate === true || parsed.hasDate === 'true') && validDate ? date : '',
    dueTime: (parsed.hasTime === true || parsed.hasTime === 'true') && validTime ? time : '',
    repeatDays,
  };
}

module.exports = { extractBuyers, extractTextUpdate, extractPersonalTodo, extractClientTaskByName, extractNewClientFromText, TASK_TYPES };
