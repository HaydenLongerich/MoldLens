import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { dispatch, jsonRequest, withCookie, cookieHeader } from './http-helpers.mjs';
import { confirmedQuote } from './proposal-fixtures.mjs';

async function workspace(callback, activate = true) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-market-'));
  try { const app = (await createApp({ dataDirectory, seeds: [] })).app; if (activate) for (const id of ['moldtech', 'aro', 'desa']) await demo(app, id); await callback(app, dataDirectory); }
  finally { await rm(dataDirectory, { recursive: true, force: true }); }
}
const post = (app, route, body = {}, cookie = '') => dispatch(app, withCookie(jsonRequest('POST', `/api/marketplace${route}`, body), cookie));
const get = (app, route, cookie = '') => dispatch(app, withCookie({ url: `/api/marketplace${route}` }, cookie));
async function sample(app) {
  const response = await post(app, '/reports', { area: 'Basement', description: 'Sample concern by the window.' });
  assert.equal(response.status, 201, response.body.toString());
  const customer = cookieHeader(response);
  assert.equal((await post(app, '/customer-contact', { email: 'customer@example.test', phone: '905-555-0123' }, customer)).status, 200);
  return { report: response.json(), customer };
}
async function demo(app, companyId) {
  const response = await post(app, '/demo-login', { companyId });
  assert.equal(response.status, 200, response.body.toString());
  const cookie = cookieHeader(response);
  assert.equal((await post(app, '/membership/demo-pay', { confirm: true }, cookie)).status, 200);
  return cookie;
}
const quote = confirmedQuote();

test('reports require consent and broadcast once to all active companies in the area', () => workspace(async app => {
  const { report, customer } = await sample(app);
  const aro = await demo(app, 'aro');
  assert.equal((await post(app, '/subscription', { status: 'paused' }, aro)).status, 200);
  assert.equal((await post(app, `/reports/${report.id}/broadcast`, {}, customer)).status, 400);
  assert.equal((await get(app, '/reports?role=partner', aro)).status, 403);
  const shared = await post(app, `/reports/${report.id}/broadcast`, { consent: true }, customer);
  assert.deepEqual(shared.json().recipientIds, ['moldtech', 'desa']);
  assert.equal(shared.json().customerOwnerHash, undefined);
  await post(app, '/subscription', { status: 'active' }, aro);
  const again = await post(app, `/reports/${report.id}/broadcast`, { consent: true }, customer);
  assert.deepEqual(again.json().recipientIds, ['moldtech', 'desa']);
  assert.equal((await get(app, '/reports?role=partner', aro)).json().length, 0);
  assert.equal((await post(app, `/reports/${report.id}/quote`, quote, aro)).status, 404);
}));

