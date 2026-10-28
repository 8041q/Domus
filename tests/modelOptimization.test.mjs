import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink, utimes, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { modelFingerprint, modelStats, optimizeModels } from '../scripts/optimize-models.mjs';
import { MODEL_CACHE_TTL_MS, modelCacheExpired } from '../scripts/model-cache.mjs';

test('model cache expires at exactly three days rather than extending on use', () => {
  assert.equal(MODEL_CACHE_TTL_MS, 259200000);
  assert.equal(modelCacheExpired(1000, 1000 + MODEL_CACHE_TTL_MS - 1), false);
  assert.equal(modelCacheExpired(1000, 1000 + MODEL_CACHE_TTL_MS), true);
});

test('model optimization creates a cached compressed derivative while preserving source, bounds and transparent sorting', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'domus-optimization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'public', 'models');
  await mkdir(directory, { recursive: true });
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const opaque = document.createMaterial('paint').setBaseColorFactor([.3, .5, .8, 1]).setRoughnessFactor(.4);
  const transparent = document.createMaterial('glass').setAlphaMode('BLEND').setBaseColorFactor([1, 1, 1, .3]);
  const sphere = new THREE.SphereGeometry(.5, 48, 32);
  const plane = new THREE.PlaneGeometry(.2, .2);
  for (let i = 0; i < 5; i++) {
    const geometry = i < 3 ? sphere : plane;
    const primitive = document.createPrimitive().setMaterial(i < 3 ? opaque : transparent);
    for (const [semantic, attribute] of [['POSITION', 'position'], ['NORMAL', 'normal'], ['TEXCOORD_0', 'uv']]) {
      const source = geometry.getAttribute(attribute);
      primitive.setAttribute(semantic, document.createAccessor().setBuffer(buffer)
        .setType(source.itemSize === 2 ? 'VEC2' : 'VEC3').setArray(source.array.slice()));
    }
    primitive.setIndices(document.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(geometry.index.array.slice()));
    scene.addChild(document.createNode(`part-${i}`).setMesh(document.createMesh().addPrimitive(primitive)).setTranslation([i, .5, 0]));
  }
  sphere.dispose(); plane.dispose();
  const bounds = getBounds(scene);
  const source = path.join(directory, 'bed.glb');
  await new NodeIO().write(source, document);
  const sourceBytes = await readFile(source);
  const originalFingerprint = await modelFingerprint(source);
  const manifest = await optimizeModels(root);
  const entry = manifest.models['bed.glb'];
  assert.equal(entry.sourceFingerprint, originalFingerprint);
  assert.deepEqual(await readFile(source), sourceBytes, 'The editable source GLB must stay byte-for-byte intact');
  const output = path.join(root, 'public', entry.url.slice(1));
  const outputBytes = await readFile(output);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  await MeshoptDecoder.ready;
  const optimized = await io.read(output);
  assert.ok(optimized.getRoot().listExtensionsRequired().some(extension => extension.extensionName === 'EXT_meshopt_compression'));
  assert.ok(modelStats(optimized).triangles < entry.before.triangles);
  const newBounds = getBounds(optimized.getRoot().listScenes()[0]);
  for (const edge of ['min', 'max']) for (let i = 0; i < 3; i++) assert.ok(Math.abs(newBounds[edge][i] - bounds[edge][i]) < .003);
  assert.equal(optimized.getRoot().listMaterials().find(material => material.getAlphaMode() !== 'BLEND').getRoughnessFactor(), .4);
  let glassParts = 0;
  for (const node of optimized.getRoot().listNodes()) {
    if (node.getMesh()?.listPrimitives().some(primitive => primitive.getMaterial()?.getAlphaMode() === 'BLEND')) glassParts++;
  }
  assert.equal(glassParts, 2, 'Separate transparent parts retain their own sort positions');
  await optimizeModels(root);
  assert.deepEqual(await readFile(output), outputBytes, 'An unchanged source reuses the generated asset');
  const expiredAt = new Date(Date.now() - MODEL_CACHE_TTL_MS - 1000);
  await utimes(output, expiredAt, expiredAt);
  await optimizeModels(root);
  assert.ok(!modelCacheExpired((await stat(output)).mtimeMs), 'Expired derivatives are rebuilt even if the source is unchanged');
  assert.deepEqual(await readFile(source), sourceBytes);
  // Cleanup precedes regeneration: even a failed source must lose its old cache.
  await utimes(output, expiredAt, expiredAt);
  await writeFile(source, Buffer.from('incomplete export'));
  await optimizeModels(root, { onError: () => {} });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(root, 'public', 'optimized-models', 'manifest.json'), 'utf8')).models['bed.glb'], undefined);
  await writeFile(source, sourceBytes);
  await optimizeModels(root);
  await writeFile(path.join(directory, 'partial.glb'), Buffer.from('partial export'));
  const issues = [];
  const fallback = await optimizeModels(root, { onError: (error, file) => issues.push({ error, file }) });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].file, 'partial.glb');
  assert.equal(fallback.models['bed.glb'].url, entry.url, 'A partial export cannot prevent other models from being used');
  await assert.rejects(optimizeModels(root), 'Explicit optimization still reports failed files');
  await unlink(path.join(directory, 'partial.glb'));
  await writeFile(path.join(directory, 'copy.glb'), sourceBytes);
  const duplicated = await optimizeModels(root);
  assert.equal(duplicated.models['copy.glb'].url, entry.url);
  await unlink(source);
  const remaining = await optimizeModels(root);
  assert.equal(remaining.models['bed.glb'], undefined);
  assert.deepEqual(await readFile(output), outputBytes, 'A source copy still owns the shared derivative');
  await unlink(path.join(directory, 'copy.glb'));
  assert.deepEqual((await optimizeModels(root)).models, {});
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});
