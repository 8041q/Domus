import { build } from 'esbuild';
await build({ entryPoints: ['server/index.ts'], outfile: 'server-dist/index.mjs', platform: 'node', target: 'node24', format: 'esm', bundle: true });
await build({ entryPoints: ['server/local.ts'], outfile: 'server-dist/local.mjs', platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external' });
