import { HttpError } from './validation.mjs';

export const proposalCategories = ['assessment', 'containment', 'removal', 'cleaning', 'drying', 'moisture_repair', 'disposal', 'clearance', 'restoration', 'other'];
const fail = message => { throw new HttpError(400, message); };
const note = (value, label, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`Enter ${label} (up to ${max} characters).`);
  return value.trim();
};
const money = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) fail(`Enter a valid ${label}, with up to two decimal places.`);
  return Math.round(value * 100);
};
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const proposalExpired = quote => Boolean(quote.validUntil && `${quote.validUntil}T23:59:59.999Z` < new Date().toISOString());

export function validateProposal(body, areaIds) {
  if (!['assessment', 'estimate', 'fixed_quote'].includes(body.proposalKind)) fail('Choose an assessment visit, preliminary estimate, or confirmed quote.');
  if (!['screening', 'virtual', 'site_visit'].includes(body.assessmentBasis)) fail('Choose how this project was assessed.');
  const today = new Date().toISOString().slice(0, 10);
  if (body.proposalKind === 'fixed_quote' && body.assessmentBasis === 'screening') fail('A confirmed quote needs a contractor virtual assessment or site visit first.');
  let assessedOn = null;
  if (body.assessmentBasis !== 'screening') {
    if (!dateOnly(body.assessedOn) || body.assessedOn > today) fail('Enter a valid completed assessment date.');
    assessedOn = body.assessedOn;
  }
  if (!dateOnly(body.validUntil) || body.validUntil < today || Date.parse(body.validUntil) > Date.now() + 366 * 86400000) fail('Choose a valid proposal expiry date within the next year.');
  if (!Array.isArray(body.lineItems) || !body.lineItems.length || body.lineItems.length > 30) fail('Add between 1 and 30 itemized services.');
  const lineItems = body.lineItems.map(item => {
    if (!item || !proposalCategories.includes(item.category)) fail('Choose a service category for each line.');
    if (!['job', 'hour', 'sq_ft', 'sample', 'day', 'each'].includes(item.unit)) fail('Choose a valid pricing unit.');
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 100000 || Math.abs(item.quantity * 1000 - Math.round(item.quantity * 1000)) > 0.00001) fail('Enter a positive quantity with up to three decimal places.');
    const unitCents = money(item.unitPrice, 'unit price');
    const assigned = item.areaIds ?? [];
    if (!Array.isArray(assigned) || new Set(assigned).size !== assigned.length || assigned.some(id => !areaIds.includes(id))) fail('A service line can only refer to areas in this project.');
    if (body.proposalKind === 'assessment' && !['assessment', 'clearance', 'other'].includes(item.category)) fail('Assessment offers must price assessment services, not remediation work.');
    const totalCents = Math.round(unitCents * item.quantity);
    if (totalCents > 10000000) fail('A service line cannot exceed $100,000.');
    return { description: note(item.description, 'a service description', 300), category: item.category, unit: item.unit, quantity: item.quantity, unitPrice: unitCents / 100, areaIds: assigned, total: totalCents / 100 };
  });
  const lineCents = lineItems.reduce((sum, item) => sum + Math.round(item.total * 100), 0);
  if (lineCents > 10000000 || lineCents === 0 && body.proposalKind !== 'assessment') fail('Project pricing must be between $1 and $100,000, or a free assessment visit.');
  if (lineCents > 0 && lineCents < 100) fail('Enter at least $1, or offer a free assessment.');
  if (!['none', 'hst13', 'included_hst13'].includes(body.taxMode)) fail('Choose how tax is charged.');
  const taxCents = body.taxMode === 'hst13' ? Math.round(lineCents * 0.13) : body.taxMode === 'included_hst13' ? Math.round(lineCents * 13 / 113) : 0;
  const totalCents = body.taxMode === 'hst13' ? lineCents + taxCents : lineCents;
  if (totalCents > 10000000) fail('The total including tax cannot exceed $100,000.');
  if (body.amount !== undefined && money(body.amount, 'project total') !== totalCents) fail('The project total must match its itemized prices and tax.');
  const depositCents = money(body.depositAmount ?? 0, 'deposit');
  if (depositCents > totalCents) fail('The requested deposit cannot exceed the project total.');
  if (body.warranty !== undefined && (typeof body.warranty !== 'string' || body.warranty.length > 1000)) fail('Enter warranty terms up to 1,000 characters, or leave them blank.');
  return {
    proposalVersion: 2, proposalKind: body.proposalKind, assessmentBasis: body.assessmentBasis, assessedOn,
    assessmentNotes: note(body.assessmentNotes, 'assessment findings or assumptions'),
    scope: note(body.scope, 'the whole-project scope'), moisturePlan: note(body.moisturePlan, 'the moisture source and who will address it'),
    exclusions: note(body.exclusions, 'exclusions and hidden-condition assumptions'), clearancePlan: note(body.clearancePlan, 'the verification or clearance plan'),
    warranty: typeof body.warranty === 'string' ? body.warranty.trim() : '',
    availability: note(body.availability, 'availability', 150), duration: note(body.duration, 'the estimated work duration', 150),
    validUntil: body.validUntil, paymentTerms: note(body.paymentTerms, 'payment terms', 1000), depositAmount: depositCents / 100,
    lineItems, taxMode: body.taxMode, lineItemsTotal: lineCents / 100,
    subtotal: (body.taxMode === 'included_hst13' ? lineCents - taxCents : lineCents) / 100,
    taxAmount: taxCents / 100, amount: totalCents / 100, taxIncluded: true,
  };
}
