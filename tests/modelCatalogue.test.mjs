import { sha256 } from '../scripts/asset-safety.mjs';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rename, unlink, rm, utimes, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { preview } from 'vite';
import { createTestServer as createServer } from './helpers/vite.mjs';
import { MODEL_CACHE_TTL_MS } from '../scripts/model-cache.mjs';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { ModelCatalogue, inspectProductGLB, automaticModelCatalogue } = await vite.ssrLoadModule('/server/modelCatalogue.ts');
const { displayProductDimensions, PRODUCTS, PRODUCT_LIST, initializeProductCatalogue, subscribeProductCatalogue, getProductCatalogueIssues } = await vite.ssrLoadModule('/src/core/products.ts');
const { PRODUCT_CATEGORIES } = await vite.ssrLoadModule('/src/core/productSchema.ts');

function glb(extras = {}, points = [-0.5,0,-1, 0.5,0,-1, 0.5,0.8,1, -0.5,0,-1, 0.5,0.8,1, -0.5,0.8,1], node = {}) {
  const binary = Buffer.alloc(points.length * 4);
  points.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, extras, ...node }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: points.length / 3, type: 'VEC3', min: [0,1,2].map(axis => Math.min(...points.filter((_, index) => index % 3 === axis))), max: [0,1,2].map(axis => Math.max(...points.filter((_, index) => index % 3 === axis))) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }], buffers: [{ byteLength: binary.length }] });
  const jsonBuffer = Buffer.from(json + ' '.repeat((4 - Buffer.byteLength(json) % 4) % 4));
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2,4); header.writeUInt32LE(28 + jsonBuffer.length + binary.length,8);
  header.writeUInt32LE(jsonBuffer.length,12); header.writeUInt32LE(0x4e4f534a,16);
  binHeader.writeUInt32LE(binary.length,0); binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,jsonBuffer,binHeader,binary]);
}
const metadata = { domus_schema_version: 2, domus_name: 'Hospital bed', domus_category: 'Hospital Bed',
  domus_display_width_m: 0.995, domus_display_depth_m: 2.18, domus_display_height_m: 0.4,
  domus_product_id: 'duplicate-in-blender', domus_width_m: 995, domus_collision_width_m: 995 };
async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'domus-catalogue-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const models = path.join(root,'public','models'); await mkdir(models,{recursive:true});
  return { root, models, catalogue: new ModelCatalogue(root) };
}

test('new models, copies and nested folders import automatically with unique persistent UUIDs', async (t) => {
  const {root,models,catalogue} = await sandbox(t);
  await mkdir(path.join(models,'Medical'));
  await writeFile(path.join(models,'Medical','bed.glb'),glb(metadata));
  await writeFile(path.join(models,'copy.glb'),glb(metadata));
  const first = await catalogue.scan();
  assert.equal(first.products.length,2); assert.equal(first.issues.length,0);
  assert.notEqual(first.products[0].id,first.products[1].id);
  for (const p of first.products) {
    assert.match(p.id,/^model-[0-9a-f-]{36}$/); assert.notEqual(p.id,metadata.domus_product_id);
    assert.equal(p.width,1); assert.equal(p.depth,2); assert.ok(Math.abs(p.height-.8)<1e-6);
    assert.equal(p.collisionFootprint.width,1); assert.equal(p.collisionFootprint.depth,2);
    assert.deepEqual(displayProductDimensions(p),{width:.995,depth:2.18,height:.4});
  }
  assert.deepEqual((await new ModelCatalogue(root).scan()).products.map(p=>p.id),first.products.map(p=>p.id));
  assert.match(first.products[0].model.url,/\/models\/Medical\/bed\.glb\?v=/);
});

test('independent catalogue writers serialize their registry updates without ID changes or temporary-file races', async t => {
  const { root, models } = await sandbox(t);
  await writeFile(path.join(models, 'fixture.glb'), glb(metadata));
  const results = await Promise.all(Array.from({ length: 6 }, () => new ModelCatalogue(root).scan()));
  assert.equal(new Set(results.map(result => result.products[0].id)).size, 1);
  const registry = JSON.parse(await readFile(path.join(root, 'model-catalogue.json'), 'utf8'));
  assert.equal(registry.entries.length, 1);
  assert.equal(registry.entries[0].id, results[0].products[0].id);
});

