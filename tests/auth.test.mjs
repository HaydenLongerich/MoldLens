import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { dispatch, intake, png, multipart, jsonRequest, cookieHeader, withCookie, createStaff, signIn, setupCode, staffCredentials } from './http-helpers.mjs';

async function workspace(callback, authOptions = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-auth-test-'));
  try {
    await callback({ ...(await createApp({ dataDirectory, seeds: [], authOptions: { setupCode, ...authOptions } })), dataDirectory });
  } finally { await rm(dataDirectory, { recursive: true, force: true }); }
}
const session = (app, cookie = '') => dispatch(app, withCookie({ url: '/api/auth/session' }, cookie));
const assertDenied = response => assert.ok([401, 403, 404].includes(response.status), `Expected access denial, got ${response.status}: ${response.body}`);

// Tests use independent browsers (different cookie headers), rather than relying on
// the UI to hide private records or admin controls.
test('first staff setup requires the private code, validates credentials, and closes after use', async () => workspace(async ({ app, dataDirectory }) => {
  const initial = await session(app);
  assert.deepEqual(initial.json(), { user: null, setupRequired: true });
  assert.ok(!initial.body.includes(setupCode));
  const wrong = await dispatch(app, jsonRequest('POST', '/api/auth/setup', { ...staffCredentials, setupCode: 'incorrect-code' }));
  assertDenied(wrong);
  const weak = await dispatch(app, jsonRequest('POST', '/api/auth/setup', { ...staffCredentials, password: 'short', setupCode }));
  assert.equal(weak.status, 400);
  const cookie = await createStaff(app);
  assert.deepEqual((await session(app, cookie)).json(), { user: { email: staffCredentials.email, role: 'admin' }, setupRequired: false });
  const duplicate = await dispatch(app, jsonRequest('POST', '/api/auth/setup', { email: 'intruder@example.test', password: staffCredentials.password, setupCode }));
  assert.equal(duplicate.status, 409);
  const privateFiles = (await readdir(dataDirectory)).filter(name => name !== 'requests.json');
  const persisted = await Promise.all(privateFiles.map(async name => ({ text: await readFile(path.join(dataDirectory, name), 'utf8'), mode: (await stat(path.join(dataDirectory, name))).mode })));
  assert.ok(persisted.some(file => file.text.includes(staffCredentials.email)), 'Account is persisted');
  for (const file of persisted) {
    assert.ok(!file.text.includes(staffCredentials.password), 'Passwords must never be persisted as plaintext');
    assert.equal(file.mode & 0o077, 0, 'Credential files must not be readable by other users');
  }
  const restarted = await createApp({ dataDirectory, seeds: [] });
  assert.equal((await session(restarted.app, cookie)).json().user, null, 'Server restart invalidates in-memory sessions');
  const nextCookie = await signIn(restarted.app);
  assert.equal((await session(restarted.app, nextCookie)).json().user.email, staffCredentials.email);
}));

test('simultaneous first-account creation cannot create a second administrator', async () => workspace(async ({ app }) => {
  const attempts = await Promise.all(['first@example.test', 'second@example.test'].map(email => dispatch(app, jsonRequest('POST', '/api/auth/setup', { email, password: staffCredentials.password, setupCode }))));
  const successes = attempts.filter(response => [200, 201].includes(response.status));
  assert.equal(successes.length, 1);
  assert.equal(attempts.filter(response => response.status === 409).length, 1);
  const loser = attempts[0].status === 409 ? 'first@example.test' : 'second@example.test';
  const login = await dispatch(app, jsonRequest('POST', '/api/auth/login', { email: loser, password: staffCredentials.password }));
  assert.equal(login.status, 401);
}));

