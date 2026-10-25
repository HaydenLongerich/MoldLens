import test from 'node:test';
import assert from 'node:assert/strict';
import { retireGeneratedSamples } from '../server/generated-samples.mjs';

test('filler quote cleanup preserves contractor proposals and reopens only synthetic selections', () => {
  const generated = { id: 'generated', simulated: true, revision: 1, proposalVersion: 2, assessmentNotes: 'Example only: based on the submitted screening; extent and access remain unverified.', lineItems: [{ description: 'Whole-project assessment and written plan' }] };
  const manual = { ...generated, id: 'manual', createdBy: 'contractor' };
  const revised = { ...generated, id: 'revised', revision: 2, scope: 'Contractor revised this proposal.' };
  const records = { quotes: [generated, manual, revised], reports: [
    { id: 'sample', selectedQuoteId: 'generated', status: 'chosen' },
    { id: 'follow-up', selectedQuoteId: null, preliminarySelection: { quoteId: 'generated' }, status: 'shared' },
    { id: 'real-choice', selectedQuoteId: 'manual', status: 'chosen' },
  ] };
  retireGeneratedSamples(records);
  assert.deepEqual(records.quotes.map(q => q.id), ['manual', 'revised']);
  assert.equal(records.retiredSampleQuotes[0].id, 'generated');
  assert.equal(records.reports[0].selectedQuoteId, null); assert.equal(records.reports[0].status, 'shared');
  assert.equal(records.reports[1].preliminarySelection, null);
  assert.equal(records.reports[2].selectedQuoteId, 'manual'); assert.equal(records.reports[2].status, 'chosen');
  retireGeneratedSamples(records);
  assert.equal(records.retiredSampleQuotes.length, 1); assert.equal(records.retiredSampleSelections.length, 2);
});
