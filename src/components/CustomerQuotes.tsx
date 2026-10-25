import { useState } from 'react';
import { Check, MessageCircle } from 'lucide-react';
import { areasOf, cad, coversProject, quoteAvailable, proposalLabel, proposalExpired, type MarketReport } from '../lib/marketplace';
import { ProposalDetails } from './ProjectQuoteForm';

type QuoteAction = 'decline' | 'undo-decline' | 'archive' | 'restore';
export default function CustomerQuotes({ report, busy, onAction, onChoose, onMessage }: {
  report: MarketReport; busy: boolean; onAction: (id: string, action: QuoteAction) => void;
  onChoose: (id: string) => void; onMessage: (companyId: string) => void;
}) {
  const [archived, setArchived] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const archivedCount = report.quotes.filter(quote => quote.archivedAt).length;
  const visible = report.quotes.filter(quote => Boolean(quote.archivedAt) === archived).sort((a, b) => Number(b.id === report.selectedQuoteId) - Number(a.id === report.selectedQuoteId) || Number(quoteAvailable(b)) - Number(quoteAvailable(a)) || a.amount - b.amount);
  const areas = areasOf(report);
  return <>
    {!!report.quotes.length && <div className="market-quote-filter"><select aria-label="Show quotes" value={archived ? 'archived' : 'current'} onChange={event => { setArchived(event.target.value === 'archived'); setConfirm(null); }}><option value="current">Current quotes ({report.quotes.length - archivedCount})</option><option value="archived">Archived quotes ({archivedCount})</option></select></div>}
    {visible.map(quote => {
      const contractor = report.recipients.find(item => item.id === quote.companyId);
      const chosen = report.selectedQuoteId === quote.id;
      const requested = report.preliminarySelection?.quoteId === quote.id && report.preliminarySelection?.revision === quote.revision;
      const available = quoteAvailable(quote);
      return <article className={`market-panel market-quote-card${chosen ? ' is-chosen' : ''}${!available ? ' is-inactive' : ''}`} key={quote.id}>
        <header><h3>{contractor?.name}</h3>{chosen || requested ? <span className="market-chosen"><Check size={14} />{chosen ? 'Chosen' : 'Follow-up requested'}</span> : (quote.declinedAt || quote.withdrawnAt || proposalExpired(quote)) && <span className="market-status">{quote.withdrawnAt ? 'Withdrawn' : quote.declinedAt ? 'Declined' : 'Expired'}</span>}</header>
        <p className="project-quote-label">{coversProject(report, quote) ? `Entire project · ${areas.length} area${areas.length === 1 ? '' : 's'}` : 'Coverage needs confirmation'}</p>
        <div className="market-quote-price">{quote.amount === 0 ? 'Free' : cad(quote.amount)}<small>{proposalLabel(quote)} · CAD · {quote.proposalVersion ? quote.taxMode === 'none' ? 'No tax charged' : 'Includes HST' : quote.taxIncluded ? 'Tax included' : 'Plus tax'}{quote.simulated ? ' · Sample' : ''}</small></div>
        {quote.proposalKind === 'estimate' && <p className="market-small">Indicative pricing, subject to contractor assessment. This is not a confirmed work price.</p>}
        {quote.proposalKind === 'assessment' && <p className="market-small">Assessment visit only. Remediation work needs a separate proposal.</p>}
        {!quote.proposalVersion && !chosen && <p className="market-small">Ask for an updated itemized proposal before choosing this contractor.</p>}
        <p>{quote.scope}</p><ProposalDetails quote={quote} areas={areas} /><p className="market-availability">{quote.availability}{quote.validUntil ? ` · Valid through ${quote.validUntil}` : ''}</p>
        <div className="market-quote-actions"><button className="btn btn-secondary" onClick={() => onMessage(quote.companyId)}>Message<MessageCircle size={16} /></button>{!report.selectedQuoteId && !requested && available && !archived && !!quote.proposalVersion && <button className="btn btn-primary" disabled={busy || !coversProject(report, quote)} onClick={() => setConfirm(quote.id)}>{quote.proposalKind === 'assessment' ? 'Request assessment' : quote.proposalKind === 'estimate' ? 'Discuss estimate' : 'Choose quote'}</button>}</div>
        <div className="market-quiet-actions">{!archived && !chosen && !requested && (quote.declinedAt ? <button className="market-text-button" disabled={busy} onClick={() => onAction(quote.id, 'undo-decline')}>Undo decline</button> : available && <button className="market-text-button" disabled={busy} onClick={() => { setConfirm(null); onAction(quote.id, 'decline'); }}>Decline quote</button>)}<button className="market-text-button" disabled={busy} onClick={() => { setConfirm(null); onAction(quote.id, archived ? 'restore' : 'archive'); }}>{archived ? 'Restore quote' : 'Remove quote'}</button></div>
        {confirm === quote.id && available && !archived && !report.selectedQuoteId && <div className="market-confirm"><p>{quote.proposalKind === 'fixed_quote' ? `Choose ${contractor?.name} for this work scope?` : `Request ${quote.proposalKind === 'assessment' ? 'an assessment visit' : 'estimate follow-up'} with ${contractor?.name}? Remediation has not been awarded.`} Your email and phone will be shared with them. Arrange booking, contracts and payments directly. This app takes no payment.</p><div><button className="btn btn-secondary" onClick={() => setConfirm(null)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => onChoose(quote.id)}>Confirm</button></div></div>}
      </article>;
    })}
    {!visible.length && !!report.quotes.length && <div className="market-empty"><p>{archived ? 'No archived quotes.' : 'No current quotes.'}</p>{!archived && !!archivedCount && <button className="market-text-button" onClick={() => setArchived(true)}>View archived quotes</button>}</div>}
  </>;
}
