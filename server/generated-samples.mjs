export function generatedSampleQuote(quote) {
  if (!quote.simulated || quote.createdBy === 'contractor' || (quote.revision || 1) > 1) return false;
  return quote.assessmentNotes === 'Example only: based on the submitted screening; extent and access remain unverified.'
    && quote.lineItems?.length === 1 && quote.lineItems[0].description === 'Whole-project assessment and written plan'
    || !quote.proposalVersion && /^Demo project quote:/i.test(quote.scope || '');
}

// Retire generated filler reversibly; contractor-written/revised quotes stay active.
export function retireGeneratedSamples(records) {
  const filler = records.quotes.filter(generatedSampleQuote);
  if (!filler.length) return;
  const ids = new Set(filler.map(quote => quote.id));
  const retired = records.retiredSampleQuotes ||= [];
  for (const quote of filler) if (!retired.some(item => item.id === quote.id)) retired.push(quote);
  records.quotes = records.quotes.filter(quote => !ids.has(quote.id));
  for (const report of records.reports) {
    if (!ids.has(report.selectedQuoteId) && !ids.has(report.preliminarySelection?.quoteId)) continue;
    (records.retiredSampleSelections ||= []).push({ reportId: report.id, selectedQuoteId: report.selectedQuoteId, preliminarySelection: report.preliminarySelection, retiredAt: new Date().toISOString() });
    if (ids.has(report.selectedQuoteId)) { report.selectedQuoteId = null; if (report.status === 'chosen') report.status = 'shared'; }
    if (ids.has(report.preliminarySelection?.quoteId)) report.preliminarySelection = null;
  }
}
