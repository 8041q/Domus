import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createServer as createViteServer, loadConfigFromFile } from 'vite';
import { createTestServer } from './helpers/vite.mjs';
import { modelBytes } from './helpers/model.mjs';
import { optimizeModels } from '../scripts/optimize-models.mjs';
import { prepareRelease, validateRelease, validateLibrary } from '../scripts/release-library.mjs';
import { validateGLB } from '../scripts/asset-safety.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { ModelCatalogue } = await vite.ssrLoadModule('/server/modelCatalogue.ts');
const { publishModel } = await vite.ssrLoadModule('/server/publishedModels.ts');
const bundle = (await build({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', format: 'esm', write: false })).outputFiles[0].contents;
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'domus-boundary-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'private/models'), { recursive: true });
  await mkdir(path.join(root, 'dist')); await writeFile(path.join(root, 'dist/index.html'), '<!doctype html><html><head></head><body>Domus fixture</body></html>');
  const source = path.join(root, 'private/models/master.glb'); await writeFile(source, modelBytes({ dense: true }));
  const manifest = await optimizeModels(root);
  const scanner = new ModelCatalogue(root); await scanner.scan();
  const product = scanner.publishedData.products[0]; assert.ok(product);
  const server = path.join(root, 'public-server.mjs'); await writeFile(server, bundle);
  const release = path.join(root, 'deployment'); await prepareRelease(root, release, server);
  return { root, source, manifest, product, release, rawProduct: scanner.data.products[0] };
}
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function launch(t, release) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs', '--port', String(port)], { cwd: release, env: { ...process.env, DOMUS_PUBLIC: '1', DOMUS_ORIGIN: `https://127.0.0.1:${port}`, OLLAMA_ALLOWED_ENDPOINTS: '' } });
  t.after(() => { child.kill('SIGTERM'); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Public server timed out')); }, 10000); let error = '';
    child.stderr.on('data', bytes => { error += bytes; }); child.once('exit', () => { clearTimeout(timer); reject(new Error(error)); });
    child.stdout.on('data', bytes => { if (String(bytes).includes('ready')) { clearTimeout(timer); resolve(); } }); });
  return `http://127.0.0.1:${port}`;
}
test('isolated public release serves approved meshes to any client but has no masters or tools', async t => {
  const h = await fixture(t); await rm(path.join(h.root, 'private'), { recursive: true });
  const origin = await launch(t, h.release);
  const response = await fetch(origin + h.product.model.url, { headers: { 'User-Agent': 'Old modified client' } });
  assert.equal(response.status, 200);
  const mesh = Buffer.from(await response.arrayBuffer()); validateGLB(mesh);
  assert.ok(mesh.includes(Buffer.from('EXT_meshopt_compression')));
  const metadata = await (await fetch(origin + `/api/published-models/${h.product.id}.json`)).json();
  assert.equal(metadata.model.url, h.product.model.url); assert.ok(!JSON.stringify(metadata).includes('private/'));
  for (const route of ['/models/master.glb', '/optimized-models/master.glb', '/private/models/master.glb', '/%2e%2e/private/models/master.glb', '/@fs/private/models/master.glb', '/api/model-catalogue/rescan', '/api/model-catalogue/compact', '/api/ai/config', '/api/ai/models', '/api/ai/turn']) {
    assert.equal((await fetch(origin + route)).status, 404);
    assert.equal((await fetch(origin + route, { method: 'POST' })).status, 404);
  }
  assert.match(await (await fetch(origin)).text(), /<meta name="domus-deployment" content="public" \/>/);
  assert.doesNotMatch(await readFile(path.join(h.root, 'dist/index.html'), 'utf8'), /domus-deployment/);
  assert.ok(!String(bundle).includes('inspectProductGLB')); assert.ok(!String(bundle).includes('ModelOptimizationQueue'));
  await writeFile(path.join(h.release, '.domus-published', `${h.product.id}.glb`), Buffer.alloc(mesh.length));
  assert.equal((await fetch(origin + h.product.model.url)).status, 404, 'Post-start modification cannot be served');
});

test('Vite serves approved assets and AI locally while denying private files and their aliases', async t => {
  const { root, product } = await fixture(t);
  const privateFiles = [
    'og_models/nested/master.blend1',
    'private/models/master.glb',
    'private/proxy-previews/review.png',
    'public/models/legacy.txt',
    '.env',
    '.env.local',
    'secret.pem',
    '.git/config'
  ];
  for (const file of privateFiles.filter(file => file !== 'private/models/master.glb')) {
    const filename = path.join(root, file);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, 'PRIVATE DUMMY DATA');
  }
  await writeFile(path.join(root, 'public/approved.txt'), 'approved fixture');
  await symlink(path.join(root, privateFiles[0]), path.join(root, 'alias.txt'));
  await symlink(path.join(root, privateFiles[2]), path.join(root, 'public/alias.png'));

  const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.resolve('vite.config.ts'));
  const dev = await createViteServer({
    ...config, root, configFile: false, logLevel: 'silent',
    cacheDir: path.join(root, '.vite'), optimizeDeps: { noDiscovery: true },
    server: { ...config.server, host: '127.0.0.1', port: 0, ws: false }
  });
  try {
    await dev.listen();
    const origin = `http://127.0.0.1:${dev.httpServer.address().port}`;
    const rawFile = file => '/@fs' + pathToFileURL(path.join(root, file)).pathname;
    for (const route of [
      ...privateFiles.flatMap(file => ['/' + file, rawFile(file)]),
      '/models/legacy.txt', '/alias.txt', rawFile('alias.txt'), '/alias.png',
      '/%6fg_models/nested/master.blend1', '/private/proxy-previews/review.png?raw'
    ]) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 403, route);
      assert.doesNotMatch(await response.text(), /PRIVATE DUMMY DATA/);
    }
    assert.equal(await (await fetch(origin + '/approved.txt')).text(), 'approved fixture');
    const published = await fetch(origin + product.model.url);
    assert.equal(published.status, 200);
    validateGLB(Buffer.from(await published.arrayBuffer()));
    assert.equal((await fetch(origin + '/api/ai/config')).status, 200);
  } finally { await dev.close(); }
});

