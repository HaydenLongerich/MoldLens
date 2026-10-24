export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const STATUSES = ['New', 'In review', 'Scheduled', 'Completed', 'Referred'];
export const PRIORITIES = ['Low', 'Medium', 'High'];
const PROPERTY_TYPES = ['House', 'Apartment', 'Commercial', 'Not specified'];
const AREAS = ['Basement', 'Bathroom', 'Attic', 'Kitchen', 'Living area', 'Other', 'Not specified'];
const SIGNS = ['Visible spots or discolouration', 'Musty smell', 'Water damage', 'Condensation', 'Not sure yet'];
const SIZES = ['Small — under 1 m²', 'Medium — 1 to 3 m²', 'Large — over 3 m²', 'Not sure'];
const DURATIONS = ['In the last few days', '1–4 weeks ago', 'More than a month ago', 'Not sure'];
const CONTACT_METHODS = ['Email', 'Phone call', 'Text message'];
const RELATIONSHIPS = ['Homeowner', 'Tenant', 'Property manager', 'Authorized representative', 'Not specified'];

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Please provide valid request details.');
}
function text(value, label, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${label} is required.`);
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(cleaned)) throw new HttpError(400, `${label} must be between ${min} and ${max} characters.`);
  return cleaned;
}
function choice(value, choices, label) {
  if (!choices.includes(value)) throw new HttpError(400, `Please select a valid ${label}.`);
  return value;
}

export function validateIntake(input) {
  object(input);
  const name = text(input.name, 'Full name', { min: 2, max: 100 });
  const email = text(input.email, 'Email', { max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  const contactPreference = choice(input.contactPreference ?? 'Email', CONTACT_METHODS, 'contact preference');
  const phone = text(input.phone ?? '', 'Phone number', { min: 0, max: 40 });
  if (phone && (!/^[+\d\s().-]+$/.test(phone) || phone.replace(/\D/g, '').length < 10 || phone.replace(/\D/g, '').length > 15)) throw new HttpError(400, 'Please enter a valid phone number with 10 to 15 digits.');
  if (contactPreference !== 'Email' && !phone) throw new HttpError(400, 'Please add a phone number for your preferred contact method.');
  const address = text(input.address ?? '', 'Property address', { min: 0, max: 300 });
  const postal = text(input.postalCode, 'Postal code', { max: 8 }).toUpperCase().replace(/[ -]/g, '');
  if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(postal)) throw new HttpError(400, 'Please enter a valid Canadian postal code.');
  if (input.consent !== true) throw new HttpError(400, 'Your permission is required to save and review this request.');
  const signs = input.signs ?? [];
  if (!Array.isArray(signs) || signs.length > SIGNS.length || signs.some((sign) => !SIGNS.includes(sign))) throw new HttpError(400, 'Please select valid signs of concern.');
  return {
    name, email, phone, address, postalCode: `${postal.slice(0, 3)} ${postal.slice(3)}`,
    propertyType: choice(input.propertyType ?? 'Not specified', PROPERTY_TYPES, 'property type'),
    area: choice(input.area ?? 'Not specified', AREAS, 'affected area'),
    size: choice(input.size ?? 'Not sure', SIZES, 'affected size'),
    duration: choice(input.duration ?? 'Not sure', DURATIONS, 'timeframe'),
    description: text(input.description, 'Description', { min: 10, max: 5000 }),
    signs: [...new Set(signs)],
    contactPreference,
    relationship: choice(input.relationship ?? 'Not specified', RELATIONSHIPS, 'relationship to the property'),
    consent: true,
  };
}

export function validateUpdates(input) {
  object(input);
  const keys = Object.keys(input);
  const allowed = ['status', 'priority', 'assignee', 'scheduledAt'];
  if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new HttpError(400, 'Only status, priority, assigned team member, and inspection time can be updated.');
  const updates = {};
  if ('status' in input) updates.status = choice(input.status, STATUSES, 'status');
  if ('priority' in input) updates.priority = choice(input.priority, PRIORITIES, 'priority');
  if ('assignee' in input) updates.assignee = text(input.assignee, 'Assigned team member', { min: 0, max: 100 });
  if ('scheduledAt' in input) {
    if (input.scheduledAt === '') updates.scheduledAt = '';
    else {
      if (typeof input.scheduledAt !== 'string' || input.scheduledAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.scheduledAt) || !Number.isFinite(Date.parse(input.scheduledAt))) throw new HttpError(400, 'Please select a valid inspection date and time.');
      const calendarDate = input.scheduledAt.slice(0, 10);
      if (new Date(`${calendarDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== calendarDate) throw new HttpError(400, 'Please select a valid inspection date and time.');
      updates.scheduledAt = new Date(input.scheduledAt).toISOString();
    }
  }
  return updates;
}

export function validateNote(input) {
  object(input);
  return text(input.text, 'Note', { max: 3000 });
}