test('customer and company isolation, quote updates, selection and two-way messages persist', () => workspace(async (app, dataDirectory) => {
  const { report, customer } = await sample(app);
  const other = await sample(app);
  assert.equal((await post(app, `/reports/${report.id}/broadcast`, { consent: true }, other.customer)).status, 404);
  assert.equal((await get(app, '/reports')).json().length, 0);
  assert.equal((await get(app, '/reports?role=partner')).status, 401);
  await post(app, `/reports/${report.id}/broadcast`, { consent: true }, customer);
  const moldtech = await demo(app, 'moldtech'); const aro = await demo(app, 'aro');
  const quoted = await post(app, `/reports/${report.id}/quote`, quote, moldtech);
  assert.equal(quoted.status, 201, quoted.body.toString());
  const quoteId = quoted.json().quotes[0].id;
  assert.equal((await get(app, '/reports?role=partner', aro)).json()[0].quotes.length, 0);
  const updated = await post(app, `/reports/${report.id}/quote`, confirmedQuote(310), moldtech);
  assert.equal(updated.json().quotes.length, 1);
  assert.equal(updated.json().quotes[0].id, quoteId);
  assert.equal(updated.json().quotes[0].amount, 310);
  assert.equal((await post(app, `/reports/${report.id}/messages`, { companyId: 'moldtech', text: 'Can you come Tuesday?' }, customer)).status, 201);
  assert.equal((await post(app, `/reports/${report.id}/messages`, { role: 'partner', companyId: 'aro', text: 'Tuesday works.' }, moldtech)).status, 201);
  const privateView = (await get(app, '/reports?role=partner', moldtech)).json()[0];
  assert.equal(privateView.messages.length, 2);
  assert.equal(privateView.messages[1].companyId, 'moldtech');
  assert.equal((await get(app, '/reports?role=partner', aro)).json()[0].messages.length, 0);
  assert.equal((await post(app, `/reports/${report.id}/messages`, { companyId: 'moldtech', text: 'Intruder' }, other.customer)).status, 404);
  assert.equal((await post(app, `/reports/${report.id}/choose`, { quoteId }, other.customer)).status, 404);
  const chosen = await post(app, `/reports/${report.id}/choose`, { quoteId }, customer);
  assert.equal(chosen.json().status, 'chosen');
  assert.equal((await post(app, `/reports/${report.id}/quote`, quote, aro)).status, 409);
  const restarted = (await createApp({ dataDirectory, seeds: [] })).app;
  const restored = (await get(restarted, '/reports', customer)).json()[0];
  assert.equal(restored.selectedQuoteId, quoteId);
  assert.equal(restored.messages.length, 2);
  assert.equal((await dispatch(app, { url: '/api/requests' })).status, 401);
}));

test('membership gates quoting, samples are idempotent, and invalid quotes are rejected', () => workspace(async app => {
  const { report, customer } = await sample(app);
  await post(app, `/reports/${report.id}/broadcast`, { consent: true }, customer);
  const moldtech = await demo(app, 'moldtech');
  for (const amount of [-1, 0, 1.234, 100001, '300']) assert.equal((await post(app, `/reports/${report.id}/quote`, { ...quote, amount }, moldtech)).status, 400);
  await post(app, '/subscription', { status: 'paused' }, moldtech);
  assert.equal((await post(app, `/reports/${report.id}/quote`, quote, moldtech)).status, 403);
  const added = await post(app, `/reports/${report.id}/sample-quotes`, {}, customer);
  assert.equal(added.json().quotes.length, 2);
  assert.ok(added.json().quotes.every(item => item.simulated));
  const again = await post(app, `/reports/${report.id}/sample-quotes`, {}, customer);
  assert.equal(again.json().quotes.length, 2);
}));

test('company registration, credentials, logout and company data survive server restart', () => workspace(async (app, dataDirectory) => {
  const input = { name: 'Newmarket Test Company', email: 'owner@example.test', password: 'test-password-long' };
  const registered = await post(app, '/register', input);
  assert.equal(registered.status, 201, registered.body.toString());
  assert.equal(registered.json().company.subscription, 'pending');
  assert.equal(registered.json().company.membership.amount, 100);
  assert.equal(registered.json().company.example, false);
  const cookie = cookieHeader(registered);
  assert.ok(cookie.includes('moldlens_partner='));
  assert.equal((await get(app, '/session', cookie)).json().company.name, input.name);
  assert.equal((await post(app, '/register', input)).status, 409);
  const companies = (await get(app, '/companies')).json();
  assert.equal(JSON.stringify(companies).includes('password'), false);
  await post(app, '/logout', {}, cookie);
  assert.equal((await get(app, '/reports?role=partner', cookie)).status, 401);
  const restarted = (await createApp({ dataDirectory, seeds: [] })).app;
  assert.equal((await post(restarted, '/login', { ...input, password: 'wrong' })).status, 401);
  const login = await post(restarted, '/login', input);
  assert.equal(login.status, 200);
  assert.equal(login.json().company.id, registered.json().company.id);
  assert.equal((await post(restarted, '/membership/demo-pay', { confirm: true }, cookieHeader(login))).status, 200);
  const { report, customer } = await sample(restarted);
  const shared = await post(restarted, `/reports/${report.id}/broadcast`, { consent: true }, customer);
  assert.equal(shared.json().recipientIds.length, 4);
}));