test('publication refuses escapes, missing pipeline checksums, damaged assets and incomplete GLBs', async t => {
  const h = await fixture(t), entry = h.manifest.models['master.glb'];
  const artifact = path.join(h.root, 'public', entry.url), bytes = await readFile(artifact);
  await unlink(artifact); await symlink(h.source, artifact);
  await assert.rejects(publishModel(h.root, h.rawProduct), /symlink/i);
  await unlink(artifact); await writeFile(artifact, bytes.subarray(0, bytes.length - 4));
  await assert.rejects(publishModel(h.root, h.rawProduct), /checksum/i);
  await writeFile(artifact, bytes); const manifest = structuredClone(h.manifest); delete manifest.models['master.glb'].after.sha256;
  await writeFile(path.join(h.root, 'public/optimized-models/manifest.json'), JSON.stringify(manifest));
  await assert.rejects(publishModel(h.root, h.rawProduct), /checksum/i);
  await assert.rejects(publishModel(h.root, { ...h.rawProduct, model: { runtimeUrl: '/../private/models/master.glb' } }), /pipeline/);
  assert.throws(() => validateGLB(bytes.subarray(0, bytes.length - 4)), /invalid|Incomplete/);
});
test('startup validation rejects unexpected private files, symlinks and checksum changes', async t => {
  const h = await fixture(t); await validateRelease(h.release);
  await mkdir(path.join(h.release, 'private')); await writeFile(path.join(h.release, 'private/master.glb'), modelBytes());
  await assert.rejects(validateRelease(h.release), /source|unexpected/);
  await rm(path.join(h.release, 'private'), { recursive: true });
  const file = path.join(h.release, '.domus-published', `${h.product.id}.glb`); await unlink(file); await symlink(h.source, file);
  await assert.rejects(validateRelease(h.release), /symlink/);
  await unlink(file); await writeFile(file, modelBytes()); await assert.rejects(validateRelease(h.release), /checksum/);
});
test('public startup refuses unsafe modes before accepting connections', async t => {
  const h = await fixture(t), run = promisify(execFile);
  for (const extra of [{ DOMUS_PUBLIC: '0' }, { OLLAMA_ALLOWED_ENDPOINTS: 'http://127.0.0.1:11434' }]) {
    await assert.rejects(run(process.execPath, ['server.mjs'], { cwd: h.release, env: { ...process.env, DOMUS_PUBLIC: '1', DOMUS_ORIGIN: 'https://planner.example', OLLAMA_ALLOWED_ENDPOINTS: '', ...extra }, timeout: 10000 }), /Public hosting/);
  }
});

