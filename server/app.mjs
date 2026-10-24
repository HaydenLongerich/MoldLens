import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { receiveUploads } from './uploads.mjs';
import { HttpError, validateIntake, validateNote, validateUpdates } from './validation.mjs';
import { contractors } from './contractors.mjs';

export const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asyncRoute = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);

export async function createApp({ dataDirectory = process.env.MOLDLENS_DATA_DIR || path.join(projectDirectory, 'data'), seeds } = {}) {
  if (seeds === undefined) {
    const { loadSeeds } = await import('./seed.mjs');
    seeds = await loadSeeds();
  }
  const store = await createStore(dataDirectory, seeds);
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
  app.use('/api', (_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '24kb' }));
  app.use('/uploads', express.static(uploadDirectory, { dotfiles: 'deny', index: false, setHeaders: (response) => response.setHeader('Cache-Control', 'private, max-age=3600') }));
  app.get('/api/health', (_request, response) => response.json({ status: 'ok', mode: 'local-demo' }));
  app.get('/api/contractors', (_request, response) => response.json(contractors));
  app.get('/api/requests', asyncRoute(async (_request, response) => response.json(await store.all())));
  app.get('/api/requests/:id', asyncRoute(async (request, response) => response.json(await store.get(request.params.id))));
  app.post('/api/requests', asyncRoute(async (request, response) => {
    const upload = await receiveUploads(request, uploadDirectory);
    try {
      const intake = validateIntake(upload.data);
      const now = new Date().toISOString();
      const record = await store.create({
        ...intake,
        id: `ML-${randomUUID().slice(0, 8).toUpperCase()}`,
        status: 'New', priority: 'Medium', createdAt: now, updatedAt: now,
        assignee: '', scheduledAt: '', attachments: upload.attachments, notes: [], isDemo: false,
      });
      response.status(201).json(record);
    } catch (error) { await upload.cleanup(); throw error; }
  }));
  app.patch('/api/requests/:id', asyncRoute(async (request, response) => {
    const updates = validateUpdates(request.body);
    response.json(await store.update(request.params.id, updates));
  }));
  app.post('/api/requests/:id/notes', asyncRoute(async (request, response) => {
    response.status(201).json(await store.addNote(request.params.id, validateNote(request.body)));
  }));
  app.use('/api', (_request, _response, next) => next(new HttpError(404, 'This API endpoint could not be found.')));
  app.use((error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof HttpError) return response.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return response.status(413).json({ error: 'The request is too large.' });
    if (error instanceof SyntaxError && error.status === 400) return response.status(400).json({ error: 'Please provide valid JSON.' });
    console.error('Request could not be completed:', error.code || error.name || 'UnknownError');
    response.status(500).json({ error: 'We could not save your changes. Please try again.' });
  });
  return { app, store };
}
