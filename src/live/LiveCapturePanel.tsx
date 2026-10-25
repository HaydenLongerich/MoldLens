import { useEffect, useRef, useState } from 'react';
import { toDataURL } from 'qrcode';
import { Camera, ImagePlus, LoaderCircle, QrCode, Smartphone } from 'lucide-react';
import { LiveApiError, liveApi, liveSocketUrl, type LiveSession, type LiveSnapshot, type LiveState } from '../lib/live-api';
import { LiveCamera } from './PhoneCapturePage';
import './live.css';

function message(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

// Phones can only open the camera over HTTPS, or from localhost on this computer.
function isSecureForPhone(origin: string) {
  return origin.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin);
}

// The camera is only offered where the browser will actually open it.
const canUseCamera = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
// Phones and tablets lead with their own camera; desktops lead with the phone code.
const touchFirst = window.matchMedia?.('(pointer: coarse)').matches ?? false;

interface PanelProps {
  disabled: boolean;
  // Until both permissions are ticked, the buttons stay clickable and call `onLocked`, which
  // points the customer at the permission boxes the same way the upload button does.
  locked: boolean;
  onLocked: () => void;
  onSnapshots: (files: File[]) => Promise<void>;
  // Creates the screening draft if needed, so the camera works before "Save draft".
  prepare: () => Promise<unknown>;
}

const Divider = () => <div className="live-or" role="separator" aria-label="or"><span>or</span></div>;