test('packaging strips legacy provenance and retains retired revisions for old rooms', async t => {
  const h = await fixture(t);
  const metadataPath = path.join(h.root, '.domus-published', `${h.product.id}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.legacyUrl = '/private/models/master.glb';
  metadata.product.sourceFile = '/private/models/master.blend';
  metadata.product.displayDimensions = { width: 1, sourceFile: '/private/dimensions.csv' };
  await writeFile(metadataPath, JSON.stringify(metadata));
  await writeFile(h.source, modelBytes({ dense: true, widthScale: 2 }));
  await optimizeModels(h.root);
  const scanner = new ModelCatalogue(h.root); await scanner.scan(true);
  assert.notEqual(scanner.publishedData.products[0].id, h.product.id);
  await unlink(h.source); await scanner.scan(true);
  assert.equal(scanner.publishedData.products.length, 0);
  const release = path.join(h.root, 'retired-deployment');
  await prepareRelease(h.root, release, path.join(h.root, 'public-server.mjs'));
  const library = await validateLibrary(path.join(release, '.domus-published'));
  assert.equal(library.records.size, 2);
  const publicMetadata = await readFile(path.join(release, '.domus-published', `${h.product.id}.json`), 'utf8');
  assert.ok(!publicMetadata.includes('private/'));
  assert.ok(!publicMetadata.includes('legacyUrl'));
  const origin = await launch(t, release);
  assert.equal((await fetch(origin + h.product.model.url)).status, 200);
  const product = await (await fetch(origin + `/api/published-models/${h.product.id}.json`)).json();
  assert.equal(product.displayDimensions.width, 1);
  assert.equal(product.displayDimensions.sourceFile, undefined);
});

test('public display sanitization removes nested authoring data while preserving architecture roles', async () => {
  const { publicDisplayGLB } = await import('../scripts/asset-safety.mjs');
  const source = Buffer.from(modelBytes()); const document = validateGLB(source);
  document.asset.extras = { source: '/private/master.blend' };
  document.asset.copyright = 'Model owner';
  document.asset.sourceFile = '/private/master.blend';
  document.sourceFile = '/private/master.blend';
  document.accessors[0].name = 'Confidential CAD surface';
  document.buffers[0].name = 'Confidential source buffer';
  document.bufferViews[0].name = 'Confidential CAD vertices';
  document.images = [{ name: 'Confidential image filename', uri: 'data:image/png;base64,AA==' }];
  document.extensionsUsed = ['KHR_xmp_json_ld'];
  document.extensions = { KHR_xmp_json_ld: { packets: [{ source: '/private/master.blend' }] } };
  document.nodes[0].name = 'Private authoring collection';
  document.nodes[0].extras = { authoring: 'secret' };
  document.meshes[0].primitives[0].extras = { source: 'private CAD part' };
  document.materials = [{ name: 'glass coated frame', pbrMetallicRoughness: { roughnessFactor: .2 } }];
  const metadata = Buffer.from(JSON.stringify(document)); const padded = Buffer.concat([metadata, Buffer.alloc((4 - metadata.length % 4) % 4, 32)]);
  const tail = source.subarray(20 + source.readUInt32LE(12)); const header = Buffer.from(source.subarray(0, 20));
  header.writeUInt32LE(20 + padded.length + tail.length, 8); header.writeUInt32LE(padded.length, 12);
  const privateModel = Buffer.concat([header, padded, tail]);
  const furniture = validateGLB(publicDisplayGLB(privateModel)), architecture = validateGLB(publicDisplayGLB(privateModel, { preserveNames: true }));
  assert.equal(furniture.nodes[0].name, undefined); assert.equal(furniture.meshes[0].primitives[0].extras, undefined);
  assert.equal(furniture.asset.extras, undefined); assert.equal(architecture.nodes[0].extras, undefined);
  assert.equal(furniture.extensions.KHR_xmp_json_ld, undefined); assert.deepEqual(furniture.extensionsUsed, []);
  assert.equal(furniture.asset.copyright, 'Model owner');
  for (const result of [furniture, architecture]) {
    assert.equal(result.sourceFile, undefined); assert.equal(result.asset.sourceFile, undefined);
    for (const key of ['accessors', 'buffers', 'bufferViews', 'images']) assert.equal(result[key][0].name, undefined);
    assert.equal(result.images[0].uri, document.images[0].uri);
  }
  const sanitized = publicDisplayGLB(privateModel);
  assert.deepEqual(sanitized.subarray(20 + sanitized.readUInt32LE(12)), tail, 'Metadata cleanup must not change geometry or texture bytes');
  assert.deepEqual(publicDisplayGLB(privateModel), sanitized, 'Publishing is deterministic');
  assert.equal(architecture.materials[0].name, 'glass coated frame'); assert.equal(architecture.materials[0].pbrMetallicRoughness.roughnessFactor, .2);
});

test('public packaging refuses an original-model folder even when its contents are not model files', async t => {
  const h = await fixture(t);
  await mkdir(path.join(h.root, 'dist/og_models'));
  await writeFile(path.join(h.root, 'dist/og_models', 'private-notes.json'), '{}');
  await assert.rejects(prepareRelease(h.root, path.join(h.root, 'unsafe-release'), path.join(h.root, 'public-server.mjs')), /source assets/);
});
