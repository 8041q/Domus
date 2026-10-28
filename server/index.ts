import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { validateRelease } from '../scripts/release-library.mjs';
import { safePath, modelId } from '../scripts/asset-safety.mjs';
import { experimentalAiGateway } from './aiGateway';
import type { IncomingMessage, ServerResponse } from 'node:http';

// This entry point has no catalogue scanner, optimizer, publisher or master loader.
if (process.env.DOMUS_PUBLIC && process.env.DOMUS_PUBLIC !== '1') throw new Error('Public hosting cannot enable local mode. Use start:local on a private workstation.');
if (process.env.OLLAMA_ALLOWED_ENDPOINTS) throw new Error('Public hosting cannot configure local provider endpoints.');
process.env.DOMUS_PUBLIC = '1';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) if (!['--host', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('Public hosting accepts only --host and --port.');
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const origin = new URL(process.env.DOMUS_ORIGIN ?? '');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Configure an HTTPS DOMUS_ORIGIN with no path or credentials.');
const host = option('--host', '127.0.0.1'), port = Number(option('--port', process.env.PORT ?? '5173'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid public port');
const root = process.cwd();
const library = await validateRelease(root);
let ai!: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
const configure = experimentalAiGateway().configureServer as (server: unknown) => void;
configure({ middlewares: { use(handler: typeof ai) { ai = handler; } } });
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain' };
function json(response: ServerResponse, value: unknown) { response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(value)); }
async function asset(request: IncomingMessage, response: ServerResponse, relative: string, type: string, immutable = false) {
  const expected = library.fingerprints.get(relative);
  if (!expected) { response.writeHead(404).end(); return; }
  const handle = await open(await safePath(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  let streaming = false;
  try {
    const info = await handle.stat();
    if (!info.isFile() || [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') !== expected) throw new Error('Release asset changed after validation');
    response.setHeader('Content-Type', type); response.setHeader('Content-Length', info.size);
    response.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = handle.createReadStream(); streaming = true;
    stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
  } finally { if (!streaming) await handle.close(); }
}
async function serve(request: IncomingMessage, response: ServerResponse) {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(404).end(); return; }
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { response.writeHead(400).end(); return; }
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) { response.writeHead(404).end(); return; }
  if (pathname === '/api/health') { json(response, { ready: true }); return; }
  if (pathname === '/api/model-catalogue') { json(response, library.catalogue); return; }
  const match = /^\/api\/published-models\/(model-[a-f0-9-]{36}--[a-f0-9]{64})\.(json|glb)$/.exec(pathname);
  if (match) {
    const record = library.records.get(match[1]); if (!record) { response.writeHead(404).end(); return; }
    if (match[2] === 'json') { json(response, record.product); return; }
    await asset(request, response, `.domus-published/${match[1]}.glb`, 'model/gltf-binary', true); return;
  }
  if (pathname === '/api/model-legacy') {
    const id = url.searchParams.get('id'), hash = url.searchParams.get('hash');
    if (id && /^model-[a-f0-9-]{36}$/.test(id) && hash && /^[a-f0-9]{64}$/.test(hash)) {
      for (const record of library.records.values()) if (record.product.catalogueId === id && record.assetHash === hash) { json(response, record.product); return; }
    }
    response.writeHead(404).end(); return;
  }
  const opening = /^\/internal\/architecture\/openings\/([a-z_]+\.glb)$/.exec(pathname), revision = url.searchParams.get('v');
  if (opening && revision && /^[a-f0-9]{64}$/.test(revision)) {
    await asset(request, response, `.domus-published/openings/${revision}-${opening[1]}`, 'model/gltf-binary', true); return;
  }
  if (pathname.startsWith('/api/') || pathname.startsWith('/internal/') || pathname.startsWith('/models/') || pathname.startsWith('/optimized-models/') || /\.(glb|gltf|blend\d*|fbx|obj|stl|step|stp)$/i.test(pathname)) { response.writeHead(404).end(); return; }
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  await asset(request, response, `dist/${file}`, types[path.extname(file)] ?? 'application/octet-stream', pathname.startsWith('/assets/'));
}
const server = createServer((request, response) => {
  if (request.headers.host !== origin.host) { response.writeHead(403).end('Unrecognized host'); return; }
  response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  ai(request, response, () => { void serve(request, response).catch(() => { if (!response.headersSent) response.writeHead(404).end('Asset unavailable'); else response.destroy(); }); });
});
server.requestTimeout = 30_000; server.headersTimeout = 15_000;
server.once('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, host, () => console.log('Domus public release is ready'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); const timer = setTimeout(() => server.closeAllConnections(), 5000); timer.unref(); });
