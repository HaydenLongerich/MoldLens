import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dispatch, intake, png, multipart, jsonRequest, cookieHeader, withCookie, createStaff, signIn, setupCode } from './http-helpers.mjs';
import { createApp } from '../server/app.mjs';
import { validateIntake, validateUpdates } from '../server/validation.mjs';
import { detectMedia, MAX_FILE_SIZE } from '../server/uploads.mjs';


async function workspace(callback) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-test-'));
  try { await callback({ ...(await createApp({ dataDirectory, seeds: [], authOptions: { setupCode } })), dataDirectory }); }
  finally { await rm(dataDirectory, { recursive: true, force: true }); }
}

test('intake creates a real case, validates a photo, and persists edits and notes across restarts', async () => workspace(async ({ app, dataDirectory }) => {
  const create = await dispatch(app, multipart({ ...intake, status: 'Completed', priority: 'High', id: 'injected', isDemo: true }, [{ name: 'window.png', type: 'image/png', data: png }]));
  assert.equal(create.status, 201, create.body.toString());
  const record = create.json();
  assert.match(record.id, /^ML-[A-F0-9]{8}$/);
  assert.equal(record.status, 'New');
  assert.equal(record.priority, undefined);
  assert.equal(record.isDemo, false);
  assert.equal(record.postalCode, 'K1S 3W7');
  assert.equal(record.attachments.length, 1);
  assert.equal(record.attachments[0].type, 'image/png');
  assert.equal(record.attachments[0].name, 'window.png');
  assert.match(record.attachments[0].url, /^\/uploads\/[a-f0-9-]+\.png$/);
  assert.deepEqual(await readFile(path.join(dataDirectory, record.attachments[0].url)), png);
  const customerCookie = cookieHeader(create);
  const media = await dispatch(app, withCookie({ url: record.attachments[0].url }, customerCookie));
  assert.equal(media.status, 200);
  assert.equal(media.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(media.body, png);

  const staffCookie = await createStaff(app);
  const update = await dispatch(app, withCookie(jsonRequest('PATCH', `/api/requests/${record.id}`, { status: 'Scheduled', priority: 'High', assignee: 'Staff A', scheduledAt: '2026-11-02T15:30:00.000Z' }), staffCookie));
  assert.equal(update.status, 200, update.body.toString());
  assert.equal(update.json().status, 'Scheduled');
  const note = await dispatch(app, withCookie(jsonRequest('POST', `/api/requests/${record.id}/notes`, { text: 'Called client to arrange the inspection.' }), staffCookie));
  assert.equal(note.status, 201);
  assert.equal(note.json().notes[0].text, 'Called client to arrange the inspection.');
  const restarted = await createApp({ dataDirectory, seeds: [{ id: 'should-not-reseed' }] });
  const listing = await dispatch(restarted.app, { headers: { cookie: await signIn(restarted.app) } });
  assert.equal(listing.status, 200);
  assert.equal(listing.json().length, 1);
  assert.equal(listing.json()[0].assignee, 'Staff A');
  assert.equal(listing.json()[0].notes.length, 1);
}));

test('invalid intake is rejected and already-uploaded files are removed', async () => workspace(async ({ app, dataDirectory }) => {
  const result = await dispatch(app, multipart({ ...intake, email: 'invalid', consent: false }, [{ name: 'window.png', type: 'image/png', data: png }]));
  assert.equal(result.status, 400);
  assert.equal((await dispatch(app, { url: '/api/my-requests' })).json().length, 0);
  assert.deepEqual(await readdir(path.join(dataDirectory, 'uploads')), []);
}));

test('a short customer request saves without a street address, phone, or property questionnaire', async () => workspace(async ({ app, dataDirectory }) => {
  const minimal = {
    name: 'Simple Intake', email: 'simple@example.test', postalCode: 'k1s3w7',
    description: 'There are dark spots near a window.', consent: true,
  };
  const result = await dispatch(app, multipart(minimal, [{ name: 'window.png', type: 'image/png', data: png }]));
  assert.equal(result.status, 201, result.body.toString());
  const record = result.json();
  assert.equal(record.address, '');
  assert.equal(record.phone, '');
  assert.equal(record.propertyType, 'Not specified');
  assert.equal(record.area, 'Not specified');
  assert.equal(record.relationship, 'Not specified');
  assert.equal(record.size, 'Not sure');
  assert.equal(record.duration, 'Not sure');
  assert.equal(record.contactPreference, 'Email');
  assert.deepEqual(record.signs, []);
  assert.equal(record.attachments.length, 1);
  assert.equal(record.postalCode, 'K1S 3W7');
  const restarted = await createApp({ dataDirectory, seeds: [], authOptions: { setupCode } });
  const persisted = (await dispatch(restarted.app, withCookie({ url: `/api/requests/${record.id}` }, cookieHeader(result)))).json();
  assert.deepEqual(persisted, record);

  for (const contactPreference of ['Phone call', 'Text message']) {
    const invalid = await dispatch(app, multipart({ ...minimal, contactPreference }));
    assert.equal(invalid.status, 400);
    assert.match(invalid.json().error, /phone number/);
  }
  const invalidPhone = await dispatch(app, multipart({ ...minimal, phone: '123' }));
  assert.equal(invalidPhone.status, 400);
}));

test('unsupported and spoofed media are rejected with no orphaned files', async () => workspace(async ({ app, dataDirectory }) => {
  for (const file of [
    { name: 'unsafe.svg', type: 'image/svg+xml', data: Buffer.from('<svg onload="alert(1)" />') },
    { name: 'fake.png', type: 'image/png', data: Buffer.from('<html>Not an image</html>') },
    { name: 'wrong.jpg', type: 'image/jpeg', data: png },
  ]) {
    const result = await dispatch(app, multipart(intake, [file]));
    assert.equal(result.status, 415, result.body.toString());
    assert.deepEqual(await readdir(path.join(dataDirectory, 'uploads')), []);
  }
}));

test('upload count is limited and client filenames cannot change the storage path', async () => workspace(async ({ app, dataDirectory }) => {
  const tooMany = await dispatch(app, multipart(intake, Array.from({ length: 11 }, (_, i) => ({ name: `${i}.png`, type: 'image/png', data: png }))));
  assert.equal(tooMany.status, 400, tooMany.body.toString());
  assert.deepEqual(await readdir(path.join(dataDirectory, 'uploads')), []);
  const safe = await dispatch(app, multipart(intake, [{ name: '../../escape.png', type: 'image/png', data: png }]));
  assert.equal(safe.status, 201);
  assert.equal(safe.json().attachments[0].name, 'escape.png');
  assert.match(safe.json().attachments[0].url, /^\/uploads\/[a-f0-9-]+\.png$/);
}));

test('oversized media is rejected and partially-written files are removed', async () => workspace(async ({ app, dataDirectory }) => {
  const oversized = Buffer.alloc(MAX_FILE_SIZE + 1);
  png.copy(oversized);
  const result = await dispatch(app, multipart(intake, [{ name: 'large.png', type: 'image/png', data: oversized }]));
  assert.equal(result.status, 413, result.body.toString());
  assert.deepEqual(await readdir(path.join(dataDirectory, 'uploads')), []);
  assert.equal((await dispatch(app, { url: '/api/my-requests' })).json().length, 0);
}));

test('a file exactly at the 25 MB limit is accepted without truncation', async () => workspace(async ({ app, dataDirectory }) => {
  const atLimit = Buffer.alloc(MAX_FILE_SIZE);
  png.copy(atLimit);
  const result = await dispatch(app, multipart(intake, [{ name: 'at-limit.png', type: 'image/png', data: atLimit }]));
  assert.equal(result.status, 201, result.body.toString());
  const attachment = result.json().attachments[0];
  assert.equal(attachment.size, MAX_FILE_SIZE);
  assert.deepEqual(await readFile(path.join(dataDirectory, attachment.url)), atLimit);
}));

test('the provided walkthrough video uploads, persists, and serves original bytes and video ranges', async () => workspace(async ({ app, dataDirectory }) => {
  const video = await readFile(new URL('../public/sample-data/02_Virtual_Sample/Videos/Walkthrough_Silent.mp4', import.meta.url));
  const result = await dispatch(app, multipart(intake, [{ name: 'Walkthrough_Silent.mp4', type: 'video/mp4', data: video }]));
  assert.equal(result.status, 201, result.body.toString());
  const record = result.json();
  const attachment = record.attachments[0];
  assert.equal(attachment.name, 'Walkthrough_Silent.mp4');
  assert.equal(attachment.type, 'video/mp4');
  assert.equal(attachment.size, video.length);
  assert.match(attachment.url, /^\/uploads\/[a-f0-9-]+\.mp4$/);
  const customerCookie = cookieHeader(result);
  const media = await dispatch(app, withCookie({ url: attachment.url }, customerCookie));
  assert.equal(media.status, 200);
  assert.equal(media.headers['content-type'], 'video/mp4');
  assert.deepEqual(media.body, video);
  const range = await dispatch(app, withCookie({ url: attachment.url, headers: { range: 'bytes=0-1023' } }, customerCookie));
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], `bytes 0-1023/${video.length}`);
  assert.deepEqual(range.body, video.subarray(0, 1024));
  const restarted = await createApp({ dataDirectory, seeds: [], authOptions: { setupCode } });
  const persisted = (await dispatch(restarted.app, withCookie({ url: `/api/requests/${record.id}` }, cookieHeader(result)))).json();
  assert.deepEqual(persisted.attachments[0], attachment);
}));

