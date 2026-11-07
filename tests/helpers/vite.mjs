import { createServer } from 'vite';

// SSR tests must never scan the user's model folder or rewrite their registry.
export const fixtureProduct = {
  id: 'model-00000000-0000-4000-8000-000000000001', name: 'Fixture hospital bed', category: 'Hospital Bed',
  width: 1.12, depth: 2.48, height: .84, available: true, collision: true, wallAffinity: false,
  collisionFootprint: { width: 1.12, depth: 2.48 }, clearance: { front: 0, back: 0, sides: 0 },
  priceLabel: '', swatch: '#888888', model: { url: '/models/C8c.glb?v=fixture' }
};

export function createTestServer(options = {}) {
  if (options.configFile === false) return createServer(options);
  return createServer({ ...options, configFile: false, plugins: [...(options.plugins ?? []), {
    name: 'isolated-test-catalogue',
    resolveId(id) { if (id === 'virtual:domus-models') return '\0test-catalogue'; },
    load(id) { if (id === '\0test-catalogue') return `export default ${JSON.stringify({ products: [fixtureProduct], aliases: { hospitalbed: fixtureProduct.id }, issues: [] })}`; }
  }] });
}
