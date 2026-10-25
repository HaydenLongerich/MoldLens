import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.mjs';
import { createDirectory, distanceKm, withinRadius, postalCode } from '../server/contractor-directory.mjs';
import { createInvitationSender } from '../server/quote-invitations.mjs';
import { dispatch, jsonRequest, withCookie, cookieHeader } from './http-helpers.mjs';

const post = (app, route, body, cookie = '') => dispatch(app, withCookie(jsonRequest('POST', `/api/marketplace${route}`, body), cookie));
const get = (app, route, cookie = '') => dispatch(app, withCookie({ url: `/api/marketplace${route}` }, cookie));
const locations = { 'L3Y 1A1': { lat: 44.05, lng: -79.46 }, 'L4G 1A1': { lat: 44.00, lng: -79.46 }, 'K1A 0B1': { lat: 45.42, lng: -75.70 } };
async function setup(t, options = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-routing-'));
  const service = await createApp({ dataDirectory, seeds: [], marketplaceOptions: { directoryOptions: { resolvePostal: async code => locations[code] }, ...options } });
  t.after(async () => { await service.marketplace.stop(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { ...service, dataDirectory };
}
async function register(service, key, code = 'L4G 1A1', paid = true) {
  const result = await post(service.app, '/register', { name: key, email: `${key}@example.test`, password: 'test-password-for-routing', postalCode: code, notificationsEnabled: true });
  assert.equal(result.status, 201, result.body.toString());
  const cookie = cookieHeader(result);
  if (paid) assert.equal((await post(service.app, '/membership/demo-pay', { confirm: true }, cookie)).status, 200);
  return { id: result.json().company.id, cookie };
}
const ready = (id = 'test-screen') => ({ id, reference: 'ML-SCREEN', status: 'ready_preview', reportAvailable: true, sharingAllowed: true, customerOwnerHash: 'customer-hash', postalCode: 'L3Y 1A1', area: 'Basement, Bathroom', projectAreas: [{ id: 'basement', label: 'Basement', findings: [] }, { id: 'bathroom', label: 'Bathroom', findings: [] }], description: 'Private description not placed in email', summary: 'Two areas to review' });

test('Ontario postcodes normalize; distance uses a true inclusive 50 km circle', () => {
  assert.equal(postalCode('l3y1a1'), 'L3Y 1A1');
  for (const code of ['', 'V6B 1A1', 'L0D 0D0', 'L3Y']) assert.throws(() => postalCode(code));
  const centre = { lat: 44, lng: -79 };
  assert.equal(withinRadius(centre, { lat: 44 + 49.999 / 111.1950802335, lng: -79 }), true);
  assert.equal(withinRadius(centre, { lat: 44 + 50.001 / 111.1950802335, lng: -79 }), false);
  assert.equal(withinRadius(centre, null), false);
  assert.ok(distanceKm(locations['L3Y 1A1'], locations['K1A 0B1']) > 300);
});

test('ready projects invite only nearby paid registered companies once, using signup email and private previews', async t => {
  const service = await setup(t);
  const nearby = await register(service, 'nearby'); const far = await register(service, 'faraway', 'K1A 0B1');
  await register(service, 'unpaid', 'L4G 1A1', false);
  await service.marketplace.syncScreening({ ...ready(), reportAvailable: false, status: 'processing' });
  assert.equal((await get(service.app, '/reports?role=partner', nearby.cookie)).json().length, 0);
  await service.marketplace.syncScreening(ready());
  await service.marketplace.syncScreening(ready()); await service.marketplace.runJobs();
  const inbox = (await get(service.app, '/reports?role=partner', nearby.cookie)).json();
  assert.equal(inbox.length, 1); assert.deepEqual(inbox[0].recipientIds, [nearby.id]);
  assert.equal((await get(service.app, '/reports?role=partner', far.cookie)).json().length, 0);
  const invites = (await get(service.app, '/invitations', nearby.cookie)).json();
  assert.equal(invites.invitations.length, 1); assert.equal(invites.invitations[0].to, 'nearby@example.test');
  assert.equal(invites.invitations[0].status, 'preview'); assert.match(invites.invitations[0].preview.text, /#partner\?id=SCREEN-test-screen/);
  assert.equal(invites.invitations[0].preview.text.includes('Private description'), false);
  assert.equal((await get(service.app, '/invitations')).status, 401);
  assert.equal((await get(service.app, '/invitations', far.cookie)).json().invitations.length, 0);
  const publicData = JSON.stringify((await get(service.app, '/companies')).json());
  assert.equal(publicData.includes('nearby@example.test'), false); assert.equal(publicData.includes('receiptId'), false);
  const disk = JSON.parse(await readFile(path.join(service.dataDirectory, 'marketplace.json'), 'utf8'));
  assert.equal(disk.emailOutbox.length, 1);
});

test('opt out, missing coordinates, sample reports and unsubscribed companies never send invitations; new subscribers match saved projects', async t => {
  const service = await setup(t); const company = await register(service, 'optout');
  await post(service.app, '/company-profile', { postalCode: 'L4G 1A1', notificationsEnabled: false }, company.cookie);
  await service.marketplace.syncScreening(ready('optout'));
  assert.equal((await get(service.app, '/invitations', company.cookie)).json().invitations.length, 0);
  await service.marketplace.syncScreening({ ...ready('unknown'), postalCode: '' });
  assert.equal((await get(service.app, '/reports?role=partner', company.cookie)).json().length, 1);
  await post(service.app, '/reports', { autoShare: true, areas: ['Basement'], description: 'Sample' });
  assert.equal((await get(service.app, '/invitations', company.cookie)).json().invitations.length, 0);
  const later = await register(service, 'newsubscriber');
  assert.equal((await get(service.app, '/invitations', later.cookie)).json().invitations.length, 1);
  assert.equal((await post(service.app, '/company-profile', { postalCode: 'V6B 1A1', notificationsEnabled: true }, later.cookie)).status, 400);
});

test('missing Google configuration preserves report pending matching and never assumes Newmarket', async t => {
  const service = await setup(t, { directoryOptions: { apiKey: '' } });
  const company = await register(service, 'pending');
  await service.marketplace.syncScreening(ready());
  assert.equal((await get(service.app, '/reports?role=partner', company.cookie)).json().length, 0);
  const disk = JSON.parse(await readFile(path.join(service.dataDirectory, 'marketplace.json'), 'utf8'));
  assert.equal(disk.reports[0].matchStatus, 'pending_location'); assert.equal(disk.reports[0].status, 'shared');
});

test('Resend delivery uses stable idempotency and requires public HTTPS configuration', async () => {
  let calls = 0;
  const sender = createInvitationSender({ mode: 'live', apiKey: 'test-key', from: 'MoldLens <quotes@example.test>', appUrl: 'https://moldlens.example.test', fetcher: async (url, options) => {
    calls++; assert.equal(url, 'https://api.resend.com/emails'); assert.equal(options.headers['Idempotency-Key'], 'moldlens-stable-id');
    assert.deepEqual(JSON.parse(options.body).to, ['signup@example.test']); return new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 });
  } });
  const item = { id: 'stable-id', to: 'signup@example.test' };
  assert.equal((await sender.send(item, ready())).status, 'sent'); assert.equal(calls, 1);
  await assert.rejects(() => createInvitationSender({ mode: 'live', apiKey: '', appUrl: 'http://localhost' }).send(item, ready()), /email_configuration_required/);
});

test('failed delivery retries after restart without duplicate outbox entries or changing email content', async t => {
  const sent = [];
  const emailOptions = { mode: 'live', apiKey: 'test-key', from: 'quotes@example.test', appUrl: 'https://moldlens.example.test', fetcher: async (_url, options) => {
    sent.push({ key: options.headers['Idempotency-Key'], body: options.body });
    return new Response(JSON.stringify(sent.length === 1 ? {} : { id: 'delivered-id' }), { status: sent.length === 1 ? 503 : 200 });
  } };
  const service = await setup(t, { emailOptions }); const company = await register(service, 'retry');
  await service.marketplace.syncScreening(ready('retry'));
  assert.equal(sent.length, 1);
  const filename = path.join(service.dataDirectory, 'marketplace.json');
  await service.marketplace.stop();
  const disk = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(disk.emailOutbox[0].status, 'pending');
  disk.emailOutbox[0].nextAttemptAt = new Date(0).toISOString();
  await writeFile(filename, JSON.stringify(disk));
  const restarted = await createApp({ dataDirectory: service.dataDirectory, seeds: [], marketplaceOptions: { directoryOptions: { resolvePostal: async code => locations[code] }, emailOptions } });
  try {
    await restarted.marketplace.runJobs(); await restarted.marketplace.runJobs();
    assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
    const persisted = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(persisted.emailOutbox.length, 1); assert.equal(persisted.emailOutbox[0].status, 'sent');
    assert.equal(persisted.emailOutbox[0].companyId, company.id);
  } finally { await restarted.marketplace.stop(); }
});

test('live email setup failures remain queued without consuming send attempts', async t => {
  const service = await setup(t, { emailOptions: { mode: 'live', apiKey: '', from: '', appUrl: 'http://localhost' } });
  const company = await register(service, 'waiting');
  await service.marketplace.syncScreening(ready()); await service.marketplace.runJobs();
  const invite = (await get(service.app, '/invitations', company.cookie)).json();
  assert.equal(invite.ready, false); assert.equal(invite.invitations[0].status, 'waiting_setup');
  const disk = JSON.parse(await readFile(path.join(service.dataDirectory, 'marketplace.json'), 'utf8'));
  assert.equal(disk.emailOutbox[0].attempts, 0);
});

test('Google directory filters exact distance and Ontario, persists IDs only, and returns live attributed reviews', async t => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-directory-'));
  const response = data => new Response(JSON.stringify(data), { status: 200 });
  const directory = createDirectory({ dataDirectory, apiKey: 'test-key', resolvePostal: async () => locations['L3Y 1A1'], fetcher: async url => {
    if (url.endsWith('searchText')) return response({ places: [
      { id: 'nearby-google', displayName: { text: 'Live Google name' }, addressComponents: [{ shortText: 'ON', types: ['administrative_area_level_1'] }], location: { latitude: 44.05, longitude: -79.46 }, rating: 4.8, userRatingCount: 23 },
      { id: 'far-google', addressComponents: [{ shortText: 'ON', types: ['administrative_area_level_1'] }], location: { latitude: 45.42, longitude: -75.7 } },
      { id: 'wrong-province', addressComponents: [{ shortText: 'QC', types: ['administrative_area_level_1'] }], location: { latitude: 44.05, longitude: -79.46 } },
    ] });
    return response({ id: 'nearby-google', reviews: [{ text: { text: 'Live review only' }, authorAttribution: { displayName: 'Author', uri: 'https://maps.google.com/contrib/author' } }] });
  } });
  t.after(async () => { await directory.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  const found = await directory.search('L3Y1A1');
  assert.equal(found.contractors.length, 1); assert.equal(found.contractors[0].rating, 4.8);
  assert.equal((await directory.reviews('nearby-google')).reviews[0].authorAttribution.displayName, 'Author');
  await assert.rejects(() => directory.reviews('unindexed'), /Find this business/);
  // Reopen only after closing: PGlite permits a single owner.
  await directory.close();
  const { PGlite } = await import('@electric-sql/pglite'); const db = new PGlite(path.join(dataDirectory, 'contractor-directory-db'));
  const stored = await db.query('SELECT * FROM google_place_index');
  assert.equal(stored.rows.length, 3); assert.equal(JSON.stringify(stored.rows).includes('Live Google name'), false); assert.equal(JSON.stringify(stored.rows).includes('Live review only'), false);
  await db.close();
});
