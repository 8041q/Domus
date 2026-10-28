import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import * as THREE from 'three';
import type { Plugin, ViteDevServer } from 'vite';
import type { ProductDefinition } from '../src/core/types';
import { normalizeProductCategory, PRODUCT_METADATA_VERSION } from '../src/core/productSchema';
import { withFileLock } from './fileLock';
import { ModelOptimizationQueue } from './modelOptimization';
import { publishModel, readPublished, publishedRoot } from './publishedModels';
import { MODEL_CACHE_TTL_MS, modelCacheExpired } from '../scripts/model-cache.mjs';

export interface CatalogueIssue { file: string; message: string }
export interface ModelCatalogueData { products: ProductDefinition[]; aliases: Record<string, string>; issues: CatalogueIssue[]; architecture?: Record<string, string> }
interface Entry { id: string; file: string; fingerprint: string; stamp: string; product: ProductDefinition; aliases?: string[] }
interface Registry { version: 1; entries: Entry[]; retiredIds?: string[] }
const PUBLIC_ID = 'virtual:domus-models';
const MODULE_ID = '\0' + PUBLIC_ID;
const COMPONENTS: Record<number, { bytes: number; read: (buffer: Buffer, offset: number) => number; max?: number }> = {
  5120: { bytes: 1, read: (b, o) => b.readInt8(o), max: 127 },
  5121: { bytes: 1, read: (b, o) => b.readUInt8(o), max: 255 },
  5122: { bytes: 2, read: (b, o) => b.readInt16LE(o), max: 32767 },
  5123: { bytes: 2, read: (b, o) => b.readUInt16LE(o), max: 65535 },
  5125: { bytes: 4, read: (b, o) => b.readUInt32LE(o) },
  5126: { bytes: 4, read: (b, o) => b.readFloatLE(o) }
};

