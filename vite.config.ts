import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { experimentalAiGateway } from './server/aiGateway';
import { automaticModelCatalogue } from './server/modelCatalogue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    publicDir: false,
    plugins: [{ name: 'safe-public-assets', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let relative: string;
        try { relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname); } catch { next(); return; }
        if (!/\.(png|jpe?g|webp|svg|ttf|woff2?|txt)$/i.test(relative) || relative.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) { next(); return; }
        const filename = path.join(process.cwd(), 'public', relative);
        void stat(filename).then(info => {
          if (!info.isFile()) { next(); return; }
          const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain' };
          response.setHeader('Content-Type', types[path.extname(filename).toLowerCase()] ?? 'application/octet-stream');
          const stream = createReadStream(filename); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
        }).catch(next);
      });
    }, async closeBundle() {
      const root = process.cwd(); await mkdir(path.join(root, 'dist'), { recursive: true });
      await cp(path.join(root, 'public'), path.join(root, 'dist'), { recursive: true,
        filter: source => { const relative = path.relative(path.join(root, 'public'), source).split(path.sep).join('/');
          return !/\.(glb|gltf|blend|fbx|obj|stl|step|stp)$/i.test(relative) && !/^(models|optimized-models)(\/|$)/.test(relative) && !/^internal\/architecture(\/|$)/.test(relative); } }).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } }, react(), automaticModelCatalogue(), experimentalAiGateway(env.OLLAMA_ALLOWED_ENDPOINTS)],
    server: { host: 'localhost', port: 5173, strictPort: true },
    preview: { host: 'localhost', port: 4173, strictPort: true }
  };
});
