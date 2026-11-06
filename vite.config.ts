import { cp, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { defineConfig, isFileLoadingAllowed, loadEnv, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { experimentalAiGateway } from './server/aiGateway';
import { automaticModelCatalogue } from './server/modelCatalogue';

const unpublishedDirectories = [
  'og_models', 'private', '.domus-published',
  'public/models', 'public/optimized-models', 'public/internal/architecture'
];
const defaultViteDeny = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'];

function safePublicAssets(): Plugin {
  let buildPaths: { source: string; destination: string } | undefined;
  return {
    name: 'safe-public-assets',
    config({ root = process.cwd() }) {
      // Vite replaces its default deny list when a custom list is supplied.
      const prefix = normalizePath(path.resolve(root)).replace(/[\\*?\[\]{}()!+@]/g, '\\$&');
      return { server: { fs: { deny: [
        ...defaultViteDeny, ...unpublishedDirectories.map(directory => `${prefix}/${directory}/**`)
      ] } } };
    },
    configResolved(config) {
      if (config.command === 'build') buildPaths = {
        source: path.join(config.root, 'public'),
        destination: path.resolve(config.root, config.build.outDir)
      };
    },
    async configureServer(server) {
      const root = server.config.root;
      const realRoot = await realpath(root);
      const isUnpublished = (filename: string) => [root, realRoot].some(directory => {
        const relative = normalizePath(path.relative(directory, filename)).toLowerCase();
        return unpublishedDirectories.some(entry => relative === entry || relative.startsWith(entry + '/'));
      });
      const resolveFile = (filename: string) => realpath(filename).catch(() => null);
      server.middlewares.use((request, response, next) => {
        void (async () => {
          let relative: string;
          try { relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname); } catch { next(); return; }
          const requestedFile = relative.startsWith('/@fs/')
            ? path.resolve(path.parse(root).root, relative.slice('/@fs/'.length))
            : path.join(root, relative);
          const target = await resolveFile(requestedFile);
          if (isUnpublished(requestedFile) || (target && isUnpublished(target))) {
            response.writeHead(403).end(); return;
          }
          if (!/\.(png|jpe?g|webp|svg|ico|webmanifest|ttf|woff2?|txt)$/i.test(relative) || relative.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) { next(); return; }
          const filename = path.join(root, 'public', relative);
          const publicTarget = await resolveFile(filename);
          if (!publicTarget) { next(); return; }
          if (isUnpublished(filename) || publicTarget !== path.join(realRoot, path.relative(root, filename))
            || !isFileLoadingAllowed(server.config, normalizePath(filename))) {
            response.writeHead(403).end(); return;
          }
          const info = await stat(publicTarget);
          if (!info.isFile()) { next(); return; }
          const types: Record<string, string> = { '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain' };
          response.setHeader('Content-Type', types[path.extname(filename).toLowerCase()] ?? 'application/octet-stream');
          const stream = createReadStream(publicTarget); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
        })().catch(next);
      });
    },
    async closeBundle() {
      if (!buildPaths) return;
      const { source, destination } = buildPaths;
      await mkdir(destination, { recursive: true });
      await cp(source, destination, { recursive: true,
        filter: file => { const relative = path.relative(source, file).split(path.sep).join('/');
          return !/\.(glb|gltf|blend|fbx|obj|stl|step|stp)$/i.test(relative) && !/^(models|optimized-models)(\/|$)/.test(relative) && !/^internal\/architecture(\/|$)/.test(relative); } }).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    publicDir: false,
    plugins: [safePublicAssets(), react(), automaticModelCatalogue(), experimentalAiGateway(env.OLLAMA_ALLOWED_ENDPOINTS)],
    server: { host: 'localhost', port: 5173, strictPort: true },
    preview: { host: 'localhost', port: 4173, strictPort: true }
  };
});
