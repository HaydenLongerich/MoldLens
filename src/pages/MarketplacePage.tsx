import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, LogOut, Plus, RefreshCw, Send, SlidersHorizontal, Trash2, Undo2 } from 'lucide-react';
import { marketplace, areasOf, projectTitle, quoteAvailable, quoteCountOf, memberActive, type Company, type MarketReport, type RemovedScreening, type CustomerContact } from '../lib/marketplace';
import ProjectReview from '../components/ProjectReview';
import ProjectQuoteForm from '../components/ProjectQuoteForm';
import CustomerQuotes from '../components/CustomerQuotes';
import CustomerContactForm from '../components/CustomerContactForm';
import ContractorMembership from '../components/ContractorMembership';
import { screeningApi } from '../lib/screening-api';
import { SCREENING_AREAS, type Screening } from '../lib/screening-types';
import './marketplace.css';

const issue = (cause: unknown) => cause instanceof Error ? cause.message : 'Please try again.';
const keyOf = (report: MarketReport) => report.screening?.id || report.id;
const date = (value: string) => new Date(value).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
const stages: Record<string, string> = { draft: 'Draft', uploading: 'Uploading', queued: 'Processing', processing: 'Processing', needs_answers: 'Needs answers', failed: 'Needs review', ready_preview: 'Ready', inconclusive: 'Ready' };
function status(report: MarketReport) {
  if (report.selectedQuoteId) return 'Contractor chosen';
  if (report.preliminarySelection) return 'Follow-up requested';
  const count = quoteCountOf(report);
  if (count) return `${count} quote${count === 1 ? '' : 's'}`;
  if (report.screening?.reportAvailable && report.id.startsWith('pending-')) return 'Report ready';
  if (report.screening && !report.screening.reportAvailable) return stages[report.screening.status] || 'Processing';
  return report.status === 'draft' ? 'Draft' : report.recipientIds.length ? 'Awaiting quotes' : 'Awaiting local contractors';
}
function partnerStatus(report: MarketReport) {
  if (report.selectedQuoteId) return report.quotes.some(quote => quote.id === report.selectedQuoteId) ? 'Your quote chosen' : 'Closed';
  if (report.preliminarySelection) return 'Follow-up requested';
  if (report.response?.declinedAt) return report.quotes.length ? 'Quote withdrawn' : 'Declined to bid';
  if (report.quotes.some(quote => quote.declinedAt)) return 'Quote declined';
  if (report.quotes.some(quoteAvailable)) return 'Quoted';
  return 'Awaiting quote';
}
function inView(report: MarketReport, filter: string) {
  if (filter === 'archived') return Boolean(report.response?.archivedAt);
  if (report.response?.archivedAt) return false;
  const state = partnerStatus(report);
  return filter === 'all' || filter === 'awaiting' && state === 'Awaiting quote' || filter === 'quoted' && ['Quoted', 'Follow-up requested'].includes(state) || filter === 'chosen' && Boolean(report.selectedQuoteId) || filter === 'declined' && ['Quote declined', 'Quote withdrawn', 'Declined to bid'].includes(state);
}
function pending(item: Screening): MarketReport {
  return { id: `pending-${item.id}`, screening: { id: item.id, reference: item.reference, status: item.status, reportAvailable: item.reportAvailable }, city: 'Newmarket', area: item.details?.areas.map(id => SCREENING_AREAS.find(([value]) => value === id)?.[1] || id).join(', ') || 'Screening', projectAreas: item.details?.areas.map(id => ({ id, label: SCREENING_AREAS.find(([value]) => value === id)?.[1] || id, description: '', findings: [] })), description: item.details?.statement || '', createdAt: item.createdAt || new Date().toISOString(), isSample: false, status: ['draft', 'uploading'].includes(item.status) ? 'draft' : 'processing', recipientIds: [], selectedQuoteId: null, broadcastAt: null, recipients: [], quotes: [], messages: [] };
}

