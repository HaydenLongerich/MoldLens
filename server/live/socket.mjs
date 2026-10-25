import { WebSocketServer } from 'ws';
import { isAllowedHost } from '../hosts.mjs';
import { frameMetrics, guidanceFor } from './analysis.mjs';

export const SOCKET_PATH = '/api/live/socket';
// Consecutive "ready" frames before the phone takes a photo on its own (about one second at the phone's frame rate).
export const AUTO_CAPTURE_STREAK = 3;

const json = (value) => JSON.stringify(value);

// Phones authenticate with the pairing token in their first message. Desktops
// authenticate with the same customer cookie the screening uses, checked on upgrade.
export function attachSocket(server, live) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== SOCKET_PATH) return;
    if (!isAllowedHost(request.headers.host)) return socket.destroy();
    const origin = request.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== request.headers.host) return socket.destroy(); }
      catch { return socket.destroy(); }
    }
    wss.handleUpgrade(request, socket, head, (ws) => connect(ws, request, url, live));
  });
  return wss;
}

function connect(ws, request, url, live) {
  const session = live.registry.get(url.searchParams.get('session') || '');
  if (!session) return ws.close(4404, 'This live session could not be found.');
  if (url.searchParams.get('role') === 'desktop') return connectDesktop(ws, request, session, live);
  return connectPhone(ws, session, live);
}

function connectDesktop(ws, request, session, live) {
  const owner = live.auth.getCustomerHash(request);
  if (!owner || owner !== session.ownerHash) return ws.close(4404, 'This live session could not be found.');
  session.desktops.add(ws);
  ws.send(json({ type: 'hello', phoneConnected: Boolean(session.phone), detector: live.detectorStatus }));
  ws.on('close', () => session.desktops.delete(ws));
}

function connectPhone(ws, session, live) {
  let claimed = null;
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      if (claimed) return;
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { return ws.close(4400, 'Please reopen the link from the computer.'); }
      if (message?.type !== 'hello') return ws.close(4400, 'Please reopen the link from the computer.');
      const current = live.registry.claim(session.id, message.token);
      if (!current) return ws.close(4401, 'This code has expired. Create a new code on the computer.');
      claimed = current;
      if (current.phone && current.phone !== ws) current.phone.close(4409, 'Another phone connected with this code.');
      current.phone = ws;
      live.send(current, { type: 'phone', connected: true });
      ws.send(json({ type: 'ready', detector: live.detectorStatus }));
      return;
    }
    if (!claimed) return ws.close(4401, 'Please reopen the link from the computer.');
    // Frames are analysed one at a time. The phone waits for guidance before sending the next.
    claimed.queue = claimed.queue.then(() => analyse(claimed, ws, data, live)).catch(() => {
      if (ws.readyState === ws.OPEN) ws.send(json({ type: 'error', message: 'This frame could not be read. Keep the camera on the area.' }));
    });
  });
  ws.on('close', () => {
    if (claimed?.phone === ws) {
      claimed.phone = null;
      live.send(claimed, { type: 'phone', connected: false });
    }
  });
}

async function analyse(session, phone, buffer, live) {
  if (live.registry.get(session.id) !== session) return phone.close(4404, 'This live session has ended.');
  const metrics = await frameMetrics(buffer);
  const detections = live.detector.ready ? await live.detector.detect(buffer) : [];
  const guidance = guidanceFor({ metrics, detections, detectorReady: live.detector.ready });
  session.streak = guidance.code === 'ready' ? session.streak + 1 : 0;
  session.guidance = guidance;
  live.registry.touch(session);
  const reply = { type: 'guidance', ...guidance, streak: session.streak, autoCapture: session.streak >= AUTO_CAPTURE_STREAK };
  if (phone.readyState === phone.OPEN) phone.send(json(reply));
  for (const desktop of session.desktops) if (desktop.readyState === desktop.OPEN) desktop.send(buffer, { binary: true });
  live.send(session, { ...reply, type: 'analysis', metrics, detections });
}
