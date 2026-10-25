import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { sql } from 'drizzle-orm';
import { createApp } from '../server/app.mjs';
import { dispatch, jsonRequest, cookieHeader, withCookie, createStaff, setupCode } from './http-helpers.mjs';

const context = { propertyType: 'house', region: 'ON', areas: ['basement'], concerns: ['visible_spots', 'water_damage'], statement: 'Spots below a window after rain.', contact: { name: 'Test homeowner', email: 'owner@example.test', postalCode: 'K1S 3W7' } };
const consent = { consentAiProcessing: true, consentMediaStorage: true };
const usage = { inputTokens: 10, outputTokens: 10, images: 1, costUsd: 0 };
const safeModel = {
  provider: 'fixture', model: 'test-vision',
  async observe(request) {
    return { provider: this.provider, model: this.model, promptVersion: 'fixture-v1', isMock: true, usage: { ...usage, images: request.frames.length },
      result: { observations: request.frames.map(f => ({ frameId: f.frameId, category: 'staining', location: 'window surround', neutralDescription: 'Patchy surface discoloration is visible.', visibility: 'good', strength: 'moderate', alternativeExplanations: ['Old water staining'], limitations: [], region: null })), frames: request.frames.map(f => ({ frameId: f.frameId, usable: true, issue: null, privacyConcern: false })), overallLimitations: [], questionPriority: [] } };
  },
};
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-screening-test-'));
  const service = await createApp({ dataDirectory: directory, seeds: [], authOptions: { setupCode }, screeningOptions: { databaseUrl: 'memory:', models: { vision: safeModel, text: null }, ...overrides } });
  t.after(async () => { await service.screening.stop(); await rm(directory, { recursive: true, force: true }); });
  return { ...service, directory };
}
async function draft(app) {
  const response = await dispatch(app, jsonRequest('POST', '/api/screenings', consent));
  assert.equal(response.status, 201, response.body.toString());
  const cookie = cookieHeader(response);
  assert.ok(cookie);
  return { id: response.json().id, cookie, detail: response.json() };
}
const call = (app, owner, method, url, body) => dispatch(app, withCookie(body === undefined ? { method, url } : jsonRequest(method, url, body), owner.cookie));
const endpoint = (owner, suffix = '') => `/api/screenings/${owner.id}${suffix}`;
async function configure(app, owner, extra = {}) {
  const response = await call(app, owner, 'PATCH', endpoint(owner), { ...context, ...extra });
  assert.equal(response.status, 200, response.body.toString());
}
async function beginUpload(app, owner, input = {}) {
  const response = await call(app, owner, 'POST', endpoint(owner, '/uploads'), { fingerprint: 'fixture-fingerprint-0001', mime: 'image/png', size: 10, name: 'photo.png', ...input });
  assert.equal(response.status, 201, response.body.toString());
  return response.json();
}
async function finishQuestions(app, screening, owner) {
  await screening.runJobs();
  const questions = await call(app, owner, 'GET', endpoint(owner, '/questions'));
  assert.equal(questions.status, 200, questions.body.toString());
  if (questions.json().status === 'needs_answers') {
    const result = await call(app, owner, 'POST', endpoint(owner, '/answers'), { answers: [], finish: true });
    assert.equal(result.status, 200, result.body.toString());
  }
  await screening.runJobs();
}

