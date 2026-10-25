import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCheck, ChevronRight, ExternalLink, FileImage, FileText, Inbox, LoaderCircle, Mail, MapPin, MessageSquare, Phone, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Users, Video, X } from 'lucide-react';
import { api } from '../lib/api';
import type { InspectionRequest, PageProps, Priority, RequestStatus } from '../lib/types';
import { SCREENING_STATUS_LABELS } from './ScreeningPage';
import './admin.css';

const statuses: RequestStatus[] = ['New', 'In review', 'Scheduled', 'Completed', 'Referred'];
const priorities: Priority[] = ['Low', 'Medium', 'High'];
const statusClass = (status: string) => status.toLowerCase().replaceAll(' ', '-');
const initials = (name: string) => name.split(' ').filter(Boolean).map((word) => word[0]).slice(0, 2).join('').toUpperCase();
const formatDate = (value: string) => value ? new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value)) : 'Not scheduled';
const formatTime = (value: string) => value ? new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Not scheduled';
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const localDateValue = (value: string) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function StatusBadge({ status }: { status: RequestStatus }) {
  return <span className={`admin-status admin-status-${statusClass(status)}`}><span />{status}</span>;
}

function RequestDetail({ request, onClose, onUpdate, onRefer }: { request: InspectionRequest; onClose: () => void; onUpdate: (request: InspectionRequest) => void; onRefer: () => void }) {
  const [status, setStatus] = useState(request.status);
  const [priority, setPriority] = useState(request.priority);
  const [assignee, setAssignee] = useState(request.assignee);
  const [scheduledAt, setScheduledAt] = useState(localDateValue(request.scheduledAt));
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const elements = panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls]');
        if (!elements?.length) return;
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', keydown);
      focused?.focus();
    };
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true); setError(''); setSaveMessage('');
    try {
      const updated = await api.updateRequest(request.id, { status, priority, assignee: assignee.trim(), scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : '' });
      onUpdate(updated);
      setSaveMessage('Case updated.');
    } catch (cause) { setError(messageOf(cause)); }
    finally { setSaving(false); }
  };

  const addNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!note.trim()) return;
    setAddingNote(true); setError('');
    try { onUpdate(await api.addNote(request.id, note.trim())); setNote(''); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setAddingNote(false); }
  };

  return <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="admin-detail" ref={panel} role="dialog" aria-modal="true" aria-labelledby="case-title">
      <div className="admin-detail-topbar"><span><FileText size={16} /> CASE DETAILS</span><button ref={closeButton} className="admin-icon-button" onClick={onClose} aria-label="Close case details"><X size={21} /></button></div>
      <div className="admin-detail-content">
        <div className="admin-detail-title"><div className="admin-person-avatar large">{initials(request.name)}</div><div><div className="admin-case-id">{request.id} {request.isDemo && <span className="admin-sample-tag">Sample case</span>}</div><h2 id="case-title">{request.name}</h2><span className="admin-subtle">Submitted {formatDate(request.createdAt)}</span></div></div>
        <div className="admin-detail-badges"><StatusBadge status={request.status} /><span className={`admin-priority ${request.priority.toLowerCase()}`}><span />{request.priority} priority</span></div>

        {request.screening && <section className="admin-detail-section"><div className="admin-section-heading"><h3>Preliminary screening</h3><span>{SCREENING_STATUS_LABELS[request.screening.status]}</span></div><p className="admin-subtle">{request.screening.reference}</p><a className="btn btn-primary" href={`#screening?id=${encodeURIComponent(request.screening.id)}&view=staff`}>{request.screening.reportAvailable ? 'View screening report' : 'View screening details'}<ArrowRight size={16} /></a></section>}

        <section className="admin-detail-section"><h3>Contact & property</h3><div className="admin-contact-grid">
          <div><Mail size={16} />{request.email ? <a href={`mailto:${request.email}`}>{request.email}</a> : <span>No email provided</span>}</div>
          <div><Phone size={16} />{request.phone ? <a href={`tel:${request.phone.replace(/[^+\d]/g, '')}`}>{request.phone}</a> : <span>No phone provided</span>}</div>
          <div className="admin-contact-address"><MapPin size={16} /><span>{[request.address, request.postalCode].filter(Boolean).join(', ') || 'Location not provided'}<small>{request.propertyType !== 'Not specified' ? `${request.propertyType} · ` : ''}Preferred contact: {request.contactPreference || 'Email'}</small></span></div>
        </div></section>

        <section className="admin-detail-section"><h3>Reported concern</h3><div className="admin-concern-box"><p>{request.description || 'No additional description provided.'}</p><div className="admin-concern-facts"><div><span>Affected area</span><strong>{request.area || 'Not specified'}</strong></div><div><span>Approximate size</span><strong>{request.size || 'Not specified'}</strong></div><div><span>First noticed</span><strong>{request.duration || 'Not specified'}</strong></div></div>{request.signs?.length > 0 && <div className="admin-signs">{request.signs.map((sign) => <span key={sign}>{sign}</span>)}</div>}</div></section>

        <section className="admin-detail-section"><div className="admin-section-heading"><h3>Photos & videos</h3><span>{request.attachments.length} files</span></div>
          {request.attachments.length > 0 ? <div className="admin-attachments">{request.attachments.map((attachment) => <div key={attachment.id} className="admin-attachment">{attachment.type.startsWith('video/') ? <video controls preload="metadata" src={attachment.url} aria-label={attachment.name} /> : attachment.type.startsWith('image/') ? <a href={attachment.url} target="_blank" rel="noreferrer"><img src={attachment.url} alt={attachment.name} loading="lazy" /></a> : <a href={attachment.url} target="_blank" rel="noreferrer" className="admin-file-link"><FileText size={30} />Open document</a>}<span title={attachment.name}>{attachment.type.startsWith('video/') ? <Video size={13} /> : <FileImage size={13} />}{attachment.name}</span></div>)}</div> : <div className="admin-no-files"><FileImage size={21} /><span>No photos or videos attached.</span></div>}
        </section>

        {request.source && <section className="admin-detail-section admin-source-section"><div className="admin-section-heading"><h3>From the source records</h3><span>Hackathon sample pack</span></div><p className="admin-source-intro">{request.source.label} · Historical case information, preserved for context.</p><div className="admin-source-money"><div><span>Recorded inspection payment</span><strong>{request.source.pricePaid}</strong></div><div><span>Recorded estimate</span><strong>{request.source.estimate}</strong></div></div><div className="admin-source-links"><a href={request.source.reportUrl} target="_blank" rel="noreferrer"><FileText size={13} />Reference report<ExternalLink size={11} /></a><a href={request.source.storyUrl} target="_blank" rel="noreferrer"><FileText size={13} />Case story<ExternalLink size={11} /></a><a href={request.source.timelineUrl} target="_blank" rel="noreferrer"><FileText size={13} />Source JSON<ExternalLink size={11} /></a></div>{request.source.discrepancies.length > 0 && <div className="admin-source-discrepancies"><AlertCircle size={16} /><div><strong>Keep these uncertainties in view</strong><ul>{request.source.discrepancies.map((item, index) => <li key={index}>{item}</li>)}</ul></div></div>}<details className="admin-source-details"><summary>Recorded findings <span>{request.source.findings.length}</span></summary><ul>{request.source.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul></details><details className="admin-source-details"><summary>Recorded recommendations <span>{request.source.recommendations.length}</span></summary><ul>{request.source.recommendations.map((recommendation, index) => <li key={index}>{recommendation}</li>)}</ul></details><details className="admin-source-details"><summary>Case timeline <span>{request.source.timeline.length} events</span></summary><div className="admin-source-timeline">{request.source.timeline.map((event, index) => <div key={index}><span className="admin-timeline-dot" /><div><div className="admin-timeline-title"><strong>{event.step}</strong><span>{event.when_eastern}</span></div><small>{event.system}</small><p>{event.what}</p></div></div>)}</div></details><span className="admin-source-footnote">Source records can disagree. Reference reports are separate from client inputs; these two cases are illustrative, not an accuracy benchmark.</span></section>}

        <section className="admin-detail-section"><h3>Manage this case</h3><form className="admin-manage-form" onSubmit={save}><div className="admin-form-grid"><label>Status<select value={status} onChange={(event) => { setStatus(event.target.value as RequestStatus); setSaveMessage(''); }}>{statuses.map((option) => <option key={option}>{option}</option>)}</select></label><label>Priority<select value={priority} onChange={(event) => { setPriority(event.target.value as Priority); setSaveMessage(''); }}>{priorities.map((option) => <option key={option}>{option}</option>)}</select></label><label>Assigned to<input value={assignee} maxLength={100} onChange={(event) => { setAssignee(event.target.value); setSaveMessage(''); }} placeholder="Team member name" /></label><label>Inspection date & time<input type="datetime-local" value={scheduledAt} onChange={(event) => { setScheduledAt(event.target.value); setSaveMessage(''); }} /></label></div><div className="admin-save-row"><span role="status">{saveMessage && <><Check size={14} />{saveMessage}</>}</span><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? <LoaderCircle size={15} className="admin-spin" /> : <Check size={15} />}{saving ? 'Saving…' : 'Save changes'}</button></div></form></section>

        <div className="admin-referral-box"><div><Users size={19} /><div><strong>Need another specialist?</strong><span>Explore local providers for an overflow referral.</span></div></div><button className="admin-icon-button" onClick={onRefer} aria-label="Explore contractors"><ArrowUpRight size={20} /></button></div>

        <section className="admin-detail-section"><div className="admin-section-heading"><h3>Internal notes</h3><span>{request.notes.length}</span></div><form className="admin-note-form" onSubmit={addNote}><label className="admin-sr-only" htmlFor="case-note">Add an internal note</label><textarea id="case-note" value={note} maxLength={3000} onChange={(event) => setNote(event.target.value)} placeholder="Leave a note for your team…" rows={3} /><button className="btn btn-secondary" disabled={!note.trim() || addingNote} type="submit">{addingNote ? <LoaderCircle size={14} className="admin-spin" /> : <MessageSquare size={14} />}{addingNote ? 'Adding…' : 'Add note'}</button></form><div className="admin-notes">{[...request.notes].reverse().map((entry) => <div key={entry.id} className="admin-note"><span className="admin-note-dot" /><div><span className="admin-note-date">Team note <span>· {formatTime(entry.createdAt)}</span></span><p>{entry.text}</p></div></div>)}{request.notes.length === 0 && <p className="admin-subtle">Your team’s notes will appear here.</p>}</div></section>
        {error && <div className="admin-error" role="alert">{error}</div>}
      </div>
      <div className="admin-detail-footer"><ShieldCheck size={14} />{request.isDemo ? 'De-identified sample case · changes saved locally' : 'Local demo · changes saved in this workspace'}</div>
    </div>
  </div>;
}