test('runtime derivatives retain source identity and dimensions, and stale or incomplete copies fall back to the source', async (t) => {
  const { root, models, catalogue } = await sandbox(t);
  const source = path.join(models, 'bed.glb');
  await writeFile(source, glb(metadata));
  const original = (await catalogue.scan()).products[0];
  const registry = JSON.parse(await readFile(path.join(root, 'model-catalogue.json'), 'utf8'));
  const fingerprint = registry.entries[0].fingerprint;
  const directory = path.join(root, 'public', 'optimized-models');
  await mkdir(directory);
  const filename = `${fingerprint}-v4.glb`;
  const derivative = glb(metadata, [-.1, 0, -.1, .1, .1, .1]);
  await writeFile(path.join(directory, filename), derivative);
  const manifest = { version: 4, models: { 'bed.glb': { sourceFingerprint: fingerprint,
    url: `/optimized-models/${filename}`, profile: 'public-display-v1', after: { bytes: derivative.length, sha256: sha256(derivative) } } } };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const optimized = (await catalogue.scan()).products[0];
  assert.equal(optimized.id, original.id);
  assert.equal(optimized.width, original.width);
  assert.equal(optimized.depth, original.depth);
  assert.equal(optimized.model.url, original.model.url);
  assert.equal(optimized.model.runtimeUrl, manifest.models['bed.glb'].url);
  const expiredAt = new Date(Date.now() - MODEL_CACHE_TTL_MS - 1000);
  await utimes(path.join(directory, filename), expiredAt, expiredAt);
  assert.equal((await catalogue.scan()).products[0].model.runtimeUrl, undefined);
  assert.equal(catalogue.requiresOptimization, true);
  assert.equal(catalogue.nextCacheExpiry, undefined);
  await writeFile(path.join(directory, filename), derivative.subarray(0, 20));
  assert.equal((await catalogue.scan()).products[0].model.runtimeUrl, undefined);
  await writeFile(path.join(directory, filename), derivative);
  await writeFile(source, glb({ ...metadata, domus_name: 'New export' }));
  assert.equal((await catalogue.scan()).products[0].model.runtimeUrl, undefined);
  await writeFile(path.join(directory, 'manifest.json'), '{broken');
  assert.equal((await catalogue.scan()).products[0].available, true);
});

test('published revisions survive source updates, retirement and processing cache expiry', async t => {
  const { root, models } = await sandbox(t);
  const server = await createServer({ configFile: false, root, plugins: [automaticModelCatalogue()], logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { noDiscovery: true } });
  t.after(() => server.close()); await server.listen(); const origin = server.resolvedUrls.local[0];
  const source = path.join(models, 'published.glb'); await writeFile(source, glb(metadata));
  const rescan = async () => (await (await fetch(origin + 'api/model-catalogue/rescan', { method: 'POST' })).json());
  const first = (await rescan()).products[0]; assert.ok(first);
  assert.equal((await fetch(new URL('/models/published.glb', origin))).status, 404);
  const bytes = await (await fetch(new URL(first.model.url, origin))).arrayBuffer();
  await writeFile(source, glb({ ...metadata, domus_name: 'Revised' }));
  const second = (await rescan()).products[0]; assert.notEqual(first.id, second.id); assert.equal(first.catalogueId, second.catalogueId);
  await unlink(source); assert.equal((await rescan()).products.length, 0);
  const retained = await fetch(new URL(first.model.url, origin)); assert.equal(retained.status, 200);
  assert.deepEqual(await retained.arrayBuffer(), bytes);
  assert.match(retained.headers.get('cache-control'), /immutable/);
});

