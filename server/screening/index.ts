/** Screening integration adapted from timothytenzin20/soon-2026, commit 82c4a58. */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, organizations, users, customerProfiles, assessments, concerns, properties,
  mediaAssets, mediaFrames, uploadSessions, reportVersions, assessmentRuns, jobs,
  recoverStaleJobs, audit, type Db,
} from '@mb/db';
import {
  AREAS, CONCERNS, PROPERTY_TYPES, REGIONS, POLICY_VERSION, customerPhase, assertAuthorized,
  ForbiddenError, type Principal, type AssessmentStatus,
} from '@mb/domain';
import {
  createDraft, updateDraftDetails, createUploadSession, appendUploadChunk, completeUpload,
  removeMediaAsset, submitAssessment, getOpenQuestions, submitAnswers, assessmentResource,
  transitionAssessment, readPipelineConfig, runOnce, ValidationError, NotFoundError,
  ConcurrencyConflict, MAX_CHUNK_BYTES, MAX_ASSETS_PER_ASSESSMENT, JOB_TYPES,
} from '@mb/pipeline';
import { LocalObjectStore } from '@mb/storage';
import { aiStatus } from '@mb/ai';

const here = path.dirname(fileURLToPath(import.meta.url));
const wrap = (handler: any) => (req: any, res: any, next: any) => Promise.resolve(handler(req, res)).catch(next);
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const asRows = (result: any): any[] => result.rows ?? result;
const safeName = (value: unknown, fallback: string) => typeof value === 'string' && value.trim()
  ? path.basename(value.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) : fallback;