export default function AdminPage({ onNavigate }: PageProps) {
  const [requests, setRequests] = useState<InspectionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All requests');
  const [priority, setPriority] = useState('All priorities');
  const [sort, setSort] = useState('newest');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState('');
  const loadRequests = async (refresh = false) => {
    if (refresh) setRefreshing(true); else setLoading(true);
    setError('');
    try { setRequests(await api.getRequests()); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); setRefreshing(false); }
  };
  useEffect(() => { void loadRequests(); }, []);
  const selected = requests.find((item) => item.id === selectedId);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return requests.filter((item) => (status === 'All requests' || item.status === status) && (priority === 'All priorities' || item.priority === priority) && (!query || [item.name, item.email, item.address, item.id, item.postalCode, item.area].join(' ').toLowerCase().includes(query))).sort((a, b) => {
      if (sort === 'priority') return priorities.indexOf(b.priority) - priorities.indexOf(a.priority) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (sort === 'oldest') return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [requests, search, status, priority, sort]);
  const counts = { active: requests.filter((item) => !['Completed', 'Referred'].includes(item.status)).length, new: requests.filter((item) => item.status === 'New').length, scheduled: requests.filter((item) => item.status === 'Scheduled').length, completed: requests.filter((item) => item.status === 'Completed').length };
  const totalMedia = requests.reduce((sum, item) => sum + item.attachments.length, 0);

  const exportCSV = () => {
    const escape = (value: string) => `"${(/^[=+@\-\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
    const rows = [['Request ID', 'Client', 'Email', 'Phone', 'Address', 'Postal code', 'Area', 'Status', 'Priority', 'Assigned to', 'Scheduled at', 'Created at', 'Sample case'], ...filtered.map((item) => [item.id, item.name, item.email, item.phone, item.address, item.postalCode, item.area, item.status, item.priority, item.assignee, item.scheduledAt, item.createdAt, item.isDemo ? 'Yes' : 'No'])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map((row) => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `moldlens-requests-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportMessage(`Exported ${filtered.length} request${filtered.length === 1 ? '' : 's'}.`);
  };

  return <div className="admin-page">
    <div className="admin-page-heading"><div><div className="eyebrow admin-eyebrow"><span />YOUR OPERATIONS, AT A GLANCE</div><h1 className="page-heading">A little clarity. A lot of progress.</h1><p className="page-description">Every home has a story. Keep each one moving toward a healthier space.</p></div><button className="btn btn-primary admin-new-request" onClick={() => onNavigate('inspection')}>New inspection <ArrowRight size={16} /></button></div>

    <div className="admin-metrics">
      {[{ label: 'Active requests', value: counts.active, note: 'Across your inspection pipeline', icon: Users, className: 'green' }, { label: 'Needs your attention', value: counts.new, note: 'New requests ready for review', icon: Inbox, className: 'amber' }, { label: 'Inspections scheduled', value: counts.scheduled, note: 'The next step to a healthier home', icon: CalendarDays, className: 'purple' }, { label: 'Cases completed', value: counts.completed, note: 'A fresh start for your clients', icon: CheckCheck, className: 'blue' }].map((metric) => <div key={metric.label} className="admin-metric"><div className="admin-metric-top"><span>{metric.label}</span><div className={`admin-metric-icon ${metric.className}`}><metric.icon size={18} /></div></div><strong>{loading ? '—' : metric.value.toString().padStart(2, '0')}</strong><span className="admin-metric-note">{metric.note}</span></div>)}
    </div>

    <section className="admin-request-panel">
      <div className="admin-panel-heading"><div><h2>Client requests <span>{requests.length}</span></h2><p>A clear view of what’s new, what’s next, and what’s taken care of.</p></div><div className="admin-panel-actions"><button className="admin-icon-button" onClick={() => void loadRequests(true)} disabled={refreshing || loading} aria-label="Refresh requests"><RefreshCw size={16} className={refreshing ? 'admin-spin' : ''} /></button><button className="btn btn-secondary" onClick={exportCSV} disabled={!filtered.length || loading}><ArrowDownToLine size={15} />Export</button></div></div>
      <div className="admin-tabs" role="tablist" aria-label="Request status">{['All requests', 'New', 'In review', 'Scheduled', 'Completed', 'Referred'].map((tab) => <button key={tab} role="tab" aria-selected={status === tab} className={status === tab ? 'active' : ''} onClick={() => setStatus(tab)}>{tab}{tab === 'New' && counts.new > 0 && <span>{counts.new}</span>}</button>)}</div>
      <div className="admin-toolbar"><div className="admin-search"><Search size={17} /><input aria-label="Search clients, addresses, or requests" placeholder="Search by client, address, or request…" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>}</div><div className="admin-filter-group"><label className="admin-filter"><SlidersHorizontal size={15} /><select aria-label="Filter by priority" value={priority} onChange={(event) => setPriority(event.target.value)}><option>All priorities</option>{priorities.map((item) => <option key={item}>{item}</option>)}</select></label><label className="admin-sort"><select aria-label="Sort requests" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="priority">Highest priority</option></select></label></div></div>
      {error ? <div className="admin-table-message" role="alert"><Inbox size={30} /><h3>We couldn’t load your requests.</h3><p>{error}</p><button className="btn btn-secondary" onClick={() => void loadRequests()}>Try again</button></div> : loading ? <div className="admin-table-message" role="status"><LoaderCircle className="admin-spin" size={30} /><p>Getting your workspace ready…</p></div> : filtered.length === 0 ? <div className="admin-table-message"><Search size={30} /><h3>{requests.length ? 'No requests match your filters.' : 'Your first request starts here.'}</h3><p>{requests.length ? 'Try a different name, status, or priority.' : 'New client inspections will appear here, ready for your team to review.'}</p>{requests.length > 0 ? <button className="btn btn-secondary" onClick={() => { setSearch(''); setStatus('All requests'); setPriority('All priorities'); }}>Clear filters</button> : <button className="btn btn-primary" onClick={() => onNavigate('inspection')}>Create an inspection</button>}</div> : <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Client & request</th><th>Property / concern</th><th>Status</th><th>Priority</th><th>Received</th><th><span className="admin-sr-only">View details</span></th></tr></thead><tbody>{filtered.map((item, index) => <tr key={item.id} onClick={() => setSelectedId(item.id)}><td><div className="admin-client-cell"><div className={`admin-person-avatar tone-${index % 4}`}>{initials(item.name)}</div><div><button className="admin-client-name" onClick={() => setSelectedId(item.id)} aria-label={`Open case for ${item.name}`}>{item.name}</button><span className="admin-row-id">{item.id}{item.isDemo && <span className="admin-sample-tag">Sample</span>}</span></div></div></td><td><span className="admin-property">{item.area && item.area !== 'Not specified' ? item.area : 'Mold concern'}</span><span className="admin-address"><MapPin size={11} />{item.address || item.postalCode || 'Location not provided'}</span></td><td><StatusBadge status={item.status} /></td><td><span className={`admin-priority ${item.priority.toLowerCase()}`}><span />{item.priority}</span></td><td><span className="admin-date">{formatDate(item.createdAt)}</span><span className="admin-file-count">{item.attachments.length > 0 ? <><FileImage size={11} />{item.attachments.length} attachments</> : 'No attachments'}</span></td><td><button className="admin-row-action" aria-label={`View ${item.name} request`} onClick={() => setSelectedId(item.id)}><ChevronRight size={18} /></button></td></tr>)}</tbody></table></div>}
      <div className="admin-table-footer"><span>Showing {filtered.length} of {requests.length} requests</span><span role="status">{exportMessage || <><ShieldCheck size={13} />Demo workspace · local data</>}</span></div>
    </section>

    <div className="admin-bottom-grid"><div className="admin-workspace-note"><div className="admin-note-icon"><FileImage size={21} /></div><div><h3>The whole picture, in one place.</h3><p>{totalMedia > 0 ? `${totalMedia} photos, videos, and documents across your client requests. Open a case to review the details.` : 'Client photos, walkthrough videos, and your team’s notes stay together with every request.'}</p></div></div><button className="admin-contractor-shortcut" onClick={() => onNavigate('contractors')}><span className="admin-shortcut-icon"><Users size={21} /></span><span><strong>A busy schedule shouldn’t mean a delay.</strong><small>Explore the Ottawa contractor network</small></span><ArrowUpRight size={21} /></button></div>
    {selected && <RequestDetail key={selected.id} request={selected} onClose={() => setSelectedId(null)} onUpdate={(updated) => setRequests((current) => current.map((item) => item.id === updated.id ? updated : item))} onRefer={() => { setSelectedId(null); onNavigate('contractors'); }} />}
  </div>;
}