function PartnerLogin({ companies, demo, onSignedIn }: { companies: Company[]; demo: boolean; onSignedIn: () => void }) {
  const [create, setCreate] = useState(false); const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [companyId, setCompanyId] = useState('moldtech'); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event?: FormEvent, example = false) {
    event?.preventDefault(); setBusy(true); setError('');
    try { if (example) await marketplace.demo(companyId); else if (create) await marketplace.register(name, email, password); else await marketplace.signIn(email, password); onSignedIn(); }
    catch (cause) { setError(issue(cause)); } finally { setBusy(false); }
  }
  return <section className="market-login market-panel"><h1>{create ? 'Create company account' : 'Contractor sign in'}</h1><form onSubmit={event => void submit(event)}>
    {create && <label>Company<input autoComplete="organization" value={name} onChange={event => setName(event.target.value)} required maxLength={100} /></label>}
    <label>Email<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label>
    <label>Password<input type="password" autoComplete={create ? 'new-password' : 'current-password'} required minLength={create ? 12 : 1} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></label>
    {create && <div className="membership-signup-price"><strong>$100 CAD / month</strong><p>Contractor membership. Demo checkout follows signup; no real payment is taken.</p><small>12-character password minimum.</small></div>}
    {error && <p className="market-error" role="alert">{error}</p>}
    <button className="btn btn-primary" disabled={busy}>{busy ? 'Loading…' : create ? 'Continue to demo checkout' : 'Sign in'}<ArrowRight size={16} /></button>
  </form><button className="market-text-button" onClick={() => { setCreate(!create); setError(''); }}>{create ? 'Sign in instead' : 'Create company account'}</button>
    {demo && <div className="market-demo-login"><label>Example workspace<select value={companyId} onChange={event => setCompanyId(event.target.value)}>{companies.filter(item => item.example).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="btn btn-secondary" disabled={busy} onClick={() => void submit(undefined, true)}>Open demo</button><small>$100 CAD/month demo membership. No real businesses are contacted and no real payment is taken.</small></div>}
  </section>;
}

