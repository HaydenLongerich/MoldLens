import { useEffect, useRef, useState } from 'react';
import { Camera, ShieldCheck } from 'lucide-react';
import { LiveApiError, liveApi, liveSocketUrl } from '../lib/live-api';
import './live.css';

const FRAME_WIDTH = 640;
const FRAME_INTERVAL_MS = 150;
const RESEND_AFTER_MS = 1500;
const CAPTURE_MAX_SIDE = 2000;
const AUTO_CAPTURE_COOLDOWN_MS = 4000;
const MAX_RECONNECTS = 3;
// Close codes the server uses when the pairing is no longer valid. Retrying would not help.
const FINAL_CLOSE_CODES = [4400, 4401, 4404, 4409];
const DEFAULT_GUIDANCE = 'Point the camera at the affected area.';

// The pairing token lives in the URL fragment, so it is never sent to the server in the page request.
function readPairing() {
  const id = window.location.pathname.match(/^\/live\/([A-Za-z0-9-]{1,80})\/?$/)?.[1] ?? '';
  const token = window.location.hash.slice(1);
  return { id, token: /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : '' };
}

function frameBlob(video: HTMLVideoElement, maxSide: number, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    if (!video.videoWidth) return reject(new Error('The camera is not ready yet.'));
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) return reject(new Error('This browser cannot read the camera image.'));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('This frame could not be captured.'))), 'image/jpeg', quality);
  });
}

// The /live/<session> page a scanned QR code opens.
export default function PhoneCapturePage() {
  const pairing = readPairing();
  return <LiveCamera id={pairing.id} token={pairing.token} />;
}

