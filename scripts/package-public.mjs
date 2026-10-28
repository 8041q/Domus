import path from 'node:path';
import { prepareRelease } from './release-library.mjs';
const destination = path.resolve(process.argv[2] ?? 'release');
await prepareRelease(process.cwd(), destination, path.resolve('server-dist/index.mjs'));
console.log(`Public deployment prepared at ${destination}. Set DOMUS_ORIGIN and run node server.mjs from that directory.`);