test('file updates retain identity while renames and deletions retire IDs and remove registry definitions', async (t) => {
  const {root,models,catalogue} = await sandbox(t);
  const file = path.join(models,'bed.glb');
  await writeFile(file,glb(metadata)); const original = (await catalogue.scan()).products[0];
  const initialStamp = (await stat(file)).mtimeMs;
  await writeFile(file,glb({...metadata,domus_name:'Updated bed'}));
  await utimes(file, new Date(initialStamp + 1000), new Date(initialStamp + 1000));
  const updated = (await catalogue.scan()).products[0];
  assert.equal(updated.id,original.id); assert.equal(updated.name,'Updated bed'); assert.notEqual(updated.model.url,original.model.url);
  const renamed = path.join(models,'renamed bed.glb'); await rename(file,renamed);
  const moved = (await catalogue.scan()).products;
  assert.equal(moved.length,1); assert.notEqual(moved[0].id,original.id); assert.match(moved[0].model.url,/renamed%20bed/);
  const renamedId = moved[0].id;
  await unlink(renamed); assert.equal((await catalogue.scan()).products.length,0);
  const registry = JSON.parse(await readFile(path.join(root,'model-catalogue.json'),'utf8'));
  assert.deepEqual(registry.entries,[]);
  assert.deepEqual(new Set(registry.retiredIds),new Set([original.id,renamedId]));
  await writeFile(renamed,glb({...metadata,domus_name:'Updated bed'}));
  const restored = (await new ModelCatalogue(root).scan()).products[0];
  assert.notEqual(restored.id,original.id); assert.notEqual(restored.id,renamedId);
  assert.equal(restored.available,true);
});

test('a partial export or invalid metadata reports an issue without discarding existing product identity', async (t) => {
  const {models,catalogue} = await sandbox(t), file = path.join(models,'bed.glb');
  await writeFile(file,glb(metadata)); const original = (await catalogue.scan()).products[0];
  await writeFile(file,Buffer.from('glTF'));
  let data = await catalogue.scan(); assert.equal(data.issues.length,1); assert.equal(data.products[0].id,original.id); assert.equal(data.products[0].available,false);
  await writeFile(file,glb({...metadata,domus_display_width_m:0}));
  data = await catalogue.scan(); assert.match(data.issues[0].message,/external dimensions/);
  await writeFile(file,glb(metadata)); data = await catalogue.scan();
  assert.equal(data.issues.length,0); assert.equal(data.products[0].id,original.id); assert.equal(data.products[0].available,true);
});

test('geometry measurements use transformed vertices rather than rotated bounding boxes', async (t) => {
  const {models} = await sandbox(t), file = path.join(models,'triangle.glb');
  const half = Math.PI/8;
  await writeFile(file,glb({},[0,0,0, 2,0,0, 0,1,1],{rotation:[0,Math.sin(half),0,Math.cos(half)],translation:[20,5,-10]}));
  const {product} = await inspectProductGLB(file,'/triangle.glb','test');
  assert.ok(Math.abs(product.width-Math.sqrt(2))<1e-6);
  assert.ok(Math.abs(product.depth-3/Math.sqrt(2))<1e-6);
  assert.equal(product.category,'Others');
});

test('corrupt ID registries are rejected instead of silently assigning new IDs to saved products', async (t) => {
  const {root,models,catalogue} = await sandbox(t);
  await writeFile(path.join(models,'bed.glb'),glb(metadata)); await catalogue.scan();
  const registry = JSON.parse(await readFile(path.join(root,'model-catalogue.json'),'utf8'));
  registry.entries.push({...registry.entries[0],file:'other.glb'});
  await writeFile(path.join(root,'model-catalogue.json'),JSON.stringify(registry));
  await assert.rejects(new ModelCatalogue(root).scan(),/registry is invalid/);
});

