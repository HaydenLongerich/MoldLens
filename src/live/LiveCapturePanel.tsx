import { useEffect, useRef, useState } from 'react';
import { toDataURL } from 'qrcode';
import { ImagePlus, LoaderCircle, QrCode, Smartphone } from 'lucide-react';
import { LiveApiError, liveApi, liveSocketUrl, type LiveAnalysis, type LiveDetection, type LiveSession, type LiveState } from '../lib/live-api';
import './live.css';

interface ChatItem { id: number; from: 'assistant' | 'system'; text: string }

function message(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

// Phones can only open the camera over HTTPS, or from localhost on this computer.
function isSecureForPhone(origin: string) {
  return origin.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin);
}

export default function LiveCapturePanel({ disabled, onSnapshots }: { disabled: boolean; onSnapshots: (files: File[]) => Promise<void> }) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [state, setState] = useState<LiveState | null>(null);
  const [qr, setQr] = useState('');
  const [pairUrl, setPairUrl] = useState('');
  const [preview, setPreview] = useState('');
  const [detections, setDetections] = useState<LiveDetection[]>([]);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [phoneConnected, setPhoneConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previewUrl = useRef('');
  const thumbUrls = useRef<Record<string, string>>({});
  const lastCode = useRef('');
  const chatId = useRef(0);

  const sessionId = session?.id ?? '';
  const origin = session ? session.publicOrigin ?? window.location.origin : window.location.origin;
  const limit = state?.limit ?? session?.limit ?? 12;
  const snapshots = state?.snapshots ?? [];
  const pending = snapshots.filter((snap) => !added.includes(snap.id));

  function push(from: ChatItem['from'], text: string) {
    setChat((items) => [...items.slice(-29), { id: ++chatId.current, from, text }]);
  }

  function clearMedia() {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = '';
    for (const url of Object.values(thumbUrls.current)) if (url !== 'pending') URL.revokeObjectURL(url);
    thumbUrls.current = {};
    setPreview(''); setThumbs({});
  }

  function showFrame(blob: Blob) {
    const next = URL.createObjectURL(blob);
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = next;
    setPreview(next);
  }

  function resetSession() {
    clearMedia();
    setSession(null); setState(null); setQr(''); setPairUrl(''); setDetections([]); setChat([]); setAdded([]);
    setPhoneConnected(false); lastCode.current = '';
  }

  useEffect(() => () => clearMedia(), []);

  // Desktop socket: preview frames arrive as binary, analysis and phone status as JSON.
  useEffect(() => {
    if (!sessionId) return;
    const socket = new WebSocket(liveSocketUrl(sessionId, 'desktop'));
    socket.binaryType = 'blob';
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') { showFrame(event.data); return; }
      const data = JSON.parse(event.data);
      if (data.type === 'hello') {
        setPhoneConnected(data.phoneConnected);
        if (!data.detector.ready) push('system', 'Framing guidance needs the detection model, which is not installed yet. Lighting and focus checks still work.');
      }
      if (data.type === 'phone') {
        setPhoneConnected(data.connected);
        push('system', data.connected ? 'Phone connected. Guidance will appear here as you move the camera.' : 'Phone disconnected.');
      }
      if (data.type === 'analysis') {
        const analysis = data as LiveAnalysis;
        setDetections(analysis.detections);
        if (analysis.code !== lastCode.current) {
          lastCode.current = analysis.code;
          push('assistant', analysis.message);
        }
      }
      if (data.type === 'snapshot') {
        push('system', `Photo ${data.count} of ${data.limit} taken on the phone.`);
        liveApi.state(sessionId).then(setState).catch(() => {});
      }
    };
    socket.onclose = (event) => {
      if (event.code === 4404) { resetSession(); setError('This live session has ended. Create a new code to try again.'); }
    };
    return () => { socket.onclose = null; socket.close(); };
    // The socket follows the session id only.
  }, [sessionId]);

  // Thumbnails load with the desktop cookie. Each photo is fetched once and then reused.
  useEffect(() => {
    if (!sessionId) return;
    for (const snap of snapshots) {
      if (thumbUrls.current[snap.id]) continue;
      thumbUrls.current[snap.id] = 'pending';
      liveApi.photo(sessionId, snap.id)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          thumbUrls.current[snap.id] = url;
          setThumbs((items) => ({ ...items, [snap.id]: url }));
        })
        .catch(() => { delete thumbUrls.current[snap.id]; });
    }
  }, [sessionId, snapshots]);

  async function startSession() {
    setBusy(true); setError('');
    try {
      const created = await liveApi.create();
      const link = `${created.publicOrigin ?? window.location.origin}/live/${created.id}#${created.token}`;
      setPairUrl(link);
      setQr(await toDataURL(link, { margin: 1, width: 240 }));
      setSession(created);
      setState(null);
      setAdded([]);
      setChat([{ id: ++chatId.current, from: 'system', text: 'Scan the code with your phone. Its camera will open here once it connects.' }]);
    } catch (cause) {
      setError(cause instanceof LiveApiError && cause.status === 403 ? cause.message : message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function endSession() {
    if (!session) return;
    setBusy(true);
    try { await liveApi.end(session.id); }
    catch { /* The session also expires on its own; clearing the screen is enough here. */ }
    finally { resetSession(); setBusy(false); }
  }

  async function addToScreening() {
    if (!session || !pending.length) return;
    setBusy(true); setError('');
    try {
      const files: File[] = [];
      for (const snap of pending) {
        const blob = await liveApi.photo(session.id, snap.id);
        const extension = blob.type === 'image/png' ? 'png' : 'jpg';
        files.push(new File([blob], `live-photo-${snap.id.slice(0, 8)}.${extension}`, { type: blob.type || 'image/jpeg' }));
      }
      await onSnapshots(files);
      setAdded((items) => [...items, ...pending.map((snap) => snap.id)]);
      push('system', `${files.length} photo${files.length === 1 ? '' : 's'} added to your screening.`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <section className="live-panel" aria-labelledby="live-heading">
        <div className="live-intro"><Smartphone size={22} /><div>
          <h3 id="live-heading">Use your phone as a live camera</h3>
          <p>Scan a code with your phone. A guide will tell you when to move closer, back off, or hold steady, then take the photos for you.</p>
        </div></div>
        {error && <p className="live-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-secondary" disabled={disabled || busy} onClick={startSession}>
          {busy ? <LoaderCircle size={16} className="live-spin" /> : <QrCode size={16} />} Show phone code
        </button>
        {disabled && <p className="screening-hint">Agree to AI processing and storage above to use the live camera.</p>}
      </section>
    );
  }

  const insecure = !isSecureForPhone(origin);
  return (
    <section className="live-panel" aria-labelledby="live-heading">
      <h3 id="live-heading">Live camera</h3>
      {insecure && <p className="live-warning" role="alert">Phones can only open the camera over HTTPS. This address is not secure, so the phone will not start the camera.</p>}
      <div className="live-body">
        <div className="live-pairing">
          {qr ? <img src={qr} alt="QR code to open the live camera on your phone" width={200} height={200} /> : null}
          <p>{phoneConnected ? 'Phone connected' : 'Scan with your phone camera'}</p>
          <details className="live-link">
            <summary>Can't scan? Copy the phone link</summary>
            <input readOnly value={pairUrl} aria-label="Phone link" onFocus={(event) => event.currentTarget.select()} />
          </details>
        </div>
        <div className="live-stage-desktop">
          <div className="live-preview">
            {preview ? <img src={preview} alt="Live view from the phone" /> : <p className="live-muted">Waiting for the phone…</p>}
            {detections.map((item, index) => (
              <span key={index} className={item.clipped ? 'live-box is-clipped' : 'live-box'}
                style={{ left: `${item.box.x * 100}%`, top: `${item.box.y * 100}%`, width: `${item.box.width * 100}%`, height: `${item.box.height * 100}%` }} />
            ))}
          </div>
          <div className="live-chat" role="log" aria-live="polite">
            {chat.map((item) => <p key={item.id} className={`live-bubble is-${item.from}`}>{item.text}</p>)}
          </div>
        </div>
      </div>
      {error && <p className="live-error" role="alert">{error}</p>}
      {snapshots.length > 0 && (
        <div className="live-thumbs" aria-label="Photos from the phone">
          {snapshots.map((snap) => (
            <div key={snap.id} className="live-thumb">
              {thumbs[snap.id] ? <img src={thumbs[snap.id]} alt="Photo from the phone" /> : <LoaderCircle size={16} className="live-spin" />}
              {added.includes(snap.id) && <span>Added</span>}
            </div>
          ))}
        </div>
      )}
      <div className="live-actions">
        <span>{snapshots.length} of {limit} photos</span>
        <button type="button" className="btn btn-secondary" disabled={disabled || busy || !pending.length} onClick={addToScreening}>
          <ImagePlus size={16} /> Add {pending.length || ''} photo{pending.length === 1 ? '' : 's'} to screening
        </button>
        <button type="button" className="screening-text-button" disabled={busy} onClick={endSession}>End live camera</button>
      </div>
    </section>
  );
}
