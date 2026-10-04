import type { PlannerSnapshot, RoomShapeKind } from './types';

export const ROOM_LIBRARY_KEY = 'domus-room-library-v1';
export const ROOM_DRAFT_KEY = 'domus-room-draft-v1';
function readJson(raw: string, message: string) {
  try { return JSON.parse(raw); } catch { throw new Error(message); }
}
const LEGACY_KEYS = ['room-planner-project-v4', 'room-planner-project-v3', 'room-planner-project-v2', 'room-planner-project'];
type StorageAdapter = Pick<Storage, 'getItem' | 'setItem'>;
export type SavedRoom = { id: string; name: string; createdAt: string; updatedAt: string; revision: string; snapshot: PlannerSnapshot };
type ProjectAdapter = { initial?: () => PlannerSnapshot; snapshot: () => PlannerSnapshot; open: (snapshot: PlannerSnapshot) => boolean; empty: (shape: Exclude<RoomShapeKind, 'custom'>) => PlannerSnapshot; decode: (value: unknown) => PlannerSnapshot | null };
export type ProjectStatus = { name: string; activeId: string | null; dirty: boolean; savedAt: string | null; rooms: SavedRoom[]; warning: string; initialized: boolean };

/** Saved room identity and recovery are separate from editable layout history. */
export class RoomProjects {
  private state: ProjectStatus = { name: 'Untitled room', activeId: null, dirty: false, savedAt: null, rooms: [], warning: '', initialized: false };
  private baseline: string | null = null;
  private revision: string | null = null;
  private replacing = false;
  private draftWritable = true;
  private listeners = new Set<() => void>();
  constructor(private storage: () => StorageAdapter, private adapter: ProjectAdapter) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ProjectStatus>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  private serialize() { return JSON.stringify(this.adapter.snapshot()); }
  private readRooms(): SavedRoom[] {
    const raw = this.storage().getItem(ROOM_LIBRARY_KEY);
    if (!raw) {
      for (const key of LEGACY_KEYS) {
        const legacy = this.storage().getItem(key);
        if (!legacy) continue;
        const snapshot = this.adapter.decode(readJson(legacy, 'The previous browser save could not be read. Its original data has been kept.'));
        if (!snapshot) throw new Error('The previous browser save could not be read. Download your current room before clearing browser data.');
        const now = new Date().toISOString();
        return [{ id: 'legacy-room', name: 'Recovered room', createdAt: now, updatedAt: now, revision: 'legacy', snapshot }];
      }
      return [];
    }
    const library = readJson(raw, 'The saved-room library could not be read. Your existing data has been kept.');
    if (library?.version !== 1 || !Array.isArray(library.rooms)) throw new Error('The saved-room library could not be read. Your existing data has been kept.');
    const rooms = library.rooms.map((record: SavedRoom) => {
      const snapshot = this.adapter.decode(record?.snapshot);
      if (!record || typeof record.id !== 'string' || !record.id || typeof record.name !== 'string' || !record.name.trim()
        || typeof record.revision !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt)) || !snapshot) {
        throw new Error('A saved room is invalid. Your existing library has been kept.');
      }
      return { ...record, snapshot };
    });
    if (new Set(rooms.map((room: SavedRoom) => room.id)).size !== rooms.length) throw new Error('The saved-room library contains duplicate IDs.');
    return rooms;
  }
  initialize() {
    if (this.state.initialized) return;
    this.baseline = JSON.stringify(this.adapter.initial?.() ?? this.adapter.snapshot());
    let libraryReadable = false;
    try {
      const rooms = this.readRooms();
      libraryReadable = true;
      this.update({ rooms });
      // Migrate the old single-slot save once, keeping its original key as a backup.
      if (!this.storage().getItem(ROOM_LIBRARY_KEY) && rooms.length) this.writeRooms(rooms);
    } catch (error) { this.update({ warning: error instanceof Error ? error.message : 'Browser storage is unavailable. Download a room file to keep your work.' }); }
    try {
      const raw = this.storage().getItem(ROOM_DRAFT_KEY);
      if (raw) {
        const draft = readJson(raw, 'The recovery draft could not be read. It has been kept in browser storage.');
        const snapshot = this.adapter.decode(draft?.snapshot);
        if (draft?.version !== 1 || typeof draft.name !== 'string' || !draft.name.trim() || !snapshot
          || !(draft.baseline === null || typeof draft.baseline === 'string')
          || !(draft.activeId === null || typeof draft.activeId === 'string')
          || !(draft.revision === null || typeof draft.revision === 'string')) throw new Error('The recovery draft could not be read. It has been kept in browser storage.');
        this.replace(snapshot);
        const activeRoom = this.state.rooms.find((room) => room.id === draft.activeId);
        const deleted = libraryReadable && draft.activeId !== null && !activeRoom;
        this.baseline = deleted ? null : draft.baseline;
        this.revision = deleted ? null : draft.revision;
        this.update({ name: draft.name, activeId: deleted ? null : draft.activeId, savedAt: activeRoom?.updatedAt ?? null });
      }
    } catch (error) {
      this.draftWritable = false;
      this.update({ warning: error instanceof Error ? error.message : 'Browser storage is unavailable. Download a room file to keep your work.' });
    }
    this.update({ initialized: true, dirty: this.serialize() !== this.baseline });
  }
  refreshRooms() { const rooms = this.readRooms(); this.update({ rooms }); return rooms; }
  changed() {
    if (this.replacing || !this.state.initialized) return;
    const dirty = this.serialize() !== this.baseline;
    if (dirty !== this.state.dirty) this.update({ dirty });
  }
  private replace(snapshot: PlannerSnapshot) {
    this.replacing = true;
    try { if (!this.adapter.open(snapshot)) throw new Error('This room contains invalid geometry and could not be opened.'); }
    finally { this.replacing = false; }
  }
  private name(value: string) {
    const name = value.trim();
    if (!name || name.length > 80) throw new Error('Enter a room name between 1 and 80 characters.');
    return name;
  }
  private writeRooms(rooms: SavedRoom[]) { this.storage().setItem(ROOM_LIBRARY_KEY, JSON.stringify({ version: 1, rooms })); }
  save(value = this.state.name, asCopy = false) {
    const name = this.name(value);
    const rooms = this.readRooms();
    const id = asCopy ? null : this.state.activeId;
    const existing = rooms.find((room) => room.id === id);
    if (id && (!existing || existing.revision !== this.revision)) throw new Error('This room changed in another tab. Use Save as to keep both versions.');
    if (rooms.some((room) => room.id !== id && room.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('A room with this name already exists. Choose another name.');
    const snapshot = this.adapter.decode(this.adapter.snapshot());
    if (!snapshot) throw new Error('The room contains invalid geometry and could not be saved.');
    const now = new Date().toISOString();
    const record: SavedRoom = { id: id ?? crypto.randomUUID(), name, createdAt: existing?.createdAt ?? now, updatedAt: now, revision: crypto.randomUUID(), snapshot };
    const updated = [...rooms.filter((room) => room.id !== record.id), record];
    // Commit metadata only after the complete library has been written successfully.
    this.writeRooms(updated);
    this.baseline = this.serialize();
    this.revision = record.revision;
    this.update({ name, activeId: record.id, dirty: false, savedAt: now, rooms: updated, warning: '' });
    this.draftWritable = true;
    this.persistDraft();
    return record;
  }
  newRoom(value: string, shape: Exclude<RoomShapeKind, 'custom'>) {
    const name = this.name(value);
    this.replace(this.adapter.empty(shape));
    this.baseline = null;
    this.revision = null;
    this.update({ name, activeId: null, dirty: true, savedAt: null });
    this.draftWritable = true;
    this.persistDraft();
  }
  open(id: string) {
    const rooms = this.readRooms();
    const record = rooms.find((room) => room.id === id);
    if (!record) throw new Error('This saved room is no longer available.');
    this.replace(record.snapshot);
    this.baseline = this.serialize();
    this.revision = record.revision;
    this.update({ name: record.name, activeId: id, dirty: false, savedAt: record.updatedAt, rooms });
    this.draftWritable = true;
    this.persistDraft();
  }
  remove(id: string, expectedRevision: string) {
    const rooms = this.readRooms();
    const record = rooms.find((room) => room.id === id);
    if (!record) throw new Error('This saved room is no longer available. Reopen the room list to refresh it.');
    if (record.revision !== expectedRevision) throw new Error('This room changed in another tab. Reopen the room list before deleting it.');
    const updated = rooms.filter((room) => room.id !== id);
    this.writeRooms(updated);
    if (this.state.activeId === id) {
      // Remove only the saved copy; retain the working layout and its undo history.
      this.baseline = null;
      this.revision = null;
      this.update({ rooms: updated, activeId: null, savedAt: null, dirty: true });
      this.draftWritable = true;
      this.persistDraft();
    } else this.update({ rooms: updated });
  }
  readFile(raw: string, fallbackName: string) {
    const file = readJson(raw, 'This is not a valid Domus room file.');
    if (file?.format === 'domus-room' && file.version !== 1) throw new Error('This room file version is not supported.');
    const snapshot = this.adapter.decode(file?.format === 'domus-room' ? file.snapshot : file);
    if (!snapshot) throw new Error('This is not a valid Domus room file.');
    return { name: this.name(file?.format === 'domus-room' ? file.name : fallbackName), snapshot };
  }
  importRoom(file: { name: string; snapshot: PlannerSnapshot }) {
    const name = this.name(file.name);
    const snapshot = this.adapter.decode(file.snapshot);
    if (!snapshot) throw new Error('This is not a valid Domus room file.');
    this.replace(snapshot);
    this.baseline = null;
    this.revision = null;
    this.update({ name, activeId: null, dirty: true, savedAt: null });
    this.draftWritable = true;
    this.persistDraft();
  }
  exportFile() { return JSON.stringify({ format: 'domus-room', version: 1, name: this.state.name, snapshot: this.adapter.snapshot() }, null, 2); }
  persistDraft() {
    if (!this.state.initialized || this.replacing || !this.draftWritable) return;
    try {
      this.storage().setItem(ROOM_DRAFT_KEY, JSON.stringify({ version: 1, name: this.state.name, activeId: this.state.activeId,
        revision: this.revision, baseline: this.baseline, snapshot: this.adapter.snapshot() }));
    } catch { this.update({ warning: 'Recovery could not be stored in this browser. Download a room file to keep your work.' }); }
  }
}
