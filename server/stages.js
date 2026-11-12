// Server-side mirror of the funnel stage names defined in crm.html's STAGES
// array — kept here so AI prompts and text-command parsing can reference real
// stage names without duplicating the list inline everywhere. If the funnel
// structure changes in crm.html, update this list to match.
const STAGES = [
  { id: 0, name: '1. Новий лід', prob: 5 },
  { id: 1, name: '2. Зателефонувати', prob: 15 },
  { id: 2, name: '3. Призначено консультацію', prob: 30 },
  { id: 3, name: '4. Підбір', prob: 45 },
  { id: 4, name: '5. Огляд', prob: 60 },
  { id: 5, name: '6. Бронювання', prob: 80 },
  { id: 6, name: '7. Угода', prob: 100 },
  { id: 7, name: '8. Постійні інвестори', prob: null },
];

// The closed/won stage, found by its prob:100 marker rather than a hardcoded
// id — exactly as crm.html does it, so both sides shift together when a stage
// is inserted, removed or reordered.
const DEAL_STAGE_ID = STAGES.find(s => s.prob === 100)?.id ?? STAGES.length - 1;

// The agency's cut: 1.3% of the middle of the client's budget range. Same
// formula as calcCommission() in crm.html; a second, drifting copy of it would
// show the manager one number in the bot and another in the CRM.
function commissionOf(client) {
  const min = parseFloat(client && client.budgetMin) || 0;
  const max = parseFloat(client && client.budgetMax) || 0;
  const budget = min > 0 && max > 0 ? (min + max) / 2 : (max || min);
  return budget > 0 ? budget * 0.013 : 0;
}

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

module.exports = { STAGES, DEAL_STAGE_ID, findStageIdByName, commissionOf };
