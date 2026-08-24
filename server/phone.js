function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0') && d.length === 10) d = '38' + d;
  else if (d.length === 9) d = '380' + d;
  return d;
}

module.exports = { normalizePhone };
