import express from 'express';
import path from 'node:path';
import { createApp, projectDirectory } from './app.mjs';

const port = Number(process.env.PORT || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number.');
const { app, auth, store, screening } = await createApp({ screeningOptions: {} });
const setupCode = await auth.getSetupCode();
let vite;
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(projectDirectory, 'dist')));
  app.get('*', (_request, response) => response.sendFile(path.join(projectDirectory, 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  vite = await createServer({
    root: projectDirectory,
    server: {
      middlewareMode: true,
      hmr: { host: '127.0.0.1', port: port + 1 },
      fs: {
        strict: true,
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/server/**', '**/tests/**', '**/data/**', '**/staff-accounts.json*', '**/staff-setup-code', `${path.dirname(store.filename)}/**`],
      },
      watch: { ignored: [`${path.dirname(store.filename)}/**`] },
    },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

const server = app.listen(port, '127.0.0.1', () => {
  screening.start();
  console.log(`\n  MoldLens · local demo\n  http://127.0.0.1:${port}\n`);
  if (setupCode) console.log(`  Create the first staff account at http://127.0.0.1:${port}/#login\n  One-time setup code: ${setupCode}\n`);
});
server.requestTimeout = 120_000;
let stopping;
const shutdown = () => stopping ??= (async () => {
  await new Promise(resolve => server.close(resolve));
  await screening.stop();
  await vite?.close();
})();
server.on('error', (error) => { console.error(`Could not start the local server: ${error.code || 'server error'}`); process.exitCode = 1; void shutdown(); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