/** Read geometry rather than trusting hand-entered dimensions or loading textures. */
export async function inspectProductGLB(filename: string, url: string, id: string): Promise<{ product: ProductDefinition; fingerprint: string }> {
  const handle = await open(filename, 'r');
  try {
    const fileSize = (await handle.stat()).size;
    const read = async (offset: number, length: number) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > fileSize) throw new Error('GLB buffer is incomplete.');
      const data = Buffer.alloc(length);
      const { bytesRead } = await handle.read(data, 0, length, offset);
      if (bytesRead !== length) throw new Error('GLB buffer is incomplete.');
      return data;
    };
    const header = await read(0, 20);
    if (header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== fileSize || header.readUInt32LE(16) !== 0x4e4f534a) throw new Error('Expected a complete glTF 2.0 binary file.');
    const jsonLength = header.readUInt32LE(12);
    if (jsonLength > 32 * 1024 * 1024) throw new Error('GLB metadata is too large.');
    const jsonBytes = await read(20, jsonLength);
    // glTF has variable JSON shapes; every buffer and graph reference below is checked.
    const gltf = JSON.parse(jsonBytes.toString('utf8'));
    if ((gltf.extensionsUsed ?? []).some((extension: string) => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'].includes(extension))) throw new Error('Export an uncompressed GLB; Draco and meshopt are not supported yet.');
    if (gltf.buffers?.some((buffer: { uri?: string }) => buffer.uri) || gltf.images?.some((image: { uri?: string }) => image.uri && !image.uri.startsWith('data:'))) throw new Error('Export with embedded buffers and textures.');
    const binHeader = await read(20 + jsonLength, 8);
    if (binHeader.readUInt32LE(4) !== 0x004e4942) throw new Error('GLB has no binary geometry.');
    const binStart = 28 + jsonLength;
    const binLength = binHeader.readUInt32LE(0);
    if (binStart + binLength !== fileSize) throw new Error('GLB binary geometry is incomplete.');
    const view = async (index: number) => {
      const v = gltf.bufferViews?.[index];
      if (!v || (v.buffer ?? 0) !== 0 || (v.byteOffset ?? 0) + v.byteLength > binLength) throw new Error('Invalid GLB buffer view.');
      return { info: v, data: await read(binStart + (v.byteOffset ?? 0), v.byteLength) };
    };
    const positions = new Map<number, Float64Array>();
    const accessor = async (index: number) => {
      if (positions.has(index)) return positions.get(index)!;
      const a = gltf.accessors?.[index];
      const component = COMPONENTS[a?.componentType];
      if (!a || a.type !== 'VEC3' || !component || !Number.isSafeInteger(a.count) || a.count <= 0 || a.count > 20_000_000) throw new Error('Invalid GLB position accessor.');
      const result = new Float64Array(a.count * 3);
      const decode = (data: Buffer, offset: number) => {
        if (offset < 0 || offset + component.bytes > data.length) throw new Error('Incomplete GLB positions.');
        const value = component.read(data, offset);
        return a.normalized && component.max ? Math.max(-1, value / component.max) : value;
      };
      if (a.bufferView !== undefined) {
        const v = await view(a.bufferView);
        const stride = v.info.byteStride ?? component.bytes * 3;
        for (let i = 0; i < a.count; i++) for (let axis = 0; axis < 3; axis++) result[i * 3 + axis] = decode(v.data, (a.byteOffset ?? 0) + i * stride + axis * component.bytes);
      }
      if (a.sparse) {
        const indices = await view(a.sparse.indices.bufferView), values = await view(a.sparse.values.bufferView);
        const indexComponent = COMPONENTS[a.sparse.indices.componentType];
        if (!indexComponent || ![5121, 5123, 5125].includes(a.sparse.indices.componentType) || a.sparse.count > a.count) throw new Error('Invalid sparse GLB positions.');
        for (let i = 0; i < a.sparse.count; i++) {
          const target = indexComponent.read(indices.data, (a.sparse.indices.byteOffset ?? 0) + i * indexComponent.bytes);
          if (target >= a.count) throw new Error('Invalid sparse GLB position index.');
          for (let axis = 0; axis < 3; axis++) result[target * 3 + axis] = decode(values.data, (a.sparse.values.byteOffset ?? 0) + (i * 3 + axis) * component.bytes);
        }
      }
      positions.set(index, result);
      return result;
    };
    const bounds = new THREE.Box3();
    const metadata: Record<string, unknown>[] = [];
    const visited = new Set<number>();
    const point = new THREE.Vector3();
    const walk = async (index: number, parent: THREE.Matrix4) => {
      const node = gltf.nodes?.[index];
      if (!node || visited.has(index)) throw new Error('Invalid or cyclic GLB scene graph.');
      visited.add(index);
      if (node.extras?.domus_schema_version) metadata.push(node.extras);
      const local = node.matrix ? new THREE.Matrix4().fromArray(node.matrix) : new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]), new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]), new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]));
      const world = parent.clone().multiply(local);
      if (node.mesh !== undefined) {
        const mesh = gltf.meshes?.[node.mesh];
        if (!mesh?.primitives) throw new Error('Invalid GLB mesh.');
        for (const primitive of mesh.primitives) {
          const values = await accessor(primitive.attributes?.POSITION);
          for (let i = 0; i < values.length; i += 3) {
            point.set(values[i], values[i + 1], values[i + 2]).applyMatrix4(world);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) throw new Error('GLB geometry has non-finite coordinates.');
            bounds.expandByPoint(point);
          }
        }
      }
      for (const child of node.children ?? []) await walk(child, world);
    };
    const scene = gltf.scenes?.[gltf.scene ?? 0];
    if (!scene?.nodes) throw new Error('GLB has no scene.');
    for (const root of scene.nodes) await walk(root, new THREE.Matrix4());
    const size = bounds.getSize(new THREE.Vector3());
    if (bounds.isEmpty() || size.x <= 0 || size.z <= 0) throw new Error('GLB has no usable product geometry.');
    if (metadata.length > 1) throw new Error('Export one product collection per GLB.');
    const extras = metadata[0] ?? {};
    const version = Number(extras.domus_schema_version ?? 0);
    if (version > PRODUCT_METADATA_VERSION) throw new Error('This metadata version is newer than Domus supports.');
    const text = (key: string, fallback = '') => typeof extras[key] === 'string' ? (extras[key] as string).trim().slice(0, 200) || fallback : fallback;
    const positive = (key: string) => typeof extras[key] === 'number' && Number.isFinite(extras[key]) && (extras[key] as number) > 0 ? extras[key] as number : null;
    const nonnegative = (key: string) => typeof extras[key] === 'number' && Number.isFinite(extras[key]) ? Math.max(0, extras[key] as number) : 0;
    const category = normalizeProductCategory(text('domus_category', 'Others'));
    if (!category) throw new Error('Choose a supported product category in Blender.');
    const display = { width: positive('domus_display_width_m'), depth: positive('domus_display_depth_m'), height: positive('domus_display_height_m') };
    if (version >= 2 && (!display.width || !display.depth || !display.height || !text('domus_name') || !text('domus_category'))) throw new Error('Complete the product name, category and external dimensions in Blender, then save metadata again.');
    // v1 manually entered size and collider fields may be in the wrong units.
    // Geometry is authoritative for physics in every version.
    const product: ProductDefinition = {
      id, name: text('domus_name', path.basename(filename, path.extname(filename))), category,
      width: size.x, depth: size.z, height: Math.max(size.y, 0.001), available: true,
      ...(display.width && display.depth && display.height ? { displayDimensions: display as { width: number; depth: number; height: number } } : {}),
      collision: extras.domus_collision !== false, wallAffinity: extras.domus_wall_affinity === true,
      collisionFootprint: { width: size.x, depth: size.z },
      clearance: { front: nonnegative('domus_clearance_front_m'), back: nonnegative('domus_clearance_back_m'), sides: nonnegative('domus_clearance_sides_m') },
      priceLabel: text('domus_price_label'), swatch: '#999999', model: { url }
    };
    // Automatic preview colour; the GLB's material remains unchanged.
    const colour = gltf.materials?.find((material: { pbrMetallicRoughness?: { baseColorFactor?: number[] } }) => material.pbrMetallicRoughness?.baseColorFactor)?.pbrMetallicRoughness.baseColorFactor;
    if (colour?.slice(0, 3).every((value: number) => Number.isFinite(value))) product.swatch = '#' + new THREE.Color().setRGB(colour[0], colour[1], colour[2]).getHexString();
    const fingerprint = createHash('sha256');
    // Stream the binary for identity/rename detection without keeping the 146 MB
    // test model or its textures in memory. Geometry arrays are temporary too.
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) fingerprint.update(chunk);
    return { product, fingerprint: fingerprint.digest('hex') };
  } finally { await handle.close(); }
}