test('staff APIs reject anonymous and customer access while public intake and directory remain open', async () => workspace(async ({ app }) => {
  const created = await dispatch(app, multipart(intake));
  assert.equal(created.status, 201);
  const id = created.json().id;
  const customerCookie = cookieHeader(created);
  for (const cookie of ['', customerCookie]) {
    assert.equal((await dispatch(app, withCookie({ url: '/api/requests' }, cookie))).status, 401);
    assert.equal((await dispatch(app, withCookie(jsonRequest('PATCH', `/api/requests/${id}`, { status: 'Completed' }), cookie))).status, 401);
    assert.equal((await dispatch(app, withCookie(jsonRequest('POST', `/api/requests/${id}/notes`, { text: 'Unauthorized note' }), cookie))).status, 401);
  }
  assert.equal((await dispatch(app, { url: '/api/contractors' })).status, 200);
  assert.equal((await dispatch(app, { url: '/api/health' })).status, 200);
  const staffCookie = await createStaff(app);
  const listing = await dispatch(app, withCookie({ url: '/api/requests' }, staffCookie));
  assert.equal(listing.status, 200);
  assert.equal(listing.json().length, 1);
  assert.equal(listing.json()[0].status, 'New');
  assert.deepEqual(listing.json()[0].notes, []);
}));

