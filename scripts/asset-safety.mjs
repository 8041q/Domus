import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const modelId = /^model-[a-f0-9-]{36}--[a-f0-9]{64}$/;
export async function safePath(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid asset path');
  if ((await lstat(path.resolve(root))).isSymbolicLink()) throw new Error('Asset root must not be a symlink');
  const base = await realpath(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Asset symlinks are forbidden');
  }
  return current;
}
export async function readSafe(root, relative) {
  const file = await open(await safePath(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await file.stat()).isFile()) throw new Error('Asset is not a regular file'); return await file.readFile(); }
  finally { await file.close(); }
}
export function validateGLB(bytes) {
  if (bytes.length < 28 || bytes.length > 1024 ** 3 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('Incomplete or invalid display GLB');
  let offset = 12, document;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('Incomplete GLB chunk');
    const length = bytes.readUInt32LE(offset), kind = bytes.readUInt32LE(offset + 4);
    if (length % 4 || offset + 8 + length > bytes.length) throw new Error('Incomplete GLB chunk');
    if (offset === 12) {
      if (kind !== 0x4e4f534a) throw new Error('GLB metadata missing');
      document = JSON.parse(bytes.toString('utf8', offset + 8, offset + 8 + length));
    }
    offset += 8 + length;
  }
  if (document?.asset?.version !== '2.0' || !document.meshes?.length || !document.scenes?.length
    || document.buffers?.some(buffer => buffer.uri) || document.images?.some(image => image.uri && !image.uri.startsWith('data:'))) throw new Error('Display assets must be self-contained GLBs');
  return document;
}
/** Only application-facing fields may cross the publishing boundary. */
export function publicProduct(product) {
  if (!modelId.test(product?.id)) throw new Error('Invalid published product ID');
  const keys = ['id', 'catalogueId', 'name', 'category', 'width', 'depth', 'height', 'displayDimensions', 'available', 'collision', 'wallAffinity', 'collisionFootprint', 'interaction', 'clearance', 'priceLabel', 'swatch'];
  const result = Object.fromEntries(keys.filter(key => product[key] !== undefined).map(key => [key, structuredClone(product[key])]));
  for (const [key, fields] of [['displayDimensions', ['width', 'depth', 'height']], ['collisionFootprint', ['width', 'depth', 'offsetX', 'offsetZ']], ['clearance', ['front', 'back', 'sides']], ['interaction', ['tags', 'allowOverlapWith']]]) {
    if (product[key]) result[key] = Object.fromEntries(fields.filter(field => product[key][field] !== undefined).map(field => [field, structuredClone(product[key][field])]));
  }
  if (result.catalogueId && !product.id.startsWith(result.catalogueId + '--') || typeof result.name !== 'string' || result.name.length > 500
    || !['width', 'depth', 'height'].every(key => Number.isFinite(result[key]) && result[key] > 0 && result[key] <= 1000)) throw new Error('Invalid public model metadata');
  result.model = { url: `/api/published-models/${product.id}.glb` };
  return result;
}
/** Strip arbitrary authoring extras, including nested primitives/extensions, while
 * retaining names used by architectural material and resizing rules. BIN offsets
 * are relative to the binary chunk, so replacing padded JSON preserves geometry. */
export function publicDisplayGLB(value, { preserveNames = false } = {}) {
  const bytes = Buffer.from(value), document = validateGLB(bytes);
  const strip = item => {
    if (!item || typeof item !== 'object') return;
    if (!Array.isArray(item)) {
      delete item.extras;
      // XMP packets describe authoring/provenance and are not needed to render.
      if (item.extensions) delete item.extensions.KHR_xmp_json_ld;
    }
    for (const child of Object.values(item)) strip(child);
  };
  strip(document);
  for (const key of ['extensionsUsed', 'extensionsRequired']) if (document[key]) document[key] = document[key].filter(name => name !== 'KHR_xmp_json_ld');
  if (!preserveNames) for (const key of ['nodes', 'meshes', 'materials', 'textures', 'images', 'scenes', 'animations', 'cameras', 'skins']) for (const item of document[key] ?? []) delete item.name;
  document.asset.generator = 'Domus public display publisher';
  const raw = Buffer.from(JSON.stringify(document));
  const metadata = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
  const tail = bytes.subarray(20 + bytes.readUInt32LE(12));
  const header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + metadata.length + tail.length, 8); header.writeUInt32LE(metadata.length, 12);
  return Buffer.concat([header, metadata, tail]);
}