export class ModelCatalogue {
  private registry: Registry = { version: 1, entries: [] };
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();
  publishedData: ModelCatalogueData = { products: [], aliases: {}, issues: [] };
  data: ModelCatalogueData = { products: [], aliases: {}, issues: [] };
  requiresOptimization = false;
  nextCacheExpiry: number | undefined;
  cacheGeneration = '';
  constructor(private root: string, private persist = true) {}
  get modelsDirectory() { return path.join(this.root, existsSync(path.join(this.root, 'private/models')) ? 'private/models' : 'public/models'); }
  private get registryFile() { return path.join(this.root, 'model-catalogue.json'); }

  scan(force = false): Promise<ModelCatalogueData> {
    const next = this.queue.then(() => process.env.DOMUS_PUBLIC === '1' ? this.scanNow(force)
      : withFileLock(this.registryFile, () => { this.initialized = false; return this.scanNow(force); }));
    this.queue = next.catch(() => {});
    return next;
  }

  private async scanNow(force: boolean) {
    if (process.env.DOMUS_PUBLIC === '1') {
      this.publishedData = JSON.parse(await readFile(path.join(publishedRoot(this.root), 'catalogue.json'), 'utf8'));
      this.data = this.publishedData; this.requiresOptimization = false;
      return this.data;
    }
    if (!this.initialized) {
      try {
        const stored = JSON.parse(await readFile(this.registryFile, 'utf8')) as Registry;
        if (stored.version !== 1 || !Array.isArray(stored.entries) || !stored.entries.every((entry) => /^model-[0-9a-f-]{36}$/.test(entry.id) && typeof entry.file === 'string' && entry.product?.id === entry.id)
          || new Set(stored.entries.map((entry) => entry.id)).size !== stored.entries.length || new Set(stored.entries.map((entry) => entry.file)).size !== stored.entries.length
          || (stored.retiredIds != null && (!Array.isArray(stored.retiredIds) || !stored.retiredIds.every((id) => typeof id === 'string' && /^model-[0-9a-f-]{36}$/.test(id))
            || new Set(stored.retiredIds).size !== stored.retiredIds.length || stored.entries.some((entry) => stored.retiredIds!.includes(entry.id))))) throw new Error('The model ID registry is invalid. Restore model-catalogue.json to retain saved-room IDs.');
        this.registry = stored;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.initialized = true;
    }
    const files: string[] = [];
    const discover = async (directory: string) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await discover(filename);
        else if (entry.isFile() && /\.glb$/i.test(entry.name)) files.push(path.relative(this.modelsDirectory, filename).split(path.sep).join('/'));
      }
    };
    await discover(this.modelsDirectory);
    files.sort();
    const present = new Set(files), issues: CatalogueIssue[] = [];
    const before = JSON.stringify(this.registry);
    const retiredIds = new Set(this.registry.retiredIds ?? []);
    for (const file of files) {
      const filename = path.join(this.modelsDirectory, ...file.split('/'));
      const info = await stat(filename);
      const stamp = `${info.size}:${info.mtimeMs}`;
      let entry = this.registry.entries.find((item) => item.file === file);
      if (!force && entry?.stamp === stamp) { entry.product.available = true; entry.product.category = normalizeProductCategory(entry.product.category) ?? 'Others'; continue; }
      let provisionalId = entry?.id ?? `model-${randomUUID()}`;
      if (!entry) while (retiredIds.has(provisionalId) || this.registry.entries.some((item) => item.id === provisionalId)) provisionalId = `model-${randomUUID()}`;
      const url = '/models/' + file.split('/').map(encodeURIComponent).join('/');
      try {
        const inspected = await inspectProductGLB(filename, url, provisionalId);
        const after = await stat(filename);
        if (`${after.size}:${after.mtimeMs}` !== stamp) throw new Error('The model is still being written. Save/export the complete file again.');
        // Each newly discovered path gets a fresh ID, even for an identical file.
        // Updates to a file still present in the registry retain its identity.
        if (!entry) {
          entry = { id: provisionalId, file, fingerprint: '', stamp: '', product: inspected.product };
          this.registry.entries.push(entry);
        }
        entry.file = file;
        entry.stamp = stamp;
        entry.fingerprint = inspected.fingerprint;
        entry.product = { ...inspected.product, id: entry.id, model: { url: `${url}?v=${inspected.fingerprint.slice(0, 16)}` } };
      } catch (error) {
        issues.push({ file, message: error instanceof Error ? error.message : 'Could not read this GLB.' });
        if (entry) { entry.product.available = false; entry.stamp = ''; }
      }
    }
    for (const entry of this.registry.entries) if (!present.has(entry.file)) retiredIds.add(entry.id);
    this.registry.entries = this.registry.entries.filter((entry) => present.has(entry.file));
    if (retiredIds.size) this.registry.retiredIds = [...retiredIds];
    if (this.persist && JSON.stringify(this.registry) !== before) {
      const temporary = this.registryFile + `.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(this.registry, null, 2) + '\n');
        await rename(temporary, this.registryFile);
      } catch (error) { this.registry = JSON.parse(before); throw error; }
    }
    // Optimized copies live outside the source folder, so they cannot create new
    // catalogue IDs. Never use a derivative belonging to an older Blender export.
    let optimized: { version?: number; models?: Record<string, { sourceFingerprint?: string; url?: string; after?: { bytes?: number } }> } = {};
    try {
      const parsed = JSON.parse(await readFile(path.join(this.root, 'public', 'optimized-models', 'manifest.json'), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') optimized = parsed;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const cacheStamps: Record<string, number> = {};
    this.nextCacheExpiry = undefined;
    const products = await Promise.all(this.registry.entries.map(async (entry) => {
      const derivative = optimized.models?.[entry.file];
      if (entry.product.available === false || !entry.product.model || derivative?.sourceFingerprint !== entry.fingerprint
        || typeof derivative.url !== 'string' || !/^\/optimized-models\/[a-f0-9]{64}-v\d+\.glb$/.test(derivative.url)
        || !derivative.url.startsWith(`/optimized-models/${entry.fingerprint}-v`)) return entry.product;
      try {
        const info = await stat(path.join(this.root, 'public', derivative.url.slice(1)));
        if (!info.isFile() || info.size !== derivative.after?.bytes) return entry.product;
        cacheStamps[entry.file] = info.mtimeMs;
        if (modelCacheExpired(info.mtimeMs)) return entry.product;
        this.nextCacheExpiry = Math.min(this.nextCacheExpiry ?? Infinity, info.mtimeMs + MODEL_CACHE_TTL_MS);
      } catch { return entry.product; }
      return { ...entry.product, model: { ...entry.product.model, runtimeUrl: derivative.url } };
    }));
    this.cacheGeneration = JSON.stringify(Object.entries(cacheStamps).sort(([a], [b]) => a.localeCompare(b)));
    this.requiresOptimization = products.some(product => product.available !== false && product.model && !product.model.runtimeUrl)
      || Object.keys(optimized.models ?? {}).some(file => !present.has(file));
    const published = (await Promise.all(products.map(product => publishModel(this.root, product)))).filter((product): product is ProductDefinition => Boolean(product));
    this.data = { products, aliases: Object.fromEntries(this.registry.entries.flatMap(entry => (entry.aliases ?? []).map(alias => [alias, entry.id]))), issues };
    this.publishedData = {
      products: published,
      aliases: Object.fromEntries(published.flatMap(product => [[product.catalogueId!, product.id], ...(this.registry.entries.find(entry => entry.id === product.catalogueId)?.aliases ?? []).map(alias => [alias, product.id])])), issues
    };
    this.publishedData.architecture = await readFile(path.join(publishedRoot(this.root), 'openings.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    await mkdir(publishedRoot(this.root), { recursive: true });
    const manifest = path.join(publishedRoot(this.root), 'catalogue.json');
    await writeFile(manifest + '.tmp', JSON.stringify(this.publishedData)); await rename(manifest + '.tmp', manifest);
    return this.data;
  }
}

export function automaticModelCatalogue(): Plugin & {
  initialize(root: string): Promise<void>;
  middleware(request: IncomingMessage, response: ServerResponse, next: () => void): void;
  dispose(): Promise<void>;
} {
  let catalogue: ModelCatalogue;
  let building = false;
  let ready: Promise<ModelCatalogueData>;
  let publish: ((data: ModelCatalogueData) => void) | undefined;
  let optimization: ModelOptimizationQueue | undefined;
  let projectRoot = '';
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let reportExpiryError: ((message: string) => void) | undefined;
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    if (!optimization || catalogue.nextCacheExpiry === undefined) return;
    expiryTimer = setTimeout(() => {
      void refresh().catch(error => reportExpiryError?.(error.message));
    }, Math.max(1, catalogue.nextCacheExpiry - Date.now()));
    expiryTimer.unref();
  };
  const optimizationKey = (data: ModelCatalogueData) => JSON.stringify(data.products.filter(product => product.model && product.available !== false)
    .map(product => [product.id, product.model!.url])) + catalogue.cacheGeneration;
  const refresh = async (force = false) => {
    const data = await catalogue.scan(force);
    publish?.(catalogue.publishedData);
    if (catalogue.requiresOptimization) optimization?.request(optimizationKey(data));
    scheduleExpiry();
    return data;
  };
  const startOptimization = (report: (message: string) => void) => {
    reportExpiryError = report;
    optimization = new ModelOptimizationQueue(projectRoot, async () => {
      const before = JSON.stringify(catalogue.data);
      const data = await catalogue.scan();
      if (JSON.stringify(data) !== before) publish?.(catalogue.publishedData);
      if (catalogue.requiresOptimization) optimization?.request(optimizationKey(data));
      scheduleExpiry();
    }, report);
    if (catalogue.requiresOptimization) optimization.request(optimizationKey(catalogue.data));
    scheduleExpiry();
  };
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const requested = new URL(request.url ?? '/', 'http://localhost');
    if (requested.pathname.startsWith('/internal/architecture/')) {
      const match = /^\/internal\/architecture\/openings\/([a-z_]+\.glb)$/.exec(requested.pathname);
      if (!match || !['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(404).end(); return; }
      const revision = requested.searchParams.get('v');
      if (!revision || !/^[a-f0-9]{64}$/.test(revision)) { response.writeHead(404).end(); return; }
      const filename = path.join(projectRoot, '.domus-published/openings', `${revision}-${match[1]}`);
      void stat(filename).then(info => {
        response.setHeader('Content-Type', 'model/gltf-binary'); response.setHeader('Content-Length', info.size);
        if (request.method === 'HEAD') { response.end(); return; }
        const stream = createReadStream(filename); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
      }).catch(() => response.writeHead(404).end()); return;
    }
    if (requested.pathname === '/api/model-legacy') {
      const hash = requested.searchParams.get('hash'), id = requested.searchParams.get('id');
      if (!hash || !/^[a-f0-9]{64}$/.test(hash) || !id || !/^model-[a-f0-9-]{36}$/.test(id)) { response.writeHead(404).end(); return; }
      void readdir(publishedRoot(projectRoot)).then(async files => {
        for (const file of files.filter(file => file.startsWith(id + '--') && file.endsWith('.json'))) {
          const entry = JSON.parse(await readFile(path.join(publishedRoot(projectRoot), file), 'utf8'));
          if (entry.assetHash === hash) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(entry.product)); return; }
        }
        response.writeHead(404).end();
      }).catch(() => response.writeHead(404).end()); return;
    }
    if (requested.pathname.startsWith('/api/published-models/')) {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return; }
      const match = /^\/api\/published-models\/(model-[a-f0-9-]{36}--[a-f0-9]{64})\.(glb|json)$/.exec(requested.pathname);
      if (!match) { response.writeHead(404).end(); return; }
      void readPublished(projectRoot, match[1]).then(async product => {
        if (!product) { response.writeHead(404).end('Model revision unavailable'); return; }
        if (match[2] === 'json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(product)); return; }
        const filename = path.join(publishedRoot(projectRoot), `${match[1]}.glb`);
        const info = await stat(filename); response.setHeader('Content-Type', 'model/gltf-binary');
        response.setHeader('Content-Length', info.size); response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (request.method === 'HEAD') { response.end(); return; }
        const stream = createReadStream(filename); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
      }).catch(() => { if (!response.headersSent) response.writeHead(404).end(); else response.destroy(); });
      return;
    }
    if (requested.pathname.startsWith('/models/') || requested.pathname.startsWith('/optimized-models/')) { response.writeHead(404).end(); return; }
    if (requested.pathname === '/api/model-catalogue/rescan' || requested.pathname === '/api/model-catalogue/compact') {
      if (process.env.DOMUS_PUBLIC === '1') { response.writeHead(404).end(); return; }
      if (request.method !== 'POST') { response.statusCode = 405; response.setHeader('Allow', 'POST'); response.end('Use POST to rescan models'); return; }
      // A browser from another origin must not trigger a costly local import.
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) {
        response.statusCode = 403; response.end('Rescan must be requested from this server'); return;
      }
      const compact = requested.pathname.endsWith('/compact');
      if (compact && !request.headers['content-type']?.startsWith('application/json')) { response.statusCode = 415; response.end('Use application/json'); return; }
      request.resume();
      void (compact ? (async () => { await optimization?.ensure(); return refresh(); })() : (async () => { await refresh(true); await optimization?.ensure(); return refresh(); })()).then((data) => {
        response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(catalogue.publishedData));
      }).catch((error) => { response.statusCode = 500; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: error.message })); });
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { next(); return; }
    if (requested.pathname === '/api/model-catalogue') {
      void refresh().then((data) => {
        response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(catalogue.publishedData));
      }).catch((error) => { response.statusCode = 500; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ error: error.message })); });
      return;
    }
    next();
  };
  return {
    name: 'domus-model-catalogue',
    async initialize(root) { projectRoot = root; catalogue = new ModelCatalogue(root); ready = catalogue.scan(); await ready; startOptimization(message => console.warn(message)); },
    middleware,
    async dispose() { clearTimeout(expiryTimer); await optimization?.dispose(); },
    configResolved(config) {
      if (process.env.DOMUS_PUBLIC === '1' || config.command === 'serve' && (![undefined, 'localhost', '127.0.0.1', '::1'].includes(config.server.host as string | undefined) || ![undefined, 'localhost', '127.0.0.1', '::1'].includes(config.preview.host as string | undefined))) throw new Error('Developer tools must run on loopback, never in public mode.');
      building = config.command === 'build';
      projectRoot = config.root; catalogue = new ModelCatalogue(config.root, config.command !== 'build'); ready = catalogue.scan(); },
    async buildStart() { await ready; },
    async closeBundle() { clearTimeout(expiryTimer); await optimization?.dispose(); },
    resolveId(id) { if (id === PUBLIC_ID) return MODULE_ID; },
    hotUpdate(context) {
      const relative = path.relative(catalogue.modelsDirectory, context.file);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) return [];
    },
    async load(id) { if (id === MODULE_ID) { await ready; return `export default ${JSON.stringify(building ? { ...catalogue.publishedData, issues: [] } : catalogue.publishedData)};`; } },
    async configureServer(server: ViteDevServer) {
      if (!['localhost', '127.0.0.1', '::1', undefined].includes(server.config.server.host as string | undefined) || process.env.DOMUS_PUBLIC === '1') throw new Error('Developer tools must run on loopback; use a packaged public release for hosting.');
      await ready;
      publish = (data) => {
        const module = server.moduleGraph.getModuleById(MODULE_ID);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: 'custom', event: 'domus:catalogue', data });
      };
      server.middlewares.use(middleware);
      startOptimization(message => server.config.logger.warn(`Model optimization: ${message}`));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const change = (filename: string) => {
        const relative = path.relative(catalogue.modelsDirectory, filename);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void refresh().catch((error) => server.config.logger.error(`Model catalogue: ${error.message}`));
        }, 200);
      };
      server.watcher.add(catalogue.modelsDirectory);
      for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) server.watcher.on(event, change);
      server.httpServer?.once('close', () => {
        clearTimeout(expiryTimer);
        clearTimeout(timer);
        publish = undefined;
        optimization?.dispose();
        for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) server.watcher.off(event, change);
      });
    },
    async configurePreviewServer(server) {
      if (!['localhost', '127.0.0.1', '::1', undefined].includes(server.config.preview.host as string | undefined) || process.env.DOMUS_PUBLIC === '1') throw new Error('Preview tools must run on loopback.');
      await ready;
      server.middlewares.use(middleware);
      startOptimization(message => server.config.logger.warn(`Model optimization: ${message}`));
      server.httpServer?.once('close', () => { clearTimeout(expiryTimer); optimization?.dispose(); });
    }
  };
}
