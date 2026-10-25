import type { SavedRoom } from './roomProjects';
import type { ModelAsset, RoomDocumentV2 } from './projectDocument';

export type StoredRoom = SavedRoom & { document: RoomDocumentV2 };
export interface RecoveryDraft { id: string; updatedAt: number; document: RoomDocumentV2; activeId: string | null; revision: string | null; baseline: string | null }
interface StoredAsset { hash: string; data?: ArrayBuffer; blob?: Blob; bytes?: number }
/** Materialize binary data before opening a transaction (not while holding it). */
export async function encodeAssets(assets: ModelAsset[]) {
  return Promise.all(assets.map(async asset => ({ hash: asset.hash, data: await asset.blob.arrayBuffer(), bytes: asset.blob.size })));
}
function decodeAsset(asset: StoredAsset): ModelAsset {
  const blob = asset.data instanceof ArrayBuffer ? new Blob([asset.data], { type: 'model/gltf-binary' }) : asset.blob;
  if (!(blob instanceof Blob)) throw new Error('A saved model is damaged. Import a portable room backup.');
  return { hash: asset.hash, blob };
}
const DATABASE = 'domus-projects-v2';
export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let requestError: DOMException | null = null;
    transaction.oncomplete = () => resolve();
    transaction.onerror = event => { requestError = (event.target as IDBRequest | null)?.error ?? null; };
    transaction.onabort = () => reject(transaction.error ?? requestError ?? new Error('Browser storage could not complete the operation.'));
  });
}
export class ProjectDatabase {
  constructor(private factory: IDBFactory = globalThis.indexedDB, private name = DATABASE) {}
  async open() {
    const request = this.factory.open(this.name, 2);
    request.onupgradeneeded = () => {
      for (const name of ['rooms', 'assets', 'drafts', 'meta']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: name === 'assets' ? 'hash' : 'id' });
      const assets = request.transaction!.objectStore('assets');
      if (!assets.indexNames.contains('bytes')) assets.createIndex('bytes', 'bytes');
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => fail(new Error('Browser storage did not respond. Reload Domus or download your layout to keep your work.')), 8000);
      request.onblocked = () => fail(new Error('Close other Domus tabs and reload to update browser storage.'));
      request.onerror = () => fail(request.error ?? new Error('Browser storage is unavailable.'));
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer); resolve(request.result);
      };
    });
    db.onversionchange = () => db.close();
    return db;
  }
  async all<T>(store: string): Promise<T[]> {
    const db = await this.open();
    try { const tx = db.transaction(store); const done = transactionDone(tx); const values = await requestValue(tx.objectStore(store).getAll()); await done; return (store === 'assets' ? values.map(decodeAsset) : values) as T[]; }
    finally { db.close(); }
  }
  async asset(hash: string): Promise<ModelAsset | undefined> {
    const db = await this.open();
    try { const tx = db.transaction('assets'); const done = transactionDone(tx); const value = await requestValue(tx.objectStore('assets').get(hash)); await done; return value ? decodeAsset(value) : undefined; }
    finally { db.close(); }
  }
  async assetBytes(): Promise<number> {
    const db = await this.open();
    try {
      const tx = db.transaction('assets'), done = transactionDone(tx), store = tx.objectStore('assets');
      let bytes = 0; const indexed = new Set<IDBValidKey>();
      await new Promise<void>((resolve, reject) => {
        const request = store.index('bytes').openKeyCursor();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { const cursor = request.result; if (!cursor) { resolve(); return; } bytes += Number(cursor.key); indexed.add(cursor.primaryKey); cursor.continue(); };
      });
      // Compatibility with early blob records; current records use the index so
      // usage checks never read all model binaries into JavaScript memory.
      for (const key of await requestValue(store.getAllKeys())) if (!indexed.has(key)) bytes += decodeAsset(await requestValue(store.get(key))).blob.size;
      await done; return bytes;
    } finally { db.close(); }
  }
  /** All revision/name checks and writes occur in the same serialized transaction. */
  async commit(action: (stores: Record<string, IDBObjectStore>) => Promise<void>) {
    const db = await this.open();
    const tx = db.transaction(['rooms', 'assets', 'drafts', 'meta'], 'readwrite');
    const done = transactionDone(tx);
    try {
      await action(Object.fromEntries(['rooms', 'assets', 'drafts', 'meta'].map(name => [name, tx.objectStore(name)])));
      await done;
    } catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } await done.catch(() => {}); throw error; }
    finally { db.close(); }
  }
}
