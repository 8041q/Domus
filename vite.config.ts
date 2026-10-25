import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { experimentalAiGateway } from './server/aiGateway';
import { automaticModelCatalogue } from './server/modelCatalogue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), automaticModelCatalogue(), experimentalAiGateway(env.OLLAMA_ALLOWED_ENDPOINTS)],
    server: { host: 'localhost', port: 5173, strictPort: true },
    preview: { host: 'localhost', port: 4173, strictPort: true }
  };
});
