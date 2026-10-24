import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Camera, Check, ChevronDown, FileVideo, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { api } from '../lib/api';
import type { CustomerRequest, PageProps } from '../lib/types';
import './simple-inspection.css';

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm']);
const EMPTY_FORM = { description: '', name: '', email: '', postalCode: '', address: '', phone: '', consent: false };
// Preserve drafts and request history created before the MoldLens rename.
const DRAFT_KEY = 'moldbusters-inspection-draft';
const REQUESTS_KEY = 'moldbusters-my-requests';
type FormValues = typeof EMPTY_FORM;
type FieldErrors = Partial<Record<keyof FormValues, string>>;

function readDraft() {
  const form = { ...EMPTY_FORM };
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    if (!saved?.form || typeof saved.form !== 'object') return { form, lostAttachments: 0 };
    for (const key of ['description', 'name', 'email', 'postalCode', 'address', 'phone'] as const) {
      if (typeof saved.form[key] === 'string') form[key] = saved.form[key];
    }
    return { form, lostAttachments: Math.max(0, Math.min(10, Number(saved.attachmentCount) || 0)) };
  } catch { return { form, lostAttachments: 0 }; }
}

function UploadedFile({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled: boolean }) {
  const [url, setUrl] = useState('');
  const canPreview = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  useEffect(() => {
    if (!canPreview) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, canPreview]);
  return <div className="simple-upload-file">
    <span className="simple-upload-thumbnail">
      {canPreview && url ? <img src={url} alt={`Upload preview: ${file.name}`} /> : file.type.startsWith('video/') ? <FileVideo size={23} /> : <ImagePlus size={23} />}
    </span>
    <span className="simple-upload-filename"><strong>{file.name}</strong><small>{file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</small></span>
    <button type="button" className="simple-remove-file" aria-label={`Remove ${file.name}`} onClick={onRemove} disabled={disabled}><X size={18} /></button>
  </div>;
}

export default function InspectionPage({ onNavigate }: PageProps) {
  const [draft] = useState(readDraft);
  const [form, setForm] = useState(draft.form);
  const [files, setFiles] = useState<File[]>([]);
  const [lostAttachments, setLostAttachments] = useState(draft.lostAttachments);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [fileError, setFileError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<CustomerRequest | null>(null);
  const [historySaved, setHistorySaved] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const optionalDetails = useRef<HTMLDetailsElement>(null);
  const errorMessage = useRef<HTMLDivElement>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    try {
      if (submitted) sessionStorage.removeItem(DRAFT_KEY);
      else sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ form: { ...form, consent: false }, attachmentCount: files.length || lostAttachments }));
    } catch { /* A draft is optional; the form remains usable without browser storage. */ }
  }, [form, files.length, lostAttachments, submitted]);
  useEffect(() => { if (submitted) successHeading.current?.focus(); }, [submitted]);
  useEffect(() => { if (submitError) errorMessage.current?.focus(); }, [submitError]);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setForm(current => ({ ...current, [key]: value }));
    setErrors(current => ({ ...current, [key]: undefined }));
    setSubmitError('');
  }

  function validate() {
    const next: FieldErrors = {};
    if (form.description.trim().length < 10) next.description = 'Tell us a little more (at least 10 characters).';
    if (form.name.trim().length < 2) next.name = 'Please enter your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) next.email = 'Please enter a valid email address.';
    if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/i.test(form.postalCode.trim())) next.postalCode = 'Enter a Canadian postal code, like K1S 3W7.';
    const phone = form.phone.trim();
    if (phone && (!/^[+\d\s().-]+$/.test(phone) || !/^\d{10,15}$/.test(phone.replace(/\D/g, '')))) next.phone = 'Please enter a phone number with 10 to 15 digits.';
    if (!form.consent) next.consent = 'Please agree to have your details saved for review.';
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) {
      if (first === 'phone' && optionalDetails.current) optionalDetails.current.open = true;
      requestAnimationFrame(() => document.getElementById(first)?.focus());
    }
    return !first;
  }

  function addFiles(incoming: FileList | File[]) {
    if (submitting) return;
    const added: File[] = [];
    const messages: string[] = [];
    for (const file of Array.from(incoming)) {
      if (!FILE_TYPES.has(file.type)) messages.push(`${file.name}: please use a JPG, PNG, WebP, HEIC, MP4, MOV, or WebM file.`);
      else if (!file.size || file.size > MAX_FILE_SIZE) messages.push(`${file.name}: choose a file between 1 byte and 25 MB.`);
      else if ([...files, ...added].some(existing => existing.name === file.name && existing.size === file.size)) messages.push(`${file.name} has already been added.`);
      else if (files.length + added.length === 10) messages.push('You can add up to 10 files.');
      else added.push(file);
    }
    setFiles(current => [...current, ...added]);
    if (added.length) setLostAttachments(0);
    setFileError([...new Set(messages)].join(' '));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !validate()) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const body = new FormData();
      body.append('data', JSON.stringify({ ...form, postalCode: form.postalCode.trim().toUpperCase() }));
      files.forEach(file => body.append('files', file));
      const result = await api.createRequest(body);
      // Server-backed history uses an HttpOnly ownership cookie. Local IDs are
      // only an index for the standalone customer's IndexedDB preview.
      if (window.location.protocol === 'file:') {
        try {
          const saved = JSON.parse(localStorage.getItem(REQUESTS_KEY) || '[]');
          const ids = Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : [];
          localStorage.setItem(REQUESTS_KEY, JSON.stringify([...new Set([...ids, result.id])]));
        } catch { setHistorySaved(false); }
      }
      setSubmitted(result);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Your request could not be saved. Please try again.');
    } finally { setSubmitting(false); }
  }

  function fieldError(key: keyof FormValues) {
    return errors[key] ? <span className="simple-field-error" id={`${key}-error`}>{errors[key]}</span> : null;
  }

  if (submitted) return <section className="simple-inspection simple-success" aria-labelledby="request-saved-title">
    <span className="simple-success-icon"><Check size={29} /></span>
    <h2 id="request-saved-title" ref={successHeading} tabIndex={-1}>Request saved</h2>
    <p>{historySaved ? 'Your details are saved. You can check the status in My requests.' : 'Your details are saved. Browser history is unavailable, so keep your request number.'}</p>
    <div className="simple-reference"><span>Request number</span><strong data-testid="request-reference">{submitted.id}</strong></div>
    <button className="btn btn-primary simple-submit" onClick={() => onNavigate('requests')}>View my request <ArrowRight size={17} /></button>
    <p className="simple-demo-note">Demo: your request is saved here. No one is contacted.</p>
  </section>;

  return <div className="simple-inspection">
    <header className="simple-intro"><h1>Worried about mold?</h1><p>Add a photo and tell us what you’ve noticed.</p></header>
    <form className="simple-intake-form" onSubmit={submit} noValidate>
      <fieldset disabled={submitting}>
        <div className="simple-field">
          <label htmlFor="photos">Photos or video <span className="simple-optional">optional</span></label>
          <div className={`simple-dropzone ${dragging ? 'is-dragging' : ''}`}
            onDragEnter={event => { event.preventDefault(); dragDepth.current += 1; setDragging(true); }}
            onDragOver={event => event.preventDefault()}
            onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
            onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(event.dataTransfer.files); }}>
            <Camera size={24} strokeWidth={1.6} />
            <button type="button" className="simple-upload-button" onClick={() => fileInput.current?.click()}>Add photos or a video</button>
            <p>or drop them here · up to 10 files, 25 MB each</p>
            <input id="photos" ref={fileInput} className="simple-file-input" type="file" multiple accept={[...FILE_TYPES].join(',')} aria-label="Upload photos or videos" onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }} tabIndex={-1} />
          </div>
          {lostAttachments > 0 && <div className="simple-restore-note" role="status">Your text was saved. Please add your photos or videos again.</div>}
          {fileError && <div className="simple-field-error" role="alert">{fileError}</div>}
          {files.length > 0 && <div className="simple-file-list" aria-label="Added files">{files.map((file, index) => <UploadedFile key={`${file.name}-${file.size}-${file.lastModified}`} file={file} disabled={submitting} onRemove={() => setFiles(current => current.filter((_, item) => item !== index))} />)}</div>}
        </div>
        <div className="simple-field">
          <label htmlFor="description">What are you noticing?</label>
          <textarea id="description" required rows={3} maxLength={5000} placeholder="For example, dark spots on the bathroom ceiling…" value={form.description} onChange={event => update('description', event.target.value)} aria-invalid={!!errors.description} aria-describedby={errors.description ? 'description-error' : undefined} />
          {fieldError('description')}
        </div>
        <div className="simple-contact-row">
          <div className="simple-field"><label htmlFor="name">Name</label><input id="name" required autoComplete="name" maxLength={100} placeholder="Your name" value={form.name} onChange={event => update('name', event.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? 'name-error' : undefined} />{fieldError('name')}</div>
          <div className="simple-field"><label htmlFor="email">Email</label><input id="email" required type="email" autoComplete="email" maxLength={254} placeholder="you@example.com" value={form.email} onChange={event => update('email', event.target.value)} aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-error' : undefined} />{fieldError('email')}</div>
        </div>
        <div className="simple-field simple-postal"><label htmlFor="postalCode">Postal code</label><input id="postalCode" required autoComplete="postal-code" maxLength={7} placeholder="K1S 3W7" value={form.postalCode} onChange={event => update('postalCode', event.target.value)} aria-invalid={!!errors.postalCode} aria-describedby={errors.postalCode ? 'postalCode-error' : 'postalCode-hint'} />{fieldError('postalCode')}<small id="postalCode-hint">To help find services near you.</small></div>
        <details className="simple-extra-details" ref={optionalDetails}>
          <summary>Add more details <span>optional</span><ChevronDown size={16} /></summary>
          <div className="simple-optional-fields">
            <div className="simple-field"><label htmlFor="address">Street address</label><input id="address" autoComplete="street-address" maxLength={300} placeholder="Your property address" value={form.address} onChange={event => update('address', event.target.value)} /></div>
            <div className="simple-field"><label htmlFor="phone">Phone number</label><input id="phone" type="tel" autoComplete="tel" maxLength={40} placeholder="(613) 555-0123" value={form.phone} onChange={event => update('phone', event.target.value)} aria-invalid={!!errors.phone} aria-describedby={errors.phone ? 'phone-error' : undefined} />{fieldError('phone')}</div>
          </div>
        </details>
        <div className="simple-consent-field"><label className="simple-consent"><input id="consent" type="checkbox" required checked={form.consent} onChange={event => update('consent', event.target.checked)} aria-invalid={!!errors.consent} aria-describedby={errors.consent ? 'consent-error' : undefined} /><span>I agree to have my details and uploads saved for review.</span></label>{fieldError('consent')}</div>
        {submitError && <div className="simple-submit-error" role="alert" ref={errorMessage} tabIndex={-1}>{submitError}</div>}
        <button type="submit" className="btn btn-primary simple-submit" disabled={submitting}>{submitting ? <><LoaderCircle size={17} className="simple-spinner" /> Saving your request…</> : <>Request a review <ArrowRight size={17} /></>}</button>
      </fieldset>
      <p className="simple-photo-note">Photos help a specialist understand your concern. They can’t confirm mold on their own.</p>
    </form>
    <p className="simple-demo-note">Demo: your request is saved here. No one is contacted.</p>
  </div>;
}
