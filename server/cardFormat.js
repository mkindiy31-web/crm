// A client card written by the server (site request, bot panel) has to look
// exactly like one the CRM page wrote itself: crm.html reads `notes` as text,
// shows `date`, counts by `dateISO`, keys tasks by type ('call', ...) and
// keeps a `history` list. A card in any other shape shows "undefined" on the
// board and breaks the search box (c.notes.toLowerCase on an array).
const KYIV = 'Europe/Kyiv';

const isoKyiv = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: KYIV });
const dateUA = (d = new Date()) => d.toLocaleDateString('uk-UA', { timeZone: KYIV, day: '2-digit', month: '2-digit', year: 'numeric' });
const timeUA = (d = new Date()) => d.toLocaleTimeString('uk-UA', { timeZone: KYIV, hour: '2-digit', minute: '2-digit' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

// Same entry crm.html's addHistory() makes, newest first, last 100 kept.
function addHistory(card, type, text) {
  const now = new Date();
  const history = Array.isArray(card.history) ? card.history.slice() : [];
  history.unshift({ id: uid(), type, text, result: '', date: dateUA(now), time: timeUA(now) });
  history.length = Math.min(history.length, 100);
  return { ...card, history };
}

// Notes are one text field in the CRM. Cards made before this fix may hold a
// list of { at, text }; it is folded into text the first time it is touched.
function notesText(notes) {
  if (Array.isArray(notes)) return notes.map(n => (n && n.text) || '').filter(Boolean).join('\n\n');
  return typeof notes === 'string' ? notes : '';
}

function appendNote(card, line) {
  const was = notesText(card.notes);
  return { ...card, notes: was ? was + '\n\n' + line : line };
}

// "1. Новий лід" -> "Новий лід": the bot shows the stage name without its
// funnel number everywhere (list, card, button, confirmation).
const stageLabel = stage => (stage && stage.name ? stage.name.replace(/^\d+\.\s*/, '') : '');

// Object status words are the CRM's own (catalog badge and select). The bot
// and the public object page use the same four, lower-cased mid-sentence.
// 'withdrawn' is an owner taking the object off the market, not a sale.
const OBJECT_STATUS = { available: 'Вільно', reserved: 'Резерв', sold: 'Продано', withdrawn: 'Знято' };
const objectStatusLabel = status => OBJECT_STATUS[status] || OBJECT_STATUS.available;

// «1 кімната», «2 кімнати», «5 кімнат», «21 кімната»; не число лишається як є.
function roomsLabel(rooms) {
  const s = String(rooms == null ? '' : rooms).trim();
  if (!/^\d+$/.test(s)) return s + ' кімнати';
  const n = Number(s), d = n % 10, dd = n % 100;
  const word = d === 1 && dd !== 11 ? 'кімната' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'кімнати' : 'кімнат';
  return `${n} ${word}`;
}

// Площа так, як її пишуть люди: «40,1 м²», а не «40.1 м²».
function areaLabel(area) {
  const s = String(area == null ? '' : area).trim();
  return s ? s.replace('.', ',') + ' м²' : '';
}

// «Під запит Діми»: імʼя клієнта в родовому відмінку. Лише перше слово і лише
// кирилицею; що правилом не відмінюється певно, дає «клієнта».
const GENITIVE_EXCEPTIONS = { 'ігор': 'Ігоря', 'любов': 'Любові', 'лев': 'Лева' };
function genitiveName(name) {
  const w = String(name == null ? '' : name).trim().split(/\s+/)[0] || '';
  if (!/^[А-ЩЬЮЯҐЄІЇа-щьюяґєії\u02bc'’-]{2,}$/u.test(w) || /^клієнт/iu.test(w)) return 'клієнта';
  const low = w.toLowerCase();
  if (GENITIVE_EXCEPTIONS[low]) return GENITIVE_EXCEPTIONS[low];
  const caps = w === w.toUpperCase(); // «ВОЛКАЧ» дає «ВОЛКАЧА», не «ВОЛКАЧа»
  const cut = (n, end) => w.slice(0, w.length - n) + (caps ? end.toUpperCase() : end);
  if (/ія$/u.test(low)) return cut(1, 'ї');
  if (/я$/u.test(low)) return cut(1, 'і');
  if (/[жчшщ]а$/u.test(low)) return cut(1, 'і');
  if (/а$/u.test(low)) return cut(1, 'и');
  if (/о$/u.test(low)) return cut(1, 'а');
  if (/[йь]$/u.test(low)) return cut(1, 'я');
  if (/[бвгґдзклмнпрстфхцжчш]$/u.test(low)) return cut(0, 'а');
  return 'клієнта';
}

// Перше слово імені, якщо воно кириличне імʼя, а не «Клієнт» чи «Без імені».
function firstNameOf(name) {
  const w = String(name == null ? '' : name).trim().split(/\s+/)[0] || '';
  return /^[А-ЩЬЮЯҐЄІЇа-щьюяґєії\u02bc'’-]{2,}$/u.test(w) && !/^(клієнт|без)/iu.test(w) ? w : '';
}
// Чоловічі імена на -а, -я, які інакше пішли б за жіночі.
const MALE_A = new Set(['микола', 'ілля', 'кузьма', 'сава', 'лука', 'фома', 'нікіта', 'никита', 'хома', 'юда']);
function isFemaleName(name) {
  const w = firstNameOf(name).toLowerCase();
  return /[ая]$/u.test(w) && !MALE_A.has(w);
}
// «Ірину», «Олега»: знахідний відмінок імені. Порожньо, коли певно не відмінюється.
function accusativeFirst(name) {
  const w = firstNameOf(name);
  if (!w) return '';
  // «Ірину», «Миколу», «Іллю»: на -а, -я знахідний однаковий для жіночих і чоловічих.
  if (/[ая]$/u.test(w)) return w.replace(/а$/u, 'у').replace(/я$/u, 'ю');
  const g = genitiveName(w);
  return g === 'клієнта' ? '' : g;
}

module.exports = { isoKyiv, dateUA, timeUA, uid, addHistory, notesText, appendNote, stageLabel, OBJECT_STATUS, objectStatusLabel, roomsLabel, areaLabel, genitiveName, firstNameOf, isFemaleName, accusativeFirst };
