import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/app.mjs';
import { demoLocations } from '../server/demo-companies.mjs';
import { dispatch, jsonRequest, withCookie, cookieHeader } from './http-helpers.mjs';

const post = (app, route, body = {}, cookie = '') => dispatch(app, withCookie(jsonRequest('POST', `/api/marketplace${route}`, body), cookie));
const get = (app, route, cookie = '') => dispatch(app, withCookie({ url: `/api/marketplace${route}` }, cookie));
async function setup(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-demo-'));
  const service = await createApp({ dataDirectory, seeds: [] });
  t.after(async () => { await service.marketplace.stop(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { ...service, dataDirectory };
}
async function fresh(app) {
  const response = await post(app, '/demo-customer/start'); assert.equal(response.status, 200, response.body.toString());
  return { cookie: cookieHeader(response), data: response.json() };
}
const sample = (app, cookie, postalCode = 'L3Y 1A1') => post(app, '/reports', { areas: ['Basement', 'Bathroom', 'Attic'], autoShare: true, postalCode }, cookie);

test('six real company demos replace old options and city postal codes match by 50 km distance', async t => {
  const { app } = await setup(t); const customer = await fresh(app);
  const companies = (await get(app, '/companies')).json();
  assert.deepEqual(companies.map(c => c.name), ['MoldTech_N', 'KleenCondition_M', 'UltraFreeMold_O', 'TheMoldGuy_T', 'LETS_L', 'MoldBusters_O']);
  assert.deepEqual(companies.map(c => c.city), demoLocations.map(l => l.city));
  for (const code of demoLocations) {
    const response = await sample(app, customer.cookie, code.postalCode); assert.equal(response.status, 201, response.body.toString());
    const report = response.json();
    assert.equal(report.demoMatches.length, 6);
    assert.deepEqual(report.recipientIds.sort(), report.demoMatches.filter(item => item.inRange).map(item => item.companyId).sort());
    assert.ok(report.demoMatches.some(item => item.inRange && item.city === code.city));
    assert.ok(report.demoMatches.filter(item => !item.inRange).every(item => !report.recipientIds.includes(item.companyId)));
    if (code.city === 'Ottawa') assert.deepEqual(report.recipientIds, ['moldbusters']);
    if (code.city === 'London') assert.deepEqual(report.recipientIds, ['lets']);
  }
  assert.equal((await post(app, '/demo-login', { companyId: 'aro' })).status, 400);
  assert.equal((await post(app, '/demo-login', { companyId: 'desa' })).status, 400);
});

test('new guests reset visible screenings and contact gate; email resumes only the saved demo with its username and phone', async t => {
  const { app, dataDirectory } = await setup(t); const first = await fresh(app);
  await post(app, '/demo-customer/name', { username: 'Test Alex' }, first.cookie);
  const report = (await sample(app, first.cookie)).json();
  assert.equal(report.demoUsername, 'Test Alex'); assert.equal(report.contactRequired, true);
  await post(app, `/reports/${report.id}/sample-quotes`, {}, first.cookie);
  const contact = { email: 'demo-customer@example.test', phone: '905-555-0100' };
  assert.equal((await post(app, '/customer-contact', contact, first.cookie)).status, 200);
  assert.equal((await get(app, '/reports', first.cookie)).json()[0].contactRequired, false);
  const second = await fresh(app);
  assert.equal((await get(app, '/reports', second.cookie)).json().length, 0);
  assert.equal((await get(app, '/customer-contact', second.cookie)).json().contact, null);
  const secondReport = (await sample(app, second.cookie, 'N6G 2N3')).json();
  assert.equal(secondReport.contactRequired, true);
  const resumed = await post(app, '/demo-customer/continue', { email: ' DEMO-CUSTOMER@example.test ' }, second.cookie);
  assert.equal(resumed.status, 200); assert.equal(resumed.json().customer.username, 'Test Alex');
  const resumedCookie = cookieHeader(resumed);
  const reports = (await get(app, '/reports', resumedCookie)).json();
  assert.equal(reports.length, 1); assert.equal(reports[0].id, report.id); assert.equal(reports[0].quotes.length, 3);
  assert.equal((await get(app, '/customer-contact', resumedCookie)).json().contact.phone, '+19055550100');
  const disk = JSON.parse(await readFile(path.join(dataDirectory, 'marketplace.json'), 'utf8'));
  assert.equal(disk.reports.length, 2, 'Reset preserves data, and changes only the active demo identity');
  assert.equal(disk.emailOutbox?.length || 0, 0);
});

test('email-only demo continuation cannot find real customer ownership or contact details', async t => {
  const { app } = await setup(t);
  const regular = await post(app, '/reports', { area: 'Basement' }); const ownerCookie = cookieHeader(regular);
  await post(app, '/customer-contact', { email: 'real-customer@example.test', phone: '905-555-0199' }, ownerCookie);
  const resumed = await post(app, '/demo-customer/continue', { email: 'real-customer@example.test' });
  const demoCookie = cookieHeader(resumed);
  assert.equal((await get(app, '/reports', demoCookie)).json().length, 0);
  assert.equal((await get(app, '/customer-contact', demoCookie)).json().contact, null);
  assert.equal((await get(app, '/reports', ownerCookie)).json().length, 1);
  const exited = await post(app, '/demo-customer/exit', {}, `${ownerCookie}; ${demoCookie}`);
  assert.equal(exited.status, 200);
  assert.equal((await get(app, '/reports', `${ownerCookie}; ${demoCookie}`)).json().length, 1, 'Exit revokes the overlay and restores the original customer');
});

test('completed source screenings under a demo identity match examples without Google or external invitations', async t => {
  const { app, marketplace, dataDirectory } = await setup(t); const customer = await fresh(app);
  const disk = JSON.parse(await readFile(path.join(dataDirectory, 'marketplace.json'), 'utf8'));
  const ownerHash = Object.keys(disk.demoCustomers)[0];
  await marketplace.syncScreening({ id: 'demo-source', customerOwnerHash: ownerHash, sharingAllowed: true, status: 'ready_preview', reportAvailable: true, postalCode: 'K1P 1J1', area: 'Basement', projectAreas: [{ id: 'basement', label: 'Basement', findings: [] }] });
  const report = (await get(app, '/reports', customer.cookie)).json()[0];
  assert.equal(report.demoProject, true); assert.deepEqual(report.recipientIds, ['moldbusters']);
  assert.equal(report.demoMatches.find(item => item.companyId === 'moldbusters').received, true);
  const stored = JSON.parse(await readFile(path.join(dataDirectory, 'marketplace.json'), 'utf8'));
  assert.equal(stored.emailOutbox?.length || 0, 0);
});

test('saved demo sessions and email continuation survive server restart; retired companies keep quote references', async t => {
  const { app, marketplace, dataDirectory } = await setup(t);
  const customer = await fresh(app);
  const report = (await sample(app, customer.cookie)).json();
  await post(app, '/demo-customer/continue', { email: 'restart@example.test' }, customer.cookie);
  await marketplace.stop();
  const filename = path.join(dataDirectory, 'marketplace.json'); const disk = JSON.parse(await readFile(filename, 'utf8'));
  disk.companies.push({ id: 'aro', name: 'ARO Restoration', example: true, subscription: 'active', membership: { status: 'paid_demo', periodEnd: '2099-01-01' } });
  disk.quotes.push({ id: 'historic', companyId: 'aro', reportId: report.id, amount: 20 });
  disk.reports[0].recipientIds.push('aro'); await writeFile(filename, JSON.stringify(disk));
  const service = await createApp({ dataDirectory, seeds: [] });
  try {
    const resumed = await post(service.app, '/demo-customer/continue', { email: 'restart@example.test' });
    const reports = (await get(service.app, '/reports', cookieHeader(resumed))).json();
    assert.equal(reports[0].id, report.id);
    assert.equal(reports[0].recipients.find(c => c.id === 'aro').name, 'ARO Restoration');
    assert.equal((await get(service.app, '/companies')).json().some(c => c.id === 'aro'), false);
    const stored = JSON.parse(await readFile(filename, 'utf8')); assert.equal(stored.quotes[0].id, 'historic');
  } finally { await service.marketplace.stop(); }
});

test('demo identities, continuation and customer-name changes are unavailable in production', async t => {
  const { app } = await setup(t); const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal((await get(app, '/demo-customer')).status, 404);
    for (const route of ['/demo-customer/start', '/demo-customer/continue', '/demo-customer/name', '/demo-customer/exit']) assert.equal((await post(app, route, { email: 'demo@example.test', username: 'Test' })).status, 404);
  } finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
});
