import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { automaticModelCatalogue } from './modelCatalogue';
import { experimentalAiGateway } from './aiGateway';

const args = process.argv.slice(2);
function option(name: string, fallback: string) { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; }
const publicMode = process.env.DOMUS_PUBLIC === '1';
const publicOrigin = publicMode ? new URL(process.env.DOMUS_ORIGIN ?? '') : null;
if (publicOrigin && publicOrigin.protocol !== 'https:') throw new Error('Public hosting requires an HTTPS DOMUS_ORIGIN.');
const host = option('host', 'localhost'), port = Number(option('port', process.env.PORT ?? '5173'));
if (!(publicMode || ['localhost', '127.0.0.1', '::1'].includes(host)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a loopback host and a port between 1 and 65535.');
const root = process.cwd(), dist = path.join(root, 'dist');
await stat(path.join(dist, 'index.html')).catch(() => { throw new Error('Build Domus first with npm run build.'); });
const catalogue = automaticModelCatalogue();
await catalogue.initialize(root);
let ai!: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
const aiPlugin = experimentalAiGateway(process.env.OLLAMA_ALLOWED_ENDPOINTS);
const configure = aiPlugin.configureServer as (server: unknown) => void;
configure({ middlewares: { use(handler: typeof ai) { ai = handler; } } });
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8' };
async function serve(request: IncomingMessage, response: ServerResponse) {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/health') { response.setHeader('Content-Type', 'application/json'); response.end('{"ready":true}'); return; }
  let relative: string;
  try { relative = decodeURIComponent(url.pathname); } catch { response.writeHead(400).end(); return; }
  if (relative.includes('\0') || relative.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) { response.writeHead(404).end(); return; }
  const filename = path.resolve(dist, relative === '/' ? 'index.html' : `.${relative}`);
  if (!filename.startsWith(dist + path.sep)) { response.writeHead(404).end(); return; }
  const info = await stat(filename).catch(() => null);
  if (!info?.isFile()) { response.writeHead(404).end('File unavailable'); return; }
  response.setHeader('Content-Type', types[path.extname(filename)] ?? 'application/octet-stream');
  response.setHeader('Content-Length', info.size);
  response.setHeader('Cache-Control', relative.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(filename); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
}
const server = createServer((request, response) => {
  const authority = request.headers.host;
  if (!(publicOrigin ? authority === publicOrigin.host : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(authority ?? ''))) { response.writeHead(403).end('Unrecognized local host'); return; }
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const fallback = () => { void serve(request, response).catch(error => { console.error('Could not serve local file', error.message); if (!response.headersSent) response.writeHead(500); response.end('Could not complete request'); }); };
  ai(request, response, () => catalogue.middleware(request, response, fallback));
});
server.requestTimeout = 30_000; server.headersTimeout = 15_000;
server.once('error', async error => { console.error(`Could not start Domus: ${error.message}. The port must be free; it will not be changed automatically.`); await catalogue.dispose(); process.exitCode = 1; });
server.listen(port, host, () => console.log(`Domus is ready at http://${host === '::1' ? '[::1]' : host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void catalogue.dispose();
  const force = setTimeout(() => server.closeAllConnections(), 5000); force.unref();
  server.close(() => clearTimeout(force)); server.closeIdleConnections();
});