test('screening consent, saved context, customer isolation, staff separation and case linking', async t => {
  const { app, screening, store } = await fixture(t);
  assert.equal((await dispatch(app, jsonRequest('POST', '/api/screenings', {}))).status, 400);
  const owner = await draft(app);
  assert.match(owner.detail.reference, /^ML-/);
  const outsider = await draft(app);
  assert.equal((await call(app, outsider, 'GET', endpoint(owner))).status, 404);
  assert.equal((await dispatch(app, { url: endpoint(owner) })).status, 404);
  assert.equal((await dispatch(app, { url: '/api/screenings?admin=true' })).status, 401);
  const invalid = await call(app, owner, 'PATCH', endpoint(owner), { ...context, areas: ['unknown'] });
  assert.equal(invalid.status, 400);
  await configure(app, owner, { contact: { name: 'Test homeowner', email: 'owner@example.test', postalCode: 'k1s3w7' } });
  const saved = await call(app, owner, 'GET', endpoint(owner));
  assert.equal(saved.json().details.contact.postalCode, 'K1S 3W7');
  assert.equal(saved.json().details.statement, context.statement);
  assert.equal((await call(app, owner, 'GET', endpoint(owner, '/report'))).status, 409);
  const staffCookie = await createStaff(app);
  const staff = { cookie: staffCookie };
  assert.equal((await call(app, staff, 'GET', endpoint(owner))).status, 200);
  assert.equal((await call(app, staff, 'PATCH', endpoint(owner), context)).status, 404);
  const submit = await call(app, owner, 'POST', endpoint(owner, '/submit'), {});
  assert.equal(submit.status, 200, submit.body.toString());
  assert.equal(submit.json().status, 'queued');
  assert.ok(submit.json().linkedRequestId);
  assert.equal((await store.all()).length, 1);
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/submit'), {})).status, 200);
  assert.equal((await store.all()).length, 1, 'Repeated submit does not duplicate client cases');
  await finishQuestions(app, screening, owner);
  const result = await call(app, owner, 'GET', endpoint(owner, '/report'));
  assert.equal(result.status, 200, result.body.toString());
  assert.equal(result.json().validation.passed, true);
  assert.equal(result.json().report.provenance.model, 'none');
  assert.match(result.json().report.disclosure, /cannot confirm whether mold is present/);
  assert.equal((await call(app, outsider, 'GET', endpoint(owner, '/report'))).status, 404);
  assert.equal((await call(app, staff, 'GET', endpoint(owner, '/report'))).status, 200);
  const cases = await store.all();
  assert.equal(cases[0].screening.reportAvailable, true);
  assert.equal(cases[0].customerOwnerHash.length, 64);
  const customerCases = await call(app, owner, 'GET', '/api/my-requests');
  assert.equal(customerCases.json()[0].screening.id, owner.id);
  assert.equal(customerCases.json()[0].screening.reportAvailable, true);
  assert.equal(customerCases.json()[0].customerOwnerHash, undefined);
  const ownList = await call(app, owner, 'GET', '/api/screenings');
  assert.deepEqual(ownList.json().map(item => item.id), [owner.id]);
  const all = await call(app, staff, 'GET', '/api/screenings?admin=true');
  assert.equal(all.json().length, 2);
  assert.ok(!JSON.stringify(all.json()).includes('customerOwnerHash'));
});

test('submit requires name, email and postal code like the main request form', async t => {
  const { app } = await fixture(t);
  const owner = await draft(app);
  const { contact: _omit, ...withoutContact } = context;
  assert.equal((await call(app, owner, 'PATCH', endpoint(owner), withoutContact)).status, 200);
  const missing = await call(app, owner, 'POST', endpoint(owner, '/submit'), {});
  assert.equal(missing.status, 400);
  assert.match(missing.body.toString(), /name/i);
  await configure(app, owner, { contact: { name: 'Test homeowner', email: 'owner@example.test', postalCode: '' } });
  assert.match((await call(app, owner, 'POST', endpoint(owner, '/submit'), {})).body.toString(), /postal code/i);
  await configure(app, owner);
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/submit'), {})).status, 200);
});

test('resumable uploads enforce offsets, idempotency, open-upload quota, cancellation and ownership', async t => {
  const { app, screening } = await fixture(t, { config: { maxUploadBytes: 100 } });
  const owner = await draft(app);
  const outsider = await draft(app);
  await configure(app, owner);
  const upload = await beginUpload(app, owner);
  const url = `/api/screening-uploads/${upload.id}`;
  assert.equal((await call(app, outsider, 'GET', url)).status, 404);
  assert.equal((await call(app, owner, 'POST', `${url}/complete`, {})).status, 400);
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/submit'), {})).status, 400);
  const chunk = (offset, text) => dispatch(app, withCookie({ method: 'PUT', url: `${url}?offset=${offset}`, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(text) }, owner.cookie));
  assert.equal((await chunk(0, '12345')).json().receivedBytes, 5);
  const raced = await Promise.all([chunk(5, '67890'), chunk(5, '67890')]);
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 409]);
  assert.equal((await beginUpload(app, owner)).receivedBytes, 10);
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/uploads'), { fingerprint: 'fixture-fingerprint-0001', mime: 'image/png', size: 11 })).status, 400);
  const completed = await call(app, owner, 'POST', `${url}/complete`, {});
  assert.equal(completed.status, 200, completed.body.toString());
  assert.deepEqual((await call(app, owner, 'POST', `${url}/complete`, {})).json(), completed.json());
  assert.equal((await beginUpload(app, owner)).assetId, completed.json().assetId);
  assert.equal((await call(app, owner, 'DELETE', url)).status, 400);
  assert.equal((await call(app, owner, 'DELETE', `/api/screening-assets/${completed.json().assetId}`)).status, 200);
  const sessions = [];
  for (let i = 0; i < 12; i++) sessions.push(await beginUpload(app, owner, { fingerprint: `quota-fingerprint-${i}` }));
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/uploads'), { fingerprint: 'one-too-many-fingerprint', mime: 'image/png', size: 10 })).status, 400);
  assert.equal((await call(app, owner, 'DELETE', `/api/screening-uploads/${sessions[0].id}`)).status, 200);
  await beginUpload(app, owner, { fingerprint: 'slot-freed-by-cancel' });
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/uploads'), { fingerprint: 'size-too-large', mime: 'image/png', size: 101 })).status, 400);
  await screening.runJobs();
});

