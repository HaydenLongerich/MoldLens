import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import WebSocket from 'ws';
import { dispatch, intake, multipart, withCookie, cookieHeader, setupCode } from './http-helpers.mjs';
import { createApp } from '../server/app.mjs';
import { decodeYolo, frameMetrics, guidanceFor, letterboxFor } from '../server/live/analysis.mjs';
import { createRegistry } from '../server/live/sessions.mjs';
import { isAllowedHost } from '../server/hosts.mjs';

const GOOD = { brightness: 120, sharpness: 500, width: 320, height: 240 };
const framed = (box, clipped = false) => [{ classId: 0, score: 0.9, box, clipped }];

test('guidance rules tell the user to adjust lighting, focus and distance in order', () => {
  assert.equal(guidanceFor({ metrics: { ...GOOD, brightness: 30 } }).code, 'more_light');
  assert.equal(guidanceFor({ metrics: { ...GOOD, brightness: 240 } }).code, 'glare');
  assert.equal(guidanceFor({ metrics: { ...GOOD, sharpness: 5 } }).code, 'hold_steady');
  assert.equal(guidanceFor({ metrics: GOOD }).code, 'ready');
});

test('framing guidance only applies when a detection model is loaded', () => {
  const far = { x: 0.4, y: 0.4, width: 0.05, height: 0.05 };
  assert.equal(guidanceFor({ metrics: GOOD, detections: framed(far), detectorReady: false }).code, 'ready');
  assert.equal(guidanceFor({ metrics: GOOD, detections: [], detectorReady: true }).code, 'find_area');
  assert.equal(guidanceFor({ metrics: GOOD, detections: framed(far), detectorReady: true }).code, 'move_closer');
  assert.equal(guidanceFor({ metrics: GOOD, detections: framed({ x: 0, y: 0.1, width: 0.5, height: 0.5 }, true), detectorReady: true }).code, 'move_back');
  assert.equal(guidanceFor({ metrics: GOOD, detections: framed({ x: 0.2, y: 0.2, width: 0.95, height: 0.6 }), detectorReady: true }).code, 'move_back');
  assert.equal(guidanceFor({ metrics: GOOD, detections: framed({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }), detectorReady: true }).code, 'ready');
});