test('the shared hospital categories have no duplicates and legacy broad categories migrate', async (t) => {
  assert.deepEqual(PRODUCT_CATEGORIES,['Hospital Bed','Homecare Bed','Children Bed','Baby Crib','Spinal Therapy Bed','Examination Table','Operating Table','Gynaecological Table','Bedside Table','Medical Chair','IV Stand','Stretcher','Patient Trolley','Medical trolley','Decoration','Others']);
  assert.equal(new Set(PRODUCT_CATEGORIES).size,PRODUCT_CATEGORIES.length);
  const {models} = await sandbox(t), file = path.join(models,'legacy.glb');
  await writeFile(file,glb({...metadata,domus_category:'Medical'}));
  assert.equal((await inspectProductGLB(file,'/legacy.glb','test')).product.category,'Others');
  await writeFile(file,glb({...metadata,domus_category:'Decor'}));
  assert.equal((await inspectProductGLB(file,'/legacy.glb','test')).product.category,'Decoration');
  for (const category of ['Unrecognised category','constructor','__proto__']) {
    await writeFile(file,glb({...metadata,domus_category:category}));
    await assert.rejects(inspectProductGLB(file,'/legacy.glb','test'),/supported product category/);
  }
  assert.equal(PRODUCT_LIST.filter(p=>p.id===PRODUCTS.hospitalbed.id).length,1);
});

test('deleting the original bed removes its legacy alias and never reassigns it to another C8c file', async (t) => {
  const {root,models,catalogue} = await sandbox(t);
  await writeFile(path.join(models,'C8c.glb'),glb(metadata));
  const original = (await catalogue.scan()).products[0].id;
  const registry = JSON.parse(await readFile(path.join(root,'model-catalogue.json'),'utf8'));
  registry.entries[0].aliases = ['hospitalbed'];
  await writeFile(path.join(root,'model-catalogue.json'),JSON.stringify(registry));
  const migratedCatalogue = new ModelCatalogue(root);
  assert.equal((await migratedCatalogue.scan()).aliases.hospitalbed,original);
  await unlink(path.join(models,'C8c.glb'));
  assert.deepEqual((await migratedCatalogue.scan()).aliases,{});
  await writeFile(path.join(models,'C8c.glb'),glb({...metadata,domus_name:'Different bed'}));
  const data = await migratedCatalogue.scan();
  assert.deepEqual(data.aliases,{}); assert.notEqual(data.products[0].id,original);
  assert.equal(data.products.length,1);
});

test('the development watcher broadcasts additions and removals without reloading the room', async (t) => {
  const {root,models} = await sandbox(t);
  const server = await createServer({ configFile:false, root, plugins:[automaticModelCatalogue()], logLevel:'silent', server:{host:'127.0.0.1',port:0}, optimizeDeps:{noDiscovery:true} });
  t.after(()=>server.close()); await server.listen();
  const broadcasts = [], originalSend = server.ws.send.bind(server.ws);
  const events = [];
  server.watcher.on('all', (event,file)=>events.push([event,file]));
  server.ws.send = (message,...rest) => { broadcasts.push(message); originalSend(message,...rest); };
  const waitForCatalogue = async (predicate) => {
    const deadline = Date.now()+5000;
    while (Date.now()<deadline) {
      const found = broadcasts.find(message=>message.type==='custom' && message.event==='domus:catalogue' && predicate(message.data));
      if (found) return found.data;
      await new Promise(done=>setTimeout(done,50));
    }
    assert.fail('The folder watcher did not broadcast the catalogue change: '+JSON.stringify({events,broadcasts}));
  };
  // The API establishes the initial scanner state before the file is added.
  const origin = server.resolvedUrls.local[0];
  assert.equal((await (await fetch(origin+'api/model-catalogue')).json()).products.length,0);
  const readyDeadline = Date.now()+3000;
  while (!Object.keys(server.watcher.getWatched()).some(directory=>path.resolve(directory)===path.resolve(models))) {
    assert.ok(Date.now()<readyDeadline, 'The model directory watcher did not initialize');
    await new Promise(done=>setTimeout(done,25));
  }
  await writeFile(path.join(models,'new.glb'),glb(metadata));
  const added = await waitForCatalogue(data=>data.products.some(p=>p.available));
  assert.equal(added.products.length,1);
  const binary = await fetch(new URL(added.products[0].model.url,origin));
  assert.equal(binary.status,200); assert.equal(Buffer.from(await binary.arrayBuffer()).toString('ascii',0,4),'glTF');
  await unlink(path.join(models,'new.glb'));
  await waitForCatalogue(data=>data.products.length===0);
  assert.equal(broadcasts.some(message=>message.type==='full-reload'),false);
});