test('production disables demo identities, sample replies and membership toggles', () => workspace(async app => {
  const { report, customer } = await sample(app);
  await post(app, `/reports/${report.id}/broadcast`, { consent: true }, customer);
  const partner = await demo(app, 'moldtech');
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal((await get(app, '/session')).json().demoAvailable, false);
    assert.equal((await post(app, '/demo-login', { companyId: 'moldtech' })).status, 404);
    assert.equal((await post(app, `/reports/${report.id}/sample-quotes`, {}, customer)).status, 404);
    assert.equal((await post(app, '/subscription', { status: 'paused' }, partner)).status, 404);
    assert.equal((await post(app, '/membership/demo-pay', { confirm: true }, partner)).status, 404);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
}));

test('three areas stay one project, require whole-project coverage, and use one validated quote total', () => workspace(async (app, dataDirectory) => {
  const created = await post(app, '/reports', { areas: ['Basement', 'Bathroom', 'Attic'], description: 'Inspect all three areas.', autoShare: true });
  assert.equal(created.status, 201, created.body.toString());
  const customer = cookieHeader(created); const report = created.json();
  await post(app, '/customer-contact', { email: 'project@example.test', phone: '905-555-0123' }, customer);
  assert.equal(report.projectAreas.length, 3);
  assert.equal((await get(app, '/reports', customer)).json().length, 1);
  const moldtech = await demo(app, 'moldtech'); const aro = await demo(app, 'aro');
  assert.equal((await get(app, '/reports?role=partner', moldtech)).json().length, 1);
  const ids = report.projectAreas.map(area => area.id);
  const values = { ...confirmedQuote(600, ids), breakdown: [{ areaId: ids[0], amount: 200 }, { areaId: ids[1], amount: 250 }, { areaId: ids[2], amount: 150 }] };
  assert.equal((await post(app, `/reports/${report.id}/quote`, quote, moldtech)).status, 400);
  assert.equal((await post(app, `/reports/${report.id}/quote`, { ...values, coveredAreaIds: [ids[0]] }, moldtech)).status, 400);
  assert.equal((await post(app, `/reports/${report.id}/quote`, { ...values, coveredAreaIds: [ids[0], ids[0], ids[2]] }, moldtech)).status, 400);
  assert.equal((await post(app, `/reports/${report.id}/quote`, { ...values, amount: 601 }, moldtech)).status, 400);
  assert.equal((await post(app, `/reports/${report.id}/quote`, { ...values, breakdown: values.breakdown.slice(0, 1) }, moldtech)).status, 400);
  assert.equal((await post(app, `/reports/${report.id}/quote`, { ...values, breakdown: [...values.breakdown.slice(0, 2), { areaId: ids[0], amount: 150 }] }, moldtech)).status, 400);
  const quoted = await post(app, `/reports/${report.id}/quote`, values, moldtech);
  assert.equal(quoted.status, 201, quoted.body.toString());
  assert.equal(quoted.json().quotes.length, 1);
  assert.equal(quoted.json().quotes[0].quoteType, 'project');
  assert.deepEqual(quoted.json().quotes[0].coveredAreaIds, ids);
  const firstId = quoted.json().quotes[0].id;
  await post(app, `/reports/${report.id}/quote`, confirmedQuote(650, ids), aro);
  const customerView = (await get(app, '/reports', customer)).json()[0];
  assert.equal(customerView.quotes.length, 2);
  assert.equal((await get(app, '/reports?role=partner', aro)).json()[0].quotes.length, 1);
  const selected = await post(app, `/reports/${report.id}/choose`, { quoteId: firstId }, customer);
  assert.equal(selected.json().selectedQuoteId, firstId);
  assert.equal(selected.json().status, 'chosen');
  const restarted = (await createApp({ dataDirectory, seeds: [] })).app;
  const saved = (await get(restarted, '/reports', customer)).json()[0];
  assert.equal(saved.projectAreas.length, 3); assert.equal(saved.quotes.length, 2);
  assert.equal(saved.quotes.find(item => item.id === firstId).breakdown.length, 3);
  assert.equal(saved.selectedQuoteId, firstId);
}));

