import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractors } from '../server/contractors.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'dist');
let html = await readFile(path.join(directory, 'index.html'), 'utf8');
const entry = html.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/);
if (!entry) throw new Error('Build the app before creating the standalone preview.');
const javascript = await readFile(path.join(directory, entry[1].replace(/^\//, '')), 'utf8');
// The standalone file is a customer preview; staff cases stay on the authenticated server.
const seeds = JSON.stringify({ requests: [], contractors }).replaceAll('<', '\\u003c');
html = html.replace(entry[0], () => `<script>window.__MOLDLENS_DEMO__=${seeds};</script><script type="module">${javascript.replaceAll('</script', '<\\/script')}</script>`);
const stylesheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)];
for (const match of stylesheets) {
  const href = match[0].match(/href="([^"]+)"/)?.[1];
  if (!href?.startsWith('/assets/')) continue;
  const css = await readFile(path.join(directory, href.slice(1)), 'utf8');
  html = html.replace(match[0], () => `<style>${css}</style>`);
}
html = html.replace('href="/favicon.svg"', 'href="./favicon.svg"');
await writeFile(path.join(directory, 'offline.html'), html);
console.log('Standalone preview written to dist/offline.html (browser data stored in IndexedDB).');
