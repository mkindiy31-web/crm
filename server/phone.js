function normalizePhone(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  // A leading "+" is an explicit "this is already a full international number"
  // signal — skip the Ukraine-local shorthand rules below so a foreign number
  // that happens to be 9 or 10 digits after its country code isn't mistaken
  // for an incomplete Ukrainian one (e.g. "+33 6 12 34 56 78").
  const isExplicitIntl = str.startsWith('+');
  let d = str.replace(/\D/g, '');
  if (!d) return null;
  if (!isExplicitIntl) {
    if (d.startsWith('0') && d.length === 10) d = '38' + d;
    else if (d.length === 9) d = '380' + d;
  }
  return d;
}

module.exports = { normalizePhone };