test('bid declines, quote decisions and private reversible archives persist and protect chosen quotes', () => workspace(async (app, dataDirectory) => {
  const { report, customer } = await sample(app);
  const outsider = await sample(app);
  await post(app, `/reports/${report.id}/broadcast`, { consent: true }, customer);
  const moldtech = await demo(app, 'moldtech'); const aro = await demo(app, 'aro');
  const response = action => post(app, `/reports/${report.id}/response`, { action }, moldtech);
  assert.equal((await response('bogus')).status, 400);
  assert.equal((await post(app, `/reports/${report.id}/response`, { action: 'decline' }, customer)).status, 401);
  const declined = await response('decline');
  assert.ok(declined.json().response.declinedAt);
  assert.equal(declined.json().quotes.length, 0);
  assert.equal((await post(app, `/reports/${report.id}/quote`, quote, moldtech)).status, 409);
  assert.equal((await get(app, '/reports?role=partner', aro)).json()[0].response.declinedAt, undefined);
  assert.equal((await get(app, '/reports', customer)).json()[0].contractorResponses, undefined);
  assert.equal((await response('reopen')).status, 200);
  const quoted = await post(app, `/reports/${report.id}/quote`, quote, moldtech);
  assert.equal(quoted.status, 201);
  const quoteId = quoted.json().quotes[0].id;
  const action = (value, cookie = customer, role = 'customer') => post(app, `/reports/${report.id}/quotes/${quoteId}/action`, { action: value, role }, cookie);
  assert.equal((await action('decline', outsider.customer)).status, 404);
  assert.equal((await action('archive', aro, 'partner')).status, 404);
  assert.equal((await action('decline', moldtech, 'partner')).status, 400);
  assert.equal((await action('bogus')).status, 400);
  const withdrawn = await response('decline');
  assert.ok(withdrawn.json().quotes[0].withdrawnAt);
  assert.equal((await post(app, `/reports/${report.id}/choose`, { quoteId }, customer)).status, 409);
  await response('reopen');
  // Reopening review does not silently revive an old price.
  assert.equal((await post(app, `/reports/${report.id}/choose`, { quoteId }, customer)).status, 409);
  const resent = await post(app, `/reports/${report.id}/quote`, confirmedQuote(325), moldtech);
  assert.equal(resent.json().quotes[0].id, quoteId);
  assert.equal(resent.json().quotes[0].withdrawnAt, null);
  assert.ok((await action('decline')).json().quotes[0].declinedAt);
  assert.equal((await post(app, `/reports/${report.id}/choose`, { quoteId }, customer)).status, 409);
  assert.equal((await post(app, `/reports/${report.id}/quote`, quote, moldtech)).status, 409);
  const archived = await action('archive');
  assert.ok(archived.json().quotes[0].archivedAt);
  assert.ok(archived.json().quotes[0].declinedAt);
  assert.equal((await get(app, '/reports?role=partner', moldtech)).json()[0].quotes[0].archivedAt, null);
  await action('archive', moldtech, 'partner');
  assert.ok((await get(app, '/reports?role=partner', moldtech)).json()[0].response.archivedAt);
  await action('restore');
  assert.equal((await get(app, '/reports?role=partner', moldtech)).json()[0].quotes[0].archivedAt !== null, true);
  await action('undo-decline');
  await action('archive');
  assert.equal((await post(app, `/reports/${report.id}/choose`, { quoteId }, customer)).status, 409);
  await action('restore');
  assert.equal((await post(app, `/reports/${report.id}/choose`, { quoteId }, customer)).status, 200);
  assert.equal((await action('decline')).status, 409);
  assert.equal((await response('decline')).status, 409);
  assert.ok((await response('archive')).json().response.archivedAt);
  assert.equal((await get(app, '/reports', customer)).json()[0].response, undefined);
  const restarted = (await createApp({ dataDirectory, seeds: [] })).app;
  const restoredSession = await demo(restarted, 'moldtech');
  const restored = (await get(restarted, '/reports?role=partner', restoredSession)).json()[0];
  assert.ok(restored.response.archivedAt);
  assert.ok(restored.quotes[0].archivedAt);
  assert.equal(restored.selectedQuoteId, quoteId);
  const restoredReport = await post(restarted, `/reports/${report.id}/response`, { action: 'restore' }, restoredSession);
  assert.equal(restoredReport.json().response.archivedAt, null);
  assert.equal(restoredReport.json().quotes[0].archivedAt, null);
  assert.equal((await get(restarted, '/reports', customer)).json()[0].selectedQuoteId, quoteId);
}));