// The camera itself. The screening page also opens it as a full-screen overlay for the device in
// hand; `onDone` then closes the overlay and the screening adds the photos.
export function LiveCamera({ id, token, onDone }: { id: string; token: string; onDone?: () => void }) {
  const pairing = { id, token };
  const overlay = onDone ? ' is-overlay' : '';
  // As an overlay it is a modal dialog inside the app; on its own route it is the page.
  const Shell = onDone ? 'div' : 'main';
  const shellProps = onDone ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Live camera' } : { 'aria-label': 'Live camera' };
  const doneButton = onDone ? <button type="button" className="live-done" onClick={onDone}>Done</button> : null;
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const capture = useRef<((reason: 'auto' | 'manual') => void) | null>(null);
  const [running, setRunning] = useState(false);
  const [ended, setEnded] = useState('');
  const [error, setError] = useState('');
  const [guidance, setGuidance] = useState(DEFAULT_GUIDANCE);
  const [status, setStatus] = useState('');
  const [saved, setSaved] = useState(0);
  const [limit, setLimit] = useState(12);
  const [connected, setConnected] = useState(false);

  const linkIsValid = Boolean(pairing.id && pairing.token);

  async function start() {
    setError('');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('Camera access needs a secure (HTTPS) address. Scan the code again from a secure link.');
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false,
      });
      if (video.current) { video.current.srcObject = stream.current; await video.current.play().catch(() => {}); }
      setRunning(true);
    } catch {
      setError('The camera could not start. Allow camera access in your browser settings, then try again.');
    }
  }

  useEffect(() => {
    if (!running || !linkIsValid) return;
    const { id, token } = pairing;
    let closed = false;
    let socket: WebSocket | null = null;
    let reconnects = 0;
    let reconnectTimer = 0;
    let ready = false;
    let awaiting = false;
    let sentAt = 0;
    let lastCapture = 0;
    let capturing = false;

    async function takePhoto(reason: 'auto' | 'manual') {
      if (capturing || !video.current) return;
      if (reason === 'auto' && Date.now() - lastCapture < AUTO_CAPTURE_COOLDOWN_MS) return;
      capturing = true;
      lastCapture = Date.now();
      setStatus('Saving photo…');
      try {
        const photo = await frameBlob(video.current, CAPTURE_MAX_SIDE, 0.9);
        const response = await liveApi.savePhoto(id, token, photo);
        setSaved(response.count);
        setLimit(response.limit);
        setStatus(`Photo ${response.count} of ${response.limit} saved.`);
      } catch (cause) {
        setStatus(cause instanceof LiveApiError && cause.status === 409 ? cause.message : 'That photo did not save. Hold still and try the shutter again.');
      } finally {
        capturing = false;
      }
    }
    capture.current = (reason) => { void takePhoto(reason); };

    function sendFrame() {
      if (!socket || socket.readyState !== WebSocket.OPEN || !ready || !video.current) return;
      if (awaiting && Date.now() - sentAt < RESEND_AFTER_MS) return;
      awaiting = true;
      sentAt = Date.now();
      frameBlob(video.current, FRAME_WIDTH, 0.7)
        .then((blob) => { if (socket?.readyState === WebSocket.OPEN) socket.send(blob); })
        .catch(() => { awaiting = false; });
    }

    function connect() {
      const current = new WebSocket(liveSocketUrl(id, 'phone'));
      socket = current;
      current.binaryType = 'blob';
      current.onopen = () => {
        reconnects = 0;
        current.send(JSON.stringify({ type: 'hello', token }));
      };
      current.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type === 'ready') { ready = true; awaiting = false; setConnected(true); setStatus(''); }
        if (message.type === 'guidance') {
          awaiting = false;
          setGuidance(message.message);
          if (message.autoCapture) takePhoto('auto');
        }
        if (message.type === 'error') { awaiting = false; setStatus(message.message); }
      };
      current.onclose = (event) => {
        ready = false;
        setConnected(false);
        if (closed) return;
        if (FINAL_CLOSE_CODES.includes(event.code)) { setEnded(event.reason || 'This live session has ended.'); return; }
        if (reconnects++ < MAX_RECONNECTS) reconnectTimer = window.setTimeout(connect, 1000 * reconnects);
        else setEnded('The connection to the computer was lost. Scan the code again to reconnect.');
      };
    }

    connect();
    const frameTimer = window.setInterval(sendFrame, FRAME_INTERVAL_MS);
    return () => {
      closed = true;
      window.clearInterval(frameTimer);
      window.clearTimeout(reconnectTimer);
      capture.current = null;
      socket?.close();
    };
    // The pairing values are fixed for the life of this component.
  }, [running, linkIsValid]);

  useEffect(() => () => { stream.current?.getTracks().forEach((track) => track.stop()); }, []);

  if (!linkIsValid) {
    return <main className="live-phone"><section className="live-card"><ShieldCheck size={30} /><h1>This link is incomplete</h1><p>Scan the code on the computer again to start the live camera.</p></section></main>;
  }

  if (ended) {
    return <Shell className={`live-phone${overlay}`} {...shellProps}><section className="live-card"><ShieldCheck size={30} /><h1>Live camera ended</h1><p>{ended}</p><p className="live-muted">{saved} photo{saved === 1 ? '' : 's'} were saved for the screening.</p>{doneButton}</section></Shell>;
  }

  return (
    <Shell className={`live-phone${overlay}`} {...shellProps}>
      <header className="live-phone-header"><span>MoldLens</span>{doneButton ?? <span>Live camera</span>}</header>
      <div className="live-stage">
        <video ref={video} className="live-video" playsInline muted autoPlay aria-label="Live camera preview" />
        {running ? <p className="live-guidance" role="status" aria-live="polite">{guidance}</p> : null}
        {!running && (
          <section className="live-card live-consent">
            <Camera size={30} />
            <h1>Share your camera</h1>
            <p>MoldLens checks the live view to help you frame the photos. Only the photos you take are saved for this screening. The camera turns off when you finish.</p>
            {error && <p className="live-error" role="alert">{error}</p>}
            <button type="button" className="live-primary" onClick={start}>Start camera</button>
          </section>
        )}
      </div>
      {running && (
        <footer className="live-controls">
          <div className="live-status" aria-live="polite">
            <span className={connected ? 'live-dot is-on' : 'live-dot'} />
            {connected ? `${saved} of ${limit} photos` : 'Connecting…'}
            {status && <small>{status}</small>}
          </div>
          <button type="button" className="live-shutter" aria-label="Take photo" disabled={!connected} onClick={() => capture.current?.('manual')} />
        </footer>
      )}
    </Shell>
  );
}
