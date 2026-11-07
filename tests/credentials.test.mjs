import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createTestServer } from './helpers/vite.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const credentials = await vite.ssrLoadModule('/src/ai/credentials.ts');
test('concurrent provider saves share one device key and only report committed writes', async () => {
  const original = globalThis.indexedDB; globalThis.indexedDB = new IDBFactory();
  try {
    await Promise.all([credentials.saveAiCredential('gemini', 'fixture-gemini-secret'), credentials.saveAiCredential('openai', 'fixture-openai-secret')]);
    assert.equal(await credentials.loadAiCredential('gemini'), 'fixture-gemini-secret');
    assert.equal(await credentials.loadAiCredential('openai'), 'fixture-openai-secret');
    await credentials.removeAiCredential('gemini');
    assert.equal(await credentials.loadAiCredential('gemini'), null);
    assert.equal((await credentials.getAiCredentialMetadata('openai')).lastFour, 'cret');
  } finally { globalThis.indexedDB = original; }
});