test('account-free contact gates quotes, reaches only the chosen company, and removed screenings restore privately', () => workspace(async (app, dataDirectory) => {
  const created = await post(app, '/reports', { area: 'Basement', description: 'Contact gate fixture.', autoShare: true });
  const customer = cookieHeader(created); const report = created.json();
  const moldtech = await demo(app, 'moldtech'); const aro = await demo(app, 'aro');
  const quoted = await post(app, `/reports/${report.id}/quote`, quote, moldtech);
  const quoteId = quoted.json().quotes[0].id;
  const locked = (await get(app, '/reports', customer)).json()[0];
  assert.equal(locked.contactRequired, true);
  assert.deepEqual(locked.quotes, []);
  assert.equal(locked.quoteCount, 1);
  assert.equal((await post(app, `/reports/${report.id}/choose`, { quoteId }, customer)).status, 400);
  for (const values of [{ email: 'bad', phone: '9055550123' }, { email: 'owner@example.test', phone: '' }, { email: 'owner@example.test', phone: '123' }, { email: 'owner@example.test', phone: '++19055550123' }]) {
    assert.equal((await post(app, '/customer-contact', values, customer)).status, 400);
  }
  const contact = { email: 'owner@example.test', phone: '+19055550123' };
  assert.deepEqual((await post(app, '/customer-contact', { email: 'OWNER@example.test', phone: '(905) 555-0123' }, customer)).json(), contact);
  assert.deepEqual((await get(app, '/customer-contact', customer)).json(), { contact });
  assert.deepEqual((await get(app, '/customer-contact')).json(), { contact: null });
  const unlocked = (await get(app, '/reports', customer)).json()[0];
  assert.equal(unlocked.contactRequired, false); assert.equal(unlocked.quotes[0].amount, quote.amount);
  assert.equal((await get(app, '/reports?role=partner', moldtech)).json()[0].customerContact, null);
  assert.equal((await get(app, '/reports?role=partner', aro)).json()[0].customerContact, null);
  assert.equal((await post(app, `/reports/${report.id}/choose`, { quoteId }, customer)).status, 200);
  assert.deepEqual((await get(app, '/reports?role=partner', moldtech)).json()[0].customerContact, contact);
  assert.equal((await get(app, '/reports?role=partner', aro)).json()[0].customerContact, null);
  const another = await post(app, '/reports', { area: 'Attic', description: 'Same browser, no new account.' }, customer);
  assert.equal(another.json().contactRequired, false);
  assert.equal((await post(app, `/screenings/${report.id}/removal`, { removed: true }, moldtech)).status, 404);
  assert.equal((await post(app, '/screenings/not-owned/removal', { removed: true }, customer)).status, 404);
  assert.equal((await post(app, `/screenings/${report.id}/removal`, { removed: 'yes' }, customer)).status, 400);
  const removed = (await post(app, `/screenings/${report.id}/removal`, { removed: true }, customer)).json();
  assert.equal(removed.length, 1); assert.equal(removed[0].key, report.id); assert.equal(removed[0].ownerHash, undefined);
  assert.deepEqual((await get(app, '/removed-screenings')).json(), []);
  assert.equal((await get(app, '/reports?role=partner', moldtech)).json().length, 1);
  const restarted = (await createApp({ dataDirectory, seeds: [] })).app;
  assert.deepEqual((await get(restarted, '/customer-contact', customer)).json(), { contact });
  assert.deepEqual((await get(restarted, '/removed-screenings', customer)).json(), removed);
  assert.deepEqual((await post(restarted, `/screenings/${report.id}/removal`, { removed: false }, customer)).json(), []);
  const restored = (await get(restarted, '/reports', customer)).json().find(item => item.id === report.id);
  assert.equal(restored.selectedQuoteId, quoteId); assert.equal(restored.quotes[0].amount, quote.amount);
}));

