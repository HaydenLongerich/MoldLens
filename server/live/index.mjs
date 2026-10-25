import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { detectMedia, MAX_FILE_SIZE } from '../uploads.mjs';
import { HttpError } from '../validation.mjs';
import { createRegistry } from './sessions.mjs';
import { loadDetector } from './analysis.mjs';
import { attachSocket } from './socket.mjs';

export const MAX_SNAPSHOTS = 12;
const TOKEN_HEADER = 'x-live-token';

const wrap = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);

// Creates live-capture state: pairing registry, optional detector, and snapshot storage.
// The detector only runs when MOLDLENS_LIVE_MODEL points at an ONNX YOLO export, so
// nothing is detected until a model that was actually trained for staining is supplied.
export async function createLive({ auth, dataDirectory, env = process.env, now = Date.now }) {
  const root = path.join(dataDirectory, 'live');
  const classes = (env.MOLDLENS_LIVE_CLASSES || 'visible_staining').split(',').map((name) => name.trim()).filter(Boolean);
  const detector = await loadDetector({ modelPath: env.MOLDLENS_LIVE_MODEL || undefined, classes });
  const detectorStatus = { ready: detector.ready, reason: detector.reason, classes: detector.classes };
  const live = { auth, detector, detectorStatus, publicOrigin: env.MOLDLENS_PUBLIC_ORIGIN || null };

  live.registry = createRegistry({
    now,
    onEnd(session) {
      for (const desktop of session.desktops) desktop.close(4404, 'This live session has ended.');
      session.phone?.close(4404, 'This live session has ended.');
      rm(path.join(root, session.id), { recursive: true, force: true }).catch(() => {});
    },
  });
  live.send = (session, message) => {
    const text = JSON.stringify(message);
    for (const desktop of session.desktops) if (desktop.readyState === desktop.OPEN) desktop.send(text);
  };
  const sweeper = setInterval(() => live.registry.sweep(), 60_000);
  sweeper.unref();
  live.attach = (server) => attachSocket(server, live);
  live.close = () => {
    clearInterval(sweeper);
    for (const session of live.registry.all()) live.registry.end(session.id);
  };
  live.snapshotRoot = root;
  return live;
}

export function registerLiveRoutes(app, live) {
  const router = express.Router();
  const ownerOf = (request) => live.auth.getCustomerHash(request);

  // Desktop routes: the same customer cookie that owns the screening.
  function ownedSession(request) {
    const session = live.registry.get(request.params.id);
    const owner = ownerOf(request);
    if (!session || !owner || session.ownerHash !== owner) throw new HttpError(404, 'This live session could not be found.');
    return session;
  }

  router.use((_request, response, next) => { response.setHeader('Cache-Control', 'private, no-store'); next(); });

  router.post('/live/sessions', wrap(async (request, response) => {
    const owner = ownerOf(request);
    if (!owner) throw new HttpError(403, 'Start your screening first, then connect a phone.');
    live.registry.endOwned(owner);
    const { session, token } = live.registry.create(owner);
    response.status(201).json({
      id: session.id, token, expiresAt: new Date(session.expiresAt).toISOString(),
      publicOrigin: live.publicOrigin, detector: live.detectorStatus, limit: MAX_SNAPSHOTS,
    });
  }));

  router.get('/live/sessions/:id', wrap(async (request, response) => {
    const session = ownedSession(request);
    response.json({
      id: session.id, phoneConnected: Boolean(session.phone), claimed: session.claimed,
      expiresAt: new Date(session.expiresAt).toISOString(), guidance: session.guidance,
      snapshots: session.snapshots.map(({ id, createdAt, bytes }) => ({ id, createdAt, bytes })),
      limit: MAX_SNAPSHOTS, detector: live.detectorStatus,
    });
  }));

  router.delete('/live/sessions/:id', wrap(async (request, response) => {
    ownedSession(request);
    live.registry.end(request.params.id);
    response.status(204).end();
  }));

  router.get('/live/sessions/:id/snapshots/:snapshotId', wrap(async (request, response) => {
    const session = ownedSession(request);
    const snapshot = session.snapshots.find((item) => item.id === request.params.snapshotId);
    if (!snapshot) throw new HttpError(404, 'This photo could not be found.');
    const bytes = await readFile(path.join(live.snapshotRoot, session.id, `${snapshot.id}.${snapshot.ext}`));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.type(snapshot.type).send(bytes);
  }));

  // Phone route: the pairing token is the only credential. Photos are checked as real images before storage.
  router.post('/live/sessions/:id/snapshots', express.raw({ type: ['image/jpeg', 'image/png'], limit: MAX_FILE_SIZE }), wrap(async (request, response) => {
    const session = live.registry.get(request.params.id);
    if (!session?.claimed || !live.registry.verify(session, request.get(TOKEN_HEADER))) throw new HttpError(404, 'This live session could not be found.');
    const body = request.body;
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Please send a photo.');
    const type = detectMedia(body);
    if (type !== 'image/jpeg' && type !== 'image/png') throw new HttpError(415, 'Please send a JPEG or PNG photo.');
    try { await sharp(body, { failOn: 'error' }).metadata(); }
    catch { throw new HttpError(415, 'This photo could not be read. Please try again.'); }
    if (session.snapshots.length >= MAX_SNAPSHOTS) throw new HttpError(409, `You can take up to ${MAX_SNAPSHOTS} photos in one session.`);
    const id = randomUUID();
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const directory = path.join(live.snapshotRoot, session.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, `${id}.${ext}`), body, { mode: 0o600 });
    session.snapshots.push({ id, ext, type, bytes: body.length, createdAt: new Date().toISOString(), guidance: session.guidance?.code ?? null });
    session.streak = 0;
    live.registry.touch(session);
    live.send(session, { type: 'snapshot', id, count: session.snapshots.length, limit: MAX_SNAPSHOTS });
    response.status(201).json({ id, count: session.snapshots.length, limit: MAX_SNAPSHOTS });
  }));

  app.use('/api', router);
}
