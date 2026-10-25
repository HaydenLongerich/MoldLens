import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import WebSocket from 'ws';
import { dispatch, intake, multipart, withCookie, cookieHeader, setupCode } from './http-helpers.mjs';
import { createApp } from '../server/app.mjs';
import { frameMetrics, loadDetector } from '../server/live/analysis.mjs';
import { MAX_SNAPSHOTS } from '../server/live/index.mjs';

// Protocol and edge-case coverage for the live camera. The happy path lives in live.test.mjs
// and tests/live.spec.ts; these tests cover the rejections and limits.

async function workspace(callback) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-live-proto-'));
  try { await callback({ ...(await createApp({ dataDirectory, seeds: [], authOptions: { setupCode } })), dataDirectory }); }
  finally { await rm(dataDirectory, { recursive: true, force: true }); }
}

async function customerCookie(app) {
  const response = await dispatch(app, multipart(intake, []));
  assert.equal(response.status, 201, response.body.toString());
  return cookieHeader(response);
}

async function createSession(app, cookie) {
  const response = await dispatch(app, withCookie({ method: 'POST', url: '/api/live/sessions' }, cookie));
  assert.equal(response.status, 201, response.body.toString());
  return response.json();
}

const jpeg = (shade = 90) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: shade, b: shade } } }).jpeg().toBuffer();
// A checkerboard has strong edges, so it passes the focus check and reads as a sharp frame.
async function sharpFrame() {
  const pixels = Buffer.alloc(320 * 240 * 3);
  for (let i = 0; i < 320 * 240; i++) pixels.fill((i % 320 + Math.floor(i / 320)) % 2 ? 180 : 60, i * 3, i * 3 + 3);
  return sharp(pixels, { raw: { width: 320, height: 240, channels: 3 } }).jpeg().toBuffer();
}

function uploadRequest(id, token, body, type = 'image/jpeg') {
  return { method: 'POST', url: `/api/live/sessions/${id}/snapshots`, headers: { 'content-type': type, 'x-live-token': token }, body };
}