test('$100 monthly demo checkout gates access, records one simulated receipt and persists membership', () => workspace(async (app, dataDirectory) => {
  const signedIn = await post(app, '/demo-login', { companyId: 'moldtech' }); const cookie = cookieHeader(signedIn);
  assert.equal(signedIn.json().company.subscription, 'pending');
  assert.equal(signedIn.json().company.membership.amount, 100);
  assert.equal((await get(app, '/reports?role=partner', cookie)).status, 403);
  assert.equal((await post(app, '/subscription', { status: 'active' }, cookie)).status, 409);
  assert.equal((await post(app, '/membership/demo-pay', {}, cookie)).status, 400);
  const paid = await post(app, '/membership/demo-pay', { confirm: true, amount: 1 }, cookie);
  assert.equal(paid.status, 200); assert.equal(paid.json().company.subscription, 'active');
  const membership = paid.json().company.membership;
  assert.equal(membership.amount, 100); assert.equal(membership.currency, 'CAD'); assert.equal(membership.interval, 'month');
  assert.equal(membership.simulated, true); assert.equal(membership.status, 'paid_demo'); assert.match(membership.receiptId, /^DEMO-/);
  assert.ok(Date.parse(membership.periodEnd) > Date.parse(membership.paidAt));
  assert.deepEqual((await post(app, '/membership/demo-pay', { confirm: true }, cookie)).json().company.membership, membership);
  assert.equal((await get(app, '/reports?role=partner', cookie)).status, 200);
  assert.equal((await get(app, '/companies')).json()[0].membership.receiptId, undefined);
  const restarted = (await createApp({ dataDirectory, seeds: [] })).app;
  const newSession = cookieHeader(await post(restarted, '/demo-login', { companyId: 'moldtech' }));
  assert.deepEqual((await get(restarted, '/session', newSession)).json().company.membership, membership);
  await post(restarted, '/subscription', { status: 'paused' }, newSession);
  assert.equal((await get(restarted, '/reports?role=partner', newSession)).status, 403);
}, false));

test('itemized proposal totals, tax, deposits, assessment requirements and dates are enforced on the server', () => workspace(async app => {
  const { report, customer } = await sample(app);
  await post(app, `/reports/${report.id}/broadcast`, { consent: true }, customer);
  const contractor = await demo(app, 'moldtech'); const send = body => post(app, `/reports/${report.id}/quote`, body, contractor);
  const base = confirmedQuote(113, ['basement'], { taxMode: 'hst13', lineItems: [{ description: 'Assessment', category: 'assessment', unit: 'job', quantity: 1, unitPrice: 100, areaIds: ['basement'] }] });
  assert.equal((await send({ amount: 100, scope: 'Incomplete', availability: 'Tomorrow' })).status, 400);
  for (const invalid of [
    { ...base, amount: 1 }, { ...base, proposalKind: 'fixed_quote', assessmentBasis: 'screening' },
    { ...base, assessedOn: '2099-01-01' }, { ...base, validUntil: '2020-01-01' }, { ...base, validUntil: '2026-02-30' },
    { ...base, depositAmount: 114 }, { ...base, moisturePlan: '' }, { ...base, exclusions: '' }, { ...base, clearancePlan: '' },
    { ...base, lineItems: [] }, { ...base, lineItems: [{ ...base.lineItems[0], areaIds: ['not-an-area'] }] },
    { ...base, lineItems: [{ ...base.lineItems[0], quantity: -1 }] }, { ...base, lineItems: [{ ...base.lineItems[0], unitPrice: 1.111 }] },
  ]) assert.equal((await send(invalid)).status, 400);
  const added = await send(base); assert.equal(added.status, 201, added.body.toString());
  const first = added.json().quotes[0];
  assert.equal(first.amount, 113); assert.equal(first.subtotal, 100); assert.equal(first.taxAmount, 13);
  assert.equal(first.revision, 1); assert.match(first.reference, /^MLQ-/);
  assert.equal((await send({ ...base, expectedRevision: 0 })).status, 409);
  const included = await send({ ...base, taxMode: 'included_hst13', lineItems: [{ ...base.lineItems[0], unitPrice: 113 }], depositAmount: 20 });
  assert.equal(included.status, 201); assert.equal(included.json().quotes[0].subtotal, 100); assert.equal(included.json().quotes[0].taxAmount, 13);
  assert.equal(included.json().quotes[0].revision, 2); assert.equal(included.json().quotes[0].revisions[0].amount, 113);
  assert.equal(included.json().quotes[0].revisions[0].taxMode, 'hst13');
  assert.equal(included.json().quotes[0].revisions[0].revisions, undefined);
  assert.equal((await post(app, `/reports/${report.id}/choose`, { quoteId: first.id, revision: 1 }, customer)).status, 409);
}));

