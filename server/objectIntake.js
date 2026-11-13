// The step-by-step dialog a manager goes through in the bot to enter a listing.
//
// Kept free of Telegram on purpose: every transition, every parse and every
// cancel can be exercised without a network, a token or a chat. The webhook
// only moves messages in and out.
//
// The states and what each one collects are fixed by _plan/STATES.md, which the
// owner approved on 2026-10-31 together with the screens.

const STEPS = ['photos', 'type', 'purpose', 'district', 'condition', 'specs', 'owner', 'confirm'];
const TERMINAL = ['published', 'draft', 'cancelled'];

// Which keys of item_data belong to which step, so "back" can undo exactly one
// answer and `edit` can redo exactly one field.
const STEP_FIELDS = {
  photos: ['photos'],
  type: ['propType', 'siteTermId'],
  purpose: ['purpose'],
  district: ['district', 'districtTermId'],
  condition: ['condition'],
  specs: ['price', 'currency', 'area', 'rooms', 'floor', 'totalFloors'],
  owner: ['ownerName', 'ownerPhone'],
  confirm: [],
};

// Steps that answer with a tap. Text sent here is not an answer: the bot repeats
// the question instead of silently dropping it.
const BUTTON_STEPS = ['type', 'purpose', 'district', 'condition'];
const TEXT_STEPS = ['specs', 'owner'];

const MAX_OBJECT_PHOTOS = 30;

function nextStep(step) {
  const i = STEPS.indexOf(step);
  return i === -1 || i === STEPS.length - 1 ? null : STEPS[i + 1];
}

function prevStep(step) {
  const i = STEPS.indexOf(step);
  return i <= 0 ? null : STEPS[i - 1];
}

function isTerminal(step) {
  return TERMINAL.includes(step);
}

// Going back drops this step's own answer: otherwise a changed mind leaves the
// old value behind and the confirm screen shows something nobody chose.
function clearStep(data, step) {
  const out = { ...data };
  for (const key of STEP_FIELDS[step] || []) delete out[key];
  return out;
}

function addPhotos(data, fileIds) {
  const have = Array.isArray(data.photos) ? data.photos : [];
  const room = MAX_OBJECT_PHOTOS - have.length;
  const added = fileIds.slice(0, Math.max(0, room));
  return {
    data: { ...data, photos: have.concat(added) },
    added: added.length,
    dropped: fileIds.length - added.length,
    total: have.length + added.length,
  };
}

function applyChoice(data, step, choice) {
  const out = { ...data };
  if (step === 'type') {
    out.propType = choice.label;
    if (choice.termId) out.siteTermId = choice.termId;
  } else if (step === 'district') {
    out.district = choice.label;
    if (choice.termId) out.districtTermId = choice.termId;
  } else if (step === 'purpose') {
    out.purpose = choice.label;
  } else if (step === 'condition') {
    out.condition = choice.value || choice.label;
  }
  return out;
}

// ── Parsing the one free-text line ──────────────────────────────────────────
// The manager types the numbers the way they say them out loud: "41500, 48 кв,
// 2 кімнати, 3 з 9" or "55 тис 60м 3к 5/9". Cyrillic matters here: \b and \w in
// JS are ASCII-only, so a word boundary around "кв" has to be written with
// Unicode property escapes.

const BOUND_L = '(?<![\\p{L}\\d])';
const BOUND_R = '(?![\\p{L}\\d])';

function rx(body, flags = 'iu') {
  return new RegExp(BOUND_L + body + BOUND_R, flags);
}