export default function MarketplacePage({ partner = false }: { partner?: boolean }) {
  const [company, setCompany] = useState<Company | null>(null); const [companies, setCompanies] = useState<Company[]>([]); const [reports, setReports] = useState<MarketReport[]>([]);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.hash.split('?')[1] || '').get('id'));
  const [tab, setTab] = useState<'screening' | 'quotes' | 'messages'>('screening'); const [conversation, setConversation] = useState(''); const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [demo, setDemo] = useState(false); const [settings, setSettings] = useState(false); const [filter, setFilter] = useState('all');
  const [removed, setRemoved] = useState<RemovedScreening[]>([]); const [removedView, setRemovedView] = useState(false);
  const [removalTarget, setRemovalTarget] = useState<MarketReport | null>(null); const [editContact, setEditContact] = useState(false);
  const cancelRemoval = useRef<HTMLButtonElement>(null);
  const version = useRef(0); const mutating = useRef(false); const messageEnd = useRef<HTMLDivElement>(null);
  const autoOpen = useRef(true);
  const report = reports.find(item => keyOf(item) === selected || item.id === selected);
  const isRemoved = (item: MarketReport) => removed.some(entry => entry.key === keyOf(item));
  const visible = partner ? reports.filter(item => inView(item, filter)) : reports.filter(item => isRemoved(item) === removedView);
  const refresh = useCallback(async (quiet = false) => {
    if (mutating.current) return;
    const sequence = ++version.current; if (!quiet) { setLoading(true); setError(''); }
    try {
      const session = await marketplace.session();
      const [directory, records, screenings, removedItems] = await Promise.all([marketplace.companies(), partner && (!session.company || !memberActive(session.company)) ? Promise.resolve([]) : marketplace.reports(partner), partner ? Promise.resolve([]) : screeningApi.list(), partner ? Promise.resolve([]) : marketplace.removedScreenings()]);
      if (sequence !== version.current) return;
      const linked = new Set(records.map(item => item.screening?.id));
      setCompany(session.company); setDemo(session.demoAvailable); setCompanies(directory);
      setRemoved(removedItems);
      setReports([...records, ...screenings.filter(item => !linked.has(item.id)).map(pending)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (cause) { if (sequence === version.current) setError(issue(cause)); } finally { if (!quiet) setLoading(false); }
  }, [partner]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const route = () => {
      if (window.location.hash.slice(1).split('?')[0] !== (partner ? 'partner' : 'customer')) return;
      autoOpen.current = true; setSelected(new URLSearchParams(window.location.hash.split('?')[1] || '').get('id'));
    };
    window.addEventListener('hashchange', route); return () => window.removeEventListener('hashchange', route);
  }, [partner]);
  useEffect(() => { const poll = () => { if (document.visibilityState === 'visible') void refresh(true); }; const timer = window.setInterval(poll, 6000); window.addEventListener('focus', poll); return () => { clearInterval(timer); window.removeEventListener('focus', poll); }; }, [refresh]);
  useEffect(() => { if (tab === 'messages') messageEnd.current?.scrollIntoView({ block: 'nearest' }); }, [report?.messages.length, tab, conversation]);
  useEffect(() => { if (removalTarget) cancelRemoval.current?.focus(); }, [removalTarget]);
  useEffect(() => {
    if (loading || partner && (!company || !memberActive(company)) || !autoOpen.current || window.location.hash.slice(1).split('?')[0] !== (partner ? 'partner' : 'customer')) return;
    const first = reports.find(item => keyOf(item) === selected || item.id === selected) || visible[0];
    if (!first) { window.history.replaceState(null, '', `#${partner ? 'partner' : 'customer'}`); return; }
    autoOpen.current = false;
    setSelected(keyOf(first));
    if (!partner) setRemovedView(isRemoved(first));
    setTab(!partner && quoteCountOf(first) ? 'quotes' : 'screening');
    setConversation(partner ? company?.id || '' : first.quotes.find(quote => quote.id === first.selectedQuoteId)?.companyId || first.recipientIds[0] || '');
    window.history.replaceState(null, '', `#${partner ? 'partner' : 'customer'}?id=${encodeURIComponent(keyOf(first))}`);
  }, [loading, reports, selected, partner, company, filter, removed, removedView]);
  async function run(action: () => Promise<void>, success = '') {
    mutating.current = true; version.current++; setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(success); } catch (cause) { setError(issue(cause)); } finally { mutating.current = false; setBusy(false); }
  }
  function update(next: MarketReport) { setReports(current => [next, ...current.filter(item => keyOf(item) !== keyOf(next))]); }
  function open(item: MarketReport) { autoOpen.current = false; setSelected(keyOf(item)); setTab(!partner && quoteCountOf(item) ? 'quotes' : 'screening'); setConversation(partner ? company?.id || '' : item.quotes.find(quote => quote.id === item.selectedQuoteId)?.companyId || item.recipientIds[0] || ''); setNotice(''); setRemovalTarget(null); setEditContact(false); window.history.replaceState(null, '', `#${partner ? 'partner' : 'customer'}?id=${encodeURIComponent(keyOf(item))}`); window.scrollTo(0, 0); }
  function back() { autoOpen.current = false; setSelected(null); setNotice(''); window.history.replaceState(null, '', `#${partner ? 'partner' : 'customer'}`); }
  function changeFilter(next: string) { autoOpen.current = true; setSelected(null); setFilter(next); }
  async function saveContact(values: CustomerContact) {
    await marketplace.saveContact(values);
    const updated = await marketplace.reports();
    setReports(current => current.map(item => updated.find(next => keyOf(next) === keyOf(item)) || item));
    setEditContact(false);
  }
  async function removeScreening(item: MarketReport, shouldRemove: boolean) {
    if (partner) update(await marketplace.respond(item.id, shouldRemove ? 'remove' : 'restore'));
    else setRemoved(await marketplace.removeScreening(keyOf(item), shouldRemove));
    setRemovalTarget(null); setEditContact(false); autoOpen.current = false; setSelected(null);
    window.history.replaceState(null, '', `#${partner ? 'partner' : 'customer'}`);
  }
  if (loading) return <p className="market-loading" role="status">Loading screenings…</p>;
  if (partner && !company) return <><PartnerLogin companies={companies} demo={demo} onSignedIn={() => { autoOpen.current = true; void refresh(); }} />{error && <p className="market-error" role="alert">{error}<button onClick={() => void refresh()}>Retry</button></p>}</>;
  if (partner && company && !memberActive(company)) return <>{error && <p className="market-error" role="alert">{error}</p>}<ContractorMembership company={company} demo={demo} busy={busy} onPay={() => void run(async () => { const paid = (await marketplace.demoPayment()).company; const records = await marketplace.reports(true); setCompany(paid); setReports(records); autoOpen.current = true; }, 'Demo payment recorded. No money was charged.')} onSignOut={() => void run(async () => { await marketplace.signOut(); setCompany(null); setSelected(null); setReports([]); })} /></>;
  const companyId = partner ? company!.id : conversation || report?.quotes.find(item => item.id === report.selectedQuoteId)?.companyId || report?.recipientIds[0] || '';
  const messages = report?.messages.filter(item => item.companyId === companyId) || [];
  const provider = report?.recipients.find(item => item.id === companyId);
  return <div className={`market-workspace minimal-market${report ? ' market-has-detail' : ''}`}>
    <header className="market-heading"><div><h1>{partner ? 'Customer screenings' : 'My screenings'}</h1><p>{partner ? company!.name : 'Newmarket, Ontario'}</p></div><div className="market-heading-actions">{partner ? <><button className="market-icon-button" aria-label="Membership" aria-expanded={settings} onClick={() => setSettings(!settings)}><SlidersHorizontal size={18} /></button><button className="market-icon-button" aria-label="Sign out" disabled={busy} onClick={() => void run(async () => { await marketplace.signOut(); setCompany(null); setSelected(null); setReports([]); })}><LogOut size={18} /></button></> : <a className="btn btn-primary" href="#screening"><Plus size={17} />New screening</a>}</div></header>
    {settings && company && <section className="market-panel market-settings"><span>$100 CAD/month · Demo paid<br /><small>{company.membership.receiptId} · Active through {date(company.membership.periodEnd || '')}. No real charge or renewal.</small></span>{demo && <button disabled={busy} className="btn btn-secondary" onClick={() => void run(async () => { setCompany((await marketplace.subscription('paused')).company); }, 'Demo membership paused.')}>Pause demo membership</button>}</section>}
    {error && <p className="market-error" role="alert">{error}<button className="market-text-button" onClick={() => void refresh()}>Retry</button></p>}{notice && <p className="market-success" role="status">{notice}</p>}
    {removalTarget && <div className="market-dialog-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !busy) setRemovalTarget(null); }}><section className="market-panel market-removal-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-screening-title"><h2 id="remove-screening-title">Remove {projectTitle(removalTarget).toLowerCase()}?</h2><p>This hides the screening from your list. Quotes, messages and any chosen contractor stay saved. You can restore it from Removed.</p><div className="market-quote-actions"><button ref={cancelRemoval} className="btn btn-secondary" disabled={busy} onClick={() => setRemovalTarget(null)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void run(() => removeScreening(removalTarget, true), 'Screening moved to Removed.')}><Trash2 size={16} />Remove screening</button></div></section></div>}
    <div className="market-body"><aside className="market-report-list"><div className="market-list-title">{partner ? <select aria-label="Filter screenings" value={filter} onChange={event => changeFilter(event.target.value)}><option value="all">All screenings</option><option value="awaiting">Awaiting quote</option><option value="quoted">Quoted / follow-up</option><option value="chosen">Chosen</option><option value="declined">Declined / withdrawn</option><option value="archived">Removed</option></select> : <select aria-label="Show screenings" value={removedView ? 'removed' : 'current'} onChange={event => { setRemovedView(event.target.value === 'removed'); setSelected(null); autoOpen.current = true; setRemovalTarget(null); setEditContact(false); }}><option value="current">My screenings ({reports.filter(item => !isRemoved(item)).length})</option><option value="removed">Removed ({reports.filter(isRemoved).length})</option></select>}<button className="market-icon-button" aria-label="Refresh screenings" disabled={busy} onClick={() => void refresh(true)}><RefreshCw size={16} /></button></div>
      {visible.map(item => { const hidden = partner ? Boolean(item.response?.archivedAt) : isRemoved(item); return <article className={`market-list-item${report?.id === item.id ? ' is-selected' : ''}`} key={keyOf(item)}><button className={`market-report-card${report?.id === item.id ? ' is-selected' : ''}`} onClick={() => open(item)}><div><strong>{projectTitle(item)}</strong><time>{date(item.createdAt)}</time></div><p>{item.description || item.screening?.reference || item.id}</p><footer><span>{partner ? partnerStatus(item) : status(item)}</span><span>{areasOf(item).length} area{areasOf(item).length === 1 ? '' : 's'} · {item.isSample ? 'Sample' : item.city}</span></footer></button><button className="market-list-remove" disabled={busy} aria-label={`${hidden ? 'Restore' : 'Remove'} screening ${item.screening?.reference || item.id}`} onClick={() => hidden ? void run(() => removeScreening(item, false), 'Screening restored.') : setRemovalTarget(item)}>{hidden ? <Undo2 size={15} /> : <Trash2 size={15} />}{hidden ? 'Restore screening' : 'Remove screening'}</button></article>; })}
      {!visible.length && <div className="market-empty"><p>{partner ? 'No screenings in this view.' : removedView ? 'No removed screenings.' : 'No screenings yet.'}</p>{!partner && !removedView && <a href="#screening" className="market-text-button">Start screening<ArrowRight size={15} /></a>}</div>}
    </aside>
    {report ? <section className="market-detail" aria-label="Screening details"><button className="market-back" onClick={back}><ArrowLeft size={16} />All screenings</button><header className="market-detail-heading"><div><small>{report.screening?.reference || report.id}{report.isSample ? ' · Sample' : ''}</small><h2>{projectTitle(report)}</h2></div><span className="market-status">{partner ? partnerStatus(report) : status(report)}</span></header>
      <div className="market-project-actions"><button className="btn btn-secondary market-remove-prominent" disabled={busy} onClick={() => (partner ? report.response?.archivedAt : isRemoved(report)) ? void run(() => removeScreening(report, false), 'Screening restored.') : setRemovalTarget(report)}>{(partner ? report.response?.archivedAt : isRemoved(report)) ? <Undo2 size={16} /> : <Trash2 size={16} />}{(partner ? report.response?.archivedAt : isRemoved(report)) ? 'Restore screening' : 'Remove screening'}</button>{partner && !report.selectedQuoteId && !(report.preliminarySelection && report.preliminarySelection.quoteId === report.quotes[0]?.id && report.preliminarySelection?.revision === report.quotes[0]?.revision) && <button className="market-text-button" disabled={busy} onClick={() => void run(async () => { update(await marketplace.respond(report.id, report.response?.declinedAt ? 'reopen' : 'decline')); }, report.response?.declinedAt ? 'Bidding reopened.' : 'Bid declined. Any existing quote is withdrawn.')}>{report.response?.declinedAt ? 'Reopen bidding' : report.quotes.some(quoteAvailable) ? 'Withdraw quote' : 'Decline to bid'}</button>}</div>
      {report.preliminarySelection && !report.selectedQuoteId && <p className="market-success">{report.preliminarySelection.proposal.proposalKind === 'assessment' ? 'Assessment visit requested.' : 'Estimate follow-up requested.'} Remediation work has not been awarded.</p>}
      {partner && report.customerContact && <section className="market-panel market-customer-contact"><h3>Customer contact</h3><a href={`mailto:${report.customerContact.email}`}>{report.customerContact.email}</a><a href={`tel:${report.customerContact.phone}`}>{report.customerContact.phone}</a></section>}
      <nav className="market-detail-tabs" aria-label="Screening sections">{(['screening', 'quotes', 'messages'] as const).map(item => <button key={item} className={tab === item ? 'is-active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item === 'screening' ? 'Screening' : item === 'quotes' ? partner ? 'Quote' : `Quotes (${quoteCountOf(report)})` : 'Messages'}</button>)}</nav>
      {tab === 'screening' && <ProjectReview key={`${report.id}-${company?.id || 'customer'}`} report={report} reviewerId={partner ? company?.id : undefined} onQuote={partner && !report.selectedQuoteId ? () => setTab('quotes') : undefined}>{!partner && report.screening && <a className="btn btn-secondary" href={`#screening?id=${report.screening.id}`}>{['draft', 'uploading'].includes(report.screening.status) ? 'Continue screening' : report.screening.status === 'needs_answers' ? 'Answer questions' : 'View screening'}<ArrowRight size={16} /></a>}{report.recipientIds.length > 0 && <p className="market-small">Sent to {report.recipientIds.length} local contractor{report.recipientIds.length === 1 ? '' : 's'}.</p>}{report.isSample && <p className="market-small">Sample project. No real company is contacted.</p>}</ProjectReview>}
      {tab === 'quotes' && (partner && company ? <ProjectQuoteForm key={`${report.id}-${report.quotes[0]?.updatedAt || 'new'}`} report={report} company={company} busy={busy} onSend={values => void run(async () => { update(await marketplace.quote(report.id, values)); }, 'Project quote sent.')} onArchive={action => void run(async () => { update(await marketplace.quoteAction(report.id, report.quotes[0].id, action, true)); autoOpen.current = false; setSelected(null); window.history.replaceState(null, '', '#partner'); }, action === 'archive' ? 'Quote archived in your workspace.' : 'Quote restored.')} /> : <div className="market-quotes">
        {report.contactRequired || editContact ? <CustomerContactForm key={report.id} contact={report.customerContact} busy={busy} onSave={values => void run(() => saveContact(values), 'Contact details saved.')} onCancel={editContact ? () => setEditContact(false) : undefined} /> : <>
        {report.customerContact && <button className="market-text-button market-contact-edit" onClick={() => setEditContact(true)}>Contact details</button>}
        <CustomerQuotes key={report.id} report={report} busy={busy} onAction={(id, action) => void run(async () => { update(await marketplace.quoteAction(report.id, id, action)); }, action === 'decline' ? 'Quote declined.' : action === 'undo-decline' ? 'Decline undone.' : action === 'archive' ? 'Quote archived.' : 'Quote restored.')} onChoose={id => void run(async () => { update(await marketplace.choose(report.id, id, report.quotes.find(quote => quote.id === id)?.revision || 1)); setConversation(report.quotes.find(quote => quote.id === id)?.companyId || ''); setTab('messages'); }, 'Request saved. Continue in messages.')} onMessage={id => { setConversation(id); setTab('messages'); }} />
        {!report.quotes.length && (report.screening?.reportAvailable && report.id.startsWith('pending-') ? <form className="market-panel" onSubmit={event => { event.preventDefault(); void run(async () => { await screeningApi.submit(report.screening!.id, true); const connected = (await marketplace.reports()).find(item => item.screening?.id === report.screening!.id); if (connected) update(connected); }, 'Sent for contractor quotes.'); }}><label className="market-check"><input type="checkbox" required />Share this screening with Newmarket contractors.</label><button className="btn btn-primary" disabled={busy}>Get quotes</button></form> : <div className="market-empty"><p>{report.status === 'draft' ? 'Complete your screening to receive quotes.' : report.status === 'processing' ? 'Contractors receive your report when the screening is complete.' : 'Awaiting contractor quotes.'}</p></div>)}
        {demo && report.isSample && report.status === 'shared' && <button className="market-text-button" disabled={busy} onClick={() => void run(async () => { update(await marketplace.samples(report.id)); })}>Add sample quotes</button>}
        </>}
      </div>)}
      {tab === 'messages' && <section className="market-panel market-messaging">{!report.recipientIds.length ? <p className="market-empty">Conversations open when your screening reaches contractors.</p> : <>{!partner && <label className="market-conversation-picker">Contractor<select aria-label="Conversation with" value={companyId} onChange={event => { setConversation(event.target.value); setMessage(''); }}>{report.recipients.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<div className="market-chat-log" role="log" aria-label="Messages" aria-live="polite">{!messages.length && <p className="market-chat-empty">No messages yet.</p>}{messages.map(item => <div className={`market-chat-message${item.sender === (partner ? 'partner' : 'customer') ? ' is-mine' : ''}`} key={item.id}><small>{item.sender === 'customer' ? partner ? 'Customer' : 'You' : partner ? 'You' : provider?.name}</small><p>{item.text}</p><time>{new Date(item.createdAt).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}</time></div>)}<div ref={messageEnd} /></div><form className="market-message-compose" onSubmit={event => { event.preventDefault(); if (message.trim()) void run(async () => { update(await marketplace.message(report.id, companyId, message.trim(), partner)); setMessage(''); }); }}><label className="market-sr-only" htmlFor="market-message">Message</label><textarea id="market-message" placeholder="Message…" rows={2} required maxLength={2000} value={message} onChange={event => setMessage(event.target.value)} /><button className="btn btn-primary" aria-label="Send message" disabled={busy || !message.trim()}><Send size={18} /></button></form></>}</section>}
    </section> : <div className="market-no-selection"><p>{partner ? 'Select a screening to quote.' : 'Select a screening.'}</p></div>}
    </div>
  </div>;
}
