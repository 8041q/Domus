import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProductDefinition } from '../src/core/types';

export const publishedId = /^model-[a-f0-9-]{36}--[a-f0-9]{64}$/;
export const publishedRoot = (root: string) => path.join(root, '.domus-published');
const publishedCache = new Map<string, ProductDefinition>();
/** Published revisions are durable: cache expiry and source deletion never prune them. */
export async function publishModel(root: string, product: ProductDefinition): Promise<ProductDefinition | undefined> {
  if (!product.model?.runtimeUrl || product.available === false) return undefined;
  const cacheKey = root + JSON.stringify(product);
  const cached = publishedCache.get(cacheKey); if (cached) return cached;
  const file = path.join(root, 'public', product.model.runtimeUrl);
  const bytes = await readFile(file);
  const definition = { ...product, model: undefined };
  const hash = createHash('sha256').update(bytes).update(JSON.stringify(definition)).digest('hex');
  const id = `${product.id}--${hash}`;
  const published = { ...definition, id, catalogueId: product.id, model: { url: `/api/published-models/${id}.glb` } };
  const directory = publishedRoot(root); await mkdir(directory, { recursive: true });
  try { await stat(path.join(directory, `${id}.json`)); }
  catch {
    const temporary = path.join(directory, `${id}.${process.pid}.tmp`);
    await copyFile(file, temporary); await rename(temporary, path.join(directory, `${id}.glb`));
    // Metadata is the publication marker, written only after the binary is complete.
    await writeFile(temporary, JSON.stringify({ product: published, legacyUrl: product.model.url,
      assetHash: createHash('sha256').update(bytes).digest('hex') }));
    await rename(temporary, path.join(directory, `${id}.json`));
  }
  publishedCache.set(cacheKey, published);
  return published;
}
export async function readPublished(root: string, id: string): Promise<ProductDefinition | undefined> {
  if (!publishedId.test(id)) return undefined;
  try { return JSON.parse(await readFile(path.join(publishedRoot(root), `${id}.json`), 'utf8')).product; }
  catch { return undefined; }
}
