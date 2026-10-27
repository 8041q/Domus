import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, flatten, getBounds, join, meshopt, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { withFileLock } from './file-lock.mjs';
import { modelCacheExpired } from './model-cache.mjs';

export const OPTIMIZER_VERSION = 5;

function stabilizePositions(document) {
  const seen = new Set();
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    if (!position || seen.has(position) || !(position.getArray() instanceof Float32Array)) continue;
    seen.add(position);
    const values = position.getArray().slice();
    const step = MeshoptSimplifier.getScale(values, 3) * 1e-6;
    if (!step) continue;
    // Remove coordinate noise below one millionth of each part's extent.
    for (let i = 0; i < values.length; i++) values[i] = Math.round(values[i] / step) * step;
    position.setArray(values);
  }
}

function simplifyStaticGeometry(document) {
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    const indices = primitive.getIndices();
    if (primitive.getMode() !== 4 || !indices || !(position?.getArray() instanceof Float32Array) || primitive.listTargets().length) continue;
    // CAD exports split nearly every face. Allow collapsing these seams while
    // including normals, texture coordinates and colours in the error metric.
    const attributes = primitive.listSemantics().filter(name => name !== 'POSITION').map(name => ({
      name, accessor: primitive.getAttribute(name), weight: name === 'NORMAL' ? .05 : 1
    }));
    if (attributes.some(({ name }) => !/^(NORMAL|TEXCOORD_\d+|COLOR_\d+)$/.test(name))) continue;
    const weights = attributes.flatMap(({ accessor, weight }) => Array(accessor.getElementSize()).fill(weight));
    const values = new Float32Array(position.getCount() * weights.length);
    const element = [];
    for (let vertex = 0; vertex < position.getCount(); vertex++) {
      let offset = vertex * weights.length;
      for (const { accessor } of attributes) {
        accessor.getElement(vertex, element);
        for (let component = 0; component < accessor.getElementSize(); component++) values[offset++] = element[component];
      }
    }
    const [result] = MeshoptSimplifier.simplifyWithAttributes(
      new Uint32Array(indices.getArray()), position.getArray(), 3, values, weights.length,
      weights, null, Math.floor(indices.getCount() * .25 / 3) * 3, .002, ['Permissive']
    );
    primitive.setIndices(indices.clone().setArray(result));
    compactPrimitive(primitive);
  }
}

export async function modelFingerprint(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export function modelStats(document) {
  let primitives = 0, vertices = 0, triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    primitives++;
    vertices += primitive.getAttribute('POSITION')?.getCount() ?? 0;
    if (primitive.getMode() === 4) triangles += (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3;
  }
  return { primitives, vertices, triangles };
}

/** Create a viewport derivative; the original export and catalogue dimensions remain authoritative. */
export async function optimizeModel(input, output) {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder
  });
  const document = await io.read(input);
  const before = modelStats(document);
  const scene = document.getRoot().listScenes()[0];
  if (!scene) throw new Error('Model has no scene.');
  const bounds = getBounds(scene);
  // Keep deformation and animation hierarchies intact; only static products are joined.
  const staticModel = document.getRoot().listAnimations().length === 0 && document.getRoot().listSkins().length === 0;
  if (staticModel) stabilizePositions(document);
  await document.transform(dedup(), weld());
  if (staticModel) {
    simplifyStaticGeometry(document);
    await document.transform(flatten(), join({ keepNamed: false, filter: node => node.getMesh()?.listPrimitives().every(primitive => {
      const material = primitive.getMaterial();
      // Transparent parts must retain independent depth sorting.
      return material?.getAlphaMode() !== 'BLEND' && !(material?.getExtension('KHR_materials_transmission')?.getTransmissionFactor() > 0);
    }) ?? false }));
  } else await document.transform(simplify({ simplifier: MeshoptSimplifier, ratio: .25, error: .0005 }));
  await document.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16, quantizeNormal: 12, quantizeTexcoord: 14 }));
  const optimizedBounds = getBounds(scene);
  for (const edge of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(optimizedBounds[edge][axis]) || Math.abs(bounds[edge][axis] - optimizedBounds[edge][axis]) > .003) {
      throw new Error('Optimization changed the model bounds by more than 3 mm.');
    }
  }
  const after = modelStats(document);
  const binary = await io.writeBinary(document);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output + '.tmp', binary);
  await rename(output + '.tmp', output);
  return { before: { ...before, bytes: (await stat(input)).size }, after: { ...after, bytes: binary.byteLength } };
}

