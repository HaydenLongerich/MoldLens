import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { dispatch, jsonRequest, cookieHeader, withCookie } from './http-helpers.mjs';
import { confirmedQuote } from './proposal-fixtures.mjs';

const context = { propertyType: 'house', region: 'ON', areas: ['basement', 'bathroom', 'attic'], concerns: ['visible_spots'], statement: 'Spots near the basement window, bathroom moisture and attic staining.', contact: { name: 'Test homeowner', email: 'owner@example.test', postalCode: 'L3Y 1A1' } };
const get = (app, url, cookie = '') => dispatch(app, withCookie({ url }, cookie));
const post = (app, url, body = {}, cookie = '') => dispatch(app, withCookie(jsonRequest('POST', url, body), cookie));
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-screen-market-'));
  const service = await createApp({ dataDirectory: directory, seeds: [], screeningOptions: { databaseUrl: 'memory:', models: { vision: null, text: null } } });
  for (const companyId of ['moldtech', 'aro', 'desa']) { const cookie = cookieHeader(await post(service.app, '/api/marketplace/demo-login', { companyId })); await post(service.app, '/api/marketplace/membership/demo-pay', { confirm: true }, cookie); }
  t.after(async () => { await service.screening.stop(); await rm(directory, { recursive: true, force: true }); });
  return service;
}
async function draft(app) {
  const result = await post(app, '/api/screenings', { consentAiProcessing: true, consentMediaStorage: true });
  assert.equal(result.status, 201, result.body.toString());
  const owner = { id: result.json().id, cookie: cookieHeader(result) };
  await post(app, '/api/marketplace/customer-contact', { email: 'owner@example.test', phone: '905-555-0123' }, owner.cookie);
  const saved = await dispatch(app, withCookie(jsonRequest('PATCH', `/api/screenings/${owner.id}`, context), owner.cookie));
  assert.equal(saved.status, 200, saved.body.toString());
  return owner;
}
async function complete(service, owner) {
  await service.screening.runJobs();
  const questions = await get(service.app, `/api/screenings/${owner.id}/questions`, owner.cookie);
  if (questions.json().status === 'needs_answers') {
    assert.equal((await post(service.app, `/api/screenings/${owner.id}/answers`, { answers: [], finish: true }, owner.cookie)).status, 200);
    await service.screening.runJobs();
  }
}

test('a real completed screening automatically reaches eligible contractors once, then accepts quotes', async t => {
  const service = await setup(t); const { app } = service; const owner = await draft(app);
  assert.equal((await post(app, `/api/marketplace/screenings/${owner.id}/removal`, { removed: true }, owner.cookie)).status, 200);
  const aro = cookieHeader(await post(app, '/api/marketplace/demo-login', { companyId: 'aro' }));
  await post(app, '/api/marketplace/subscription', { status: 'paused' }, aro);
  const submitted = await post(app, `/api/screenings/${owner.id}/submit`, { contractorSharing: true, city: 'Newmarket' }, owner.cookie);
  assert.equal(submitted.status, 200, submitted.body.toString());
  const pending = (await get(app, '/api/marketplace/reports', owner.cookie)).json();
  assert.equal(pending.length, 1); assert.equal(pending[0].status, 'processing'); assert.equal(pending[0].recipients.length, 0);
  const moldtech = cookieHeader(await post(app, '/api/marketplace/demo-login', { companyId: 'moldtech' }));
  assert.equal((await get(app, '/api/marketplace/reports?role=partner', moldtech)).json().length, 0);
  await complete(service, owner);
  const report = (await get(app, '/api/marketplace/reports', owner.cookie)).json()[0];
  assert.equal(report.screening.id, owner.id); assert.equal(report.screening.reportAvailable, true); assert.equal(report.status, 'shared');
  assert.equal(report.isSample, false); assert.deepEqual(report.recipientIds, ['moldtech', 'desa']); assert.ok(report.summary);
  assert.deepEqual(report.projectAreas.map(area => area.id), ['basement', 'bathroom', 'attic']);
  assert.equal(report.customerOwnerHash, undefined);
  const inbox = (await get(app, '/api/marketplace/reports?role=partner', moldtech)).json();
  assert.equal(inbox.length, 1); assert.equal(inbox[0].screening.id, owner.id);
  assert.equal((await get(app, '/api/marketplace/reports?role=partner', aro)).status, 403);
  const quote = await post(app, `/api/marketplace/reports/${report.id}/quote`, confirmedQuote(325, report.projectAreas.map(area => area.id)), moldtech);
  assert.equal(quote.status, 201, quote.body.toString());
  await service.screening.runJobs();
  await post(app, `/api/screenings/${owner.id}/submit`, { contractorSharing: true, city: 'Newmarket' }, owner.cookie);
  const again = (await get(app, '/api/marketplace/reports', owner.cookie)).json();
  assert.equal(again.length, 1); assert.equal(again[0].quotes.length, 1); assert.equal(again[0].quotes[0].amount, 325);
  assert.deepEqual(again[0].recipientIds, report.recipientIds);
  const removed = (await get(app, '/api/marketplace/removed-screenings', owner.cookie)).json();
  assert.equal(removed.length, 1); assert.equal(removed[0].key, owner.id);
  const removedByReport = (await post(app, `/api/marketplace/screenings/${report.id}/removal`, { removed: true }, owner.cookie)).json();
  assert.equal(removedByReport.length, 1); assert.equal(removedByReport[0].key, owner.id);
  assert.equal((await get(app, '/api/marketplace/reports?role=partner', moldtech)).json().length, 1, 'Removing from the customer list preserves the contractor project');
  assert.deepEqual((await post(app, `/api/marketplace/screenings/${owner.id}/removal`, { removed: false }, owner.cookie)).json(), []);
});

test('unshared and unowned screenings never enter contractor inboxes; samples auto-send in one action', async t => {
  const service = await setup(t); const { app } = service; const owner = await draft(app); const outsider = await draft(app);
  assert.equal((await post(app, `/api/marketplace/screenings/${owner.id}/removal`, { removed: true }, outsider.cookie)).status, 404);
  assert.equal((await post(app, `/api/screenings/${owner.id}/submit`, { contractorSharing: true, city: 'Newmarket' }, outsider.cookie)).status, 404);
  assert.equal((await post(app, `/api/screenings/${owner.id}/submit`, { contractorSharing: true, city: 'Toronto' }, owner.cookie)).status, 400);
  await post(app, `/api/screenings/${owner.id}/submit`, {}, owner.cookie);
  await complete(service, owner);
  assert.equal((await get(app, '/api/marketplace/reports', owner.cookie)).json().length, 0);
  const enabled = await post(app, `/api/screenings/${owner.id}/submit`, { contractorSharing: true, city: 'Newmarket' }, owner.cookie);
  assert.equal(enabled.status, 200);
  assert.equal((await get(app, '/api/marketplace/reports', owner.cookie)).json()[0].recipientIds.length, 3);
  const sample = await post(app, '/api/marketplace/reports', { area: 'Basement', description: 'Sample concern', autoShare: true }, owner.cookie);
  assert.equal(sample.status, 201); assert.equal(sample.json().status, 'shared'); assert.equal(sample.json().recipientIds.length, 3);
  assert.equal((await get(app, '/api/marketplace/reports', outsider.cookie)).json().length, 0);
});
