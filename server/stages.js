// Server-side mirror of the funnel stage names defined in crm.html's STAGES
// array — kept here so AI prompts and text-command parsing can reference real
// stage names without duplicating the list inline everywhere. If the funnel
// structure changes in crm.html, update this list to match.
const STAGES = [
  { id: 0, name: '1. Новий лід' },
  { id: 1, name: '2. Зателефонувати' },
  { id: 2, name: '3. Призначено консультацію' },
  { id: 3, name: '4. Підбір' },
  { id: 4, name: '5. Огляд' },
  { id: 5, name: '6. Бронювання' },
  { id: 6, name: '7. Угода' },
  { id: 7, name: '8. Постійні інвестори' },
];

// Looks up a stage by name as returned by the AI extraction. Tries, in order:
// exact match (e.g. "4. Підбір"), a bare number (e.g. "4" or "4."), and a
// match against the name with its "N. " prefix stripped (e.g. "Підбір") —
// the model usually returns the exact quoted string, but this tolerates the
// odd case where it drops the number or the punctuation differs.
function findStageIdByName(name) {
  if (!name) return null;
  const clean = name.trim().toLowerCase();

  const exact = STAGES.find(s => s.name.toLowerCase() === clean);
  if (exact) return exact.id;

  const numMatch = clean.match(/^(\d+)\.?$/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    const byNumber = STAGES.find(s => s.name.startsWith(`${n}.`));
    if (byNumber) return byNumber.id;
  }

  const byBareName = STAGES.find(s => s.name.replace(/^\d+\.\s*/, '').toLowerCase() === clean);
  return byBareName ? byBareName.id : null;
}

// The closed/won stage — found by name rather than a hardcoded id, same
// reasoning as DEAL_STAGE_ID in crm.html (stage ids shift whenever a stage
// is inserted/removed/reordered).
const DEAL_STAGE_ID = STAGES.find(s => s.name.replace(/^\d+\.\s*/, '') === 'Угода')?.id ?? null;

module.exports = { STAGES, findStageIdByName, DEAL_STAGE_ID };