test('file-backed screenings and ownership survive application restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'moldlens-screening-persist-'));
  let service;
  t.after(async () => { if (service) await service.screening.stop(); await rm(directory, { recursive: true, force: true }); });
  const options = { dataDirectory: directory, seeds: [], authOptions: { setupCode }, screeningOptions: { models: { vision: safeModel, text: null } } };
  service = await createApp(options);
  const owner = await draft(service.app);
  await configure(service.app, owner);
  const upload = await beginUpload(service.app, owner);
  const uploadUrl = `/api/screening-uploads/${upload.id}`;
  const partial = await dispatch(service.app, withCookie({ method: 'PUT', url: `${uploadUrl}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('12345') }, owner.cookie));
  assert.equal(partial.json().receivedBytes, 5);
  // Simulate a process exit after a file write but before committing its DB offset.
  const row = await service.screening.db.execute(sql`SELECT object_key FROM upload_sessions WHERE id=${upload.id}::uuid`);
  await service.screening.objectStore.putBuffer(row.rows[0].object_key, Buffer.from('12345uncommitted-tail'));
  await service.screening.stop(); service = null;
  service = await createApp(options);
  const response = await call(service.app, owner, 'GET', endpoint(owner));
  assert.equal(response.status, 200, response.body.toString());
  assert.equal(response.json().details.statement, context.statement);
  assert.equal((await call(service.app, owner, 'GET', uploadUrl)).json().receivedBytes, 5);
  const resumed = await dispatch(service.app, withCookie({ method: 'PUT', url: `${uploadUrl}?offset=5`, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('67890') }, owner.cookie));
  assert.equal(resumed.json().receivedBytes, 10);
  assert.equal((await call(service.app, owner, 'POST', `${uploadUrl}/complete`, {})).status, 200);
});

test('real photo processing produces private evidence and filters unsafe summaries', async t => {
  let sharp;
  try { sharp = (await import('sharp')).default; await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer(); }
  catch { t.skip('Native sharp is unavailable in this environment.'); return; }
  const unsafeSummary = { provider: 'fixture', model: 'test-summary', summarize: async () => ({ provider: 'fixture', model: 'test-summary', promptVersion: 'fixture', usage, summary: { headline: 'There is mold on the ceiling.', points: ['The mold has spread throughout the home.'] } }) };
  const { app, screening } = await fixture(t, { models: { vision: safeModel, text: unsafeSummary } });
  const owner = await draft(app);
  const outsider = await draft(app);
  await configure(app, owner);
  const pixels = Buffer.alloc(512 * 384 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 60 + ((i * 17 + Math.floor(i / 1536) * 31) % 130);
  const png = await sharp(pixels, { raw: { width: 512, height: 384, channels: 3 } }).png().toBuffer();
  const upload = await beginUpload(app, owner, { size: png.length, area: 'basement' });
  const uploadUrl = `/api/screening-uploads/${upload.id}`;
  assert.equal((await dispatch(app, withCookie({ method: 'PUT', url: `${uploadUrl}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, body: png }, owner.cookie))).status, 200);
  assert.equal((await call(app, owner, 'POST', `${uploadUrl}/complete`, {})).status, 200);
  await screening.runJobs();
  const prepared = (await call(app, owner, 'GET', endpoint(owner))).json();
  assert.equal(prepared.media[0].status, 'ready', JSON.stringify(prepared.media));
  assert.equal((await call(app, outsider, 'GET', prepared.media[0].url)).status, 404);
  assert.equal((await call(app, owner, 'GET', prepared.media[0].url)).status, 200);
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/submit'), {})).status, 200);
  await finishQuestions(app, screening, owner);
  const result = await call(app, owner, 'GET', endpoint(owner, '/report'));
  assert.equal(result.status, 200, result.body.toString());
  assert.ok(result.json().frames.length > 0);
  assert.ok(!JSON.stringify(result.json().report.summary).includes('There is mold'));
  assert.ok(!JSON.stringify(result.json().report.summary).includes('mold has spread'));
  assert.equal((await call(app, outsider, 'GET', result.json().frames[0].url)).status, 404);
  assert.equal((await call(app, owner, 'GET', result.json().frames[0].url)).status, 200);
});