test('a free assessment request keeps the project open, preserves its original offer, and leads to a confirmed work quote', () => workspace(async (app, dataDirectory) => {
  const { report, customer } = await sample(app); await post(app, `/reports/${report.id}/broadcast`, { consent: true }, customer);
  const contractor = await demo(app, 'moldtech'); const other = await demo(app, 'aro');
  const assessment = confirmedQuote(0, ['basement'], { proposalKind: 'assessment', assessmentBasis: 'screening', assessedOn: null });
  const offered = await post(app, `/reports/${report.id}/quote`, assessment, contractor);
  assert.equal(offered.status, 201, offered.body.toString()); const quoteId = offered.json().quotes[0].id;
  const selected = await post(app, `/reports/${report.id}/choose`, { quoteId }, customer);
  assert.equal(selected.status, 200); assert.equal(selected.json().selectedQuoteId, null); assert.equal(selected.json().status, 'shared');
  assert.equal(selected.json().preliminarySelection.proposal.amount, 0);
  assert.equal((await get(app, '/reports?role=partner', other)).json()[0].preliminarySelection, null);
  assert.equal((await get(app, '/reports?role=partner', other)).json()[0].customerContact, null);
  assert.ok((await get(app, '/reports?role=partner', contractor)).json()[0].customerContact);
  assert.equal((await post(app, `/reports/${report.id}/response`, { action: 'decline' }, contractor)).status, 409);
  assert.equal((await post(app, `/reports/${report.id}/quote`, assessment, contractor)).status, 409);
  const final = await post(app, `/reports/${report.id}/quote`, confirmedQuote(1500), contractor);
  assert.equal(final.status, 201); assert.equal(final.json().quotes[0].id, quoteId); assert.equal(final.json().quotes[0].revision, 2);
  assert.equal(final.json().preliminarySelection.proposal.amount, 0);
  assert.equal(final.json().quotes[0].revisions[0].proposalKind, 'assessment');
  const chosen = await post(app, `/reports/${report.id}/choose`, { quoteId }, customer);
  assert.equal(chosen.json().selectedQuoteId, quoteId); assert.equal(chosen.json().status, 'chosen');
  assert.equal((await post(app, `/reports/${report.id}/quote`, confirmedQuote(1600), contractor)).status, 409);
  const filename = path.join(dataDirectory, 'marketplace.json'); const records = JSON.parse(await readFile(filename, 'utf8'));
  records.reports.find(item => item.id === report.id).selectedQuoteId = null;
  records.quotes.find(item => item.id === quoteId).validUntil = '2020-01-01';
  await writeFile(filename, JSON.stringify(records));
  const restarted = (await createApp({ dataDirectory, seeds: [] })).app;
  assert.equal((await post(restarted, `/reports/${report.id}/choose`, { quoteId }, customer)).status, 409);
}));
