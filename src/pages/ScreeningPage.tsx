import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, FileText, ImagePlus, LoaderCircle, Pause, Play, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { ScreeningApiError, screeningApi, screeningOffline } from '../lib/screening-api';
import {
  SCREENING_AREAS, SCREENING_CONCERNS, SCREENING_PROPERTY_TYPES, SCREENING_REGIONS,
  type Screening, type ScreeningConfig, type ScreeningDetails, type ScreeningLimits, type ScreeningQuestion,
  type ScreeningQuestions, type ScreeningReportResponse, type ScreeningStatus,
} from '../lib/screening-types';
import './screening.css';

const DEFAULT_LIMITS: ScreeningLimits = { maxFiles: 12, maxUploadBytes: 500 * 1024 * 1024, maxVideoSeconds: 600, chunkBytes: 8 * 1024 * 1024 };
const EMPTY_DETAILS: ScreeningDetails = { areas: [], concerns: [], statement: '', propertyType: '', region: '' };
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
      <span><strong>{item.reference}</strong>{item.createdAt && <small>{new Date(item.createdAt).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}</small>}</span>
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
      <legend>{question.text}{question.optional && <span className="screening-hint"> (optional)</span>}</legend>
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

function ScreeningResult({ result, readOnly }: { result: ScreeningReportResponse; readOnly: boolean }) {
  const report = result.report;
  const urls = Object.fromEntries(result.frames.map(frame => [frame.id, safeUrl(frame.url, true)]));
  if (!result.validation.passed) return <div className="screening-error" role="alert">This report needs review before it can be shown. Your submission is saved.</div>;
  const outcome = report.outcome === 'qualified' ? 'Screening complete' : report.outcome === 'limited' ? 'Limited screening' : 'Inconclusive screening';
  return <div className="screening-report">
    <section className="screening-card">
      <span className="screening-badge">{outcome}</span>
      <h1>{report.summary.headline}</h1>
      {(result.isDemo || report.provenance.isMock) && <p className="screening-notice">Demo analysis: this result was not produced by an AI model.</p>}
      {report.outcomeReasons.length > 0 && <p className="screening-notice">{report.outcomeReasons.join(' ')}</p>}
      <ul className="screening-copy-list">{report.summary.points.map((point, i) => <li key={i}>{point}</li>)}</ul>
      <p className="screening-hint">{report.disclosure}</p>
    </section>
    {report.highlights.length > 0 && <section className="screening-card">
      <h2>What the photos show</h2><p className="screening-hint">Marked areas are approximate. Appearance alone cannot confirm mold.</p>
      <div className="screening-highlights">{report.highlights.map(highlight => {
        const region = highlight.region;
        const x = region ? Math.max(0, Math.min(1, region.x)) : 0;
        const y = region ? Math.max(0, Math.min(1, region.y)) : 0;
        const showRegion = region && [region.x, region.y, region.width, region.height].every(Number.isFinite);
        return <figure key={highlight.observationId} id={`screening-evidence-${highlight.frameId}`}>
          <div className="screening-evidence-image">
            {urls[highlight.frameId] ? <a href={urls[highlight.frameId]} target="_blank" rel="noreferrer"><img src={urls[highlight.frameId]} alt={highlight.description} loading="lazy" /></a> : <span>Image unavailable</span>}
            {urls[highlight.frameId] && showRegion && <span className="screening-evidence-box" aria-hidden="true" style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${Math.max(0, Math.min(1 - x, region.width)) * 100}%`, height: `${Math.max(0, Math.min(1 - y, region.height)) * 100}%` }} />}
          </div>
          <figcaption><strong>{highlight.location}</strong><p>{highlight.description}</p><small>{highlight.area} · {highlight.sourceLabel}{highlight.timestampMs != null && ` · ${timestamp(highlight.timestampMs)}`}</small></figcaption>
        </figure>;
      })}</div>
    </section>}
    <section className="screening-card">
      <h2>Your next steps</h2>
      <p className="screening-hint">Suggested timing: {report.priority === 'prompt' ? 'prompt follow-up' : report.priority === 'soon' ? 'follow up soon' : 'routine follow-up'}. {report.priorityReasons.join(' ')}</p>
      <ul className="screening-copy-list">{report.recommendations.map(item => <li key={item.id}><strong>{item.text}</strong><p className="screening-hint">{item.rationale}</p></li>)}</ul>
      {!readOnly && <div className="screening-actions"><a className="btn btn-primary" href="#inspection">Request a specialist review<ArrowRight size={16} /></a><a className="btn btn-secondary" href="#contractors">Find a specialist</a></div>}
    </section>
    {report.safetyGuidance.length > 0 && <section className="screening-card"><h2>What you can do now</h2>{report.safetyGuidance.map(item => <details className="screening-disclosure" key={item.id}><summary>{item.title}<ChevronDown size={16} /></summary><p>{item.text}</p>{item.source?.publisher && <p className="screening-hint">Source: {safeUrl(item.source.url) ? <a href={safeUrl(item.source.url)} target="_blank" rel="noreferrer">{item.source.publisher}</a> : item.source.publisher}{item.reviewStatus && item.reviewStatus !== 'approved' && ' (wording pending review)'}</p>}</details>)}</section>}
    <section className="screening-card">
      <h2>Details of your screening</h2>
      <details className="screening-disclosure"><summary>Findings by area<ChevronDown size={16} /></summary>
        {report.areas.map(area => <section className="screening-findings" key={area.area}><h3>{area.label}</h3>{area.findings.length === 0 && <p className="screening-hint">No area-level finding was recorded.</p>}{area.findings.map(finding => <div className="screening-finding" key={finding.id}><span className="screening-evidence-label">{finding.kind === 'visual' ? 'Visible observation' : finding.kind === 'reported_only' ? 'You reported' : 'Limited visibility'}</span><p>{finding.statement}</p>{finding.strength && <small>Visibility: {finding.strength}</small>}<div className="screening-evidence-links">{finding.evidenceRefs.map((ref, i) => ref.frameId && urls[ref.frameId] ? <a href={urls[ref.frameId]} key={`${ref.id}-${i}`} target="_blank" rel="noreferrer">{ref.label}</a> : <span key={`${ref.id}-${i}`}>{ref.label}</span>)}</div>{finding.alternatives.length > 0 && <p className="screening-hint">Other explanations: {finding.alternatives.join('; ')}</p>}{finding.missing.length > 0 && <p className="screening-hint">Still unknown: {finding.missing.join('; ')}</p>}</div>)}</section>)}
      </details>
      <details className="screening-disclosure"><summary>All referenced images<ChevronDown size={16} /></summary><div className="screening-gallery">{report.evidenceGallery.filter((ref, i, refs) => ref.frameId && refs.findIndex(other => other.frameId === ref.frameId) === i).map(ref => <figure key={ref.frameId}>{ref.frameId && urls[ref.frameId] && <a href={urls[ref.frameId]} target="_blank" rel="noreferrer"><img src={urls[ref.frameId]} alt={ref.label} loading="lazy" /></a>}<figcaption>{ref.label}</figcaption></figure>)}</div></details>
      <details className="screening-disclosure"><summary>Your answers<ChevronDown size={16} /></summary><dl className="screening-context">{report.customerContext.map((entry, i) => <div key={i}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl></details>
      <details className="screening-disclosure"><summary>What remains unknown<ChevronDown size={16} /></summary><ul className="screening-copy-list">{report.unknowns.map((item, i) => <li key={i}>{item}</li>)}</ul></details>
      <details className="screening-disclosure"><summary>Your checklist<ChevronDown size={16} /></summary><ul className="screening-copy-list">{report.checklist.map((item, i) => <li key={i}>{item}</li>)}</ul></details>
      <details className="screening-disclosure"><summary>About this report<ChevronDown size={16} /></summary><p>{report.reportType}</p><p className="screening-hint">{report.method}</p><ul className="screening-copy-list">{report.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul><p className="screening-hint">{report.provenance.isMock ? 'Demo mode' : `${report.provenance.modelProvider} · ${report.provenance.model}`} · {new Date(report.generatedAt).toLocaleString('en-CA')}{result.version && ` · Version ${result.version}`}</p></details>
    </section>
  </div>;
}

export default function ScreeningPage({ readOnly = false }: { readOnly?: boolean }) {
  const [id, setId] = useState(readId);
  const [screening, setScreening] = useState<Screening | null>(null);
  const [details, setDetails] = useState<ScreeningDetails>({ ...EMPTY_DETAILS });
  const [consentAi, setConsentAi] = useState(false);
  const [consentStorage, setConsentStorage] = useState(false);
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
  function draftDetails() {
    if (!details.areas.length) throw new Error('Choose at least one affected area.');
    if (!details.concerns.length) throw new Error('Choose what you’ve noticed. “Not sure” is fine.');
    if (!details.propertyType || !details.region) throw new Error('Choose the property type and region.');
    const contact = details.contact ? { ...details.contact, name: details.contact.name?.trim() || '', email: details.contact.email?.trim() || '', postalCode: details.contact.postalCode?.trim() || '' } : undefined;
    if (contact && [contact.name, contact.email, contact.postalCode].some(Boolean)) {
      if (!contact.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new Error('Add your name and a valid email, or leave the optional contact section blank.');
    }
    return { ...details, statement: details.statement?.trim() || undefined, contact };
  }
  async function save(submit: boolean) {
    if (busy || addingFiles) return;
    const version = routeVersion.current;
    setError(''); setSaved('');
    try {
      const data = draftDetails();
      if (submit && uploads.some(item => item.state !== 'done')) throw new Error('Finish or remove each pending upload before starting your screening.');
      if (submit && (screening?.uploads || []).some(item => item.status === 'open' && !uploads.some(local => local.sessionId === item.id && local.state === 'done'))) throw new Error('An upload is unfinished. Reselect its original file to resume, or remove it.');
      setBusy(true);
      const assessmentId = await ensureDraft();
      const next = await screeningApi.save(assessmentId, data);
      if (activeRoute(version)) setScreening(next);
      if (submit) {
        const submitted = await screeningApi.submit(assessmentId);
        if (activeRoute(version)) { setScreening(submitted); setQuestions(null); setRetry(value => value + 1); }
      } else if (activeRoute(version)) setSaved('Draft saved. You can return from My requests in this browser.');
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
  function contact(key: 'name' | 'email' | 'postalCode', value: string) {
    setSaved(''); setDetails(previous => ({ ...previous, contact: { name: '', email: '', postalCode: '', ...previous.contact, [key]: value } }));
  }

  if (screeningOffline) return <section className="screening-shell screening-card screening-offline"><ShieldCheck size={32} /><h1>Start a screening</h1><p>AI screening needs the running app. You can still save a request for specialist review in this preview.</p><div className="screening-actions"><a className="btn btn-primary" href="http://127.0.0.1:5173/#screening">Open screening<ArrowRight size={16} /></a><a className="btn btn-secondary" href="#inspection">Request a review</a></div></section>;

  return <div className={`screening-shell ${report ? 'screening-shell-report' : ''}`}>
    <div className="screening-top-links"><a href={readOnly ? '#admin' : '#inspection'}><ArrowLeft size={15} />{readOnly ? 'Client dashboard' : 'Customer form'}</a>{id && !readOnly && <a href="#screening">Start another screening</a>}</div>
    {!report && <header className="screening-intro"><span className="screening-intro-icon"><ShieldCheck size={24} /></span><h1>{readOnly ? 'Screening details' : editable ? 'Start a screening' : screening?.status === 'needs_answers' ? 'A little more context' : 'Your screening'}</h1><p>{readOnly ? 'Review the customer’s screening and results.' : editable ? 'Show us what you’ve noticed. Get a preliminary review of visible signs and useful next steps.' : 'Your submission is saved. Follow its progress here.'}</p>{screening && <span className="screening-reference">{screening.reference}</span>}</header>}
    {loading && <div className="screening-card screening-loading" role="status"><LoaderCircle className="screening-spin" size={22} />Loading your screening…</div>}
    {loadError && <div className="screening-error" role="alert"><p>{loadError}</p><button className="btn btn-secondary" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
    {error && <div className="screening-error" role="alert">{error}</div>}
    {report && <ScreeningResult result={report} readOnly={readOnly} />}
    {readOnly && !id && <p className="screening-notice">Open a case in the client dashboard to review its screening.</p>}
    {!report && !loading && editable && (!id || screening) && <form className="screening-card screening-form" onSubmit={event => { event.preventDefault(); void save(true); }}>
      {configError && <div className="screening-error" role="alert"><p>{configError}</p><button type="button" className="btn btn-secondary" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
      {config && !config.ai.configured && <p className="screening-notice">Photo and video analysis is not configured yet. You can get guidance from your written answers, save a draft, or <a href="#inspection">request a specialist review</a>.</p>}
      {config?.ai.isDemo && <p className="screening-notice">Demo mode is enabled. Results will be labelled as a demonstration, not AI analysis.</p>}
      <fieldset className="screening-consents" disabled={!!id || busy}>
        <legend className="screening-sr-only">Your permission</legend>
        <label><input type="checkbox" checked={consentAi} onChange={event => setConsentAi(event.target.checked)} /><span>I agree to AI processing of my photos, video and answers by third-party providers for a preliminary screening.</span></label>
        <label><input type="checkbox" checked={consentStorage} onChange={event => setConsentStorage(event.target.checked)} /><span>I agree to private storage of my submission for me and authorized staff to review.</span></label>
        <p className="screening-hint">Audio is not transcribed. Keep faces and personal documents out of frame.</p>
      </fieldset>
      <div className="screening-field"><label htmlFor="screening-media">Photos or video <span>optional</span></label>
        <div className={`screening-dropzone ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void addFiles(event.dataTransfer.files); }}>
          <ImagePlus size={25} /><button type="button" className="btn btn-secondary" disabled={busy || addingFiles || !consentAi || !consentStorage} onClick={() => fileInput.current?.click()}>{addingFiles ? 'Preparing files…' : 'Add photos or a video'}</button>
          <p>JPG, PNG, WebP, HEIC, MP4, MOV or WebM · up to {limits.maxFiles} files<br />{bytes(limits.maxUploadBytes)} per file · video up to {Math.round(limits.maxVideoSeconds / 60)} minutes</p>
          <input ref={fileInput} id="screening-media" className="screening-sr-only" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm" disabled={busy || addingFiles || !consentAi || !consentStorage} onChange={event => { if (event.target.files) void addFiles(event.target.files); event.target.value = ''; }} />
        </div>
        <p className="screening-hint">One wider view and a steady close-up help. You can continue with answers only.</p>
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
      <fieldset className="screening-choice-field" disabled={busy}><legend>Where have you noticed it?</legend><div className="screening-options">{SCREENING_AREAS.map(([value, label]) => <label className="screening-choice" key={value}><input type="checkbox" checked={details.areas.includes(value)} disabled={!details.areas.includes(value) && details.areas.length >= 6} onChange={() => toggle('areas', value)} /><span>{label}</span></label>)}</div></fieldset>
      <fieldset className="screening-choice-field" disabled={busy}><legend>What have you noticed?</legend><div className="screening-options">{SCREENING_CONCERNS.map(([value, label]) => <label className="screening-choice" key={value}><input type="checkbox" checked={details.concerns.includes(value)} onChange={() => toggle('concerns', value)} /><span>{label}</span></label>)}</div></fieldset>
      <div className="screening-field"><label htmlFor="screening-description">Anything else? <span>optional</span></label><textarea id="screening-description" value={details.statement || ''} maxLength={1500} rows={3} disabled={busy} onChange={event => { setDetails(previous => ({ ...previous, statement: event.target.value })); setSaved(''); }} placeholder="For example, the spots appeared after a leak." /><small>Please leave names, phone numbers and addresses out of this description.</small></div>
      <div className="screening-field-row"><div className="screening-field"><label htmlFor="screening-property">Property type</label><select id="screening-property" value={details.propertyType} disabled={busy} onChange={event => { setDetails(previous => ({ ...previous, propertyType: event.target.value })); setSaved(''); }}><option value="">Choose one</option>{SCREENING_PROPERTY_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="screening-field"><label htmlFor="screening-region">Region</label><select id="screening-region" value={details.region} disabled={busy} onChange={event => { setDetails(previous => ({ ...previous, region: event.target.value })); setSaved(''); }}><option value="">Choose one</option>{SCREENING_REGIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
      <details className="screening-disclosure"><summary>Add contact details <span className="screening-hint">optional</span><ChevronDown size={16} /></summary><p className="screening-hint">Include these if you want your screening attached to a named client request. No one is contacted automatically.</p><div className="screening-contact-fields"><div className="screening-field"><label htmlFor="screening-name">Name</label><input id="screening-name" value={details.contact?.name || ''} maxLength={100} autoComplete="name" disabled={busy} onChange={event => contact('name', event.target.value)} /></div><div className="screening-field"><label htmlFor="screening-email">Email</label><input id="screening-email" type="email" value={details.contact?.email || ''} maxLength={254} autoComplete="email" disabled={busy} onChange={event => contact('email', event.target.value)} /></div><div className="screening-field"><label htmlFor="screening-postal">Postal code</label><input id="screening-postal" value={details.contact?.postalCode || ''} maxLength={10} autoComplete="postal-code" disabled={busy} onChange={event => contact('postalCode', event.target.value.toUpperCase())} /></div></div></details>
      {saved && <p className="screening-saved" role="status"><Check size={16} />{saved}</p>}
      <div className="screening-actions"><button type="button" className="btn btn-secondary" disabled={busy || addingFiles} onClick={() => void save(false)}>Save draft</button><button type="submit" className="btn btn-primary" disabled={busy || addingFiles || !consentAi || !consentStorage}>{busy ? <><LoaderCircle className="screening-spin" size={16} />Saving…</> : <>Start screening<ArrowRight size={16} /></>}</button></div>
      <p className="screening-hint screening-center">A preliminary screening cannot confirm mold species, hidden growth, or health risk.</p>
    </form>}
    {!report && screening && !editable && <>
      {screening.status === 'needs_answers' && questions && !readOnly ? <FollowupQuestions key={screening.id} questions={questions.open} busy={busy} onFinish={answer} /> : <section className="screening-card">
        {screening.status === 'failed' ? <><h2>We couldn’t complete this screening</h2><p>{readOnly ? 'The submission is saved. Resolve the processing issue, then retry.' : 'Your submission is saved. A staff member can review the issue and retry it.'}</p>{screening.lastErrorCode === 'ai_not_configured' && <p className="screening-notice">AI analysis is not configured on this server yet.</p>}<div className="screening-actions">{readOnly ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void retryScreening()}>{busy ? 'Retrying…' : 'Retry screening'}</button> : <a href="#inspection" className="btn btn-primary">Request a specialist review</a>}<button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>Check again</button></div></>
          : <><h2>{readOnly && screening.status === 'needs_answers' ? 'Waiting for customer answers' : ['draft', 'uploading'].includes(screening.status) ? 'Customer draft' : ['ready_preview', 'inconclusive'].includes(screening.status) ? 'Your report is being reviewed' : 'Your screening is underway'}</h2><ol className="screening-phases">{['Submission saved', 'Preparing media', 'Reviewing evidence', 'Follow-up questions', 'Results ready'].map((label, index) => { const current = screening.phase?.step ?? (screening.status === 'queued' ? 2 : screening.status === 'processing' ? 3 : screening.status === 'needs_answers' ? 4 : 5); return <li key={label} data-state={index + 1 < current ? 'done' : index + 1 === current ? 'current' : 'todo'}><span>{index + 1 < current ? <Check size={15} /> : index + 1}</span>{label}</li>; })}</ol><p className="screening-hint">{readOnly ? 'Customer answers and uploads can only be changed by the customer.' : 'You can leave and return from My requests in this browser.'}</p></>}
        {screening.media.filter(media => ['rejected', 'failed'].includes(media.status)).map(media => <p className="screening-notice" key={media.id}>{media.name}: {media.rejectionReason || 'This file could not be used.'}</p>)}
      </section>}
    </>}
    {!id && config && !readOnly && <ScreeningsList />}
    {id && <p className="screening-bottom-link"><a href={readOnly ? '#admin' : '#requests'}><FileText size={15} />{readOnly ? 'Client dashboard' : 'My requests and screenings'}</a></p>}
  </div>;
}
