import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { modelBytes } from '../tests/helpers/model.mjs';
import { prepareRelease } from './release-library.mjs';
import { optimizeModels } from './optimize-models.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'domus-browser-'));
const marker = path.join(os.tmpdir(), 'domus-browser-5199.json');
await cp('dist', path.join(root, 'dist'), { recursive: true });
await mkdir(path.join(root, 'public', 'models'), { recursive: true });
await writeFile(path.join(root, 'public', 'models', 'fixture-bed.glb'), modelBytes({ dense: true }));
const compact = await optimizeModels(root);
if (compact.models['fixture-bed.glb'].after.triangles < 1000) throw new Error('The browser fixture must exercise the picking worker.');
await writeFile(marker, JSON.stringify({ root }));
const child = spawn(process.execPath, [path.resolve('server-dist/local.mjs'), '--host', '127.0.0.1', '--port', '5199'], { cwd: root, stdio: 'inherit' });
const publicRoot = root + '-public';
let publicChild;
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; child.kill('SIGTERM'); publicChild?.kill('SIGTERM'); } };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
void (async () => {
  while (!stopping) {
    try { if ((await fetch('http://127.0.0.1:5199/api/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (stopping) return;
  await prepareRelease(root, publicRoot, path.resolve('server-dist/index.mjs'));
  await writeFile(marker, JSON.stringify({ root, publicRoot }));
  if (stopping) return;
  publicChild = spawn(process.execPath, ['server.mjs', '--port', '5200'], { cwd: publicRoot, stdio: 'inherit', env: { ...process.env, DOMUS_PUBLIC: '1', DOMUS_ORIGIN: 'https://127.0.0.1:5200', OLLAMA_ALLOWED_ENDPOINTS: '' } });
  publicChild.once('exit', code => { if (!stopping) { console.error('Public fixture exited', code); stop(); } });
})().catch(error => { console.error(error); stop(); });
child.once('exit', async code => { publicChild?.kill('SIGTERM'); await rm(root, { recursive: true, force: true }); await rm(publicRoot, { recursive: true, force: true }); await rm(marker, { force: true }); process.exitCode = code ?? 0; });
