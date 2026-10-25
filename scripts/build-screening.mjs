import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = path.join(root, 'server/screening/vendor');
await build({
  absWorkingDir: root,
  entryPoints: ['server/screening/index.ts'],
  outfile: 'server/screening/runtime.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  plugins: [{
    name: 'screening-packages',
    setup(builder) {
      builder.onResolve({ filter: /^@mb\// }, ({ path: specifier }) => {
        const [, name, subpath = 'index'] = specifier.split('/');
        return { path: path.join(vendor, name, 'src', `${subpath}.ts`) };
      });
    },
  }],
});
console.log('Screening backend built.');