// Camera guidance lives on the camera screen only. This panel pairs the phone and collects its photos.
export default function LiveCapturePanel({ disabled, locked, onLocked, onSnapshots, prepare }: PanelProps) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [deviceMode, setDeviceMode] = useState(false);
  const [notice, setNotice] = useState('');
  const [state, setState] = useState<LiveState | null>(null);
  const [qr, setQr] = useState('');
  const [pairUrl, setPairUrl] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [phoneConnected, setPhoneConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const thumbUrls = useRef<Record<string, string>>({});

  const sessionId = session?.id ?? '';
  const origin = session ? session.publicOrigin ?? window.location.origin : window.location.origin;
  const limit = state?.limit ?? session?.limit ?? 12;
  const snapshots = state?.snapshots ?? [];
  const pending = snapshots.filter((snap) => !added.includes(snap.id));

  function clearThumbs() {
    for (const url of Object.values(thumbUrls.current)) if (url !== 'pending') URL.revokeObjectURL(url);
    thumbUrls.current = {};
    setThumbs({});
  }

  function resetSession() {
    clearThumbs();
    setSession(null); setDeviceMode(false); setState(null); setQr(''); setPairUrl(''); setAdded([]);
    setPhoneConnected(false);
  }

  useEffect(() => () => clearThumbs(), []);

  // Desktop socket: phone status and new photos only.
  useEffect(() => {
    if (!sessionId) return;
    const socket = new WebSocket(liveSocketUrl(sessionId, 'desktop'));
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const data = JSON.parse(event.data);
      if (data.type === 'hello') setPhoneConnected(data.phoneConnected);
      if (data.type === 'phone') setPhoneConnected(data.connected);
      if (data.type === 'snapshot') liveApi.state(sessionId).then(setState).catch(() => {});
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

  async function startSession(mode: 'phone' | 'device') {
    if (locked) { onLocked(); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await prepare();
      const created = await liveApi.create();
      const link = `${created.publicOrigin ?? window.location.origin}/live/${created.id}#${created.token}`;
      setPairUrl(link);
      if (mode === 'phone') setQr(await toDataURL(link, { margin: 1, width: 240 }));
      setSession(created);
      setDeviceMode(mode === 'device');
      setState(null);
      setAdded([]);
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

  // Downloads the photos and hands them to the screening's normal upload path.
  async function addSnapshots(sessionKey: string, list: LiveSnapshot[]) {
    const files: File[] = [];
    for (const snap of list) {
      const blob = await liveApi.photo(sessionKey, snap.id);
      const extension = blob.type === 'image/png' ? 'png' : 'jpg';
      files.push(new File([blob], `live-photo-${snap.id.slice(0, 8)}.${extension}`, { type: blob.type || 'image/jpeg' }));
    }
    await onSnapshots(files);
    setAdded((items) => [...items, ...list.map((snap) => snap.id)]);
    return `${files.length} photo${files.length === 1 ? '' : 's'} added to your screening.`;
  }

  async function addToScreening() {
    if (!session || !pending.length) return;
    setBusy(true); setError('');
    try { setNotice(await addSnapshots(session.id, pending)); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  // Closing the device camera adds whatever it took, then ends the session.
  async function finishDevice() {
    if (!session) return;
    const current = session;
    setDeviceMode(false);
    setBusy(true); setError('');
    try {
      const fresh = await liveApi.state(current.id);
      const taken = fresh.snapshots.filter((snap) => !added.includes(snap.id));
      const summary = taken.length ? await addSnapshots(current.id, taken) : '';
      await liveApi.end(current.id).catch(() => {});
      resetSession();
      setNotice(summary);
    } catch (cause) {
      setError(message(cause));
      resetSession();
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    const deviceButton = canUseCamera && (
      <button type="button" className={touchFirst ? 'btn btn-primary' : 'btn btn-secondary'} disabled={disabled || busy} aria-disabled={locked} onClick={() => startSession('device')}>
        <Camera size={16} /> Use this device's camera
      </button>
    );
    const phoneButton = (
      <button type="button" className="btn btn-secondary" disabled={disabled || busy} aria-disabled={locked} onClick={() => startSession('phone')}>
        {busy ? <LoaderCircle size={16} className="live-spin" /> : <QrCode size={16} />} {touchFirst ? 'Use a different phone' : 'Use phone camera'}
      </button>
    );
    return (<>
      <Divider />
      <section className={locked ? 'live-panel is-locked' : 'live-panel'} aria-labelledby="live-heading">
        <div className="live-intro"><Smartphone size={22} /><div>
          <h3 id="live-heading">Use your camera</h3>
          <p>On-screen tips help you get a clear photo.</p>
        </div></div>
        {notice && <p className="live-notice" role="status">{notice}</p>}
        {error && <p className="live-error" role="alert">{error}</p>}
        <div className="live-start-actions">{touchFirst ? <>{deviceButton}{phoneButton}</> : <>{phoneButton}{deviceButton}</>}</div>
      </section>
    </>);
  }

  if (deviceMode) return <LiveCamera id={session.id} token={session.token} onDone={finishDevice} />;

  const insecure = !isSecureForPhone(origin);
  return (<>
    <Divider />
    <section className="live-panel" aria-labelledby="live-heading">
      <h3 id="live-heading">Phone camera</h3>
      {insecure && <p className="live-warning" role="alert">Phones can only open the camera over HTTPS. This address is not secure, so the phone will not start the camera.</p>}
      <div className="live-pairing">
        {qr ? <img src={qr} alt="QR code to open the live camera on your phone" width={200} height={200} /> : null}
        <div className="live-pairing-text">
          <p className={phoneConnected ? 'live-status-line is-on' : 'live-status-line'}>
            {phoneConnected ? 'Phone connected. Take photos on your phone.' : 'Scan with your phone camera.'}
          </p>
          <details className="live-link">
            <summary>Can't scan? Copy the phone link</summary>
            <input readOnly value={pairUrl} aria-label="Phone link" onFocus={(event) => event.currentTarget.select()} />
          </details>
        </div>
      </div>
      {notice && <p className="live-notice" role="status">{notice}</p>}
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
        <button type="button" className="screening-text-button" disabled={busy} onClick={endSession}>End phone camera</button>
      </div>
    </section>
  </>);
}