test('a forced rescan rereads models even when size and modification time are unchanged', async (t) => {
  const {models,catalogue} = await sandbox(t), file = path.join(models,'bed.glb');
  await writeFile(file,glb(metadata)); await utimes(file,1700000000,1700000000);
  const original = (await catalogue.scan()).products[0];
  await writeFile(file,glb({...metadata,domus_name:'Hospital cot'})); await utimes(file,1700000000,1700000000);
  assert.equal((await catalogue.scan()).products[0].name,'Hospital bed');
  const updated = (await catalogue.scan(true)).products[0];
  assert.equal(updated.id,original.id); assert.equal(updated.name,'Hospital cot');
  assert.notEqual(updated.model.url,original.model.url);
  await writeFile(file,Buffer.alloc((await readFile(file)).length)); await utimes(file,1700000000,1700000000);
  assert.equal((await catalogue.scan(true)).products[0].available,false);
  const stillInvalid = await catalogue.scan();
  assert.equal(stillInvalid.products[0].available,false); assert.equal(stillInvalid.issues.length,1);
});

test('the rescan command imports missed files and broadcasts to open planners with the watcher stopped', async (t) => {
  const {root,models} = await sandbox(t);
  const server = await createServer({configFile:false,root,plugins:[automaticModelCatalogue()],logLevel:'silent',server:{host:'127.0.0.1',port:0},optimizeDeps:{noDiscovery:true}});
  t.after(()=>server.close()); await server.listen(); await server.watcher.close();
  const broadcasts = [];
  server.ws.send = message => broadcasts.push(message);
  const origin = server.resolvedUrls.local[0];
  await writeFile(path.join(models,'missed.glb'),glb(metadata));
  const {stdout} = await promisify(execFile)(process.execPath,[path.resolve('scripts/rescan-models.mjs'),origin],{cwd:root});
  assert.match(stdout,/1 available, 0 unavailable, 0 import issue/);
  const update = broadcasts.findLast(message=>message.event==='domus:catalogue' && message.data.products.length);
  assert.equal(update.data.products[0].name,'Hospital bed');
  assert.equal(broadcasts.some(message=>message.type==='full-reload'),false);
  const id = update.data.products[0].id;
  assert.equal((await fetch(origin+'api/model-catalogue/rescan')).status,405);
  assert.equal((await fetch(origin+'api/model-catalogue/rescan',{method:'POST',headers:{Origin:'http://other.example'}})).status,403);
  await writeFile(path.join(models,'broken.glb'),'unfinished');
  await assert.rejects(promisify(execFile)(process.execPath,[path.resolve('scripts/rescan-models.mjs'),origin]), error => {
    assert.equal(error.code,1); assert.match(error.stderr,/broken.glb/); return true;
  });
  assert.equal(broadcasts.at(-1).data.products[0].id,id);
});

test('preview imports and serves new source models after the production build', async (t) => {
  const {root,models} = await sandbox(t);
  await mkdir(path.join(root,'dist')); await writeFile(path.join(root,'dist','index.html'),'<html>Static preview</html>');
  const server = await preview({configFile:false,root,plugins:[automaticModelCatalogue()],logLevel:'silent',preview:{host:'127.0.0.1',port:0}});
  t.after(()=>new Promise((resolve,reject)=>server.httpServer.close(error=>error?reject(error):resolve())));
  const origin = server.resolvedUrls.local[0];
  await writeFile(path.join(models,'after build.glb'),glb(metadata));
  const rescan = await fetch(origin+'api/model-catalogue/rescan',{method:'POST'});
  assert.equal(rescan.status,200);
  const data = await rescan.json();
  assert.equal(data.products.length,1);
  const head = await fetch(new URL(data.products[0].model.url,origin),{method:'HEAD'});
  assert.equal(head.status,200); assert.equal(head.headers.get('content-type'),'model/gltf-binary');
  await writeFile(path.join(models,'after build.glb'),glb({...metadata,domus_name:'Changed'}));
  const updated = await (await fetch(origin+'api/model-catalogue/rescan', { method: 'POST' })).json();
  assert.notEqual(updated.products[0].id,data.products[0].id);
  assert.equal((await fetch(new URL(data.products[0].model.url,origin))).status,200);
  await unlink(path.join(models,'after build.glb'));
  const removed = await (await fetch(origin+'api/model-catalogue')).json();
  assert.equal(removed.products.length,0);
  assert.equal((await fetch(new URL(updated.products[0].model.url,origin))).status,200);
});

