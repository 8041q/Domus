import { readSafe, safePath, sha256, validateGLB, publicProduct } from '../scripts/asset-safety.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProductDefinition } from '../src/core/types';

export const publishedId = /^model-[a-f0-9-]{36}--[a-f0-9]{64}$/;
export const publishedRoot = (root: string) => path.join(root, '.domus-published');

/** Published revisions are durable: cache expiry and source deletion never prune them. */
export async function publishModel(root: string, product: ProductDefinition): Promise<ProductDefinition | undefined> {
  if (!product.model?.runtimeUrl || product.available === false) return undefined;
  const match = /^\/optimized-models\/([a-f0-9]{64}-v\d+\.glb)$/.exec(product.model.runtimeUrl);
  if (!match) throw new Error('Only pipeline display assets can be published');
  const manifest = JSON.parse((await readSafe(root, 'public/optimized-models/manifest.json')).toString());
  const entry = Object.values(manifest.models ?? {}).find((value: any) => value.url === product.model!.runtimeUrl) as { profile?: string; after?: { bytes?: number; sha256?: string } } | undefined;
  const bytes = await readSafe(root, `public/optimized-models/${match[1]}`);
  if (entry?.profile !== 'public-display-v1' || !entry?.after?.sha256 || entry.after.bytes !== bytes.length || entry.after.sha256 !== sha256(bytes)) throw new Error('Display asset checksum mismatch or missing pipeline checksum');
  validateGLB(bytes);
  const definition = { ...product, model: undefined };
  const hash = createHash('sha256').update(bytes).update(JSON.stringify(definition)).digest('hex');
  const id = `${product.id}--${hash}`;
  const published = publicProduct({ ...definition, id, catalogueId: product.id });
  const directory = publishedRoot(root); await mkdir(directory, { recursive: true });
  await safePath(root, '.domus-published');
  const existing = await stat(path.join(directory, `${id}.json`)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    const record = JSON.parse((await readSafe(directory, `${id}.json`)).toString());
    if (JSON.stringify(publicProduct(record.product)) !== JSON.stringify(published) || record.assetHash !== sha256(bytes) || sha256(await readSafe(directory, `${id}.glb`)) !== record.assetHash) throw new Error('Existing published revision is damaged');
  } else {
    const temporary = path.join(directory, `${id}.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path.join(directory, `${id}.glb`));
    // Metadata is the publication marker, written only after the binary is complete.
    await writeFile(temporary, JSON.stringify({ product: published,
      assetHash: createHash('sha256').update(bytes).digest('hex') }));
    await rename(temporary, path.join(directory, `${id}.json`));
  }
  return published;
}
export async function readPublished(root: string, id: string): Promise<ProductDefinition | undefined> {
  if (!publishedId.test(id)) return undefined;
  try { return publicProduct(JSON.parse((await readSafe(publishedRoot(root), `${id}.json`)).toString()).product); }
  catch { return undefined; }
}