test('customers can only read their own requests and media, including after a server restart', async () => workspace(async ({ app, store, dataDirectory }) => {
  const first = await dispatch(app, multipart({ ...intake, name: 'First customer', customerOwnerHash: 'forged' }, [{ name: 'private.png', type: 'image/png', data: png }]));
  const second = await dispatch(app, multipart({ ...intake, name: 'Second customer' }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstCookie = cookieHeader(first);
  const secondCookie = cookieHeader(second);
  assert.notEqual(firstCookie, secondCookie);
  for (const response of [first, second]) {
    assert.match(response.headers['set-cookie'].toString(), /HttpOnly/i);
    assert.match(response.headers['set-cookie'].toString(), /SameSite=Strict/i);
    assert.match(response.headers['set-cookie'].toString(), /Path=\//i);
    assert.equal(response.json().customerOwnerHash, undefined);
    assert.equal(response.json().priority, undefined);
  }
  const record = first.json();
  await store.addNote(record.id, 'Internal staff note that customers must never receive.');
  await store.update(record.id, { priority: 'High', source: { findings: ['Private internal review'] } });
  await store.create({ ...record, id: 'MB-SAMPLE', isDemo: true, notes: [], attachments: [], customerOwnerHash: undefined });
  assert.deepEqual((await dispatch(app, { url: '/api/my-requests' })).json(), []);
  const own = await dispatch(app, withCookie({ url: '/api/my-requests' }, firstCookie));
  assert.deepEqual(own.json().map(item => item.id), [record.id]);
  assert.deepEqual(own.json()[0].notes, []);
  assert.equal(own.json()[0].priority, undefined);
  assert.equal(own.json()[0].source, undefined);
  assert.equal(own.json()[0].customerOwnerHash, undefined);
  assert.ok(!own.body.includes('Internal staff note'));
  for (const cookie of ['', secondCookie, 'moldlens_customer=forged']) {
    assertDenied(await dispatch(app, withCookie({ url: `/api/requests/${record.id}` }, cookie)));
    assertDenied(await dispatch(app, withCookie({ url: record.attachments[0].url }, cookie)));
  }
  const attachment = await dispatch(app, withCookie({ url: record.attachments[0].url }, firstCookie));
  assert.equal(attachment.status, 200);
  assert.match(attachment.headers['cache-control'], /no-store/);
  assert.deepEqual(attachment.body, png);
  const again = await dispatch(app, withCookie(multipart({ ...intake, name: 'Another first-customer request' }), firstCookie));
  assert.equal(again.status, 201);
  assert.equal((await dispatch(app, withCookie({ url: '/api/my-requests' }, firstCookie))).json().length, 2);
  const restarted = await createApp({ dataDirectory, seeds: [] });
  assert.equal((await dispatch(restarted.app, withCookie({ url: '/api/my-requests' }, firstCookie))).json().length, 2);
  const staffCookie = await createStaff(restarted.app);
  const adminDetail = await dispatch(restarted.app, withCookie({ url: `/api/requests/${record.id}` }, staffCookie));
  assert.equal(adminDetail.json().notes[0].text, 'Internal staff note that customers must never receive.');
  assert.equal(adminDetail.json().priority, 'High');
  assert.equal(adminDetail.json().customerOwnerHash, undefined);
  assert.equal((await dispatch(restarted.app, withCookie({ url: record.attachments[0].url }, staffCookie))).status, 200);
}));

test('staff cookies are protected, logout revokes replay, and staff logout preserves customer tracking', async () => workspace(async ({ app }) => {
  const customer = await dispatch(app, multipart(intake));
  const customerCookie = cookieHeader(customer);
  await createStaff(app);
  const login = await dispatch(app, jsonRequest('POST', '/api/auth/login', staffCredentials));
  assert.equal(login.status, 200);
  const cookie = cookieHeader(login);
  const setCookie = login.headers['set-cookie'].toString();
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\//i);
  assert.match(setCookie, /Max-Age=/i);
  assert.ok(!login.body.includes(staffCredentials.password));
  const combined = `${cookie}; ${customerCookie}`;
  const logout = await dispatch(app, withCookie(jsonRequest('POST', '/api/auth/logout', {}), combined));
  assert.equal(logout.status, 200);
  assert.equal(logout.json().user, null);
  assert.match(logout.headers['set-cookie'].toString(), /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  assert.equal((await dispatch(app, withCookie({ url: '/api/requests' }, cookie))).status, 401);
  assert.equal((await session(app, cookie)).json().user, null);
  assert.equal((await dispatch(app, withCookie({ url: '/api/my-requests' }, combined))).json().length, 1);
}));

test('staff sessions expire on the server even if the browser replays the cookie', async () => {
  let now = Date.now();
  await workspace(async ({ app }) => {
    const cookie = await createStaff(app);
    assert.equal((await dispatch(app, withCookie({ url: '/api/requests' }, cookie))).status, 200);
    now += 8 * 60 * 60 * 1000 + 1;
    assert.equal((await dispatch(app, withCookie({ url: '/api/requests' }, cookie))).status, 401);
    assert.equal((await session(app, cookie)).json().user, null);
  }, { now: () => now });
});

test('login failures are generic and repeated attempts are throttled', async () => workspace(async ({ app }) => {
  await createStaff(app);
  const unknown = await dispatch(app, jsonRequest('POST', '/api/auth/login', { email: 'unknown@example.test', password: staffCredentials.password }));
  const incorrect = await dispatch(app, jsonRequest('POST', '/api/auth/login', { ...staffCredentials, password: 'Wrong-password-2026!' }));
  assert.equal(unknown.status, 401);
  assert.equal(incorrect.status, 401);
  assert.deepEqual(unknown.json(), incorrect.json());
  let limited;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    limited = await dispatch(app, jsonRequest('POST', '/api/auth/login', { ...staffCredentials, password: 'Wrong-password-2026!' }));
    if (limited.status === 429) break;
    assert.equal(limited.status, 401);
  }
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
}));

test('cross-origin authentication changes are rejected and private project files are not served', async () => workspace(async ({ app, dataDirectory }) => {
  // Model Vite/static middleware mounted after createApp. Without the guard, a
  // private path would reach this successful fallback rather than Express's 404.
  app.get('*', (_request, response) => response.status(200).send('Static asset fallback'));
  assert.equal((await dispatch(app, { url: '/src/App.tsx' })).status, 200);
  const badSetup = await dispatch(app, jsonRequest('POST', '/api/auth/setup', { ...staffCredentials, setupCode }, { origin: 'https://untrusted.example' }));
  assert.equal(badSetup.status, 403);
  assert.equal((await session(app)).json().setupRequired, true);
  const cookie = await createStaff(app);
  const logout = await dispatch(app, withCookie(jsonRequest('POST', '/api/auth/logout', {}, { origin: 'https://untrusted.example' }), cookie));
  assert.equal(logout.status, 403);
  assert.equal((await session(app, cookie)).json().user.email, staffCredentials.email);
  for (const url of [
    '/data/requests.json', '/data/staff-setup-code', '/.git/config', '/server/auth.mjs', '/@fs/etc/passwd',
    '/DATA/requests.json', '/Data/staff-accounts.json', '/%64ata%2Fstaff-setup-code',
    '/%2564ata/staff-setup-code', '/%2564ata%252Fstaff-setup-code', '/src/../data/requests.json',
    '/%2573rc%252F..%252F%2564ata%252Frequests.json',
    `/@fs${path.join(dataDirectory, 'requests.json')}`,
    `/@fs${path.join(dataDirectory.toUpperCase(), 'requests.json')}`,
    `/@fs${path.join(dataDirectory, 'STAFF-SETUP-CODE')}`,
  ]) {
    assertDenied(await dispatch(app, { url }));
  }
}));
