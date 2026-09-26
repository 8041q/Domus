import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { experimentalAiGateway } from './server/aiGateway';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), experimentalAiGateway(env.OLLAMA_ALLOWED_ENDPOINTS)],
    server: { port: 5173 }
  };
});
