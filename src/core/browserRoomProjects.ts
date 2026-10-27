import { OPENING_MODELS, architecturalRevision } from './architecturalRevisions';
import { createId } from './id';
import { RoomProjects, ROOM_DRAFT_KEY, ROOM_LIBRARY_KEY, type ProjectStatus } from './roomProjects';
import { ProjectDatabase, encodeAssets, requestValue, type RecoveryDraft, type StoredRoom } from './projectDatabase';
import { missingProduct, readDocument, snapshotSignature, validateSnapshotSize, type ArchivedProduct, type ModelAsset, type RoomDocumentV2 } from './projectDocument';
import { readRoomArchive } from './projectArchive';
import { PRODUCTS, setRoomProducts, withRoomProducts } from './products';
import type { PlannerSnapshot, ProductDefinition, RoomShapeKind } from './types';

interface Adapter {
  initial: () => PlannerSnapshot; snapshot: () => PlannerSnapshot; open: (snapshot: PlannerSnapshot) => boolean;
  empty: (shape: Exclude<RoomShapeKind, 'custom'>) => PlannerSnapshot; decode: (value: unknown) => PlannerSnapshot | null;
}
export type BrowserProjectStatus = ProjectStatus & { busy: string; assetBytes: number; additionalBytes: number; packageBytes: number; storageBytes: number; storageQuota: number; recoveries: RecoveryDraft[] };
type PreparedRoom = { document: RoomDocumentV2; assets: ModelAsset[] };
const message = (error: unknown) => error instanceof Error ? error.message : 'Browser storage is unavailable. Download a room file to keep your work.';
/** Named saves and recovery contain references only; legacy blobs are retained until explicit cleanup. */
export class BrowserRoomProjects {
  private state: BrowserProjectStatus = { name: 'Untitled room', activeId: null, dirty: false, savedAt: null, rooms: [], warning: '', initialized: false,
    busy: '', assetBytes: 0, additionalBytes: 0, packageBytes: 0, storageBytes: 0, storageQuota: 0, recoveries: [] };
  private listeners = new Set<() => void>();
  private openingPins = new Map<string, string>();
  private baseline: string | null = null;
  private revision: string | null = null;
  private products: ArchivedProduct[] = [];
  private starting?: Promise<void>;
  private draftQueue = Promise.resolve();
  private draftWritable = true;
  private draftHealthy = true;
  private generation = 0;
  private saving = false;
  constructor(private adapter: Adapter, private database = new ProjectDatabase(), private tabId = createId(), private legacyStorage: () => Storage = () => localStorage) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<BrowserProjectStatus>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private pinOpenings(snapshot: PlannerSnapshot) {
    const openings = snapshot.openings.map(opening => {
      const key = `${opening.id}:${opening.variant}`;
      const revision = opening.modelRevision ?? this.openingPins.get(key)
        ?? architecturalRevision(OPENING_MODELS[opening.variant]?.file ?? '');
      if (revision) this.openingPins.set(key, revision);
      return revision ? { ...opening, modelRevision: revision } : opening;
    });
    return { ...snapshot, openings };
  }
  private serialize() { return snapshotSignature(this.pinOpenings(this.adapter.snapshot())); }
  changed() { if (this.state.initialized) { const dirty = this.serialize() !== this.baseline; if (dirty !== this.state.dirty) this.update({ dirty }); } }
  private name(value: string) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('Enter a room name between 1 and 80 characters.'); return value.trim(); }
  private decode(document: RoomDocumentV2) {
    const snapshot = withRoomProducts(document.products.map(product => product.definition), () => this.adapter.decode(document.snapshot));
    if (!snapshot) throw new Error('This room contains invalid geometry and could not be opened.');
    return { ...document, snapshot };
  }
  private legacyDocument(name: string, snapshot: PlannerSnapshot): RoomDocumentV2 {
    validateSnapshotSize(snapshot);
    const ids = new Set([...(snapshot?.objects ?? []), ...(snapshot?.unplacedObjects ?? [])].map(object => object.productId));
    const products = [...ids].filter(id => typeof id === 'string').flatMap(id => {
      const product = Object.hasOwn(PRODUCTS, id) ? PRODUCTS[id] : undefined;
      // An unversioned legacy alias cannot prove which historical revision was
      // used. Preserve its identity and metadata for a placeholder, not latest.
      return product?.model ? [{ definition: { ...structuredClone(product), id }, hash: null, bytes: 0 }] : product ? [] : [missingProduct(id)];
    });
    return this.decode(readDocument({ format: 'domus-room', version: 2, name: this.name(name), snapshot, products }));
  }
  private checkedDrafts(values: RecoveryDraft[]) {
    return values.flatMap(draft => {
      try {
        if (!draft || typeof draft.id !== 'string' || !draft.id || draft.id.length > 200 || !Number.isFinite(draft.updatedAt)
          || ![draft.activeId, draft.revision].every(value => value === null || typeof value === 'string')
          || !(draft.baseline === null || typeof draft.baseline === 'string' && draft.baseline.length <= 16 * 1024 * 1024)) throw new Error();
        if (draft.baseline !== null) validateSnapshotSize(JSON.parse(draft.baseline));
        return [{ ...draft, document: readDocument(draft.document) }];
      } catch {
        if (draft?.id === this.tabId) this.draftWritable = false;
        this.update({ warning: 'An unreadable recovery draft has been retained. Download your current layout before replacing it.' });
        return [];
      }
    });
  }
  initialize() { return this.starting ??= this.initializeNow(); }
  private async initializeNow() {
    this.baseline = snapshotSignature(this.adapter.initial());
    try {
      // window.open can clone sessionStorage. A lifetime Web Lock distinguishes
      // that new tab while preserving the same tab's recovery ID across reloads.
      if (typeof window !== 'undefined' && navigator.locks) {
        await new Promise<void>((resolve, reject) => {
          const claim = () => {
            void navigator.locks.request(`domus-tab:${this.tabId}`, { ifAvailable: true }, async lock => {
              if (!lock) { this.tabId = createId(); try { sessionStorage.setItem('domus-tab-id', this.tabId); } catch { /* Recovery remains available in the list. */ } claim(); return; }
              resolve(); await new Promise<void>(() => {});
            }).catch(reject);
          };
          claim();
        });
      }
      await this.database.commit(async stores => {
        stores.meta.delete(`import:${this.tabId}`);
        if (await requestValue(stores.meta.get('migrated'))) return;
        // Decode migrations with placeholders before the legacy decoder filters absent models.
        const memory = new Map<string, string>();
        const legacy = this.legacyStorage();
        for (const key of [ROOM_LIBRARY_KEY, ROOM_DRAFT_KEY, 'room-planner-project-v4', 'room-planner-project-v3', 'room-planner-project-v2', 'room-planner-project']) {
          const raw = legacy.getItem(key); if (raw) memory.set(key, raw);
        }
        const migrated = new RoomProjects(() => ({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); } }), {
          ...this.adapter, open: () => true, decode: value => this.legacyDocument('Recovered room', value as PlannerSnapshot).snapshot,
        });
        migrated.initialize();
        if (migrated.getState().warning) throw new Error(migrated.getState().warning);
        for (const room of migrated.getState().rooms) {
          const original = memory.get(ROOM_LIBRARY_KEY);
          const rawRoom = original ? JSON.parse(original).rooms.find((item: { id: string }) => item.id === room.id) : null;
          const document = this.legacyDocument(room.name, rawRoom?.snapshot ?? room.snapshot);
          if (!await requestValue(stores.rooms.get(room.id))) stores.rooms.put({ ...room, snapshot: document.snapshot, document });
        }
        const rawDraft = memory.get(ROOM_DRAFT_KEY);
        if (rawDraft) {
          const draft = JSON.parse(rawDraft);
          stores.drafts.put({ id: this.tabId, updatedAt: Date.now(), document: this.legacyDocument(draft.name, draft.snapshot), activeId: draft.activeId, revision: draft.revision, baseline: draft.baseline });
        }
        stores.meta.put({ id: 'migrated' });
      });
      await this.refreshRooms();
      const drafts = this.checkedDrafts(await this.database.all<RecoveryDraft>('drafts')).sort((a, b) => b.updatedAt - a.updatedAt);
      const own = drafts.find(draft => draft.id === this.tabId);
      // An abandoned tab's draft is offered explicitly; active tabs never overwrite one another.
      if (own) {
        const document = this.decode(readDocument(own.document));
        await this.activate(document);
        const room = this.state.rooms.find(room => room.id === own.activeId);
        this.baseline = own.activeId && !room ? null : own.baseline === null ? null : snapshotSignature(JSON.parse(own.baseline));
        this.revision = own.activeId && !room ? null : own.revision;
        this.update({ name: document.name, activeId: room?.id ?? null, savedAt: room?.updatedAt ?? null });
      }
      this.update({ recoveries: drafts.filter(draft => draft.id !== this.tabId) });
      if (!own && drafts.length && !this.state.warning) this.update({ warning: 'Recovery drafts are available under Project → Room storage.' });
    } catch (error) { this.draftWritable = false; this.update({ warning: message(error) }); }
    this.update({ initialized: true, dirty: this.serialize() !== this.baseline });
    await this.storageInfo().catch(() => {});
  }
  async refreshRooms() {
    const rooms = await this.database.all<StoredRoom>('rooms');
    for (const room of rooms) {
      if (!room || typeof room.id !== 'string' || !room.id || typeof room.revision !== 'string' || !room.revision
        || this.name(room.name) !== room.name || !Number.isFinite(Date.parse(room.createdAt)) || !Number.isFinite(Date.parse(room.updatedAt))) throw new Error('The saved-room library is invalid. Its data has been retained.');
      readDocument(room.document);
    }
    this.update({ rooms }); return rooms;
  }
  private async activate(document: RoomDocumentV2) {
    // Files describe references, never executable fetch URLs or trusted model definitions.
    const response = await fetch('/api/model-catalogue', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Connect to the Domus server to open this room. Your current room has been kept.');
    await response.json();
    const definitions: ProductDefinition[] = [];
    const resolvedIds = new Map<string, string>();
    try {
      for (const entry of document.products) {
        let product: ProductDefinition | undefined;
        if (/^model-[a-f0-9-]{36}--[a-f0-9]{64}$/.test(entry.definition.id)) {
          const result = await fetch(`/api/published-models/${entry.definition.id}.json`, { signal: AbortSignal.timeout(15000) });
          if (result.ok) product = await result.json();
          else if (result.status !== 404) throw new Error('Could not retrieve a model revision. Retry opening this room.');
        } else if (entry.hash || entry.legacyHash) {
          const result = await fetch(`/api/model-legacy?hash=${entry.legacyHash ?? entry.hash}&id=${encodeURIComponent(entry.definition.id)}`, { signal: AbortSignal.timeout(15000) });
          if (result.ok) product = await result.json();
          else if (result.status !== 404) throw new Error('Could not resolve an older model. Retry opening this room.');
        }
        if (product) {
          resolvedIds.set(entry.definition.id, product.id);
          definitions.push(product);
        } else definitions.push({ ...entry.definition, available: false, model: { url: `missing:${entry.definition.id}` } });
      }
      document = { ...document, snapshot: { ...document.snapshot,
        objects: document.snapshot.objects.map(item => ({ ...item, productId: resolvedIds.get(item.productId) ?? item.productId })),
        unplacedObjects: document.snapshot.unplacedObjects.map(item => ({ ...item, productId: resolvedIds.get(item.productId) ?? item.productId })) },
        version: 3, namespace: 'domus', products: definitions.map((definition, index) => ({ definition, hash: null, bytes: 0, ...(definition.available === false && (document.products[index]?.legacyHash ?? document.products[index]?.hash) ? { legacyHash: document.products[index].legacyHash ?? document.products[index].hash! } : {}) })) };
      // Validation completed before replacing the effective catalogue or live layout.
      const previous = this.products.map(entry => PRODUCTS[entry.definition.id]).filter(Boolean);
      setRoomProducts([...previous, ...definitions]);
      if (!this.adapter.open(document.snapshot)) { setRoomProducts(previous); throw new Error('This room could not be opened.'); }
      setRoomProducts(definitions);
      this.openingPins.clear();
      this.products = document.products; this.generation++;
      this.update({ warning: definitions.some(product => product.available === false) ? 'This room references missing models. Their positions have been retained. Reconnect and reopen to retry, or replace those items. The saved references have been retained.' : '' });
    } catch (error) { throw error; }
  }
  private async prepare(complete = true): Promise<PreparedRoom> {
    const raw = this.pinOpenings(structuredClone(this.adapter.snapshot()));
    const ids = [...new Set([...raw.objects, ...raw.unplacedObjects].map(item => item.productId))];
    const products: ArchivedProduct[] = ids.flatMap(id => {
      const product = PRODUCTS[id];
      if (!product?.model) return [];
      const definition = structuredClone(product);
      // URLs and binary hashes are never part of the transferable document.
      definition.model = { url: `published:${id}` };
      return [{ definition, hash: null, bytes: 0, legacyHash: this.products.find(entry => entry.definition.id === id)?.legacyHash }];
    });
    const document = this.decode(readDocument({ format: 'domus-room', version: 3, namespace: 'domus', name: this.state.name, snapshot: raw, products }));
    return { document, assets: [] };
  }
  async inspect() {
    return this.operation('Checking room storage…', async () => {
      const prepared = await this.prepare();
      let additionalBytes = 0;
      for (const asset of prepared.assets) if (!await this.database.asset(asset.hash)) additionalBytes += asset.blob.size;
      this.update({ additionalBytes, packageBytes: prepared.assets.reduce((sum, asset) => sum + asset.blob.size, 0) + new Blob([JSON.stringify(prepared.document)]).size });
      await this.storageInfo();
    });
  }
  private async operation<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (this.state.busy) throw new Error('Wait for the current project operation to finish.');
    this.update({ busy: label });
    try { return await action(); }
    finally { this.update({ busy: '' }); }
  }
  async save(value = this.state.name, asCopy = false) {
    return this.operation('Saving room…', async () => {
      await this.persistDraft();
      this.saving = true; this.generation++;
      await this.draftQueue;
      try {
      const name = this.name(value), prepared = await this.prepare(); prepared.document.name = name;
      const storedAssets: Awaited<ReturnType<typeof encodeAssets>> = [];
      const id = asCopy ? null : this.state.activeId, expected = this.revision;
      const now = new Date().toISOString();
      let record!: StoredRoom;
      await this.database.commit(async stores => {
        const rooms = await requestValue(stores.rooms.getAll()) as StoredRoom[];
        const existing = rooms.find(room => room.id === id);
        if (id && (!existing || existing.revision !== expected)) throw new Error('This room changed in another tab. Use Save as to keep both versions.');
        if (rooms.some(room => room.id !== id && room.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('A room with this name already exists. Choose another name.');
        record = { id: id ?? createId(), name, createdAt: existing?.createdAt ?? now, updatedAt: now, revision: createId(), snapshot: prepared.document.snapshot, document: prepared.document };
        for (const asset of storedAssets) stores.assets.put(asset);
        stores.rooms.put(record);
        stores.meta.delete(`import:${this.tabId}`);
        stores.drafts.delete(`import:${this.tabId}`);
        stores.drafts.put({ id: this.tabId, updatedAt: Date.now(), document: prepared.document, activeId: record.id, revision: record.revision, baseline: snapshotSignature(record.snapshot) });
      });
      this.products = prepared.document.products; this.baseline = snapshotSignature(prepared.document.snapshot); this.revision = record.revision; this.generation++;
      this.draftWritable = true;
      this.update({ name, activeId: record.id, dirty: this.serialize() !== this.baseline, savedAt: now, warning: '' });
      await this.refreshRooms(); await this.storageInfo();
      if (typeof navigator !== 'undefined') void navigator.storage?.persist?.().catch(() => {});
      return record;
      } finally { this.saving = false; void this.persistDraft(); }
    });
  }
  async newRoom(value: string, shape: Exclude<RoomShapeKind, 'custom'>) {
    return this.operation('Creating room…', async () => {
      const document: RoomDocumentV2 = { format: 'domus-room', version: 2, name: this.name(value), snapshot: this.adapter.empty(shape), products: [] };
      await this.activate(this.decode(document)); this.baseline = null; this.revision = null; this.draftWritable = true;
      this.update({ name: document.name, activeId: null, dirty: true, savedAt: null }); await this.persistDraft();
    });
  }
  async open(id: string) {
    return this.operation('Opening room…', async () => {
      const rooms = await this.refreshRooms() as StoredRoom[]; const record = rooms.find(room => room.id === id);
      if (!record) throw new Error('This saved room is no longer available.');
      await this.activate(this.decode(readDocument(record.document))); this.baseline = this.serialize(); this.revision = record.revision; this.draftWritable = true;
      this.update({ name: record.name, activeId: id, dirty: false, savedAt: record.updatedAt }); await this.persistDraft();
    });
  }
  async remove(id: string, expectedRevision: string) {
    return this.operation('Deleting saved room…', async () => {
      await this.database.commit(async stores => {
        const record = await requestValue(stores.rooms.get(id)) as StoredRoom | undefined;
        if (!record || record.revision !== expectedRevision) throw new Error('This room changed in another tab. Reopen the list before deleting it.');
        stores.rooms.delete(id);
      });
      if (this.state.activeId === id) { this.baseline = null; this.revision = null; this.generation++; this.update({ activeId: null, dirty: true, savedAt: null }); await this.persistDraft(); }
      await this.refreshRooms();
    });
  }
  exportFile() {
    const snapshot = this.pinOpenings(structuredClone(this.adapter.snapshot()));
    const products = [...new Set([...snapshot.objects, ...snapshot.unplacedObjects].map(item => item.productId))].flatMap(id => {
      const product = PRODUCTS[id]; if (!product?.model) return [];
      return [{ definition: { ...structuredClone(product), model: { url: `published:${id}` } }, hash: null, bytes: 0, legacyHash: this.products.find(entry => entry.definition.id === id)?.legacyHash }];
    });
    return JSON.stringify({ format: 'domus-room', version: 3, namespace: 'domus', name: this.state.name, snapshot, products }, null, 2);
  }
  async exportArchive() { return new Blob([this.exportFile()], { type: 'application/json' }); }
  async readFile(file: File): Promise<PreparedRoom> {
    if (file.size > 1024 ** 3) throw new Error('This room file exceeds the 1 GiB limit.');
    const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (header[0] === 0x50 && header[1] === 0x4b) {
      const prepared = await readRoomArchive(file); prepared.document = this.decode(prepared.document); return prepared;
    }
    if (file.size > 16 * 1024 * 1024) throw new Error('The layout JSON is too large.');
    let value; try { value = JSON.parse(await file.text()); } catch { throw new Error('This is not a valid Domus room file.'); }
    if (value?.format === 'domus-room' && value.version === 3) return { document: this.decode(readDocument(value)), assets: [] };
    if (value?.format === 'domus-room' && value.version !== 1) throw new Error('This room file version is not supported.');
    return { document: this.legacyDocument(value?.format === 'domus-room' ? value.name : file.name.replace(/(?:\.domus)?\.json$/i, '').slice(0, 80), value?.format === 'domus-room' ? value.snapshot : value), assets: [] };
  }
  async importRoom(prepared: PreparedRoom) {
    return this.operation('Importing room…', async () => {
      const document = this.decode(readDocument(prepared.document));
      const storedAssets: Awaited<ReturnType<typeof encodeAssets>> = [];
      // Assets are staged first; an interrupted import can leave only unreferenced blobs.
      await this.database.commit(async stores => {
        for (const asset of storedAssets) stores.assets.put(asset);
        stores.drafts.put({ id: `import:${this.tabId}`, updatedAt: Date.now(), document, activeId: null, revision: null, baseline: null });
      });
      try {
        await this.activate(document); this.baseline = null; this.revision = null; this.draftWritable = true;
        this.update({ name: document.name, activeId: null, dirty: true, savedAt: null }); await this.persistDraft();
      } finally { if (this.draftHealthy) await this.database.commit(async stores => { stores.drafts.delete(`import:${this.tabId}`); }).catch(() => {}); }
    });
  }
  async restoreDraft(id: string) {
    const draft = this.checkedDrafts(await this.database.all<RecoveryDraft>('drafts')).find(draft => draft.id === id);
    if (!draft) throw new Error('This recovery draft is no longer available.');
    return this.importRoom({ document: draft.document, assets: [] });
  }
  async discardRecovery(id: string, updatedAt: number) {
    return this.operation('Discarding recovery draft…', async () => {
      if (id === this.tabId) throw new Error('The current tab still uses this recovery draft.');
      const owner = id.replace(/^import:/, '');
      const discard = async () => this.database.commit(async stores => {
        const draft = await requestValue(stores.drafts.get(id)) as RecoveryDraft | undefined;
        if (!draft || draft.updatedAt !== updatedAt) throw new Error('This draft changed. Reopen Room storage before discarding it.');
        stores.drafts.delete(id);
      });
      if (typeof window !== 'undefined' && navigator.locks && owner !== this.tabId) {
        await navigator.locks.request(`domus-tab:${owner}`, { ifAvailable: true }, async lock => {
          if (!lock) throw new Error('This draft belongs to an open tab. Close that tab before discarding its recovery.');
          await discard();
        });
      } else {
        if (typeof window !== 'undefined' && owner !== this.tabId && Date.now() - updatedAt < 120_000) throw new Error('This draft may still be in use. Close its tab and wait two minutes.');
        await discard();
      }
      await this.storageInfo();
    });
  }
  persistDraft(): Promise<void> {
    if (!this.state.initialized || !this.draftWritable || this.saving) return Promise.resolve();
    const generation = this.generation;
    const raw = this.pinOpenings(structuredClone(this.adapter.snapshot()));
    const state = { name: this.state.name, activeId: this.state.activeId, revision: this.revision, baseline: this.baseline };
    const products = [...new Set([...raw.objects, ...raw.unplacedObjects].map(object => object.productId))].flatMap(id => {
      const product = PRODUCTS[id];
      const pinned = this.products.find(product => product.definition.id === id);
      if (pinned && product) return [pinned];
      return product?.model ? [{ definition: structuredClone(product), hash: null, bytes: 0 }] : [];
    });
    const action = async () => {
      if (generation !== this.generation) return;
      try {
        const assets: ModelAsset[] = [];
        const durableProducts = products.map(entry => ({ definition: { ...entry.definition, model: { url: `published:${entry.definition.id}` } }, hash: null, bytes: 0, legacyHash: entry.legacyHash ?? entry.hash ?? undefined }));
        if (generation !== this.generation) return;
        const storedAssets = await encodeAssets(assets);
        await this.database.commit(async stores => {
          if (generation !== this.generation) return;
          for (const asset of storedAssets) stores.assets.put(asset);
          stores.drafts.put({ id: this.tabId, updatedAt: Date.now(), document: { format: 'domus-room', version: 3, namespace: 'domus', name: state.name, snapshot: raw, products: durableProducts },
            activeId: state.activeId, revision: state.revision, baseline: state.baseline });
        });
        this.draftHealthy = true;
      } catch { this.draftHealthy = false; this.update({ warning: 'Recovery could not be stored. Download a room file to keep your work.' }); }
    };
    return this.draftQueue = this.draftQueue.then(action, action);
  }
  async storageInfo() {
    const assetBytes = await this.database.assetBytes();
    const estimate = typeof navigator !== 'undefined' ? await navigator.storage?.estimate?.() : undefined;
    const recoveries = this.checkedDrafts(await this.database.all<RecoveryDraft>('drafts')).filter(draft => draft.id !== this.tabId);
    this.update({ assetBytes, storageBytes: estimate?.usage ?? 0, storageQuota: estimate?.quota ?? 0, recoveries });
  }
  async cleanUnusedAssets() {
    return this.operation('Cleaning unused models…', async () => {
      await this.persistDraft();
      await this.database.commit(async stores => {
        const rooms = await requestValue(stores.rooms.getAll()) as StoredRoom[];
        const drafts = await requestValue(stores.drafts.getAll()) as RecoveryDraft[];
        const referenced = new Set([...rooms.map(room => room.document), ...drafts.map(draft => draft.document)].flatMap(document => document.products.flatMap(product => product.hash ? [product.hash] : [])));
        for (const hash of await requestValue(stores.assets.getAllKeys())) if (!referenced.has(String(hash))) stores.assets.delete(hash);
      });
      await this.storageInfo();
    });
  }
}
