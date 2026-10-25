import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleHelp, ClipboardList, FileText, Gauge, HardHat, ImagePlus, Images, Info, ListChecks, LoaderCircle, MessageSquareText, Pause, Play, Printer, RefreshCw, ScanSearch, ShieldAlert, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react';
import { ScreeningApiError, screeningApi, screeningOffline } from '../lib/screening-api';
import {
  SCREENING_AREAS, SCREENING_CONCERNS, SCREENING_PROPERTY_TYPES, SCREENING_REGIONS,
  type Screening, type ScreeningConfig, type ScreeningContact, type ScreeningDetails, type ScreeningLimits, type ScreeningQuestion,
  type ScreeningQuestions, type ScreeningReportResponse, type ScreeningStatus, type ScreeningCheck, type ScreeningStepTiming,
} from '../lib/screening-types';
import './screening.css';
import { localTesting } from '../lib/testing';
import { marketplace } from '../lib/marketplace';

const DEFAULT_LIMITS: ScreeningLimits = { maxFiles: 12, maxUploadBytes: 500 * 1024 * 1024, maxVideoSeconds: 600, chunkBytes: 8 * 1024 * 1024 };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTAL_PATTERN = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/i;
const CONTACT_IDS = { name: 'screening-name', email: 'screening-email', postalCode: 'screening-postal', address: 'screening-address', phone: 'screening-phone' } as const;
type ContactErrors = Partial<Record<'name' | 'email' | 'postalCode' | 'phone', string>>;
const EMPTY_DETAILS: ScreeningDetails = { areas: [], concerns: [], statement: '', propertyType: '', region: 'ON' };
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm']);
export const SCREENING_STATUS_LABELS: Record<ScreeningStatus, string> = {
  draft: 'Draft', uploading: 'Uploading', queued: 'Preparing media', processing: 'Reviewing evidence',
  needs_answers: 'A few questions', ready_preview: 'Results ready', inconclusive: 'Results ready', failed: 'Review needs help',
};
type UploadState = 'queued' | 'uploading' | 'paused' | 'error' | 'done';
interface UploadItem { key: string; name: string; size: number; file?: File; state: UploadState; sent: number; sessionId?: string; assetId?: string; error?: string; }