export async function optimizeModels(root = process.cwd(), options = {}) {
  return withFileLock(path.join(root, '.domus-optimization'), () => optimizeModelsUnlocked(root, options), 300_000);
}

async function optimizeModelsUnlocked(root, { onError } = {}) {
  const sourceDirectory = path.join(root, await stat(path.join(root, 'private/models')).catch(() => null) ? 'private/models' : 'public/models');
  const outputDirectory = path.join(root, 'public', 'optimized-models');
  const manifestFile = path.join(outputDirectory, 'manifest.json');
  let manifest = { version: OPTIMIZER_VERSION, models: {} };
  try {
    const stored = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (stored.version === OPTIMIZER_VERSION && stored.models) manifest = stored;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Expiry is based on creation/write time, never extended by reading a model.
  // Clear expired derivatives before rebuilding so a failed rebuild cannot
  // leave an expired asset registered as usable.
  let expiredFiles = [];
  try { expiredFiles = await readdir(outputDirectory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let expired = false;
  for (const entry of expiredFiles) {
    if (!entry.isFile() || !/^[a-f0-9]{64}-v\d+\.glb$/.test(entry.name)) continue;
    const filename = path.join(outputDirectory, entry.name);
    if (!modelCacheExpired((await stat(filename)).mtimeMs)) continue;
    await unlink(filename);
    expired = true;
    for (const [file, model] of Object.entries(manifest.models)) {
      if (model.url === `/optimized-models/${entry.name}`) delete manifest.models[file];
    }
  }
  if (expired) {
    await writeFile(manifestFile + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
    await rename(manifestFile + '.tmp', manifestFile);
  }
  const discover = async (directory) => {
    const files = [];
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return files; throw error; }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await discover(filename));
      else if (entry.isFile() && /\.glb$/i.test(entry.name)) files.push(filename);
    }
    return files;
  };
  const inputs = await discover(sourceDirectory);
  for (const input of inputs) {
    const file = path.relative(sourceDirectory, input).split(path.sep).join('/');
    try {
      const sourceFingerprint = await modelFingerprint(input);
      const filename = `${sourceFingerprint}-v${OPTIMIZER_VERSION}.glb`;
      const output = path.join(outputDirectory, filename);
      if (manifest.models[file]?.sourceFingerprint === sourceFingerprint) {
        try {
          const info = await stat(output);
          if (info.isFile() && info.size === manifest.models[file].after?.bytes && manifest.models[file].url === `/optimized-models/${filename}`) {
            console.log(`${file}: optimized asset is current`); continue;
          }
        }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      console.log(`${file}: optimizing…`);
      const stats = await optimizeModel(input, output);
      if (await modelFingerprint(input) !== sourceFingerprint) throw new Error(`${file} changed during optimization; run again.`);
      manifest.models[file] = { sourceFingerprint, url: `/optimized-models/${filename}`, ...stats };
      console.log(`${file}: ${(stats.before.bytes / 1e6).toFixed(2)} → ${(stats.after.bytes / 1e6).toFixed(2)} MB, ${stats.before.triangles} → ${stats.after.triangles} triangles, ${stats.before.primitives} → ${stats.after.primitives} primitives`);
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(manifestFile + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
      await rename(manifestFile + '.tmp', manifestFile);
    } catch (error) {
      if (!onError) throw error;
      onError(error, file);
    }
  }
  // Only generated files are pruned. Identical source copies share one binary,
  // so retain it until the final referring model is removed.
  const present = new Set(inputs.map(input => path.relative(sourceDirectory, input).split(path.sep).join('/')));
  const removed = Object.keys(manifest.models).filter(file => !present.has(file));
  for (const file of removed) delete manifest.models[file];
  if (removed.length) {
    await writeFile(manifestFile + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
    await rename(manifestFile + '.tmp', manifestFile);
  }
  const retained = new Set(Object.values(manifest.models).map(entry => entry.url));
  let generated = [];
  try { generated = await readdir(outputDirectory, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of generated) {
    if (entry.isFile() && /^[a-f0-9]{64}-v\d+\.glb$/.test(entry.name) && !retained.has(`/optimized-models/${entry.name}`)) {
      await unlink(path.join(outputDirectory, entry.name));
    }
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const optional = process.argv.includes('--optional');
  const onError = optional ? (error, file) => console.warn(`${file}: using source model; optimization failed: ${error.message}`) : undefined;
  try { await optimizeModels(process.cwd(), { onError }); }
  catch (error) { console.error(`Model optimization failed: ${error.message}`); process.exitCode = optional ? 0 : 1; }
}