function num(value) {
  const n = parseFloat(String(value).replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseSpecs(text) {
  const src = String(text || '');
  const out = {};
  let rest = src;

  // Floor first: "3/9", "3 з 9", "7 поверх з 10", "поверх 3 з 9". Done before
  // anything else so its two numbers never get read as area or rooms. The word
  // between the numbers is optional, because people say it both ways.
  const floor = rest.match(rx('(\\d{1,2})\\s*(?:поверх\\p{L}*\\s*)?(?:/|із|з|из|iz)\\s*(\\d{1,2})'));
  if (floor) {
    out.floor = String(num(floor[1]));
    out.totalFloors = String(num(floor[2]));
    rest = rest.replace(floor[0], ' ');
  } else {
    const lone = rest.match(rx('поверх\\s*(\\d{1,2})'));
    if (lone) {
      out.floor = String(num(lone[1]));
      rest = rest.replace(lone[0], ' ');
    }
  }

  // Area: a number followed by м, м2, м², метри, кв, кв.м. The approved screen
  // offers "62 метри" as the example, so the word form has to parse too. The
  // right-hand boundary is what keeps "2 квартири" from reading as 2 м².
  const area = rest.match(rx('(\\d{1,4}(?:[.,]\\d{1,2})?)\\s*(?:кв\\.?\\s*м(?:етр\\p{L}*)?|кв|м²|м2|m2|m²|метр\\p{L}*|м)'));
  if (area) {
    out.area = String(num(area[1]));
    rest = rest.replace(area[0], ' ');
  }

  // Rooms: a number followed by к, кім, кімн, кімната in any form.
  const rooms = rest.match(rx('(\\d{1,2})\\s*(?:-?\\s*х?\\s*)?(?:кімнат\\p{L}*|кімн\\.?|кім\\.?|к)'));
  if (rooms) {
    out.rooms = String(num(rooms[1]));
    rest = rest.replace(rooms[0], ' ');
  }

  // Currency is decided before the price, because the symbol sits next to it.
  if (/[₴]|грн|гривень|гривні/iu.test(src)) out.currency = 'UAH';
  else if (/€|євро|eur/iu.test(src)) out.currency = 'EUR';
  else out.currency = 'USD';

  // Price: the largest number left, with "тис"/"k" multiplying by a thousand.
  let best = null;
  const priceRx = new RegExp(BOUND_L + '(\\d{1,3}(?:[ \\u00a0]\\d{3})+|\\d+(?:[.,]\\d{1,2})?)\\s*(тис\\p{L}*|k|к\\.?)?', 'giu');
  let m;
  while ((m = priceRx.exec(rest)) !== null) {
    let value = num(String(m[1]).replace(/[  ]/g, ''));
    if (value === null) continue;
    if (m[2]) value *= 1000;
    if (best === null || value > best) best = value;
  }
  if (best !== null) out.price = String(best);

  return out;
}

// "Оксана Дмитришин 0671234567" in any order; either part may be missing.
function parseOwner(text) {
  const src = String(text || '').trim();
  const out = {};
  const phone = src.match(/(\+?\d[\d\s()-]{7,}\d)/u);
  let rest = src;
  if (phone) {
    out.ownerPhone = phone[1].replace(/[^\d+]/g, '');
    rest = src.replace(phone[1], ' ');
  }
  const name = rest.replace(/[^\p{L}\s'’-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (name) out.ownerName = name;
  return out;
}

// What the confirm screen has to show, in the order the screens show it.
const SUMMARY_ORDER = [
  ['propType', 'Тип'],
  ['purpose', 'Продаж чи оренда'],
  ['district', 'Район'],
  ['condition', 'Стан'],
  ['price', 'Ціна'],
  ['area', 'Площа'],
  ['rooms', 'Кімнат'],
  ['floor', 'Поверх'],
  ['ownerName', 'Власник'],
  ['ownerPhone', 'Телефон власника'],
];

function missingRequired(data) {
  const need = [
    ['photos', 'фото'],
    ['propType', 'тип'],
    ['purpose', 'продаж чи оренда'],
    ['district', 'район'],
    ['condition', 'стан'],
    ['price', 'ціна'],
  ];
  return need
    .filter(([key]) => (key === 'photos' ? !(data.photos || []).length : !data[key]))
    .map(([, label]) => label);
}

module.exports = {
  STEPS,
  TERMINAL,
  STEP_FIELDS,
  BUTTON_STEPS,
  TEXT_STEPS,
  MAX_OBJECT_PHOTOS,
  SUMMARY_ORDER,
  nextStep,
  prevStep,
  isTerminal,
  clearStep,
  addPhotos,
  applyChoice,
  parseSpecs,
  parseOwner,
  missingRequired,
};
