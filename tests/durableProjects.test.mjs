import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { zipSync, Zip, ZipPassThrough, strToU8 } from 'fflate';
import { createTestServer } from './helpers/vite.mjs';
import { modelBytes } from './helpers/model.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { BrowserRoomProjects } = await vite.ssrLoadModule('/src/core/browserRoomProjects.ts');
const { ProjectDatabase } = await vite.ssrLoadModule('/src/core/projectDatabase.ts');
const { assetHash } = await vite.ssrLoadModule('/src/core/projectDocument.ts');
const { readRoomArchive, writeRoomArchive } = await vite.ssrLoadModule('/src/core/projectArchive.ts');
const { emptyRoomSnapshot, parseProjectSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { PRODUCTS, setRoomProducts } = await vite.ssrLoadModule('/src/core/products.ts');

async function harness(database = new ProjectDatabase(new IDBFactory()), id = 'tab-a', legacy = new Map()) {
  let snapshot = emptyRoomSnapshot();
  const adapter = { initial: emptyRoomSnapshot, snapshot: () => structuredClone(snapshot), empty: emptyRoomSnapshot,
    decode: parseProjectSnapshot, open: value => { snapshot = structuredClone(value); return true; } };
  const storage = { getItem: key => legacy.get(key) ?? null, setItem: (key, value) => legacy.set(key, value) };
  const service = new BrowserRoomProjects(adapter, database, id, () => storage);
  await service.initialize();
  return { service, database, get: () => snapshot, set: value => { snapshot = value; service.changed(); }, edit: (height = 3) => { snapshot.room.height = height; service.changed(); } };
}
async function portable(name = 'Archived bed') {
  const bytes = modelBytes(), hash = await assetHash(bytes);
  const snapshot = emptyRoomSnapshot();
  const definition = { id: 'model-archived-bed', name: 'Archived bed', category: 'Hospital Bed', width: 1, depth: 2, height: .8,
    available: true, collision: true, clearance: { front: 0, back: 0, sides: 0 }, priceLabel: '', swatch: '#888888', model: { url: `asset:${hash}` } };
  snapshot.objects.push({ id: 'bed-a', productId: definition.id, x: 2, z: 1.5, rotationY: 0 });
  snapshot.unplacedObjects.push({ id: 'bed-b', productId: definition.id });
  return { document: { format: 'domus-room', version: 2, name, snapshot, products: [{ definition, hash, bytes: bytes.length }] }, assets: [{ hash, blob: new Blob([bytes]) }] };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async url => new Response(JSON.stringify(String(url) === '/api/model-catalogue' ? { products: [] } : null), { status: String(url) === '/api/model-catalogue' ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
after(() => { globalThis.fetch = realFetch; });

test('room transfer contains references, never embedded binaries, and preserves missing items', async () => {
  const h = await harness(), prepared = await portable();
  await h.service.importRoom(prepared);
  const saved = await h.service.save('Ward');
  assert.equal(saved.document.version, 3);
  assert.equal(saved.document.products[0].hash, null);
  assert.equal((await h.database.all('assets')).length, 0);
  const blob = await h.service.exportArchive(), document = JSON.parse(await blob.text());
  assert.equal(document.version, 3); assert.equal(document.products[0].definition.model.url, 'published:model-archived-bed');
  const transferred = await harness();
  await transferred.service.importRoom(await transferred.service.readFile(new File([blob], 'Ward.domus')));
  assert.equal(JSON.stringify(transferred.get()), JSON.stringify(prepared.document.snapshot));
  assert.equal(PRODUCTS['model-archived-bed'].available, false);
  setRoomProducts([]);
});

test('opening requires the server and failed opening preserves current work', async () => {
  const h = await harness(); h.edit(3.1); const before = h.get(), fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Offline'); };
  try { await assert.rejects(h.service.importRoom(await portable()), /Offline/); assert.deepEqual(h.get(), before); }
  finally { globalThis.fetch = fetch; setRoomProducts([]); }
});

test('concurrent saves enforce revision and unique names inside the write transaction', async () => {
  const a = await harness(), first = await a.service.save('Room');
  const b = await harness(a.database, 'tab-b'); await b.service.open(first.id);
  a.edit(3); b.edit(3.1);
  const results = await Promise.allSettled([a.service.save(), b.service.save()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /another tab/);
  const c = await harness(a.database, 'tab-c'), d = await harness(a.database, 'tab-d');
  const names = await Promise.allSettled([c.service.save('Duplicate', true), d.service.save('Duplicate', true)]);
  assert.equal(names.filter(result => result.status === 'fulfilled').length, 1);
});

test('transaction failure preserves the last save, active identity, and dirty work', async () => {
  const h = await harness(), saved = await h.service.save('Safe'); h.edit();
  const commit = h.database.commit.bind(h.database);
  h.database.commit = async () => { throw new DOMException('Full', 'QuotaExceededError'); };
  await assert.rejects(h.service.save(), /Full/);
  assert.equal(h.service.getState().activeId, saved.id);
  assert.equal(h.service.getState().dirty, true);
  assert.equal((await h.database.all('rooms'))[0].snapshot.room.height, 2.6);
  h.database.commit = commit;
});

test('normalization key order does not mark a successfully saved room dirty', async () => {
  const h = await harness();
  await h.service.save('Clean'); h.service.changed();
  assert.equal(h.service.getState().dirty, false);
  const reordered = h.get();
  reordered.room = Object.fromEntries(Object.entries(reordered.room).reverse());
  h.set(reordered);
  assert.equal(h.service.getState().dirty, false);
});

test('discarding a stale recovery requires the displayed revision and permits unused assets to be reclaimed', async () => {
  const a = await harness(); await a.service.importRoom(await portable()); await a.service.persistDraft();
  const b = await harness(a.database, 'tab-b');
  const draft = b.service.getState().recoveries[0];
  await assert.rejects(b.service.discardRecovery(draft.id, draft.updatedAt - 1), /changed/);
  await b.service.discardRecovery(draft.id, draft.updatedAt);
  await b.service.cleanUnusedAssets();
  assert.equal((await b.database.all('assets')).length, 0);
  setRoomProducts([]);
});

test('per-tab drafts recover independently and opening another room isolates history and identity', async () => {
  const a = await harness(), b = await harness(a.database, 'tab-b');
  a.edit(3); b.edit(3.1); await Promise.all([a.service.persistDraft(), b.service.persistDraft()]);
  const ar = await harness(a.database, 'tab-a'), br = await harness(a.database, 'tab-b');
  assert.equal(ar.get().room.height, 3); assert.equal(br.get().room.height, 3.1);
  assert.equal(ar.service.getState().recoveries.length, 1);
});

test('a delayed recovery write cannot overwrite the identity of a newer named save', async () => {
  const h = await harness(); await h.service.save('Before'); await h.service.persistDraft(); h.edit();
  const commit = h.database.commit.bind(h.database);
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
  let first = true;
  h.database.commit = async action => { if (first) { first = false; entered(); await gate; } return commit(action); };
  const oldDraft = h.service.persistDraft(); await waiting;
  let finished = false; const saving = h.service.save('After', true).then(record => { finished = true; return record; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false);
  release(); const [saved] = await Promise.all([saving, oldDraft]); await h.service.persistDraft();
  const draft = (await h.database.all('drafts')).find(draft => draft.id === 'tab-a');
  assert.equal(draft.activeId, saved.id); assert.equal(draft.document.name, 'After');
});

test('legacy migration keeps browser keys and retains absent furniture references', async () => {
  const snapshot = emptyRoomSnapshot(); snapshot.objects.push({ id: 'missing', productId: 'model-retired', x: 2, z: 1, rotationY: 0 });
  const raw = JSON.stringify(snapshot), legacy = new Map([['room-planner-project-v4', raw]]);
  const h = await harness(undefined, 'migration', legacy);
  assert.equal(h.service.getState().rooms.length, 1);
  await h.service.open(h.service.getState().rooms[0].id);
  assert.equal(h.get().objects[0].productId, 'model-retired');
  assert.match(h.service.getState().warning, /missing models/);
  assert.equal(legacy.get('room-planner-project-v4'), raw);
  assert.equal(JSON.parse(await (await h.service.exportArchive()).text()).snapshot.objects[0].productId, 'model-retired');
  setRoomProducts([]);
});

test('invalid archives, hashes, external textures and duplicate paths fail before replacing current work', async () => {
  const h = await harness(), before = h.get(), prepared = await portable();
  const files = { 'room.json': strToU8(JSON.stringify(prepared.document)), [`assets/${prepared.assets[0].hash}.glb`]: new Uint8Array([1,2,3]) };
  await assert.rejects(readRoomArchive(new Blob([zipSync(files)])), /damaged/);
  await assert.rejects(readRoomArchive(new Blob([zipSync({ '../room.json': strToU8('{}') })])), /paths/);
  const chunks = [], duplicate = new Zip((error, bytes) => { if (error) throw error; chunks.push(bytes); });
  for (let i = 0; i < 2; i++) { const entry = new ZipPassThrough('room.json'); duplicate.add(entry); entry.push(strToU8('{}'), true); } duplicate.end();
  await assert.rejects(readRoomArchive(new Blob(chunks)), /duplicate paths/);
  const external = modelBytes({ imageUri: 'https://example.test/texture.png' }), externalHash = await assetHash(external);
  const unsafe = structuredClone(prepared.document); unsafe.products[0].hash = externalHash; unsafe.products[0].bytes = external.length;
  await assert.rejects(readRoomArchive(await writeRoomArchive(unsafe, [{ hash: externalHash, blob: new Blob([external]) }])), /embedded/);
  const oversized = zipSync({ 'room.json': strToU8('{}') }, { level: 0 }); new DataView(oversized.buffer).setUint32(22, 1024 ** 3 + 1, true);
  await assert.rejects(readRoomArchive(new Blob([oversized])), /too large/);
  const invalid = structuredClone(prepared.document); invalid.snapshot.room.vertices[0].x = 'bad';
  await assert.rejects(h.service.readFile(new File([await writeRoomArchive(invalid, prepared.assets)], 'bad.domus')), /invalid geometry/);
  assert.deepEqual(h.get(), before);
});

test('opening a published reference uses trusted server metadata and ignores file-supplied URLs', async () => {
  const h = await harness(), prepared = await portable();
  const id = 'model-00000000-0000-4000-8000-000000000001--' + 'a'.repeat(64);
  const canonical = { ...prepared.document.products[0].definition, id, name: 'Published bed', model: { url: `/api/published-models/${id}.glb` } };
  prepared.document.version = 3; prepared.document.namespace = 'domus';
  prepared.document.products = [{ definition: { ...canonical, name: 'Untrusted file name', model: { url: 'https://untrusted.example/model.glb' } }, hash: null, bytes: 0 }];
  for (const item of [...prepared.document.snapshot.objects, ...prepared.document.snapshot.unplacedObjects]) item.productId = id;
  const fetch = globalThis.fetch, requested = [];
  globalThis.fetch = async url => {
    requested.push(url);
    return new Response(JSON.stringify(url === '/api/model-catalogue' ? { products: [] } : canonical), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await h.service.importRoom(prepared);
    assert.deepEqual(requested, ['/api/model-catalogue', `/api/published-models/${id}.json`]);
    assert.equal(PRODUCTS[id].name, 'Published bed');
    const exported = JSON.parse(await (await h.service.exportArchive()).text());
    assert.equal(exported.products[0].definition.model.url, `published:${id}`);
    assert.equal((await h.database.all('assets')).length, 0);
    await h.service.save('Pinned');
    assert.equal(h.service.getState().dirty, false);
  } finally { globalThis.fetch = fetch; setRoomProducts([]); }
});