test('API rejects invalid updates, empty notes, malformed JSON, unknown IDs and cross-origin changes', async () => workspace(async ({ app }) => {
  const staffCookie = await createStaff(app);
  const authorized = (options = {}) => dispatch(app, withCookie(options, staffCookie));
  const record = (await dispatch(app, multipart(intake))).json();
  for (const updates of [{ status: 'Unrecognized' }, { status: 'Scheduled' }, { priority: 'Urgent' }, { scheduledAt: 'tomorrow' }, { scheduledAt: '2026-02-30T10:00:00.000Z' }, { email: 'changed@example.test' }, {}]) {
    assert.equal((await authorized(jsonRequest('PATCH', `/api/requests/${record.id}`, updates))).status, 400);
  }
  assert.equal((await authorized(jsonRequest('POST', `/api/requests/${record.id}/notes`, { text: '   ' }))).status, 400);
  assert.equal((await authorized(jsonRequest('PATCH', '/api/requests/unknown', { status: 'In review' }))).status, 404);
  assert.equal((await authorized({ url: '/api/does-not-exist' })).status, 404);
  assert.equal((await authorized({ ...jsonRequest('PATCH', `/api/requests/${record.id}`, {}), body: '{broken' })).status, 400);
  const external = await authorized(jsonRequest('PATCH', `/api/requests/${record.id}`, { status: 'Completed' }, { origin: 'https://untrusted.example' }));
  assert.equal(external.status, 403);
  const rebound = await authorized({ url: '/api/requests', headers: { host: 'malicious.example' } });
  assert.equal(rebound.status, 403);
  assert.equal((await authorized()).json()[0].status, 'New');
}));

