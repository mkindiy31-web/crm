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

module.exports = { isoKyiv, dateUA, timeUA, uid, addHistory, notesText, appendNote, stageLabel };
