export function confirmedQuote(amount = 299.99, coveredAreaIds = ['basement'], overrides = {}) {
  return { proposalKind: 'fixed_quote', assessmentBasis: 'site_visit', assessedOn: new Date().toISOString().slice(0, 10), assessmentNotes: 'Fixture assessment of the full project; access and materials reviewed.',
    amount, scope: 'Inspection and moisture readings across the full project. Repairs excluded.', availability: 'Tuesday morning', duration: 'One visit',
    moisturePlan: 'Inspect the window leak; the owner arranges separate repair.', exclusions: 'Rebuilding, hidden damage and lab testing excluded.', clearancePlan: 'Written findings provided; clearance testing is separately arranged if needed.',
    paymentTerms: 'Balance due after the visit. Additional work requires written approval.', depositAmount: 0, taxMode: 'none',
    validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), coveredAreaIds,
    lineItems: [{ category: 'assessment', description: 'Whole-project inspection and written findings', quantity: 1, unit: 'job', unitPrice: amount, areaIds: coveredAreaIds }], ...overrides };
}