test('catalogue deletion cleans live furniture, aliases, unplaced items, history and later saved-room imports', async (t) => {
  const {models,catalogue} = await sandbox(t);
  const originalCatalogue = {
    products: PRODUCT_LIST.filter(product=>product.model),
    aliases: Object.fromEntries(Object.entries(PRODUCTS).filter(([id,product])=>product.model && id!==product.id).map(([id,product])=>[id,product.id])),
    issues: getProductCatalogueIssues()
  };
  let responseData = originalCatalogue;
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(responseData),{headers:{'Content-Type':'application/json'}}));
  const {usePlannerStore:store,getSnapshot,parseProjectSnapshot} = await vite.ssrLoadModule('/src/store.ts');
  const previous = getSnapshot();
  t.after(async()=>{responseData=originalCatalogue; await initializeProductCatalogue(); store.getState().openProject(previous);});
  const file = path.join(models,'bed.glb'); await writeFile(file,glb(metadata));
  responseData = await catalogue.scan();
  const id = responseData.products[0].id;
  responseData.aliases.temporaryAlias = id;
  await initializeProductCatalogue();
  // Start with the standard empty room, preserving architecture throughout.
  store.getState().resetProject();
  store.getState().addObject(id); store.getState().addObject('sofa');
  const placed = store.getState().objects.find(object=>object.productId===id);
  assert.ok(placed);
  store.setState({unplacedObjects:[{id:'queued-import',productId:id}],selectedId:placed.id});
  const before = getSnapshot();
  const stop = subscribeProductCatalogue(()=>assert.ok(store.getState().objects.every(object=>Object.hasOwn(PRODUCTS,object.productId))));
  t.after(stop);
  await unlink(file); responseData = await catalogue.scan(); await initializeProductCatalogue();
  assert.equal(Object.hasOwn(PRODUCTS,id),false); assert.equal(Object.hasOwn(PRODUCTS,'temporaryAlias'),false);
  assert.equal(store.getState().selectedId,null); assert.deepEqual(store.getState().unplacedObjects,[]);
  assert.deepEqual(store.getState().objects.map(object=>object.productId),['sofa']);
  assert.deepEqual(getSnapshot().room,before.room);
  const opened = parseProjectSnapshot(before);
  assert.ok(opened); assert.deepEqual(opened.objects.map(object=>object.productId),['sofa']); assert.deepEqual(opened.unplacedObjects,[]);
  store.getState().undo(); store.getState().redo();
  assert.ok(store.getState().objects.every(object=>object.productId!==id));
  await writeFile(file,glb(metadata)); responseData = await catalogue.scan(); await initializeProductCatalogue();
  assert.notEqual(responseData.products[0].id,id);
  assert.ok(store.getState().objects.every(object=>object.productId!==responseData.products[0].id));
});

test('developer host refuses public mode instead of exposing publishing tools', async t => {
  const { root } = await sandbox(t); const previous = process.env.DOMUS_PUBLIC; process.env.DOMUS_PUBLIC = '1';
  await mkdir(path.join(root, '.domus-published'), { recursive: true });
  await writeFile(path.join(root, '.domus-published/catalogue.json'), JSON.stringify({ products: [], aliases: {}, issues: [] }));
  try {
    await assert.rejects(createServer({ configFile: false, root, plugins: [automaticModelCatalogue()], logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } }), /loopback/);
  } finally { if (previous === undefined) delete process.env.DOMUS_PUBLIC; else process.env.DOMUS_PUBLIC = previous; }
});