function readId() {
  const id = new URLSearchParams(window.location.hash.split('?')[1] || '').get('id');
  return id && /^[a-zA-Z0-9-]{1,80}$/.test(id) ? id : null;
}
function screeningHref(id: string) { return `#screening?id=${encodeURIComponent(id)}`; }
function viewingScreening(id: string) { return window.location.hash.split('?')[0] === '#screening' && readId() === id; }
function message(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
function bytes(size: number) { return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`; }
function mimeFor(file: File) {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' } as Record<string, string>)[ext] || '';
}
async function fingerprint(file: File) {
  const header = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const metadata = new TextEncoder().encode(`${file.name}:${file.size}:${file.lastModified}:`);
  const buffer = new Uint8Array(metadata.length + header.length);
  buffer.set(metadata); buffer.set(header, metadata.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function safeUrl(value?: string, sameOrigin = false) {
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.href);
    if (!['http:', 'https:'].includes(url.protocol) || (sameOrigin && url.origin !== window.location.origin)) return undefined;
    return url.href;
  } catch { return undefined; }
}
function timestamp(ms: number | null | undefined) {
  if (ms == null) return '';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function ScreeningsList({ refreshKey = 0, excludeIds = [], hideWhenEmpty = false, onCount }: { refreshKey?: number; excludeIds?: string[]; hideWhenEmpty?: boolean; onCount?: (count: number | null) => void }) {
  const [items, setItems] = useState<Screening[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (screeningOffline) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    void screeningApi.list(controller.signal).then(result => {
      if (!controller.signal.aborted) setItems(result);
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refreshKey, retry]);
  const visibleItems = items.filter(item => !excludeIds.includes(item.id));
  useEffect(() => { onCount?.(loading || error ? null : visibleItems.length); }, [loading, error, visibleItems.length, onCount]);
  if (screeningOffline) return null;
  if (hideWhenEmpty && !error && (loading || visibleItems.length === 0)) return null;
  return <section className="screening-history" aria-labelledby="screening-history-heading">
    <div className="screening-section-heading"><h2 id="screening-history-heading">Your screenings</h2><button type="button" className="screening-text-button" disabled={loading} onClick={() => setRetry(v => v + 1)}><RefreshCw size={14} />Refresh</button></div>
    <p className="screening-hint">Screenings started in this browser.</p>
    {loading && <p className="screening-hint" role="status">Loading screenings…</p>}
    {error && <p className="screening-error" role="alert">{error}</p>}
    {!loading && !error && visibleItems.length === 0 && <p className="screening-hint">Your saved screenings will appear here.</p>}
    <div className="screening-history-list">{visibleItems.map(item => <a href={screeningHref(item.id)} className="screening-history-item" key={item.id}>
      <span><strong>REF: {item.reference}</strong>{item.createdAt && <small>{new Date(item.createdAt).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}</small>}</span>
      <span className="screening-history-status">{SCREENING_STATUS_LABELS[item.status]}<ArrowRight size={16} /></span>
    </a>)}</div>
  </section>;
}

function FollowupQuestions({ questions, busy, onFinish }: { questions: ScreeningQuestion[]; busy: boolean; onFinish: (answers: { questionId: string; value: string | string[] }[]) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [error, setError] = useState('');
  async function finish(skip: boolean) {
    if (!skip && questions.some(q => !q.optional && !values[q.id])) { setError('Please answer each question, or choose “Not sure”. You can also skip.'); return; }
    setError('');
    const answers = questions.filter(q => values[q.id] !== undefined).map(q => ({ questionId: q.id, value: values[q.id] }));
    try { await onFinish(answers); } catch (cause) { setError(message(cause)); }
  }
  function choose(question: ScreeningQuestion, value: string) {
    if (question.kind !== 'multi') { setValues(old => ({ ...old, [question.id]: value })); return; }
    const previous = Array.isArray(values[question.id]) ? values[question.id] as string[] : [];
    const next = value === 'not_sure' ? ['not_sure'] : previous.includes(value) ? previous.filter(v => v !== value) : [...previous.filter(v => v !== 'not_sure'), value];
    setValues(old => { const updated = { ...old }; if (next.length) updated[question.id] = next; else delete updated[question.id]; return updated; });
  }
  return <form className="screening-card screening-questions" onSubmit={(event: FormEvent) => { event.preventDefault(); void finish(false); }}>
    <h2>{questions.length === 1 ? 'One quick question' : `${questions.length} quick questions`}</h2>
    <p className="screening-hint">Your answers help put the visible signs in context.</p>
    {questions.map(question => <fieldset className="screening-question" key={question.id} disabled={busy}>
      <legend>{question.text}{question.optional && <span className="screening-hint"> (optional)</span>}{question.kind === 'multi' && <span className="screening-multi-hint">Select all that apply</span>}</legend>
      {question.help && <p className="screening-hint">{question.help}</p>}
      <div className="screening-options">{question.options.map(option => <label className="screening-choice" key={option.value}>
        <input type={question.kind === 'multi' ? 'checkbox' : 'radio'} name={question.id} checked={Array.isArray(values[question.id]) ? (values[question.id] as string[]).includes(option.value) : values[question.id] === option.value} onChange={() => choose(question, option.value)} />
        <span>{option.label}</span>
      </label>)}</div>
    </fieldset>)}
    {error && <p className="screening-error" role="alert">{error}</p>}
    <div className="screening-actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void finish(true)}>Skip for now</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'See my results'}<ArrowRight size={16} /></button></div>
  </form>;
}

const OUTCOME_LABEL = { qualified: 'Screening complete', limited: 'Limited screening', inconclusive: 'Inconclusive screening' } as const;
const PRIORITY_LABEL = { prompt: 'Address promptly', soon: 'Follow up soon', routine: 'Routine follow-up' } as const;
const STEP_GROUPS: { when: ScreeningStepTiming; title: string }[] = [{ when: 'now', title: 'Do now' }, { when: 'next', title: 'Next' }, { when: 'ongoing', title: 'Keep doing' }];
const CHECK_STATUS: Record<ScreeningCheck['status'], string> = { seen: 'Seen in your media', reviewed: 'Reviewed', reported: 'You reported', not_measured: 'Not measured', not_reported: 'Nothing reported' };
const FINDING_TAG: Record<string, string> = { visual: 'Seen in media', reported_only: 'You reported', poor_visibility: 'Unclear in media' };

/** Opens every collapsed section and names the file after the report, so the saved PDF is complete. */
function printReport(root: HTMLElement | null, reference: string) {
  const closed = root ? Array.from(root.querySelectorAll<HTMLDetailsElement>('details:not([open])')) : [];
  const title = document.title;
  closed.forEach(item => { item.open = true; });
  document.title = `MoldLens screening report ${reference}`;
  const restore = () => { closed.forEach(item => { item.open = false; }); document.title = title; window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  window.print();
}

function DocSection({ title, icon: Icon, intro, className, children }: { title: string; icon: LucideIcon; intro?: string; className?: string; children: ReactNode }) {
  return <section className={className ? `doc-section ${className}` : 'doc-section'}>
    <h2 className="doc-heading"><span className="doc-heading-icon" aria-hidden="true"><Icon size={17} strokeWidth={1.9} /></span>{title}</h2>
    {intro && <p className="doc-intro">{intro}</p>}
    {children}
  </section>;
}

/**
 * Customers get a short report at the level of a job summary. Staff and contractors
 * (readOnly) also get the measurement table, typical work, guidance and provenance.
 */
function ScreeningResult({ result, readOnly }: { result: ScreeningReportResponse; readOnly: boolean }) {
  const report = result.report;
  const doc = useRef<HTMLElement>(null);
  const urls = Object.fromEntries(result.frames.map(frame => [frame.id, safeUrl(frame.url, true)]));
  if (!result.validation.passed) return <div className="screening-error" role="alert">This report needs review before it can be shown. Your submission is saved.</div>;
  const full = readOnly;
  const areasReviewed = [...new Set([...report.areas.map(area => area.label), ...(report.professional?.inspectionFocus.map(item => item.area) ?? [])])];
  const steps = STEP_GROUPS.flatMap(group => report.recommendations.filter(item => (item.when ?? 'next') === group.when).map((item, index) => ({ ...item, group: index === 0 ? group.title : '' })));
  const photoRefs = report.evidenceGallery.filter((ref, i, refs) => ref.frameId && urls[ref.frameId] && refs.findIndex(other => other.frameId === ref.frameId) === i);
  const generated = new Date(report.generatedAt);
  const limitations = report.limitations.filter(item => !report.outcomeReasons.includes(item) && !report.summary.points.includes(item));
  const usedModel = !report.provenance.isMock && !!report.provenance.modelProvider && report.provenance.modelProvider !== 'none';
  const provenance = report.provenance.isMock ? 'Demo mode, no AI model' : usedModel ? `${report.provenance.modelProvider} (${report.provenance.model})` : 'Rules only, no AI model';

  return <article className="screening-report doc" ref={doc} aria-labelledby="screening-doc-title">
    <header className="doc-head">
      <div className="doc-brandrow">
        <span className="doc-brand"><strong>MoldLens</strong><span>{report.reportType}</span>{full && <em className="doc-audience">Full report, staff and contractors</em>}</span>
        <button type="button" className="screening-text-button no-print" onClick={() => printReport(doc.current, report.reference)}><Printer size={15} />Print or save as PDF</button>
      </div>
      <h1 id="screening-doc-title">{report.summary.headline}</h1>
      {(result.isDemo || report.provenance.isMock) && <p className="doc-note">Demo result, not AI analysis.</p>}
    </header>

    <DocSection title="What to do" icon={ClipboardList} className="doc-section-first">
      <table className="doc-table">
        <thead><tr><th scope="col" className="doc-col-narrow">When</th><th scope="col">Action</th><th scope="col">Why</th></tr></thead>
        <tbody>{steps.map(item => <tr key={item.id}><td className="doc-when">{item.group}</td><td className="doc-strong">{item.text}</td><td>{item.rationale}</td></tr>)}</tbody>
      </table>
      {!readOnly && <div className="screening-actions no-print"><a className="btn btn-primary" href="#customer">My screenings<ArrowRight size={16} /></a></div>}
    </DocSection>

    <DocSection title="Report details" icon={FileText}>
      <table className="doc-kv">
        <tbody>
          <tr><th scope="row">Reference</th><td>{report.reference}</td></tr>
          <tr><th scope="row">Date</th><td>{generated.toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })}</td></tr>
          <tr><th scope="row">Property</th><td>{report.property.type}, {report.property.region}</td></tr>
          {areasReviewed.length > 0 && <tr><th scope="row">Areas</th><td>{areasReviewed.join(', ')}</td></tr>}
          <tr><th scope="row">Method</th><td>{report.method}</td></tr>
          <tr><th scope="row">Result</th><td className="doc-strong">{OUTCOME_LABEL[report.outcome]}{report.outcomeReasons.length > 0 && <span className="doc-cell-note">{report.outcomeReasons.join(' ')}</span>}</td></tr>
          <tr><th scope="row">Priority</th><td className={`doc-strong doc-priority is-${report.priority}`}>{PRIORITY_LABEL[report.priority]}{report.priorityReasons.length > 0 && <span className="doc-cell-note">{report.priorityReasons.join('. ')}.</span>}</td></tr>
        </tbody>
      </table>
    </DocSection>

    {(report.areas.length > 0 || report.highlights.length > 0) && <DocSection title="What we saw" icon={ScanSearch} intro="Appearance alone cannot confirm mold.">
      {report.areas.length > 0 && <table className="doc-table">
        <thead><tr><th scope="col" className="doc-col-narrow">Area</th><th scope="col" className="doc-col-narrow">Source</th><th scope="col">Observation</th></tr></thead>
        <tbody>{report.areas.flatMap(area => area.findings.map((finding, index) => <tr key={finding.id}>
          <td className="doc-strong">{index === 0 ? area.label : ''}</td>
          <td>{FINDING_TAG[finding.kind] ?? 'Note'}</td>
          <td>{finding.statement}{full && finding.kind === 'visual' && finding.alternatives.length > 0 && <span className="doc-cell-note">Could also be: {finding.alternatives.slice(0, 2).join('; ').toLowerCase()}</span>}</td>
        </tr>))}</tbody>
      </table>}
      {report.highlights.length > 0 && <div className="screening-highlights">{report.highlights.map((highlight, index) => {
        const region = highlight.region;
        const x = region ? Math.max(0, Math.min(1, region.x)) : 0;
        const y = region ? Math.max(0, Math.min(1, region.y)) : 0;
        const showRegion = region && [region.x, region.y, region.width, region.height].every(Number.isFinite);
        return <figure key={highlight.observationId} id={`screening-evidence-${highlight.frameId}`}>
          <div className="screening-evidence-image">
            {urls[highlight.frameId] ? <a href={urls[highlight.frameId]} target="_blank" rel="noreferrer"><img src={urls[highlight.frameId]} alt={highlight.description} loading="lazy" /></a> : <span>Image unavailable</span>}
            {urls[highlight.frameId] && showRegion && <span className="screening-evidence-box" aria-hidden="true" style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${Math.max(0, Math.min(1 - x, region.width)) * 100}%`, height: `${Math.max(0, Math.min(1 - y, region.height)) * 100}%` }} />}
          </div>
          <figcaption><strong>Photo {index + 1}: {highlight.location}</strong><p>{highlight.description}</p><small>{[highlight.area, highlight.sourceLabel, highlight.timestampMs != null ? timestamp(highlight.timestampMs) : ''].filter(Boolean).join(', ')}</small></figcaption>
        </figure>;
      })}</div>}
      {report.highlights.length > 0 && <p className="doc-intro">Marked areas are approximate.</p>}
    </DocSection>}

    {report.customerContext.length > 0 && <DocSection title={full ? 'Customer answers' : 'Your answers'} icon={MessageSquareText}>
      <table className="doc-kv">
        <tbody>{report.customerContext.map((entry, i) => <tr key={i}><th scope="row">{entry.label}</th><td>{entry.value}</td></tr>)}</tbody>
      </table>
    </DocSection>}

    {report.checklist.length > 0 && <DocSection title="Things to check yourself" icon={ListChecks}>
      <ul className="doc-list">{report.checklist.map((item, i) => <li key={i}>{item}</li>)}</ul>
    </DocSection>}

    {full && report.checks && report.checks.length > 0 && <DocSection title="Checks and measurements" icon={Gauge} intro="No instrument readings were taken.">
      <table className="doc-table">
        <thead><tr><th scope="col">Check</th><th scope="col" className="doc-col-narrow">Status</th><th scope="col">What we know</th><th scope="col">To measure it</th></tr></thead>
        <tbody>{report.checks.map(check => <tr key={check.id}>
          <td className="doc-strong">{check.label}</td>
          <td className={`doc-status is-${check.status}`}>{CHECK_STATUS[check.status]}</td>
          <td>{check.finding}</td>
          <td className="doc-muted">{check.needs}</td>
        </tr>)}</tbody>
      </table>
    </DocSection>}

    {full && report.professional && <DocSection title="On-site scope" icon={HardHat}>
      {report.professional.inspectionFocus.length > 0 && <>
        <h3>Inspection focus</h3>
        <table className="doc-table">
          <thead><tr><th scope="col" className="doc-col-narrow">Area</th><th scope="col">What to check</th></tr></thead>
          <tbody>{report.professional.inspectionFocus.map(item => <tr key={item.area}><td className="doc-strong">{item.area}</td><td><ul className="doc-cell-list">{item.items.map(text => <li key={text}>{text}</li>)}</ul></td></tr>)}</tbody>
        </table>
      </>}
      <h3>Typical job, if work is needed</h3>
      <table className="doc-table">
        <thead><tr><th scope="col" className="doc-col-index">#</th><th scope="col" className="doc-col-narrow">Step</th><th scope="col">What happens</th></tr></thead>
        <tbody>{report.professional.typicalWork.map((item, index) => <tr key={item.step}><td className="doc-muted">{index + 1}</td><td className="doc-strong">{item.step}</td><td>{item.detail}</td></tr>)}</tbody>
      </table>
      <p className="doc-paragraph"><strong>Cost.</strong> {report.professional.costNote}</p>
      <h3>A clear quote should state</h3>
      <ul className="doc-list doc-list-columns">{report.professional.quoteChecklist.map(text => <li key={text}>{text}</li>)}</ul>
    </DocSection>}

    {full && report.safetyGuidance.length > 0 && <DocSection title="Safety guidance" icon={ShieldAlert}>
      <table className="doc-table">
        <thead><tr><th scope="col" className="doc-col-narrow">Topic</th><th scope="col">Guidance</th></tr></thead>
        <tbody>{report.safetyGuidance.map(item => <tr key={item.id}>
          <td className="doc-strong">{item.title}</td>
          <td>{item.text}{item.source?.publisher && <span className="doc-cell-note">Source: {safeUrl(item.source.url) ? <a href={safeUrl(item.source.url)} target="_blank" rel="noreferrer">{item.source.publisher}</a> : item.source.publisher}{item.reviewStatus && item.reviewStatus !== 'approved' && ' (wording pending review)'}</span>}</td>
        </tr>)}</tbody>
      </table>
    </DocSection>}

    {full && report.unknowns.length > 0 && <DocSection title="What remains unknown" icon={CircleHelp}>
      <ul className="doc-list">{report.unknowns.map((item, i) => <li key={i}>{item}</li>)}</ul>
    </DocSection>}

    {full && photoRefs.length > 0 && <DocSection title={`Referenced images (${photoRefs.length})`} icon={Images}>
      <div className="screening-gallery">{photoRefs.map(ref => <figure key={ref.frameId}><a href={urls[ref.frameId!]} target="_blank" rel="noreferrer"><img src={urls[ref.frameId!]} alt={ref.label} loading="lazy" /></a><figcaption>{ref.label}</figcaption></figure>)}</div>
    </DocSection>}

    {full && <DocSection title="About this report" icon={Info}>
      {limitations.length > 0 && <ul className="doc-list">{limitations.map((item, i) => <li key={i}>{item}</li>)}</ul>}
      <table className="doc-kv">
        <tbody>
          <tr><th scope="row">Analysis</th><td>{provenance}</td></tr>
          <tr><th scope="row">Generated</th><td>{generated.toLocaleString('en-CA')}</td></tr>
          {!!result.version && <tr><th scope="row">Version</th><td>{result.version}</td></tr>}
        </tbody>
      </table>
    </DocSection>}

    {!full && <p className="doc-handoff"><HardHat size={16} aria-hidden="true" />A specialist receives the full report, including what to measure on site and the typical scope of work.</p>}

    <footer className="doc-disclosure"><span>REF: {report.reference}</span><p>{report.disclosure}</p></footer>
  </article>;
}