test('letterboxing keeps aspect ratio and maps detections back to the original frame', () => {
  const letterbox = letterboxFor(1000, 500, 640);
  assert.deepEqual(letterbox, { inputSize: 640, newWidth: 640, newHeight: 320, padLeft: 0, padTop: 160 });
  // One box covering the centre of the letterboxed content (cx=320, cy=320, 320x160 in input pixels).
  const output = { data: Float32Array.from([320, 320, 320, 160, 0.9]), dims: [1, 5, 1] };
  const [detection] = decodeYolo(output, { numClasses: 1, letterbox });
  assert.deepEqual(detection.box, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.equal(detection.clipped, false);
});

test('YOLO decoding drops weak anchors and suppresses overlapping duplicates', () => {
  const letterbox = letterboxFor(640, 640, 640);
  // Two overlapping strong anchors and one weak anchor, laid out channel-major as [1, 5, 3].
  const anchors = 3;
  const data = new Float32Array(5 * anchors);
  const set = (channel, anchor, value) => { data[channel * anchors + anchor] = value; };
  [0, 1].forEach((i) => { set(0, i, 300 + i * 4); set(1, i, 300); set(2, i, 200); set(3, i, 200); set(4, i, 0.8 - i * 0.1); });
  set(0, 2, 100); set(1, 2, 100); set(2, 2, 40); set(3, 2, 40); set(4, 2, 0.1);
  const detections = decodeYolo({ data, dims: [1, 5, anchors] }, { numClasses: 1, confidence: 0.35, letterbox });
  assert.equal(detections.length, 1);
  assert.equal(detections[0].score, 0.8);
});

test('YOLO decoding rejects a model whose output does not match the class list', () => {
  assert.throws(() => decodeYolo({ data: new Float32Array(12), dims: [1, 6, 2] }, { numClasses: 1, letterbox: letterboxFor(10, 10, 640) }), /expected 5/);
});

test('frame metrics separate a flat blurred image from a sharp one', async () => {
  const flat = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer();
  const pixels = Buffer.alloc(320 * 240 * 3);
  for (let i = 0; i < 320 * 240; i++) pixels.fill((i % 320 + Math.floor(i / 320)) % 2 ? 180 : 60, i * 3, i * 3 + 3);
  const checker = await sharp(pixels, { raw: { width: 320, height: 240, channels: 3 } }).jpeg().toBuffer();
  const flatMetrics = await frameMetrics(flat);
  const sharpMetrics = await frameMetrics(checker);
  assert.ok(Math.abs(flatMetrics.brightness - 120) < 3);
  assert.ok(flatMetrics.sharpness < 5);
  assert.ok(sharpMetrics.sharpness > 1000);
});

test('pairing tokens are required, single-use per session claim, and expire', () => {
  let time = 0;
  const registry = createRegistry({ now: () => time, pairingMs: 1000, idleMs: 5000 });
  const { session, token } = registry.create('owner-a');
  assert.equal(registry.claim(session.id, 'wrong-token'), null);
  assert.equal(registry.claim(session.id, undefined), null);
  assert.equal(registry.claim(session.id, token)?.id, session.id);
  time = 4000;
  assert.ok(registry.get(session.id), 'claimed sessions use the longer idle timeout');
  time = 10000;
  assert.equal(registry.get(session.id), null);
});

test('ending a session notifies cleanup and owner-wide cleanup removes old codes', () => {
  const ended = [];
  const registry = createRegistry({ onEnd: (session) => ended.push(session.id) });
  const first = registry.create('owner-a').session;
  registry.create('owner-b');
  registry.endOwned('owner-a');
  assert.deepEqual(ended, [first.id]);
  assert.equal(registry.size(), 1);
});

test('host allowlist accepts loopback by default and only configured extras', () => {
  assert.equal(isAllowedHost('127.0.0.1:5173', {}), true);
  assert.equal(isAllowedHost('evil.example:5173', {}), false);
  assert.equal(isAllowedHost('192.168.1.20:5173', {}), false);
  assert.equal(isAllowedHost('192.168.1.20:5173', { MOLDLENS_ALLOWED_HOSTS: '192.168.1.20' }), true);
  assert.equal(isAllowedHost(undefined, {}), false);
});

async function workspace(callback) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-live-'));
  try { await callback({ ...(await createApp({ dataDirectory, seeds: [], authOptions: { setupCode } })), dataDirectory }); }
  finally { await rm(dataDirectory, { recursive: true, force: true }); }
}

async function customerCookie(app) {
  const response = await dispatch(app, multipart(intake, []));
  assert.equal(response.status, 201, response.body.toString());
  return cookieHeader(response);
}

const jpegBytes = () => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();

