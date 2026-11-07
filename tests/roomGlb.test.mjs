import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTestServer } from './helpers/vite.mjs';
import { modelBytes } from './helpers/model.mjs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { embedRoomDocumentGLB, readRoomGLB } = await vite.ssrLoadModule('/src/core/roomGlb.ts');
const { emptyRoomSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const room = () => ({ format: 'domus-room', version: 3, namespace: 'domus', name: 'Portable room', snapshot: emptyRoomSnapshot(), products: [] });

test('a standard GLB carries editable reference data without altering its geometry bytes', async () => {
  const original = Buffer.from(modelBytes()), document = room();
  document.snapshot.objects.push({ id: 'chair-a', productId: 'chair', x: 1, z: 2, rotationY: 1 });
  document.snapshot.room.projectDetails = { company: 'Example', clientContacts: [{ name: 'Jane Smith', phone: '+351 210 000 000', email: 'jane@example.test' }] };
  const binary = embedRoomDocumentGLB(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength), document);
  const result = Buffer.from(binary);
  assert.equal(result.subarray(0, 4).toString(), 'glTF');
  assert.equal(result.readUInt32LE(8), result.length);
  assert.deepEqual(result.subarray(20 + result.readUInt32LE(12)), original.subarray(20 + original.readUInt32LE(12)));
  const imported = await readRoomGLB(new Blob([binary]));
  assert.equal(imported.name, document.name); assert.deepEqual(imported.snapshot.objects, document.snapshot.objects);
  assert.equal(imported.snapshot.room.projectDetails.company, 'Example');
  assert.deepEqual(imported.snapshot.room.projectDetails.clientContacts, document.snapshot.room.projectDetails.clientContacts);
  const rendered = await new GLTFLoader().parseAsync(binary, '');
  let meshes = 0; rendered.scene.traverse(node => { if (node.isMesh) meshes++; });
  assert.equal(meshes, 1, 'A standard GLB loader can still read the unchanged geometry');
});
test('plain GLBs, truncated data, impossible chunks and embedded-model room documents are rejected', async () => {
  const original = modelBytes();
  await assert.rejects(readRoomGLB(new Blob([original])), /no editable room data/);
  const binary = embedRoomDocumentGLB(original.buffer, room());
  await assert.rejects(readRoomGLB(new Blob([binary.slice(0, -4)])), /invalid|incomplete/);
  const damaged = binary.slice(0); const view = new DataView(damaged);
  view.setUint32(20 + view.getUint32(12, true), 0xfffffffc, true);
  await assert.rejects(readRoomGLB(new Blob([damaged])), /incomplete/);
  assert.throws(() => embedRoomDocumentGLB(original.buffer, { ...room(), version: 2 }), /reference-only/);
});

test('room import ignores geometry URLs and never fetches resources from the imported GLB', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const original = modelBytes({ imageUri: 'https://untrusted.invalid/private-model.glb' });
  const binary = embedRoomDocumentGLB(original.buffer, room());
  assert.equal((await readRoomGLB(new Blob([binary]))).name, 'Portable room');
  assert.equal(fetch.mock.callCount(), 0);
});