export default function ScreeningPage({ readOnly = false }: { readOnly?: boolean }) {
  const [id, setId] = useState(readId);
  const [screening, setScreening] = useState<Screening | null>(null);
  const [details, setDetails] = useState<ScreeningDetails>({ ...EMPTY_DETAILS });
  const [consentAi, setConsentAi] = useState(false);
  const [consentStorage, setConsentStorage] = useState(false);
  const [consentQuotes, setConsentQuotes] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [config, setConfig] = useState<ScreeningConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [questions, setQuestions] = useState<ScreeningQuestions | null>(null);
  const [report, setReport] = useState<ScreeningReportResponse | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [busy, setBusy] = useState(false);
  const [addingFiles, setAddingFiles] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saved, setSaved] = useState('');
  const [retry, setRetry] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [contactErrors, setContactErrors] = useState<ContactErrors>({});
  const moreDetails = useRef<HTMLDetailsElement>(null);
  const contactError = (key: keyof ContactErrors) => contactErrors[key] ? <p className="screening-file-error" id={`${CONTACT_IDS[key]}-error`}>{contactErrors[key]}</p> : null;
  // Shown when someone tries to add files before ticking both consent boxes.
  const [consentNudge, setConsentNudge] = useState(false);
  const [consentShake, setConsentShake] = useState(false);
  const consentRef = useRef<HTMLFieldSetElement>(null);
  const consented = consentAi && consentStorage;
  useEffect(() => { if (consented) setConsentNudge(false); }, [consented]);
  function nudgeConsent() {
    setConsentNudge(true);
    setConsentShake(false);
    requestAnimationFrame(() => setConsentShake(true));
    const fieldset = consentRef.current;
    fieldset?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    fieldset?.querySelector<HTMLInputElement>('input:not(:checked)')?.focus({ preventScroll: true });
  }
  const hydratedId = useRef<string | null>(null);
  const mounted = useRef(true);
  const routeVersion = useRef(0);
  const creating = useRef<Promise<string> | null>(null);
  const activeUpload = useRef<string | null>(null);
  const uploadItems = useRef(uploads);
  uploadItems.current = uploads;
  const controllers = useRef(new Map<string, AbortController>());
  const fileInput = useRef<HTMLInputElement>(null);
  const limits = screening?.limits || config?.limits || DEFAULT_LIMITS;
  const editable = !readOnly && (!screening || ['draft', 'uploading'].includes(screening.status));
  const activeRoute = (version: number) => mounted.current && version === routeVersion.current;

  useEffect(() => {
    mounted.current = true;
    const change = () => {
      routeVersion.current++;
      setId(readId()); setBusy(false); setAddingFiles(false); setError(''); setSaved('');
      setConsentQuotes(false);
    };
    window.addEventListener('hashchange', change);
    return () => { mounted.current = false; window.removeEventListener('hashchange', change); for (const controller of controllers.current.values()) controller.abort(); };
  }, []);

  useEffect(() => {
    if (screeningOffline) return;
    const controller = new AbortController();
    setConfigError('');
    void screeningApi.config(controller.signal).then(setConfig).catch(cause => { if (!controller.signal.aborted) setConfigError(message(cause)); });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    if (!id || screeningOffline) {
      setScreening(null); setReport(null); setQuestions(null); setLoading(false); setLoadError('');
      if (!id) { hydratedId.current = null; setDetails({ ...EMPTY_DETAILS }); setConsentAi(false); setConsentStorage(false); setUploads([]); setError(''); setSaved(''); }
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    if (hydratedId.current !== id) { setLoading(true); setScreening(null); setReport(null); setQuestions(null); setUploads([]); setError(''); setSaved(''); }
    const tick = async () => {
      try {
        const next = await screeningApi.get(id, controller.signal);
        if (stopped) return;
        setScreening(next); setLoadError(''); setLoading(false);
        if (hydratedId.current !== id) {
          hydratedId.current = id;
          setDetails(next.details || { ...EMPTY_DETAILS }); setConsentAi(true); setConsentStorage(true);
          setUploads((next.uploads || []).filter(item => item.status === 'open').map(item => ({ key: item.fingerprint, name: item.name || 'Unfinished upload', size: item.declaredSize, sent: item.receivedBytes, state: 'paused', sessionId: item.id })));
        } else {
          // Recover a server-created session even when its response was interrupted.
          setUploads(previous => {
            const recovered = [...previous];
            for (const session of next.uploads || []) {
              const index = recovered.findIndex(item => item.key === session.fingerprint);
              if (session.status === 'completed' && session.assetId && index >= 0) {
                recovered[index] = { ...recovered[index], sessionId: session.id, assetId: session.assetId, sent: session.declaredSize, state: 'done', error: undefined };
                continue;
              }
              if (session.status !== 'open') continue;
              if (index < 0) recovered.push({ key: session.fingerprint, name: session.name || 'Unfinished upload', size: session.declaredSize, sent: session.receivedBytes, state: 'paused', sessionId: session.id });
              else if (!recovered[index].sessionId) recovered[index] = { ...recovered[index], sessionId: session.id };
            }
            return recovered;
          });
        }
        if (next.status === 'needs_answers') {
          const open = await screeningApi.questions(id, controller.signal);
          if (!stopped) setQuestions(open);
        }
        if (next.reportAvailable && ['ready_preview', 'inconclusive'].includes(next.status)) {
          const result = await screeningApi.report(id, controller.signal);
          if (!stopped) setReport(result);
        }
        if (!stopped && !['failed', 'ready_preview', 'inconclusive'].includes(next.status)) timer = setTimeout(tick, 3000);
        else if (!stopped && !next.reportAvailable && ['ready_preview', 'inconclusive'].includes(next.status)) timer = setTimeout(tick, 5000);
      } catch (cause) {
        if (stopped) return;
        setLoading(false);
        setLoadError(cause instanceof ScreeningApiError && cause.status === 404 ? 'This screening is not available in this browser. Open one of your saved screenings or start a new one.' : message(cause));
        if (cause instanceof ScreeningApiError && [401, 403, 404].includes(cause.status)) setScreening(null);
        else timer = setTimeout(tick, 5000);
      }
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [id, retry]);

  useEffect(() => {
    return () => { for (const controller of controllers.current.values()) controller.abort(); };
  }, [id, readOnly]);

  function patchUpload(key: string, patch: Partial<UploadItem>) { setUploads(items => items.map(item => item.key === key ? { ...item, ...patch } : item)); }

  async function ensureDraft() {
    if (readOnly) throw new Error('Staff can review this screening. Only the customer can edit it.');
    if (id) return id;
    if (!consentAi || !consentStorage) throw new Error('Please agree to AI processing and private storage before starting.');
    if (!creating.current) {
      const initialHash = window.location.hash;
      const version = routeVersion.current;
      creating.current = screeningApi.create().then(next => {
        if (!activeRoute(version) || window.location.hash !== initialHash) throw new DOMException('You left this screening. Your draft is saved.', 'AbortError');
        hydratedId.current = next.id; setScreening(next); setId(next.id);
        window.history.replaceState(null, '', screeningHref(next.id));
        return next.id;
      }).finally(() => { creating.current = null; });
    }
    return creating.current;
  }

  async function addFiles(selected: FileList | File[]) {
    if (busy || addingFiles) return;
    const version = routeVersion.current;
    const files = Array.from(selected);
    if (!files.length) return;
    setError(''); setSaved(''); setAddingFiles(true);
    try {
      if (!consentAi || !consentStorage) throw new Error('Please tick both consent boxes before adding files.');
      const assessmentId = await ensureDraft();
      if (!activeRoute(version) || !viewingScreening(assessmentId)) return;
      const next = [...uploadItems.current];
      const additions: UploadItem[] = [];
      const knownAssets = new Set((screening?.media || []).map(item => item.id));
      let count = knownAssets.size + next.filter(item => !item.assetId || !knownAssets.has(item.assetId)).length;
      const failures: string[] = [];
      for (const file of files) {
        if (!MIME_TYPES.has(mimeFor(file))) { failures.push(`${file.name}: use a supported photo or video.`); continue; }
        if (!file.size || file.size > limits.maxUploadBytes) { failures.push(`${file.name}: files must be between 1 byte and ${bytes(limits.maxUploadBytes)}.`); continue; }
        const key = await fingerprint(file);
        if (!activeRoute(version) || !viewingScreening(assessmentId)) return;
        const existing = next.findIndex(item => item.key === key);
        if (existing >= 0) {
          if (!next[existing].file && next[existing].state !== 'done') {
            next[existing] = { ...next[existing], file, name: file.name, state: 'queued', error: undefined };
            additions.push(next[existing]);
          }
          else failures.push(`${file.name} has already been added.`);
          continue;
        }
        if ((screening?.uploads || []).some(item => item.fingerprint === key && item.status === 'completed')) { failures.push(`${file.name} has already been uploaded.`); continue; }
        if (count >= limits.maxFiles) { failures.push(`You can add up to ${limits.maxFiles} files.`); continue; }
        const addition: UploadItem = { key, name: file.name, size: file.size, file, sent: 0, state: 'queued' };
        next.push(addition); additions.push(addition); count++;
      }
      setUploads(current => {
        const merged = [...current];
        for (const addition of additions) {
          const index = merged.findIndex(item => item.key === addition.key);
          if (index < 0) merged.push(addition);
          else if (!merged[index].file && merged[index].state !== 'done') merged[index] = { ...merged[index], file: addition.file, name: addition.name, state: 'queued', error: undefined };
        }
        return merged;
      });
      if (failures.length) setError([...new Set(failures)].join(' '));
    } catch (cause) { if (activeRoute(version)) setError(message(cause)); } finally { if (activeRoute(version)) setAddingFiles(false); }
  }

  async function upload(item: UploadItem, assessmentId: string) {
    if (!item.file || activeUpload.current) return;
    activeUpload.current = item.key;
    const controller = new AbortController(); controllers.current.set(item.key, controller);
    const update = (patch: Partial<UploadItem>) => { if (mounted.current && viewingScreening(assessmentId)) patchUpload(item.key, patch); };
    update({ state: 'uploading', error: undefined });
    try {
      // Let creation return its ID before pausing, so an upload can always be removed.
      const session = await screeningApi.beginUpload(assessmentId, { fingerprint: item.key, name: item.name, mime: mimeFor(item.file), size: item.size });
      update({ sessionId: session.id, sent: session.receivedBytes });
      if (controller.signal.aborted) throw new DOMException('Upload paused', 'AbortError');
      if (session.status === 'completed' && session.assetId) {
        update({ state: 'done', sent: item.size, assetId: session.assetId });
        if (viewingScreening(assessmentId)) setRetry(value => value + 1);
        return;
      }
      let offset = session.receivedBytes;
      let failures = 0;
      while (offset < item.file.size) {
        try {
          const result = await screeningApi.uploadChunk(session.id, offset, item.file.slice(offset, offset + Math.min(limits.chunkBytes, 8 * 1024 * 1024)), controller.signal);
          if (!Number.isInteger(result.receivedBytes) || result.receivedBytes < 0 || result.receivedBytes > item.file.size) throw new Error('The upload returned an invalid position. Please remove the file and add it again.');
          if (result.receivedBytes === offset) throw new Error('The upload did not advance. Please resume it.');
          offset = result.receivedBytes; failures = 0; update({ sent: offset });
        } catch (cause) {
          if (controller.signal.aborted || ++failures > 2 || (cause instanceof ScreeningApiError && cause.status >= 400 && cause.status < 500)) throw cause;
          await new Promise<void>(resolve => { const timer = window.setTimeout(resolve, 1000 * failures); controller.signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true }); });
        }
      }
      const result = await screeningApi.finishUpload(session.id, controller.signal);
      update({ state: 'done', sent: item.size, assetId: result.assetId });
      if (viewingScreening(assessmentId)) setRetry(value => value + 1);
    } catch (cause) { update(controller.signal.aborted ? { state: 'paused' } : { state: 'error', error: message(cause) }); }
    finally { controllers.current.delete(item.key); activeUpload.current = null; if (mounted.current) setUploads(items => [...items]); }
  }

  useEffect(() => {
    if (!id || !editable || busy || activeUpload.current) return;
    const item = uploads.find(uploaded => uploaded.state === 'queued' && uploaded.file);
    if (item) void upload(item, id);
    // Each queued item owns one abort controller; state changes drive the next upload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads, id, editable, busy]);

  async function removeUpload(item: UploadItem) {
    if (activeUpload.current === item.key || busy) return;
    const version = routeVersion.current;
    setError(''); setBusy(true); patchUpload(item.key, { state: 'paused' });
    try {
      const latest = id ? await screeningApi.get(id) : null;
      const session = latest?.uploads?.find(uploaded => uploaded.fingerprint === item.key && ['open', 'completed'].includes(uploaded.status));
      const assetId = session?.assetId || item.assetId;
      if (assetId) await screeningApi.removeMedia(assetId);
      else if (session?.id || item.sessionId) await screeningApi.cancelUpload(session?.id || item.sessionId!);
      if (activeRoute(version)) { setUploads(items => items.filter(next => next.key !== item.key)); setRetry(value => value + 1); }
    } catch (cause) { if (activeRoute(version)) setError(message(cause)); } finally { if (activeRoute(version)) setBusy(false); }
  }
  async function removeMedia(assetId: string) {
    if (busy) return;
    const version = routeVersion.current;
    setError(''); setBusy(true);
    try {
      await screeningApi.removeMedia(assetId);
      if (activeRoute(version)) { setUploads(items => items.filter(item => item.assetId !== assetId)); setScreening(previous => previous ? { ...previous, media: previous.media.filter(item => item.id !== assetId) } : null); setRetry(value => value + 1); }
    } catch (cause) { if (activeRoute(version)) setError(message(cause)); } finally { if (activeRoute(version)) setBusy(false); }
  }
  function draftDetails(submit: boolean) {
    if (!details.areas.length) throw new Error('Choose at least one affected area.');
    if (!details.concerns.length) throw new Error('Choose what you’ve noticed. “Not sure” is fine.');
    if (!details.propertyType) throw new Error('Choose the property type.');
    const raw = details.contact;
    const contact: ScreeningContact = { name: raw?.name?.trim() || '', email: raw?.email?.trim() || '', postalCode: raw?.postalCode?.trim() || '', address: raw?.address?.trim() || '', phone: raw?.phone?.trim() || '' };
    // Same rules as the main request form. Drafts only check what has been filled in.
    const next: ContactErrors = {};
    if ((submit || contact.name) && contact.name.length < 2) next.name = 'Please enter your name.';
    if ((submit || contact.email) && !EMAIL_PATTERN.test(contact.email)) next.email = 'Please enter a valid email address.';
    if ((submit || contact.postalCode) && !POSTAL_PATTERN.test(contact.postalCode)) next.postalCode = 'Enter a Canadian postal code, like L3Y 1A1.';
    if (contact.phone && (!/^[+\d\s().-]+$/.test(contact.phone) || !/^\d{10,15}$/.test(contact.phone.replace(/\D/g, '')))) next.phone = 'Please enter a phone number with 10 to 15 digits.';
    setContactErrors(next);
    const first = (['name', 'email', 'postalCode', 'phone'] as const).find(key => next[key]);
    if (first) {
      if (first === 'phone' && moreDetails.current) moreDetails.current.open = true;
      requestAnimationFrame(() => document.getElementById(CONTACT_IDS[first])?.focus());
      throw new Error('Please check your contact details below.');
    }
    if (contact.postalCode) { const code = contact.postalCode.toUpperCase().replace(/[ -]/g, ''); contact.postalCode = `${code.slice(0, 3)} ${code.slice(3)}`; }
    return { ...details, statement: details.statement?.trim() || undefined, contact };
  }
  async function save(submit: boolean) {
    if (busy || addingFiles) return;
    const version = routeVersion.current;
    setError(''); setSaved('');
    try {
      const data = draftDetails(submit);
      if (submit && !consentQuotes) throw new Error('Allow the completed report to be shared with local contractors for quotes.');
      if (submit && uploads.some(item => item.state !== 'done')) throw new Error('Finish or remove each pending upload before starting your screening.');
      if (submit && (screening?.uploads || []).some(item => item.status === 'open' && !uploads.some(local => local.sessionId === item.id && local.state === 'done'))) throw new Error('An upload is unfinished. Reselect its original file to resume, or remove it.');
      setBusy(true);
      const assessmentId = await ensureDraft();
      const next = await screeningApi.save(assessmentId, data);
      if (activeRoute(version)) setScreening(next);
      if (submit) {
        const submitted = await screeningApi.submit(assessmentId, consentQuotes);
        if (activeRoute(version)) { setScreening(submitted); setQuestions(null); setRetry(value => value + 1); }
      } else if (activeRoute(version)) setSaved('Draft saved.');
    } catch (cause) { if (activeRoute(version)) setError(message(cause)); } finally { if (activeRoute(version)) setBusy(false); }
  }
  async function answer(values: { questionId: string; value: string | string[] }[]) {
    if (!id || readOnly) return;
    const version = routeVersion.current;
    setBusy(true); setError('');
    try {
      await screeningApi.answers(id, values);
      if (activeRoute(version)) { setQuestions(null); setScreening(previous => previous ? { ...previous, status: 'processing' } : null); setRetry(value => value + 1); }
    } catch (cause) { if (activeRoute(version)) throw cause; }
    finally { if (activeRoute(version)) setBusy(false); }
  }
  async function retryScreening() {
    if (!id || !readOnly || busy) return;
    const version = routeVersion.current;
    setBusy(true); setError('');
    try { const retried = await screeningApi.retry(id); if (activeRoute(version)) { setScreening(retried); setRetry(value => value + 1); } }
    catch (cause) { if (activeRoute(version)) setError(message(cause)); }
    finally { if (activeRoute(version)) setBusy(false); }
  }
  function toggle(key: 'areas' | 'concerns', value: string) {
    setSaved('');
    setDetails(previous => ({ ...previous, [key]: previous[key].includes(value) ? previous[key].filter(item => item !== value) : [...previous[key], value] }));
  }
  function contact(key: keyof ScreeningContact, value: string) {
    setSaved(''); setContactErrors(previous => ({ ...previous, [key]: undefined }));
    setDetails(previous => ({ ...previous, contact: { name: '', email: '', postalCode: '', ...previous.contact, [key]: value } }));
  }


  if (screeningOffline) return <section className="screening-shell screening-card screening-offline"><ShieldCheck size={32} /><h1>Start a screening</h1><p>AI screening needs the running app. You can still save a request for specialist review in this preview.</p><div className="screening-actions"><a className="btn btn-primary" href="http://127.0.0.1:5173/#screening">Open screening<ArrowRight size={16} /></a><a className="btn btn-secondary" href="#inspection">Request a review</a></div></section>;

  return <div className={`screening-shell ${report ? 'screening-shell-report' : ''}`}>
    {id && <div className="screening-top-links"><a href={readOnly ? '#admin' : '#customer'}><ArrowLeft size={15} />{readOnly ? 'Client dashboard' : 'My screenings'}</a></div>}
    {!report && <header className="screening-intro"><h1>{readOnly ? 'Screening details' : editable ? 'Screening' : screening?.status === 'needs_answers' ? 'Follow-up questions' : 'Your screening'}</h1>{screening && <span className="screening-reference">REF: {screening.reference}</span>}</header>}
    {!id && !readOnly && localTesting && <button className="market-text-button screening-sample-button" disabled={busy} onClick={() => { setBusy(true); setError(''); void marketplace.sampleReport(['Basement', 'Bathroom', 'Attic'], 'Check spots near the basement window, moisture around the bathroom shower, and staining in the attic.').then(sample => { window.location.hash = `customer?id=${sample.id}`; }).catch(cause => setError(message(cause))).finally(() => setBusy(false)); }}>Create sample screening</button>}
    {loading && <div className="screening-card screening-loading" role="status"><LoaderCircle className="screening-spin" size={22} />Loading your screening…</div>}
    {loadError && <div className="screening-error" role="alert"><p>{loadError}</p><button className="btn btn-secondary" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
    {error && <div className="screening-error" role="alert">{error}</div>}
    {report && <ScreeningResult result={report} readOnly={readOnly} />}
    {readOnly && !id && <p className="screening-notice">Open a case in the client dashboard to review its screening.</p>}
    {!report && !loading && editable && (!id || screening) && <form className="screening-card screening-form" noValidate onSubmit={event => { event.preventDefault(); void save(true); }}>
      {configError && <div className="screening-error" role="alert"><p>{configError}</p><button type="button" className="btn btn-secondary" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
      {config && !config.ai.configured && <p className="screening-notice">Photo analysis is unavailable. Written answers can still be screened.</p>}
      {config?.ai.isDemo && <p className="screening-notice">Demo mode is enabled. Results will be labelled as a demonstration, not AI analysis.</p>}
      <fieldset ref={consentRef} className={`screening-consents ${consentShake && !consented ? 'is-shaking' : ''}`} disabled={!!id || busy} onAnimationEnd={() => setConsentShake(false)}>
        <legend className="screening-sr-only">Your permission</legend>
        <label className={consentNudge && !consentAi ? 'needs-consent' : undefined}><input type="checkbox" checked={consentAi} aria-invalid={consentNudge && !consentAi} onChange={event => setConsentAi(event.target.checked)} /><span>Allow third-party AI providers to screen my photos, video and answers.</span></label>
        <label className={consentNudge && !consentStorage ? 'needs-consent' : undefined}><input type="checkbox" checked={consentStorage} aria-invalid={consentNudge && !consentStorage} onChange={event => setConsentStorage(event.target.checked)} /><span>Allow private storage for me and authorized staff.</span></label>
        {consentNudge && !consented && <p className="screening-consent-error" role="alert">Please tick both boxes above before adding photos or a video.</p>}
        <p className="screening-hint">Avoid faces and documents. Audio is not transcribed.</p>
      </fieldset>
      <div className="screening-field"><label htmlFor="screening-media">Photos or video <span>optional</span></label>
        <div className={`screening-dropzone ${dragging ? 'is-dragging' : ''} ${consented ? '' : 'is-locked'}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!consented) { nudgeConsent(); return; } void addFiles(event.dataTransfer.files); }}>
          <ImagePlus size={25} /><button type="button" className="btn btn-secondary" disabled={busy || addingFiles} aria-disabled={!consented} onClick={() => { if (!consented) { nudgeConsent(); return; } fileInput.current?.click(); }}>{addingFiles ? 'Preparing files…' : 'Add photos or a video'}</button>
          <p>JPG, PNG, WebP, HEIC, MP4, MOV or WebM<br />Up to {limits.maxFiles} files, {bytes(limits.maxUploadBytes)} each, videos up to {Math.round(limits.maxVideoSeconds / 60)} min</p>
          <input ref={fileInput} id="screening-media" className="screening-sr-only" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm" disabled={busy || addingFiles || !consentAi || !consentStorage} onChange={event => { if (event.target.files) void addFiles(event.target.files); event.target.value = ''; }} />
        </div>

      </div>
      {(uploads.length > 0 || !!screening?.media.length) && <div className="screening-upload-list" aria-label="Screening files">
        {uploads.filter(item => !item.assetId || !screening?.media.some(media => media.id === item.assetId)).map(item => <div className="screening-upload" key={item.key}>
          <div className="screening-upload-heading"><strong>{item.name}</strong><span>{bytes(item.size)}</span></div>
          <progress value={item.sent} max={Math.max(1, item.size)} aria-label={`Upload ${item.name}`} />
          <div className="screening-upload-actions"><span>{item.state === 'done' ? 'Uploaded' : item.state === 'uploading' ? `${Math.round(item.sent / item.size * 100)}% uploaded` : item.state === 'queued' ? 'Waiting to upload' : item.file ? item.state === 'error' ? 'Upload interrupted' : 'Paused' : 'Reselect this file to resume'}</span><div>
            {item.state === 'uploading' && <button type="button" className="screening-text-button" onClick={() => controllers.current.get(item.key)?.abort()}><Pause size={14} />Pause</button>}
            {['paused', 'error'].includes(item.state) && item.file && <button type="button" className="screening-text-button" onClick={() => patchUpload(item.key, { state: 'queued', error: undefined })}><Play size={14} />Resume</button>}
            {['paused', 'error'].includes(item.state) && !item.file && <button type="button" className="screening-text-button" onClick={() => fileInput.current?.click()}>Choose file</button>}
            <button type="button" className="screening-text-button" disabled={item.state === 'uploading' || busy} aria-label={`Remove ${item.name}`} onClick={() => void removeUpload(item)}><Trash2 size={14} />Remove</button>
          </div></div>{item.error && <p className="screening-file-error">{item.error}</p>}
        </div>)}
        {screening?.media.map(media => <div className="screening-upload" key={media.id}><div className="screening-upload-heading"><strong>{media.name || (media.kind === 'video' ? 'Uploaded video' : 'Uploaded photo')}</strong><button type="button" className="screening-text-button" aria-label={`Remove ${media.name || media.id}`} disabled={busy} onClick={() => void removeMedia(media.id)}><Trash2 size={14} />Remove</button></div><span className="screening-hint">{media.status === 'ready' ? 'Ready for review' : media.status === 'rejected' || media.status === 'failed' ? 'Could not use this file' : 'Preparing media…'}</span>{media.rejectionReason && <p className="screening-file-error">{media.rejectionReason}</p>}</div>)}
      </div>}
      <fieldset className="screening-choice-field" disabled={busy}><legend>Where have you noticed it?<span className="screening-multi-hint">Select all that apply, up to 6</span></legend><div className="screening-options">{SCREENING_AREAS.map(([value, label]) => <label className="screening-choice" key={value}><input type="checkbox" checked={details.areas.includes(value)} disabled={!details.areas.includes(value) && details.areas.length >= 6} onChange={() => toggle('areas', value)} /><span>{label}</span></label>)}</div></fieldset>
      <fieldset className="screening-choice-field" disabled={busy}><legend>What have you noticed?<span className="screening-multi-hint">Select all that apply</span></legend><div className="screening-options">{SCREENING_CONCERNS.map(([value, label]) => <label className="screening-choice" key={value}><input type="checkbox" checked={details.concerns.includes(value)} onChange={() => toggle('concerns', value)} /><span>{label}</span></label>)}</div></fieldset>
      <div className="screening-field"><label htmlFor="screening-description">Anything else? <span>optional</span></label><textarea id="screening-description" value={details.statement || ''} maxLength={1500} rows={3} disabled={busy} onChange={event => { setDetails(previous => ({ ...previous, statement: event.target.value })); setSaved(''); }} placeholder="For example, the spots appeared after a leak." /><small>Please leave names, phone numbers and addresses out of this description.</small></div>
      <div className="screening-field-row"><div className="screening-field"><label htmlFor="screening-property">Property type</label><select id="screening-property" value={details.propertyType} disabled={busy} onChange={event => { setDetails(previous => ({ ...previous, propertyType: event.target.value })); setSaved(''); }}><option value="">Choose one</option>{SCREENING_PROPERTY_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
      <fieldset className="screening-contact" disabled={busy}>
        <legend>Your contact details</legend>
        <p className="screening-hint">Used to match you with local contractors. No one is contacted without your permission.</p>
        <div className="screening-contact-fields">
          <div className="screening-field"><label htmlFor={CONTACT_IDS.name}>Name</label><input id={CONTACT_IDS.name} required maxLength={100} autoComplete="name" placeholder="Your name" onChange={event => contact('name', event.target.value)} value={details.contact?.name || ''} disabled={busy} aria-invalid={!!contactErrors.name} aria-describedby={contactErrors.name ? `${CONTACT_IDS.name}-error` : undefined} />{contactError('name')}</div>
          <div className="screening-field"><label htmlFor={CONTACT_IDS.email}>Email</label><input id={CONTACT_IDS.email} required type="email" maxLength={254} autoComplete="email" placeholder="you@example.com" onChange={event => contact('email', event.target.value)} value={details.contact?.email || ''} disabled={busy} aria-invalid={!!contactErrors.email} aria-describedby={contactErrors.email ? `${CONTACT_IDS.email}-error` : undefined} />{contactError('email')}</div>
          <div className="screening-field"><label htmlFor={CONTACT_IDS.postalCode}>Postal code</label><input id={CONTACT_IDS.postalCode} required maxLength={7} autoComplete="postal-code" placeholder="L3Y 1A1" onChange={event => contact('postalCode', event.target.value.toUpperCase())} value={details.contact?.postalCode || ''} disabled={busy} aria-invalid={!!contactErrors.postalCode} aria-describedby={contactErrors.postalCode ? `${CONTACT_IDS.postalCode}-error` : 'screening-postal-hint'} />{contactError('postalCode')}<small id="screening-postal-hint">To help find services near you.</small></div>
        </div>
        <details className="screening-disclosure" ref={moreDetails}><summary>Add more details <span className="screening-hint">optional</span><ChevronDown size={16} /></summary>
          <div className="screening-contact-fields">
            <div className="screening-field"><label htmlFor={CONTACT_IDS.address}>Street address</label><input id={CONTACT_IDS.address} maxLength={300} autoComplete="street-address" placeholder="Your property address" value={details.contact?.address || ''} disabled={busy} onChange={event => contact('address', event.target.value)} /></div>
            <div className="screening-field"><label htmlFor={CONTACT_IDS.phone}>Phone number</label><input id={CONTACT_IDS.phone} type="tel" maxLength={40} autoComplete="tel" placeholder="(613) 555-0123" onChange={event => contact('phone', event.target.value)} value={details.contact?.phone || ''} disabled={busy} aria-invalid={!!contactErrors.phone} aria-describedby={contactErrors.phone ? `${CONTACT_IDS.phone}-error` : undefined} />{contactError('phone')}</div>
          </div>
        </details>
      </fieldset>
      {saved && <p className="screening-saved" role="status"><Check size={16} />{saved}</p>}
      <label className="screening-quotes-consent"><input type="checkbox" checked={consentQuotes} onChange={event => setConsentQuotes(event.target.checked)} disabled={busy} /><span>Automatically send my completed screening to Newmarket contractors for quotes.</span></label>
      <div className="screening-actions"><button type="button" className="btn btn-secondary" disabled={busy || addingFiles} onClick={() => void save(false)}>Save draft</button><button type="submit" className="btn btn-primary" disabled={busy || addingFiles || !consentAi || !consentStorage || !consentQuotes}>{busy ? <><LoaderCircle className="screening-spin" size={16} />Saving…</> : <>Start screening<ArrowRight size={16} /></>}</button></div>
      <p className="screening-hint screening-center">Preliminary screening only; not a mold diagnosis.</p>
    </form>}
    {!report && screening && !editable && <>
      {screening.status === 'needs_answers' && questions && !readOnly ? <FollowupQuestions key={screening.id} questions={questions.open} busy={busy} onFinish={answer} /> : <section className="screening-card">
        {screening.status === 'failed' ? <><h2>We couldn’t complete this screening</h2><p>{readOnly ? 'The submission is saved. Resolve the processing issue, then retry.' : 'Your submission is saved. A staff member can review the issue and retry it.'}</p>{screening.lastErrorCode === 'ai_not_configured' && <p className="screening-notice">AI analysis is not configured on this server yet.</p>}<div className="screening-actions">{readOnly ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void retryScreening()}>{busy ? 'Retrying…' : 'Retry screening'}</button> : <a href="#customer" className="btn btn-primary">My screenings</a>}<button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>Check again</button></div></>
          : <><h2>{readOnly && screening.status === 'needs_answers' ? 'Waiting for customer answers' : ['draft', 'uploading'].includes(screening.status) ? 'Customer draft' : ['ready_preview', 'inconclusive'].includes(screening.status) ? 'Your report is being reviewed' : 'Your screening is underway'}</h2><ol className="screening-phases">{['Submission saved', 'Preparing media', 'Reviewing evidence', 'Follow-up questions', 'Results ready'].map((label, index) => { const current = screening.phase?.step ?? (screening.status === 'queued' ? 2 : screening.status === 'processing' ? 3 : screening.status === 'needs_answers' ? 4 : 5); return <li key={label} data-state={index + 1 < current ? 'done' : index + 1 === current ? 'current' : 'todo'}><span>{index + 1 < current ? <Check size={15} /> : index + 1}</span>{label}</li>; })}</ol><p className="screening-hint">{readOnly ? 'Customer answers and uploads can only be changed by the customer.' : 'Track progress in My screenings.'}</p></>}
        {screening.media.filter(media => ['rejected', 'failed'].includes(media.status)).map(media => <p className="screening-notice" key={media.id}>{media.name}: {media.rejectionReason || 'This file could not be used.'}</p>)}
      </section>}
    </>}
  </div>;
}