test('desktop routes are owned by the screening customer and phone uploads need the pairing token', async () => workspace(async ({ app, live }) => {
  const cookie = await customerCookie(app);
  const create = await dispatch(app, withCookie({ method: 'POST', url: '/api/live/sessions' }, cookie));
  assert.equal(create.status, 201, create.body.toString());
  const { id, token } = create.json();
  assert.equal(create.json().detector.ready, false);

  assert.equal((await dispatch(app, { method: 'POST', url: '/api/live/sessions' })).status, 403);
  assert.equal((await dispatch(app, { method: 'GET', url: `/api/live/sessions/${id}` })).status, 404);

  const photo = await jpegBytes();
  const unclaimed = await dispatch(app, { method: 'POST', url: `/api/live/sessions/${id}/snapshots`, headers: { 'content-type': 'image/jpeg', 'x-live-token': token }, body: photo });
  assert.equal(unclaimed.status, 404, 'a session must be claimed by a phone before it accepts photos');

  live.registry.claim(id, token);
  const wrongToken = await dispatch(app, { method: 'POST', url: `/api/live/sessions/${id}/snapshots`, headers: { 'content-type': 'image/jpeg', 'x-live-token': 'nope' }, body: photo });
  assert.equal(wrongToken.status, 404);
  const text = await dispatch(app, { method: 'POST', url: `/api/live/sessions/${id}/snapshots`, headers: { 'content-type': 'image/jpeg', 'x-live-token': token }, body: Buffer.from('not an image') });
  assert.equal(text.status, 415);
  const saved = await dispatch(app, { method: 'POST', url: `/api/live/sessions/${id}/snapshots`, headers: { 'content-type': 'image/jpeg', 'x-live-token': token }, body: photo });
  assert.equal(saved.status, 201, saved.body.toString());
  const snapshotId = saved.json().id;

  const state = await dispatch(app, withCookie({ url: `/api/live/sessions/${id}` }, cookie));
  assert.equal(state.status, 200);
  assert.equal(state.json().snapshots.length, 1);
  assert.equal(state.json().phoneConnected, false);

  const image = await dispatch(app, withCookie({ url: `/api/live/sessions/${id}/snapshots/${snapshotId}` }, cookie));
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/jpeg');
  assert.deepEqual(image.body, photo);
  const otherCustomer = await customerCookie(app);
  assert.equal((await dispatch(app, withCookie({ url: `/api/live/sessions/${id}/snapshots/${snapshotId}` }, otherCustomer))).status, 404);

  assert.equal((await dispatch(app, withCookie({ method: 'DELETE', url: `/api/live/sessions/${id}` }, cookie))).status, 204);
  assert.equal((await dispatch(app, withCookie({ url: `/api/live/sessions/${id}` }, cookie))).status, 404);
}));

test('a live socket round trip gives the phone guidance and the desktop preview and analysis', { timeout: 20000 }, async () => workspace(async ({ app, live }) => {
  const cookie = await customerCookie(app);
  const create = await dispatch(app, withCookie({ method: 'POST', url: '/api/live/sessions' }, cookie));
  const { id, token } = create.json();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  live.attach(server);
  const base = `ws://127.0.0.1:${server.address().port}/api/live/socket`;
  const sockets = [];
  const open = (url, headers = {}) => new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    sockets.push(socket);
    const messages = [];
    socket.on('message', (data, isBinary) => messages.push({ data, isBinary }));
    socket.once('open', () => resolve({ socket, messages }));
    socket.once('error', reject);
  });
  const waitFor = (messages, predicate) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = messages.find(predicate);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error('Timed out waiting for a socket message')); }
    }, 20);
  });
  try {
    const desktop = await open(`${base}?session=${id}&role=desktop`, { cookie });
    await waitFor(desktop.messages, ({ data, isBinary }) => !isBinary && JSON.parse(data).type === 'hello');
    const phone = await open(`${base}?session=${id}&role=phone`);
    phone.socket.send(JSON.stringify({ type: 'hello', token }));
    await waitFor(phone.messages, ({ data, isBinary }) => !isBinary && JSON.parse(data).type === 'ready');
    await waitFor(desktop.messages, ({ data, isBinary }) => !isBinary && JSON.parse(data).type === 'phone' && JSON.parse(data).connected === true);

    phone.socket.send(await jpegBytes(), { binary: true });
    const guidance = await waitFor(phone.messages, ({ data, isBinary }) => !isBinary && JSON.parse(data).type === 'guidance');
    const reply = JSON.parse(guidance.data);
    assert.equal(typeof reply.code, 'string');
    assert.equal(reply.autoCapture, false);
    await waitFor(desktop.messages, ({ isBinary }) => isBinary);
    await waitFor(desktop.messages, ({ data, isBinary }) => !isBinary && JSON.parse(data).type === 'analysis');

    const wrong = await open(`${base}?session=${id}&role=phone`);
    wrong.socket.send(JSON.stringify({ type: 'hello', token: 'bad' }));
    await new Promise((resolve) => wrong.socket.once('close', resolve));

    const stranger = new WebSocket(`${base}?session=${id}&role=desktop`);
    sockets.push(stranger);
    const refused = await new Promise((resolve) => stranger.once('close', (code) => resolve(code)));
    assert.equal(refused, 4404, 'desktop sockets must belong to the customer who created the session');
    phone.socket.close();
    desktop.socket.close();
  } finally {
    // server.close waits for open sockets, so terminate them first or a failed assertion hangs the run.
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}));
