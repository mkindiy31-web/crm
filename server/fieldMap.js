// Translates a property as the WordPress site stores it into the shape the CRM
// keeps in catalog_items.data, and back.
//
// The site's keys here are the ones its theme actually reads, measured on all 47
// published listings — not the ones the JetFormBuilder field map names. They
// differ in three places: address lives in property_address (not address),
// total floors in floor_all (not total-floors), rooms in rooms (not bedrooms).

// site key -> CRM key, for the plain scalar fields
const SCALARS = {
  post_title: 'title',
  property_address: 'address',
  post_content: 'description',
  price: 'price',
  currency: 'currency',
  area: 'area',
  rooms: 'rooms',
  floor: 'floor',
  floor_all: 'totalFloors',
  phone: 'ownerPhone',
};

// taxonomy on the site -> CRM key
const TAXONOMIES = {
  'jet_tax__property-type': 'propType',
  'jet_tax__purpose': 'purpose',
  'jet_tax__location': 'district',
  'jet_tax__type-of-housing': 'condition',
};

// The two lists were built separately and do not match term for term: the CRM
// has Гараж and Інше, the site calls houses Будинки where the CRM says Будинок.
// Reconciled here rather than by renaming anything in the client's site.
const PROP_TYPE_TO_CRM = {
  'Квартира': 'Квартира',
  'Будинки': 'Будинок',
  'Будинок': 'Будинок',
  'Земля': 'Земля',
  'Комерція': 'Комерція',
};

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toGallery(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  if (!text) return [];
  return text.split(',').map(s => s.trim()).filter(Boolean);
}

// Returns { item, errors }. Never throws: a malformed event must come back as a
// 400 naming the field, not as a 500.
function siteToCrm(postId, fields) {
  const errors = [];
  const f = fields && typeof fields === 'object' ? fields : {};
  const item = { id: `site-${postId}`, sitePostId: Number(postId) || null };

  for (const [siteKey, crmKey] of Object.entries(SCALARS)) {
    const value = clean(f[siteKey]);
    if (value) item[crmKey] = value;
  }
  for (const [siteKey, crmKey] of Object.entries(TAXONOMIES)) {
    const value = clean(f[siteKey]);
    if (value) item[crmKey] = value;
  }

  if (item.propType) item.propType = PROP_TYPE_TO_CRM[item.propType] || item.propType;

  const photos = toGallery(f.gallery);
  const thumb = clean(f._thumbnail_id || f.thumb);
  if (thumb && !photos.includes(thumb)) photos.unshift(thumb);
  if (photos.length) item.photos = photos;

  if (!item.title && !item.address) errors.push('post_title або property_address');
  if (!Number(postId)) errors.push('post_id');

  return { item, errors };
}

module.exports = { siteToCrm, SCALARS, TAXONOMIES, PROP_TYPE_TO_CRM };
