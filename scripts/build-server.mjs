import { build } from 'esbuild';
await build({ entryPoints: ['server/index.ts'], outfile: 'server-dist/index.mjs', platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external' });