test('invalid media is rejected honestly, unapproved answers fail, and only staff can retry a failed case', async t => {
  const { app, screening } = await fixture(t);
  const owner = await draft(app);
  await configure(app, owner);
  const upload = await beginUpload(app, owner);
  await dispatch(app, withCookie({ method: 'PUT', url: `/api/screening-uploads/${upload.id}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('not-a-png!') }, owner.cookie));
  assert.equal((await call(app, owner, 'POST', `/api/screening-uploads/${upload.id}/complete`, {})).status, 200);
  await screening.runJobs();
  const media = (await call(app, owner, 'GET', endpoint(owner))).json().media[0];
  assert.equal(media.status, 'rejected');
  assert.ok(media.rejectionReason);
  assert.equal(media.url, null);
  await call(app, owner, 'POST', endpoint(owner, '/submit'), {});
  await screening.runJobs();
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/answers'), { answers: [{ questionId: 'invented-question', value: 'yes' }] })).status, 400);
  const questions = (await call(app, owner, 'GET', endpoint(owner, '/questions'))).json();
  assert.ok(questions.open.length > 0 && questions.open.length <= 4);
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/answers'), { answers: [{ questionId: questions.open[0].id, value: 'unapproved-answer' }] })).status, 400);
  await screening.db.execute(sql`UPDATE assessments SET status='failed',last_error_code='fixture_failure' WHERE id=${owner.id}::uuid`);
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/retry'), {})).status, 401);
  const staff = { cookie: await createStaff(app) };
  const retried = await call(app, staff, 'POST', endpoint(owner, '/retry'), {});
  assert.equal(retried.status, 200, retried.body.toString());
  assert.equal(retried.json().status, 'queued');
  assert.equal(retried.json().lastErrorCode, null);
  await finishQuestions(app, screening, owner);
  assert.equal((await call(app, owner, 'GET', endpoint(owner, '/report'))).status, 200);
});

test('early visual review excludes private and unusable frames and invalidates when the selected model changes', async t => {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { t.skip('Native sharp is unavailable.'); return; }
  const pixels = Buffer.alloc(256 * 256 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 80 + ((i * 29) % 100);
  let png;
  try { png = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer(); }
  catch { t.skip('Native sharp is unavailable.'); return; }
  let mode = 'private';
  let calls = 0;
  const model = { ...safeModel, async observe(request) {
    calls++;
    const result = await safeModel.observe.call(this, request);
    for (const frame of result.result.frames) { frame.privacyConcern = mode === 'private'; frame.usable = mode !== 'unusable'; }
    if (mode === 'duplicate-private' || mode === 'duplicate-unusable') {
      result.result.frames.push({ ...result.result.frames[0], privacyConcern: mode === 'duplicate-private', usable: mode !== 'duplicate-unusable' });
    }
    return result;
  } };
  const { app, screening } = await fixture(t, { models: { vision: model, text: null } });
  for (const selectedMode of ['private', 'unusable', 'duplicate-private', 'duplicate-unusable', 'normal']) {
    mode = selectedMode;
    const owner = await draft(app);
    await configure(app, owner);
    const upload = await beginUpload(app, owner, { size: png.length });
    const url = `/api/screening-uploads/${upload.id}`;
    await dispatch(app, withCookie({ method: 'PUT', url: `${url}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, body: png }, owner.cookie));
    await call(app, owner, 'POST', `${url}/complete`, {});
    await screening.runJobs();
    await screening.db.execute(sql`UPDATE jobs SET run_at=now() WHERE type='assessment.preobserve' AND status='queued'`);
    const before = calls;
    await screening.runJobs();
    assert.equal(calls, before + 1);
    if (selectedMode === 'normal') model.model = 'test-vision-updated';
    await call(app, owner, 'POST', endpoint(owner, '/submit'), {});
    await finishQuestions(app, screening, owner);
    const report = (await call(app, owner, 'GET', endpoint(owner, '/report'))).json();
    if (selectedMode === 'normal') {
      assert.equal(calls, before + 2, 'Changed model cannot reuse the earlier result');
      assert.ok(report.frames.length > 0);
    } else {
      assert.equal(calls, before + 1, 'Matching early review is reused');
      assert.equal(report.frames.length, 0);
      assert.equal(report.report.outcome, 'inconclusive');
      assert.ok(!JSON.stringify(report.report).includes('Patchy surface discoloration is visible.'));
      if (selectedMode === 'private' || selectedMode === 'duplicate-private') {
        const rows = await screening.db.execute(sql`SELECT id FROM media_frames WHERE assessment_id=${owner.id}::uuid`);
        assert.equal((await call(app, owner, 'GET', `/api/screening-media/frames/${rows.rows[0].id}`)).status, 404);
      }
    }
  }
});