test('snapshots accept PNG, stop at the session limit, and are deleted when the session ends', async () => workspace(async ({ app, live, dataDirectory }) => {
  const cookie = await customerCookie(app);
  const { id, token } = await createSession(app, cookie);
  live.registry.claim(id, token);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toBuffer();
  const first = await dispatch(app, uploadRequest(id, token, png, 'image/png'));
  assert.equal(first.status, 201, first.body.toString());
  for (let i = 1; i < MAX_SNAPSHOTS; i++) assert.equal((await dispatch(app, uploadRequest(id, token, await jpeg(i)))).status, 201);
  const overflow = await dispatch(app, uploadRequest(id, token, await jpeg()));
  assert.equal(overflow.status, 409);
  assert.match(overflow.json().error, /up to 12 photos/);

  const stored = await dispatch(app, withCookie({ url: `/api/live/sessions/${id}/snapshots/${first.json().id}` }, cookie));
  assert.equal(stored.headers['content-type'], 'image/png');
  assert.deepEqual(stored.body, png);

  assert.equal((await dispatch(app, withCookie({ method: 'DELETE', url: `/api/live/sessions/${id}` }, cookie))).status, 204);
  // Removal runs in the background after the response, so wait for it rather than racing it.
  const photos = path.join(dataDirectory, 'live', id);
  for (let i = 0; i < 50; i++) { if (!(await access(photos).then(() => true, () => false))) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
  await assert.rejects(access(photos), 'photos must be removed when the session ends');
}));

test('creating a new code ends the previous session for the same customer', async () => workspace(async ({ app }) => {
  const cookie = await customerCookie(app);
  const older = await createSession(app, cookie);
  const newer = await createSession(app, cookie);
  assert.notEqual(older.id, newer.id);
  assert.equal((await dispatch(app, withCookie({ url: `/api/live/sessions/${older.id}` }, cookie))).status, 404);
  assert.equal((await dispatch(app, withCookie({ url: `/api/live/sessions/${newer.id}` }, cookie))).status, 200);
}));

test('photos need a claimed session, the right token, and a real image', async () => workspace(async ({ app, live }) => {
  const cookie = await customerCookie(app);
  const { id, token } = await createSession(app, cookie);
  assert.equal((await dispatch(app, uploadRequest(id, token, await jpeg()))).status, 404, 'an unclaimed code takes no photos');
  assert.equal((await dispatch(app, uploadRequest('00000000-0000-4000-8000-000000000000', token, await jpeg()))).status, 404);
  live.registry.claim(id, token);
  assert.equal((await dispatch(app, uploadRequest(id, token, Buffer.from('%PDF-1.4 not an image')))).status, 415);
}));

test('the detector stays off without a model and reports why', async () => {
  const none = await loadDetector({});
  assert.equal(none.ready, false);
  assert.equal(none.reason, 'no_model');
  assert.deepEqual(none.classes, ['visible_staining']);
  const missing = await loadDetector({ modelPath: path.join(os.tmpdir(), 'no-such-model.onnx') });
  assert.equal(missing.ready, false);
  assert.ok(['runtime_missing', 'model_unreadable'].includes(missing.reason), `unexpected reason ${missing.reason}`);
});

test('unreadable frames are rejected rather than analysed', async () => {
  await assert.rejects(frameMetrics(Buffer.from('not a jpeg')));
});

async function withSocketServer(app, live, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  live.attach(server);
  const sockets = [];
  const base = `ws://127.0.0.1:${server.address().port}/api/live/socket`;
  const open = (query, headers = {}) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base}?${query}`, { headers });
    const inbox = [];
    socket.on('message', (data, isBinary) => inbox.push({ data, isBinary }));
    sockets.push(socket);
    socket.once('open', () => resolve({ socket, inbox }));
    socket.once('error', reject);
  });
  const closed = (socket) => new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  const next = (inbox, predicate) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = inbox.find(predicate);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error('Timed out waiting for a socket message')); }
    }, 20);
  });
  try { await callback({ open, closed, next, base }); }
  finally {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (message) => JSON.stringify(message);
const isType = (type) => ({ data, isBinary }) => !isBinary && JSON.parse(data).type === type;

test('a phone that sends a frame before it says hello is disconnected', async () => workspace(async ({ app, live }) => {
  const cookie = await customerCookie(app);
  const { id } = await createSession(app, cookie);
  await withSocketServer(app, live, async ({ open, closed }) => {
    const phone = await open(`session=${id}&role=phone`);
    const close = closed(phone.socket);
    phone.socket.send(await jpeg(), { binary: true });
    assert.equal((await close).code, 4401);
  });
}));

test('a malformed hello is refused and a wrong token is refused', async () => workspace(async ({ app, live }) => {
  const cookie = await customerCookie(app);
  const { id, token } = await createSession(app, cookie);
  await withSocketServer(app, live, async ({ open, closed }) => {
    const garbled = await open(`session=${id}&role=phone`);
    const garbledClose = closed(garbled.socket);
    garbled.socket.send('{not json');
    assert.equal((await garbledClose).code, 4400);

    const wrong = await open(`session=${id}&role=phone`);
    const wrongClose = closed(wrong.socket);
    wrong.socket.send(json({ type: 'hello', token: 'x'.repeat(20) }));
    assert.equal((await wrongClose).code, 4401);

    const valid = await open(`session=${id}&role=phone`);
    const validClose = closed(valid.socket);
    valid.socket.send(json({ type: 'hello', token }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    valid.socket.close();
    await validClose;
  });
}));

test('a second phone with the same code replaces the first, and the first is told why', async () => workspace(async ({ app, live }) => {
  const cookie = await customerCookie(app);
  const { id, token } = await createSession(app, cookie);
  await withSocketServer(app, live, async ({ open, closed, next }) => {
    const desktop = await open(`session=${id}&role=desktop`, { cookie });
    const first = await open(`session=${id}&role=phone`);
    first.socket.send(json({ type: 'hello', token }));
    await next(first.inbox, isType('ready'));
    const firstClose = closed(first.socket);

    const second = await open(`session=${id}&role=phone`);
    second.socket.send(json({ type: 'hello', token }));
    await next(second.inbox, isType('ready'));

    const replaced = await firstClose;
    assert.equal(replaced.code, 4409);
    assert.match(replaced.reason, /Another phone/);
    const notice = await next(desktop.inbox, ({ data, isBinary }) => !isBinary && JSON.parse(data).type === 'phone' && JSON.parse(data).connected === true);
    assert.ok(notice);
    second.socket.close();
  });
}));

test('ending a session closes the desktop and phone sockets with a session-ended code', async () => workspace(async ({ app, live }) => {
  const cookie = await customerCookie(app);
  const { id, token } = await createSession(app, cookie);
  await withSocketServer(app, live, async ({ open, closed, next }) => {
    const desktop = await open(`session=${id}&role=desktop`, { cookie });
    await next(desktop.inbox, isType('hello'));
    const phone = await open(`session=${id}&role=phone`);
    phone.socket.send(json({ type: 'hello', token }));
    await next(phone.inbox, isType('ready'));
    const desktopClose = closed(desktop.socket);
    const phoneClose = closed(phone.socket);
    assert.equal((await dispatch(app, withCookie({ method: 'DELETE', url: `/api/live/sessions/${id}` }, cookie))).status, 204);
    assert.equal((await desktopClose).code, 4404);
    assert.equal((await phoneClose).code, 4404);
  });
}));

test('the third stable frame asks the phone to take a photo automatically', async () => workspace(async ({ app, live }) => {
  const cookie = await customerCookie(app);
  const { id, token } = await createSession(app, cookie);
  await withSocketServer(app, live, async ({ open, next }) => {
    const phone = await open(`session=${id}&role=phone`);
    phone.socket.send(json({ type: 'hello', token }));
    await next(phone.inbox, isType('ready'));
    const frame = await sharpFrame();
    const replies = [];
    for (let i = 0; i < 3; i++) {
      const seen = phone.inbox.length;
      phone.socket.send(frame, { binary: true });
      const reply = await next(phone.inbox, (message, index) => index >= seen && isType('guidance')(message));
      replies.push(JSON.parse(reply.data));
    }
    assert.deepEqual(replies.map((reply) => reply.streak), [1, 2, 3]);
    assert.equal(replies.at(-1).code, 'ready');
    assert.equal(replies.at(-1).autoCapture, true);
    assert.equal(replies[0].autoCapture, false);
  });
}));