test('concurrent notes are serialized without losing changes', async () => workspace(async ({ app, store }) => {
  const record = (await dispatch(app, multipart(intake))).json();
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.addNote(record.id, `Team note ${index}`)));
  assert.equal((await store.get(record.id)).notes.length, 8);
  const persisted = JSON.parse(await readFile(store.filename, 'utf8'));
  assert.equal(persisted[0].notes.length, 8);
}));

test('provided contractor information and local health endpoint are available', async () => workspace(async ({ app }) => {
  assert.equal((await dispatch(app, { url: '/api/health' })).json().mode, 'local-demo');
  const result = await dispatch(app, { url: '/api/contractors' });
  assert.equal(result.status, 200);
  assert.ok(result.json().length >= 3);
  assert.ok(result.json().every((provider) => provider.sourceUrl.startsWith('https://')));
}));

test('validation requires actual consent and valid Canadian property information', () => {
  assert.throws(() => validateIntake({ ...intake, consent: 'true' }), /permission/);
  assert.throws(() => validateIntake({ ...intake, postalCode: '90210' }), /postal code/);
  assert.throws(() => validateIntake({ ...intake, signs: ['invented'] }), /signs/);
  assert.throws(() => validateIntake({ ...intake, phone: 'abc123' }), /phone number/);
  assert.equal(validateIntake({ ...intake, phone: '' }).phone, '');
  assert.throws(() => validateIntake({ ...intake, phone: '', contactPreference: 'Phone call' }), /phone number/);
  assert.throws(() => validateUpdates({ scheduledAt: 'invalid' }), /date and time/);
  assert.equal(detectMedia(png), 'image/png');
  assert.equal(detectMedia(Buffer.from('a file without a media signature')), null);
});
