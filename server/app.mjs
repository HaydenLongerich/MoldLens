import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { receiveUploads } from './uploads.mjs';
import { HttpError, validateIntake, validateNote, validateUpdates } from './validation.mjs';
import { contractors } from './contractors.mjs';
import { createAuth, customerRecord, staffRecord } from './auth.mjs';
import { registerMarketplace } from './marketplace.mjs';

export const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asyncRoute = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);

export async function createApp({ dataDirectory = process.env.MOLDLENS_DATA_DIR || path.join(projectDirectory, 'data'), seeds, authOptions, screeningOptions = false, marketplaceOptions = {} } = {}) {
  dataDirectory = path.resolve(dataDirectory);
  if (seeds === undefined) {
    const { loadSeeds } = await import('./seed.mjs');
    seeds = await loadSeeds();
  }
  const store = await createStore(dataDirectory, seeds);
  const auth = await createAuth(dataDirectory, authOptions);
  const uploadDirectory = path.join(dataDirectory, 'uploads');
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    let host;
    try { host = new URL(`http://${request.headers.host}`).hostname; }
    catch { return next(new HttpError(400, 'Invalid request host.')); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return next(new HttpError(403, 'This prototype is available on the local computer only.'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const expectedOrigin = `${request.protocol}://${request.get('host')}`;
      if ((request.headers.origin && request.headers.origin !== expectedOrigin) || request.headers['sec-fetch-site'] === 'cross-site') return next(new HttpError(403, 'Cross-origin changes are not allowed.'));
    }
    next();
  });
  // Vite serves source files in development. Keep the backing stores and server
  // files private regardless of URL encoding, ?raw imports, or /@fs aliases.
  app.use((request, _response, next) => {
    let pathname;
    try {
      pathname = request.path;
      for (let i = 0; i < 4 && pathname.includes('%'); i++) pathname = decodeURIComponent(pathname);
      if (pathname.includes('%') || pathname.includes('\0')) throw new Error('Invalid encoding.');
      pathname = path.posix.normalize(pathname.replaceAll('\\', '/'));
    }
    catch { return next(new HttpError(400, 'Invalid request path.')); }
    const segments = pathname.toLowerCase().split('/');
    if (pathname.startsWith('/@fs') && !pathname.startsWith('/@fs/')) return next(new HttpError(404, 'This file could not be found.'));
    const privateName = segments.some((part) => ['data', 'server', 'tests', '.git', '.aws', '.codex', '.agents'].includes(part) || part === '.env' || part.startsWith('.env.') || part.startsWith('staff-accounts.json') || part === 'staff-setup-code');
    const filePath = pathname.startsWith('/@fs/') ? path.resolve(pathname.slice('/@fs'.length)) : path.resolve(projectDirectory, `.${pathname}`);
    const privateData = filePath.toLowerCase() === dataDirectory.toLowerCase() || filePath.toLowerCase().startsWith(`${dataDirectory.toLowerCase()}${path.sep}`);
    const fsOutsideClient = pathname.startsWith('/@fs/') && !['src', 'public', 'node_modules'].some((directory) => filePath.startsWith(`${path.join(projectDirectory, directory)}${path.sep}`));
    if (privateName || privateData || fsOutsideClient) return next(new HttpError(404, 'This file could not be found.'));
    next();
  });
  app.use('/api', (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '24kb' }));
  app.use('/uploads', (_request, response, next) => { response.setHeader('Cache-Control', 'private, no-store'); next(); });
  app.get('/uploads/:filename', asyncRoute(async (request, response) => {
    const filename = request.params.filename;
    if (!/^[a-f0-9-]{36}\.(?:jpg|png|webp|heic|heif|mp4|mov|webm)$/.test(filename)) throw new HttpError(404, 'This file could not be found.');
    const record = (await store.all()).find((item) => item.attachments?.some((attachment) => attachment.url === `/uploads/${filename}`));
    if (!record || (!auth.userForRequest(request) && !auth.owns(request, record))) throw new HttpError(404, 'This file could not be found.');
    await new Promise((resolve, reject) => response.sendFile(filename, {
      root: uploadDirectory, dotfiles: 'deny', cacheControl: false, lastModified: false,
    }, (error) => error ? reject(new HttpError(error.statusCode === 416 ? 416 : 404, 'This file could not be read.')) : resolve()));
  }));
  app.use('/uploads', (_request, _response, next) => next(new HttpError(404, 'This file could not be found.')));
  app.get('/api/health', (_request, response) => response.json({ status: 'ok', mode: 'local-demo' }));
  app.get('/api/auth/session', asyncRoute(async (request, response) => response.json(await auth.state(request))));
  app.post('/api/auth/setup', asyncRoute(async (request, response) => response.status(201).json(await auth.setup(request, response))));
  app.post('/api/auth/login', asyncRoute(async (request, response) => response.json(await auth.login(request, response))));
  app.post('/api/auth/logout', (request, response) => response.json(auth.logout(request, response)));
  app.get('/api/contractors', (_request, response) => response.json(contractors));
  app.get('/api/my-requests', asyncRoute(async (request, response) => response.json((await store.all()).filter((record) => auth.owns(request, record)).map(customerRecord))));
  app.get('/api/requests', auth.requireStaff, asyncRoute(async (_request, response) => response.json((await store.all()).map(staffRecord))));
  app.get('/api/requests/:id', asyncRoute(async (request, response) => {
    const record = await store.get(request.params.id);
    if (auth.userForRequest(request)) return response.json(staffRecord(record));
    if (!auth.owns(request, record)) throw new HttpError(404, 'This inspection request could not be found.');
    response.json(customerRecord(record));
  }));
  app.post('/api/requests', asyncRoute(async (request, response) => {
    const upload = await receiveUploads(request, uploadDirectory);
    try {
      const intake = validateIntake(upload.data);
      const owner = auth.customerIdentity(request);
      const now = new Date().toISOString();
      const record = await store.create({
        ...intake,
        id: `ML-${randomUUID().slice(0, 8).toUpperCase()}`,
        status: 'New', priority: 'Medium', createdAt: now, updatedAt: now,
        assignee: '', scheduledAt: '', attachments: upload.attachments, notes: [], isDemo: false,
        customerOwnerHash: owner.hash,
      });
      owner.save(response);
      response.status(201).json(customerRecord(record));
    } catch (error) { await upload.cleanup(); throw error; }
  }));
  app.patch('/api/requests/:id', auth.requireStaff, asyncRoute(async (request, response) => {
    const updates = validateUpdates(request.body);
    response.json(staffRecord(await store.update(request.params.id, updates)));
  }));
  app.post('/api/requests/:id/notes', auth.requireStaff, asyncRoute(async (request, response) => {
    response.status(201).json(staffRecord(await store.addNote(request.params.id, validateNote(request.body))));
  }));
  let screening;
  const marketplace = await registerMarketplace(app, { dataDirectory, auth, ...marketplaceOptions, ownsScreening: (req, id) => screening?.ownsCustomerScreening(req, id) || false });
  if (screeningOptions !== false) {
    const { registerScreeningRoutes } = await import('./screening/runtime.mjs');
    screening = await registerScreeningRoutes(app, { auth, store, dataDirectory, ...screeningOptions, onScreeningUpdate: marketplace.syncScreening });
  }
  app.use('/api', (_request, _response, next) => next(new HttpError(404, 'This API endpoint could not be found.')));
  app.use((error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof HttpError) {
      if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
      return response.status(error.status).json({ error: error.message });
    }
    if (error.type === 'entity.too.large') return response.status(413).json({ error: 'The request is too large.' });
    if (error instanceof SyntaxError && error.status === 400) return response.status(400).json({ error: 'Please provide valid JSON.' });
    console.error('Request could not be completed:', error.code || error.name || 'UnknownError');
    response.status(500).json({ error: 'We could not save your changes. Please try again.' });
  });
  return { app, store, auth, screening, marketplace };
}