test('media screening fails visibly without a configured vision provider and staff can retry after configuration', async t => {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { t.skip('Native sharp is unavailable.'); return; }
  const pixels = Buffer.alloc(256 * 256 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 80 + ((i * 29) % 100);
  let png;
  try { png = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer(); }
  catch { t.skip('Native sharp is unavailable.'); return; }
  const previous = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'unsupported-test-provider';
  t.after(() => { if (previous === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = previous; });
  const { app, screening } = await fixture(t, { models: { text: null } });
  const owner = await draft(app);
  await configure(app, owner);
  const upload = await beginUpload(app, owner, { size: png.length });
  await dispatch(app, withCookie({ method: 'PUT', url: `/api/screening-uploads/${upload.id}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, body: png }, owner.cookie));
  await call(app, owner, 'POST', `/api/screening-uploads/${upload.id}/complete`, {});
  await call(app, owner, 'POST', endpoint(owner, '/submit'), {});
  await screening.runJobs();
  const result = (await call(app, owner, 'GET', endpoint(owner))).json();
  assert.equal(result.status, 'failed');
  assert.equal(result.lastErrorCode, 'ai_not_configured');
  assert.equal((await call(app, owner, 'GET', endpoint(owner, '/report'))).status, 409);
  const staff = { cookie: await createStaff(app) };
  // The explicitly selected mock is restricted to this isolated test process.
  process.env.AI_PROVIDER = 'mock';
  assert.equal((await call(app, staff, 'POST', endpoint(owner, '/retry'), {})).status, 200);
  await finishQuestions(app, screening, owner);
  const report = await call(app, owner, 'GET', endpoint(owner, '/report'));
  assert.equal(report.status, 200, report.body.toString());
  assert.equal(report.json().isDemo, true);
});

test('form-only reports with answered follow-ups describe rules and answers accurately and are always free', async t => {
  const previous = process.env.FEATURE_REPORT_PUBLISHING;
  process.env.FEATURE_REPORT_PUBLISHING = 'false';
  t.after(() => { if (previous === undefined) delete process.env.FEATURE_REPORT_PUBLISHING; else process.env.FEATURE_REPORT_PUBLISHING = previous; });
  let summaryCalls = 0;
  const noTextCalls = { provider: 'fixture', model: 'must-not-run', async summarize() { summaryCalls++; assert.fail('A form-only screening must use deterministic rules without calling AI.'); } };
  const { app, screening } = await fixture(t, { models: { vision: safeModel, text: noTextCalls } });
  const owner = await draft(app);
  await configure(app, owner);
  await call(app, owner, 'POST', endpoint(owner, '/submit'), {});
  await screening.runJobs();
  const questions = (await call(app, owner, 'GET', endpoint(owner, '/questions'))).json().open;
  assert.ok(questions.length >= 2);
  const answers = questions.map(q => ({ questionId: q.id, value: q.kind === 'multi' ? [q.options[0].value] : q.options[0].value }));
  assert.equal((await call(app, owner, 'POST', endpoint(owner, '/answers'), { answers, finish: true })).status, 200);
  await screening.runJobs();
  const result = await call(app, owner, 'GET', endpoint(owner, '/report'));
  assert.equal(result.status, 200, result.body.toString());
  const report = result.json().report;
  assert.equal(report.outcome, 'limited');
  assert.match(report.summary.headline, /Your answers/);
  assert.match(report.method, /written answers only/);
  assert.ok(!/AI-assisted|photos, video and answers/i.test(report.disclosure));
  assert.ok(!/we didn't see|your media shows/i.test(report.summary.headline));
  assert.equal(report.provenance.modelProvider, 'none');
  assert.equal(report.provenance.summaryModel, undefined);
  assert.equal(summaryCalls, 0);
  // Document sections: grouped steps, honest checks with no readings, a professional outlook with no prices.
  assert.equal(report.schemaVersion, 'report-v2');
  assert.ok(report.recommendations.every(r => ['now', 'next', 'ongoing'].includes(r.when)));
  const checks = Object.fromEntries(report.checks.map(c => [c.id, c]));
  for (const id of ['moisture', 'humidity', 'thermal', 'air']) {
    assert.equal(checks[id].status, 'not_measured', id);
    assert.ok(checks[id].needs.length > 0, id);
  }
  assert.equal(checks.visual.status, 'not_measured');
  assert.ok(!/\d\s*(%|ppm|°)/.test(JSON.stringify(report.checks)));
  assert.ok(report.professional.inspectionFocus.some(f => f.area === 'Basement'));
  assert.ok(report.professional.typicalWork.length >= 4);
  assert.ok(report.professional.quoteChecklist.length > 0);
  assert.ok(!/\$\s?\d/.test(JSON.stringify(report.professional)));
  const persisted = await screening.db.execute(sql`SELECT status FROM report_versions WHERE assessment_id=${owner.id}::uuid`);
  assert.equal(persisted.rows[0].status, 'published');
});

test('slow early AI never blocks draft mutations or submit and removed evidence cannot return', async t => {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { t.skip('Native sharp is unavailable.'); return; }
  const pixels = Buffer.alloc(256 * 256 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 80 + ((i * 29) % 100);
  let png;
  try { png = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer(); }
  catch { t.skip('Native sharp is unavailable.'); return; }
  let entered;
  let release;
  let hold;
  let callCount = 0;
  const model = { ...safeModel, async observe(request) { callCount++; entered(); await hold; return safeModel.observe.call(this, request); } };
  const { app, screening } = await fixture(t, { models: { vision: model, text: null } });
  for (const removeEvidence of [true, false]) {
    const waiting = new Promise(resolve => { entered = resolve; });
    hold = new Promise(resolve => { release = resolve; });
    const owner = await draft(app);
    await configure(app, owner);
    const upload = await beginUpload(app, owner, { size: png.length });
    const uploadUrl = `/api/screening-uploads/${upload.id}`;
    await dispatch(app, withCookie({ method: 'PUT', url: `${uploadUrl}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, body: png }, owner.cookie));
    const assetId = (await call(app, owner, 'POST', `${uploadUrl}/complete`, {})).json().assetId;
    await screening.runJobs(1);
    await screening.db.execute(sql`UPDATE jobs SET run_at=now() WHERE type='assessment.preobserve' AND status='queued'`);
    const work = screening.runJobs(1);
    const callsBefore = callCount;
    await waiting;
    try {
      const started = Date.now();
      await configure(app, owner, { statement: 'Saved while analysis is waiting.' });
      const extra = await beginUpload(app, owner, { fingerprint: 'extra-while-ai-waits' });
      const chunk = await dispatch(app, withCookie({ method: 'PUT', url: `/api/screening-uploads/${extra.id}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('12345') }, owner.cookie));
      assert.equal(chunk.status, 200);
      assert.equal((await call(app, owner, 'DELETE', `/api/screening-uploads/${extra.id}`)).status, 200);
      if (removeEvidence) assert.equal((await call(app, owner, 'DELETE', `/api/screening-assets/${assetId}`)).status, 200);
      const submitted = await call(app, owner, 'POST', endpoint(owner, '/submit'), {});
      assert.equal(submitted.status, 200, submitted.body.toString());
      assert.equal(submitted.json().status, 'queued');
      assert.ok(Date.now() - started < 2000, 'Draft edits and submit must not wait for the AI request');
    } finally { release(); await work; }
    await finishQuestions(app, screening, owner);
    assert.equal(callCount, callsBefore + 1, 'Unchanged early evidence is reused after submission');
    const result = (await call(app, owner, 'GET', endpoint(owner, '/report'))).json();
    if (removeEvidence) {
      assert.equal(result.frames.length, 0);
      assert.ok(!JSON.stringify(result.report).includes('Patchy surface discoloration is visible.'));
      const runs = await screening.db.execute(sql`SELECT state FROM assessment_runs WHERE assessment_id=${owner.id}::uuid AND stage='observe'`);
      assert.equal(runs.rows[0].state, 'superseded');
      assert.equal((await screening.db.execute(sql`SELECT count(*) AS count FROM observations WHERE assessment_id=${owner.id}::uuid`)).rows[0].count, 0);
    } else assert.ok(result.frames.length > 0);
  }
});

test('slow video preparation never blocks draft changes and deletion cannot resurrect the asset', async t => {
  let ffmpeg;
  try { ffmpeg = process.env.FFMPEG_PATH || (await import('ffmpeg-static')).default; await access(ffmpeg); }
  catch { t.skip('Local FFmpeg is unavailable.'); return; }
  const { app, screening, directory } = await fixture(t);
  const video = path.join(directory, 'fixture.mp4');
  await promisify(execFile)(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=4', '-t', '1', '-pix_fmt', 'yuv420p', video]);
  const bytes = await readFile(video);
  const owner = await draft(app);
  await configure(app, owner);
  const upload = await beginUpload(app, owner, { fingerprint: 'slow-video-fixture', mime: 'video/mp4', size: bytes.length, name: 'fixture.mp4' });
  await dispatch(app, withCookie({ method: 'PUT', url: `/api/screening-uploads/${upload.id}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, body: bytes }, owner.cookie));
  const assetId = (await call(app, owner, 'POST', `/api/screening-uploads/${upload.id}/complete`, {})).json().assetId;
  const marker = path.join(directory, 'ffmpeg-entered');
  const release = path.join(directory, 'ffmpeg-release');
  const wrapper = path.join(directory, 'slow-ffmpeg.cjs');
  await writeFile(wrapper, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nfs.writeFileSync(${JSON.stringify(marker)}, 'ready');\nconst timer = setInterval(() => {\n  if (!fs.existsSync(${JSON.stringify(release)})) return;\n  clearInterval(timer);\n  const child = spawn(${JSON.stringify(ffmpeg)}, process.argv.slice(2), { stdio: 'inherit' });\n  child.once('exit', code => process.exit(code || 0));\n  child.once('error', () => process.exit(1));\n}, 10);\n`, { mode: 0o700 });
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = wrapper;
  t.after(() => { if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous; });
  const work = screening.runJobs(1);
  try {
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      try { await access(marker); waiting = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'The video job must reach the intentionally paused transcode');
    const started = Date.now();
    await configure(app, owner, { statement: 'Saved while video is processing.' });
    const extra = await beginUpload(app, owner, { fingerprint: 'photo-while-video-waits' });
    const chunk = await dispatch(app, withCookie({ method: 'PUT', url: `/api/screening-uploads/${extra.id}?offset=0`, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('12345') }, owner.cookie));
    assert.equal(chunk.status, 200);
    assert.equal((await call(app, owner, 'DELETE', `/api/screening-uploads/${extra.id}`)).status, 200);
    assert.equal((await call(app, owner, 'DELETE', `/api/screening-assets/${assetId}`)).status, 200);
    assert.equal((await call(app, owner, 'POST', endpoint(owner, '/submit'), {})).status, 200);
    assert.ok(Date.now() - started < 2000, 'Draft mutations must not wait for FFmpeg');
  } finally { await writeFile(release, 'continue'); await work; }
  const detail = (await call(app, owner, 'GET', endpoint(owner))).json();
  assert.equal(detail.media.length, 0);
  assert.equal((await screening.db.execute(sql`SELECT count(*) AS count FROM media_frames WHERE asset_id=${assetId}::uuid`)).rows[0].count, 0);
  const job = await screening.db.execute(sql`SELECT status FROM jobs WHERE type='media.process' AND payload->>'assetId'=${assetId}`);
  assert.equal(job.rows[0].status, 'succeeded');
  await assert.rejects(access(path.join(directory, 'screening-media', 'assessments', owner.id, 'derived', assetId)), { code: 'ENOENT' });
  await finishQuestions(app, screening, owner);
  const report = (await call(app, owner, 'GET', endpoint(owner, '/report'))).json();
  assert.equal(report.frames.length, 0);
});