export async function registerScreeningRoutes(app: any, options: any) {
  const { auth, store: clientStore, dataDirectory, models } = options;
  const cfg = { ...readPipelineConfig(), ...options.config };
  const handle = createDb(options.databaseUrl ?? process.env.SCREENING_DATABASE_URL ?? `pglite:${path.join(dataDirectory, 'screening-db')}`, {
    migrationsFolder: options.migrationsFolder ?? path.join(here, 'vendor/db/drizzle'),
  });
  await handle.migrate();
  const db = handle.db;
  const mediaRoot = path.join(dataDirectory, 'screening-media');
  await fs.mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  const objectStore = new LocalObjectStore(mediaRoot);
  // Bind the existing opaque browser identity to a profile. No browser-provided IDs
  // or legacy localStorage request IDs participate in authorization.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS moldlens_screening_owners (
    owner_hash text PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customer_profiles(id), created_at timestamptz NOT NULL DEFAULT now())`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS moldlens_screening_links (
    assessment_id uuid PRIMARY KEY REFERENCES assessments(id) ON DELETE CASCADE, request_id text,
    contact jsonb NOT NULL DEFAULT '{}'::jsonb, owner_hash text NOT NULL)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS moldlens_screening_upload_names (
    upload_id uuid PRIMARY KEY REFERENCES upload_sessions(id) ON DELETE CASCADE, name text NOT NULL)`);
  await db.insert(organizations).values({ slug: 'mold-busters', name: 'MoldLens', serviceRegions: ['ON', 'QC'], policyVersion: POLICY_VERSION }).onConflictDoNothing();
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, 'mold-busters'));
  const deps = { db, store: objectStore, cfg, visionModel: models?.vision, textModel: models?.text, serialize: <T>(id: string, work: () => Promise<T>) => serial(id, work) };
  const locks = new Map<string, Promise<unknown>>();
  async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(work);
    locks.set(key, operation);
    try { return await operation; } finally { if (locks.get(key) === operation) locks.delete(key); }
  }
  const customerHash = (req: any) => auth.getCustomerHash(req);
  async function customerPrincipal(req: any): Promise<Principal> {
    const owner = customerHash(req);
    if (!owner) return { kind: 'anonymous' };
    const [binding] = asRows(await db.execute(sql`SELECT customer_id FROM moldlens_screening_owners WHERE owner_hash = ${owner}`));
    return binding ? { kind: 'customer', orgId: org!.id, customerId: binding.customer_id, emailVerified: false } : { kind: 'anonymous' };
  }
  async function principal(req: any, allowStaff = true): Promise<Principal> {
    const staff = allowStaff && auth.userForRequest(req);
    if (staff) {
      await db.insert(users).values({ email: staff.email, displayName: 'MoldLens staff' }).onConflictDoNothing();
      const [user] = await db.select().from(users).where(eq(users.email, staff.email));
      return { kind: 'staff', orgId: org!.id, userId: user!.id, role: 'manager' };
    }
    return customerPrincipal(req);
  }
  async function permitted(req: any, id: string, action = 'assessment.read', allowStaff = true) {
    const p = await principal(req, allowStaff);
    const loaded = await assessmentResource(db, p, id);
    assertAuthorized(p, action as any, loaded.res);
    return { ...loaded, p };
  }
  const limits = { maxFiles: MAX_ASSETS_PER_ASSESSMENT, maxUploadBytes: cfg.maxUploadBytes, maxVideoSeconds: cfg.maxVideoSeconds, chunkBytes: MAX_CHUNK_BYTES };
  const assetUrl = (id: string, variant = 'preview') => `/api/screening-media/assets/${id}/${variant}`;
  const frameUrl = (id: string) => `/api/screening-media/frames/${id}`;
  async function linkFor(id: string) {
    return asRows(await db.execute(sql`SELECT request_id, contact FROM moldlens_screening_links WHERE assessment_id = ${id}::uuid`))[0];
  }
  async function publicMedia(id: string) {
    const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.assessmentId, id)).orderBy(mediaAssets.createdAt);
    const uploads = await db.select().from(uploadSessions).where(eq(uploadSessions.assessmentId, id));
    const names = asRows(await db.execute(sql`SELECT n.upload_id,n.name FROM moldlens_screening_upload_names n JOIN upload_sessions u ON u.id=n.upload_id WHERE u.assessment_id=${id}::uuid`));
    return assets.map(asset => {
      const upload = uploads.find(u => u.assetId === asset.id);
      const name = names.find(n => n.upload_id === upload?.id)?.name ?? `${asset.kind === 'video' ? 'Video' : 'Photo'} ${assets.indexOf(asset) + 1}`;
      return { id: asset.id, name, kind: asset.kind, status: asset.status, rejectionReason: asset.rejectionReason, area: asset.area,
        sizeBytes: asset.sizeBytes, mime: asset.mime, durationMs: asset.durationMs, width: asset.width, height: asset.height,
        url: asset.status === 'ready' ? assetUrl(asset.id) : null,
        previewUrl: asset.status === 'ready' ? assetUrl(asset.id) : null,
        posterUrl: asset.posterObjectKey && asset.status === 'ready' ? assetUrl(asset.id, 'poster') : null };
    });
  }
  async function detail(id: string) {
    const [a] = await db.select().from(assessments).where(eq(assessments.id, id));
    if (!a) throw new NotFoundError('not found');
    const [prop] = a.propertyId ? await db.select().from(properties).where(eq(properties.id, a.propertyId)) : [];
    const context = await db.select().from(concerns).where(eq(concerns.assessmentId, id));
    const [run] = await db.select().from(assessmentRuns).where(and(eq(assessmentRuns.assessmentId, id), eq(assessmentRuns.stage, 'observe'))).orderBy(desc(assessmentRuns.version)).limit(1);
    const [report] = await db.select().from(reportVersions).where(and(eq(reportVersions.assessmentId, id), inArray(reportVersions.status, ['published', 'validated']))).orderBy(desc(reportVersions.version)).limit(1);
    const link = await linkFor(id);
    const media = await publicMedia(id);
    const uploads = await db.select().from(uploadSessions).where(eq(uploadSessions.assessmentId, id));
    const names = asRows(await db.execute(sql`SELECT n.upload_id,n.name FROM moldlens_screening_upload_names n JOIN upload_sessions u ON u.id=n.upload_id WHERE u.assessment_id=${id}::uuid`));
    return { id: a.id, reference: a.reference, status: a.status, phase: customerPhase(a.status as AssessmentStatus), modality: a.modality,
      createdAt: a.createdAt, updatedAt: a.updatedAt, lastErrorCode: a.lastErrorCode,
      details: prop ? { propertyType: prop.propertyType, region: prop.approximateRegion,
        areas: context.map(c => c.area), concerns: [...new Set(context.flatMap(c => c.issueTypes))],
        statement: context.find(c => c.statement)?.statement ?? '', contact: link?.contact ?? {} } : null,
      media, assets: media, review: !run || run.state === 'superseded' ? 'none' : run.state === 'succeeded' ? 'done' : run.state === 'failed' ? 'failed' : 'running',
      uploads: uploads.map(u => ({ id: u.id, fingerprint: u.clientFingerprint, mime: u.declaredMime, area: u.area,
        name: names.find(n => n.upload_id === u.id)?.name ?? 'Upload', receivedBytes: u.receivedBytes, declaredSize: u.declaredSize,
        status: u.status, expiresAt: u.expiresAt, assetId: u.assetId })),
      reportAvailable: !!report && (report.validation as any)?.passed === true,
      linkedRequestId: link?.request_id ?? null, limits };
  }
  function parseContact(value: any) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Please provide valid contact details.');
    const contact: Record<string, string> = {};
    for (const [key, max] of Object.entries({ name: 100, email: 254, phone: 40, address: 300, postalCode: 8 })) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== 'string' || value[key].length > max || /[\u0000-\u001f]/.test(value[key])) throw new ValidationError('Please provide valid contact details.', key);
      contact[key] = value[key].trim();
    }
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new ValidationError('Enter a valid email address.', 'email');
    if (contact.postalCode) {
      const code = contact.postalCode.toUpperCase().replace(/[ -]/g, '');
      if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(code)) throw new ValidationError('Enter a Canadian postal code.', 'postalCode');
      contact.postalCode = `${code.slice(0, 3)} ${code.slice(3)}`;
    }
    if (contact.phone && (!/^[+\d\s().-]+$/.test(contact.phone) || !/^\d{10,15}$/.test(contact.phone.replace(/\D/g, '')))) throw new ValidationError('Enter a valid phone number.', 'phone');
    return contact;
  }
  async function syncClient(id: string) {
    if (!clientStore) return;
    const current = await detail(id);
    const binding = asRows(await db.execute(sql`SELECT owner_hash,contact,request_id FROM moldlens_screening_links WHERE assessment_id=${id}::uuid`))[0];
    if (!binding || !current.details) return;
    const contact = binding.contact ?? {};
    const attachments = current.media.filter(m => m.status === 'ready').map(m => ({ id: m.id, name: m.name, type: m.kind === 'video' ? 'video/mp4' : 'image/jpeg', size: m.sizeBytes, url: m.previewUrl }));
    const screening = { id, reference: current.reference, status: current.status, reportAvailable: current.reportAvailable };
    if (binding.request_id) {
      const existing = await clientStore.get(binding.request_id);
      if (JSON.stringify(existing.screening) !== JSON.stringify(screening) || JSON.stringify(existing.attachments) !== JSON.stringify(attachments)) {
        await clientStore.update(binding.request_id, { screening, attachments });
      }
      return;
    }
    // Deterministic ID makes reconciliation safe if the process exits between the
    // client-store write and the link write. No synthetic contact data is invented.
    const requestId = `ML-S-${id.toUpperCase()}`;
    let record;
    try { record = await clientStore.get(requestId); } catch {}
    if (!record) {
      const now = new Date().toISOString();
      record = await clientStore.create({ id: requestId, name: contact.name || 'Screening customer', email: contact.email || '', phone: contact.phone || '',
        address: contact.address || '', postalCode: contact.postalCode || '', propertyType: current.details.propertyType,
        area: current.details.areas.join(', '), size: 'Not sure', duration: 'Not sure', description: current.details.statement || current.details.concerns.map(c => CONCERNS.find(x => x.id === c)?.label ?? c).join(', '),
        signs: current.details.concerns, contactPreference: 'Email', consent: true, relationship: 'Not specified',
        status: 'In review', priority: 'Medium', assignee: '', scheduledAt: '', createdAt: now, updatedAt: now,
        attachments, notes: [], isDemo: false, customerOwnerHash: binding.owner_hash, screening });
    }
    await db.execute(sql`UPDATE moldlens_screening_links SET request_id=${record.id} WHERE assessment_id=${id}::uuid`);
  }
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  const attempts = new Map<string, { n: number; until: number }>();
  function intakeLimit(req: any, res: any, next: any) {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
    const key = req.socket.remoteAddress ?? 'local';
    const entry = attempts.get(key) ?? { n: 0, until: now + 3600_000 };
    if (++entry.n > 20) { res.setHeader('Retry-After', String(Math.ceil((entry.until - now) / 1000))); return res.status(429).json({ error: 'Too many screenings started. Please try again later.' }); }
    attempts.set(key, entry); next();
  }
  router.get('/screening-config', (_req, res) => {
    const ai = aiStatus();
    res.json({ limits, ai: { provider: ai.provider, configured: ai.configured, isDemo: ai.provider === 'mock' }, areas: AREAS, concerns: CONCERNS, propertyTypes: PROPERTY_TYPES, regions: REGIONS });
  });
  router.get('/screenings', wrap(async (req: any, res: any) => {
    const p = await principal(req, req.query.admin === 'true');
    if (req.query.admin === 'true' && p.kind !== 'staff') return res.status(401).json({ error: 'Please sign in to access screening cases.' });
    const items = p.kind === 'anonymous' ? [] : await db.select().from(assessments).where(p.kind === 'staff' ? eq(assessments.orgId, org!.id) : eq(assessments.customerId, p.customerId)).orderBy(desc(assessments.createdAt));
    res.json(await Promise.all(items.map(item => detail(item.id))));
  }));
  router.post('/screenings', intakeLimit, wrap(async (req: any, res: any) => {
    const identity = auth.customerIdentity(req);
    const result = await serial(`owner:${identity.hash}`, async () => {
      const [binding] = asRows(await db.execute(sql`SELECT customer_id FROM moldlens_screening_owners WHERE owner_hash=${identity.hash}`));
      const p: Principal = binding ? { kind: 'customer', orgId: org!.id, customerId: binding.customer_id, emailVerified: false } : { kind: 'anonymous' };
      const created = await db.transaction(async tx => {
        const created = await createDraft(tx as any, p, req.body);
        await tx.execute(sql`INSERT INTO moldlens_screening_owners(owner_hash,customer_id) VALUES(${identity.hash},${created.customerId}::uuid) ON CONFLICT(owner_hash) DO NOTHING`);
        await tx.execute(sql`INSERT INTO moldlens_screening_links(assessment_id,owner_hash) VALUES(${created.assessment.id}::uuid,${identity.hash})`);
        return created;
      });
      return detail(created.assessment.id);
    });
    identity.save(res); res.status(201).json(result);
  }));
  router.get('/screenings/:id', wrap(async (req: any, res: any) => { await permitted(req, req.params.id); res.json(await detail(req.params.id)); }));
  router.patch('/screenings/:id', wrap(async (req: any, res: any) => {
    const p = await principal(req, false);
    const contact = parseContact(req.body?.contact);
    await serial(req.params.id, async () => {
      await db.transaction(async tx => {
        await updateDraftDetails(tx as any, p, req.params.id, req.body);
        if (contact) await tx.execute(sql`UPDATE moldlens_screening_links SET contact=${JSON.stringify(contact)}::jsonb WHERE assessment_id=${req.params.id}::uuid`);
      });
    });
    res.json(await detail(req.params.id));
  }));
  router.post('/screenings/:id/uploads', wrap(async (req: any, res: any) => {
    const p = await principal(req, false);
    const upload = await serial(req.params.id, async () => {
      const upload = await createUploadSession(db, p, cfg, req.params.id, req.body);
      const name = safeName(req.body?.name, req.body?.mime?.startsWith('video/') ? 'Video' : 'Photo');
      await db.execute(sql`INSERT INTO moldlens_screening_upload_names(upload_id,name) VALUES(${upload.id}::uuid,${name}) ON CONFLICT(upload_id) DO NOTHING`);
      return upload;
    });
    res.status(201).json({ id: upload.id, receivedBytes: upload.receivedBytes, declaredSize: upload.declaredSize, status: upload.status, expiresAt: upload.expiresAt, assetId: upload.assetId });
  }));
  async function uploadFor(req: any) {
    if (!uuid(req.params.id)) throw new NotFoundError('not found');
    const [upload] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, req.params.id));
    if (!upload) throw new NotFoundError('not found');
    const { p } = await permitted(req, upload.assessmentId, 'assessment.upload_media', false);
    return { upload, p };
  }
  router.get('/screening-uploads/:id', wrap(async (req: any, res: any) => {
    const { upload } = await uploadFor(req);
    res.json({ id: upload.id, receivedBytes: upload.receivedBytes, declaredSize: upload.declaredSize, status: upload.status, expiresAt: upload.expiresAt, assetId: upload.assetId });
  }));
  router.put('/screening-uploads/:id', express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK_BYTES }), wrap(async (req: any, res: any) => {
    const { upload, p } = await uploadFor(req);
    const offset = Number(req.query.offset);
    if (!/^\d+$/.test(String(req.query.offset ?? '')) || !Number.isSafeInteger(offset) || !Buffer.isBuffer(req.body)) throw new ValidationError('Provide a valid offset and binary upload chunk.');
    const result = await serial(upload.assessmentId, () => appendUploadChunk(db, objectStore, p, upload.id, offset, req.body));
    res.status(result.conflict ? 409 : 200).json(result);
  }));
  router.post('/screening-uploads/:id/complete', wrap(async (req: any, res: any) => {
    const { upload, p } = await uploadFor(req);
    res.json(await serial(upload.assessmentId, () => completeUpload(db, objectStore, p, upload.id)));
  }));
  router.delete('/screening-uploads/:id', wrap(async (req: any, res: any) => {
    const { upload } = await uploadFor(req);
    await serial(upload.assessmentId, async () => {
      await permitted(req, upload.assessmentId, 'assessment.edit_draft', false);
      const [current] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, upload.id));
      if (current?.status === 'completed') throw new ValidationError('Remove the completed media item instead.');
      await db.update(uploadSessions).set({ status: 'aborted', updatedAt: new Date() }).where(eq(uploadSessions.id, upload.id));
      await objectStore.delete(upload.objectKey);
    });
    res.json({ ok: true });
  }));
  router.delete('/screening-assets/:id', wrap(async (req: any, res: any) => {
    if (!uuid(req.params.id)) throw new NotFoundError('not found');
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, req.params.id));
    if (!asset) throw new NotFoundError('not found');
    await serial(asset.assessmentId, async () => {
      await removeMediaAsset(db, objectStore, await principal(req, false), asset.id);
      await db.update(uploadSessions).set({ status: 'aborted', assetId: null, updatedAt: new Date() }).where(eq(uploadSessions.assetId, asset.id));
    });
    res.json({ ok: true });
  }));
  router.post('/screenings/:id/submit', wrap(async (req: any, res: any) => {
    await serial(req.params.id, async () => {
      const { a, p } = await permitted(req, req.params.id, 'assessment.read', false);
      if (!['draft', 'uploading'].includes(a.status)) { await syncClient(a.id); return; }
      const pending = await db.select().from(uploadSessions).where(and(eq(uploadSessions.assessmentId, a.id), eq(uploadSessions.status, 'open')));
      if (pending.length) throw new ValidationError('Finish or remove your uploads before submitting.');
      const failed = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(eq(mediaAssets.assessmentId, a.id), eq(mediaAssets.status, 'failed')));
      if (failed.length) throw new ValidationError('Remove files that could not be processed before submitting.');
      await db.transaction(tx => submitAssessment(tx as any, p, a.id));
      await syncClient(a.id);
    });
    res.json(await detail(req.params.id));
  }));
  router.get('/screenings/:id/questions', wrap(async (req: any, res: any) => res.json(await getOpenQuestions(db, await principal(req), req.params.id))));
  router.post('/screenings/:id/answers', wrap(async (req: any, res: any) => {
    const p = await principal(req, false);
    res.json(await serial(req.params.id, () => db.transaction(tx => submitAnswers(tx as any, p, req.params.id, req.body))));
  }));
  router.get('/screenings/:id/report', wrap(async (req: any, res: any) => {
    await permitted(req, req.params.id, 'assessment.read_preview');
    const [report] = await db.select().from(reportVersions).where(and(eq(reportVersions.assessmentId, req.params.id), inArray(reportVersions.status, ['published', 'validated']))).orderBy(desc(reportVersions.version)).limit(1);
    if (!report || !(report.validation as any)?.passed) return res.status(409).json({ error: 'Your screening report is not ready yet.' });
    const frames = await db.select().from(mediaFrames).where(eq(mediaFrames.assessmentId, req.params.id));
    const content: any = report.content;
    const referenced = new Set((content.evidenceGallery ?? []).map((e: any) => e.frameId));
    for (const highlight of content.highlights ?? []) if (highlight.frameId) referenced.add(highlight.frameId);
    res.json({ report: content, media: await publicMedia(req.params.id), frames: frames.filter(f => referenced.has(f.id) && !f.qualityFlags.includes('privacy_review')).map(f => ({ id: f.id, url: frameUrl(f.id), assetId: f.assetId, timestampMs: f.timestampMs })), validation: { passed: true }, isDemo: content.provenance?.isMock === true });
  }));
  async function sendMedia(req: any, res: any, key: string, mime: string) {
    const filename = await objectStore.localPath(key);
    res.type(mime);
    await new Promise<void>((resolve, reject) => res.sendFile(filename, { dotfiles: 'deny', cacheControl: false, lastModified: false }, (error: any) => error ? reject(error) : resolve()));
  }
  router.get('/screening-media/assets/:id/:variant', wrap(async (req: any, res: any) => {
    if (!uuid(req.params.id)) throw new NotFoundError('not found');
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, req.params.id));
    if (!asset || asset.status !== 'ready') throw new NotFoundError('not found');
    await permitted(req, asset.assessmentId, 'media.read');
    const key = req.params.variant === 'poster' ? asset.posterObjectKey : req.params.variant === 'preview' ? asset.proxyObjectKey ?? asset.posterObjectKey : null;
    if (!key) throw new NotFoundError('not found');
    await sendMedia(req, res, key, req.params.variant === 'preview' && asset.kind === 'video' ? 'video/mp4' : 'image/jpeg');
  }));
  router.get('/screening-media/frames/:id', wrap(async (req: any, res: any) => {
    if (!uuid(req.params.id)) throw new NotFoundError('not found');
    const [frame] = await db.select().from(mediaFrames).where(eq(mediaFrames.id, req.params.id));
    if (!frame) throw new NotFoundError('not found');
    const { p } = await permitted(req, frame.assessmentId, 'media.read');
    if (p.kind !== 'staff' && frame.qualityFlags.includes('privacy_review')) throw new NotFoundError('not found');
    await sendMedia(req, res, frame.objectKey, 'image/jpeg');
  }));
  router.post('/screenings/:id/retry', wrap(async (req: any, res: any) => {
    if (!auth.userForRequest(req)) return res.status(401).json({ error: 'Please sign in to retry a screening.' });
    await serial(req.params.id, async () => {
      const { a, p } = await permitted(req, req.params.id, 'assessment.override');
      if (a.status !== 'failed') throw new ValidationError('Only a failed screening can be retried.');
      await db.transaction(async tx => {
        await transitionAssessment(tx as any, a.id, 'failed', 'queued', { lastErrorCode: null });
        const failedAssets = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.assessmentId, a.id), eq(mediaAssets.status, 'failed')));
        for (const asset of failedAssets) {
          await tx.update(mediaAssets).set({ status: 'quarantined' }).where(eq(mediaAssets.id, asset.id));
          await tx.insert(jobs).values({ orgId: org!.id, type: JOB_TYPES.mediaProcess, payload: { assetId: asset.id }, idempotencyKey: `retry-media:${asset.id}:${randomUUID()}` });
        }
        await tx.insert(jobs).values({ orgId: org!.id, type: JOB_TYPES.observe, payload: { assessmentId: a.id }, idempotencyKey: `retry-observe:${a.id}:${randomUUID()}` });
        await audit(tx as any, { orgId: org!.id, actorType: 'staff', actorId: p.kind === 'staff' ? p.userId : null,
          action: 'assessment.retried', resourceType: 'assessment', resourceId: a.id, metadata: { failedMedia: failedAssets.length } });
      });
    });
    res.json(await detail(req.params.id));
  }));
  router.use((error: any, _req: any, res: any, next: any) => {
    if (res.headersSent) return next(error);
    if (error instanceof ForbiddenError || error instanceof NotFoundError) return res.status(404).json({ error: 'This screening could not be found.' });
    if (error instanceof ValidationError) return res.status(400).json({ error: error.message, field: error.field });
    if (error instanceof ConcurrencyConflict) return res.status(409).json({ error: 'This screening changed. Refresh and try again.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Upload chunks must be 8 MB or smaller.' });
    if (error.statusCode === 416) return res.status(416).end();
    next(error);
  });
  app.use('/api', router);
  let stopped = true;
  let closing: Promise<void> | null = null;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRecovery = 0;
  async function runJobs(maxJobs = 25, stopWhenRequested = false) {
    let count = 0;
    while (count < maxJobs && (!stopWhenRequested || !stopped) && await runOnce(deps as any, `moldlens-${process.pid}`)) count++;
    const linked = asRows(await db.execute(sql`SELECT assessment_id FROM moldlens_screening_links WHERE request_id IS NOT NULL`));
    for (const row of linked) await syncClient(row.assessment_id);
    return count;
  }
  async function tick() {
    if (stopped) return;
    active = (async () => {
      if (Date.now() - lastRecovery > 60_000) { await recoverStaleJobs(db, 20 * 60_000); lastRecovery = Date.now(); }
      await runJobs(10, true);
    })().catch(error => console.error('Screening worker could not complete a job:', error.name || 'Error'));
    await active;
    active = null;
    if (!stopped) { timer = setTimeout(tick, 1000); timer.unref?.(); }
  }
  return { db, handle, objectStore, config: cfg, runJobs,
    start() { if (!stopped || closing) return; stopped = false; void tick(); },
    stop() {
      if (closing) return closing;
      stopped = true;
      if (timer) clearTimeout(timer);
      return closing = (async () => { await active; await Promise.allSettled([...locks.values()]); await handle.close(); })();
    },
  };
}
