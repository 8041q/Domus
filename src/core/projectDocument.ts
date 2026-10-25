import type { PlannerSnapshot, ProductDefinition } from './types';
import { normalizeProductCategory } from './productSchema';

export interface ArchivedProduct { definition: ProductDefinition; hash: string | null; bytes: number; sourceUrl?: string; sourceRuntimeUrl?: string }
export interface RoomDocumentV2 {
  format: 'domus-room'; version: 2; name: string; snapshot: PlannerSnapshot; products: ArchivedProduct[];
}
export interface ModelAsset { hash: string; blob: Blob }
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const validHash = (hash: unknown): hash is string => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
/** Semantic equality must not depend on key order introduced by migrations. */
export function snapshotSignature(value: unknown): string {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export function validateSnapshotSize(snapshot: PlannerSnapshot) {
  if (!snapshot || !Array.isArray(snapshot.objects) || snapshot.objects.length > 2000
    || (snapshot.unplacedObjects?.length ?? 0) > 2000 || (snapshot.room?.vertices?.length ?? 0) > 512
    || (snapshot.openings?.length ?? 0) > 1000 || (snapshot.dividers?.length ?? 0) > 512 || (snapshot.spaces?.length ?? 0) > 512) throw new Error('The room layout is invalid or exceeds the supported editing limits.');
  if (snapshot.unplacedObjects != null && (!Array.isArray(snapshot.unplacedObjects) || snapshot.unplacedObjects.some(object => !object || typeof object.id !== 'string' || !object.id || typeof object.productId !== 'string'))) throw new Error('The room contains invalid unplaced furniture.');
  const objects = [...snapshot.objects, ...(snapshot.unplacedObjects ?? [])];
  if (objects.some(object => !object || typeof object.id !== 'string' || !object.id || object.id.length > 160 || typeof object.productId !== 'string' || object.productId.length > 160)
    || new Set(objects.map(object => object.id)).size !== objects.length) throw new Error('The room contains invalid or duplicate furniture IDs.');
}

export async function assetHash(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Check archived metadata before it can reach placement or rendering code. */
export function readDocument(value: unknown): RoomDocumentV2 {
  const doc = value as RoomDocumentV2;
  if (!doc || doc.format !== 'domus-room' || doc.version !== 2 || typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 80
    || !doc.snapshot || !Array.isArray(doc.products) || doc.products.length > 2000) throw new Error('This room document is invalid or uses an unsupported version.');
  validateSnapshotSize(doc.snapshot);
  const ids = new Set<string>(), sizes = new Map<string, number>();
  for (const entry of doc.products) {
    const product = entry?.definition;
    if (!product || typeof product.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(product.id) || ['__proto__', 'constructor', 'prototype', 'sofa', 'armchair', 'chair', 'dining-table', 'coffee-table', 'cabinet', 'bookcase', 'rug', 'plant'].includes(product.id) || ids.has(product.id)
      || typeof product.name !== 'string' || product.name.length > 500 || !normalizeProductCategory(product.category)
      || typeof product.swatch !== 'string' || !/^#[a-f0-9]{6}$/i.test(product.swatch) || typeof product.priceLabel !== 'string' || product.priceLabel.length > 500
      || ![product.width, product.depth, product.height].every(n => Number.isFinite(n) && n > 0 && n <= 1000)
      || !product.clearance || ![product.clearance.front, product.clearance.back, product.clearance.sides].every(n => Number.isFinite(n) && n >= 0 && n <= 1000)
      || !(entry.hash === null || validHash(entry.hash)) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_PACKAGE_BYTES
      || (entry.hash !== null && entry.bytes === 0)) throw new Error('The room contains invalid model metadata.');
    if ([entry.sourceUrl, entry.sourceRuntimeUrl].some(url => url != null && (typeof url !== 'string' || url.length > 4096))) throw new Error('The room contains invalid model provenance.');
    if (product.displayDimensions && ![product.displayDimensions.width, product.displayDimensions.depth, product.displayDimensions.height].every(n => Number.isFinite(n) && n > 0 && n <= 100_000)) throw new Error('The room contains invalid display dimensions.');
    if ([product.collision, product.wallAffinity, product.available].some(value => value != null && typeof value !== 'boolean')) throw new Error('The room contains invalid model flags.');
    if (product.collisionFootprint && (![product.collisionFootprint.width, product.collisionFootprint.depth].every(n => Number.isFinite(n) && n > 0 && n <= 1000)
      || ![product.collisionFootprint.offsetX ?? 0, product.collisionFootprint.offsetZ ?? 0].every(n => Number.isFinite(n) && Math.abs(n) <= 1000))) throw new Error('The room contains invalid collision metadata.');
    if (product.interaction && Object.values(product.interaction).some(tags => !Array.isArray(tags) || tags.length > 30 || tags.some(tag => typeof tag !== 'string'))) throw new Error('The room contains invalid interaction metadata.');
    ids.add(product.id);
    if (entry.hash) {
      if (sizes.has(entry.hash) && sizes.get(entry.hash) !== entry.bytes) throw new Error('The room contains inconsistent asset sizes.');
      sizes.set(entry.hash, entry.bytes);
    }
  }
  return structuredClone(doc);
}

/** A legacy layout can retain an unresolved model ID without inventing geometry. */
export function missingProduct(id: string): ArchivedProduct {
  return { hash: null, bytes: 0, definition: { id, name: 'Missing model', category: 'Others', width: .1, depth: .1, height: .1,
    collision: false, available: false, clearance: { front: 0, back: 0, sides: 0 }, priceLabel: '', swatch: '#999999', model: { url: `missing:${id}` } } };
}
