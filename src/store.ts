import { create } from 'zustand';
import { PRODUCTS, rotatedFootprint } from './core/products';
import { objectsOverlap, resolvePlacement } from './core/placement';
import { SnapshotHistory } from './core/history';
import {
  findNearestValidPosition,
  getRoomWalls,
  getWall,
  resizeWallCentered,
  splitWall,
  roomBounds,
  roomTemplate,
  scaleRoom,
  syncRoomBounds
} from './core/roomGeometry';
import type {
  AppMode,
  OpeningType,
  OpeningVariant,
  PlannerSnapshot,
  PlacedObject,
  ProductKind,
  RoomOpening,
  RoomShapeKind,
  RoomState,
  RoomVertex,
  RoomWall,
  SnapFeedback,
  BuildWorkspaceView,
  PlanCameraView,
  MeasurementSystem
} from './core/types';

interface PlannerStore extends PlannerSnapshot {
  mode: AppMode;
  buildView: BuildWorkspaceView;
  planView: PlanCameraView;
  measurementSystem: MeasurementSystem;
  selectedId: string | null;
  selectedOpeningId: string | null;
  selectedWallId: string | null;
  activeSnap: SnapFeedback;
  collisionId: string | null;
  collisionPush: boolean;
  showClearance: boolean;
  showRoomDimensions: boolean;
  showProductDimensions: boolean;
  showSpacingDimensions: boolean;

  setMode: (mode: AppMode) => void;
  setBuildView: (view: BuildWorkspaceView) => void;
  setPlanView: (view: PlanCameraView) => void;
  setMeasurementSystem: (system: MeasurementSystem) => void;
  setShowClearance: (show: boolean) => void;
  setShowRoomDimensions: (show: boolean) => void;
  setShowProductDimensions: (show: boolean) => void;
  setShowSpacingDimensions: (show: boolean) => void;

  addObject: (productId: ProductKind) => void;
  duplicateSelected: () => void;
  select: (id: string | null) => void;
  updateObject: (id: string, patch: Partial<PlacedObject>) => void;
  commitSnapshot: (before: PlannerSnapshot) => void;
  setRoom: (room: RoomState) => void;
  setRoomVertices: (vertices: RoomVertex[], shapeKind?: RoomShapeKind) => void;
  setRoomTemplate: (shape: Exclude<RoomShapeKind, 'custom'>) => void;
  updateRoom: (patch: Partial<RoomState>) => void;
  resizeWallById: (wallId: string, length: number, recordHistory?: boolean) => boolean;
  splitWallById: (wallId: string) => boolean;
  selectWall: (id: string | null) => void;
  rotateSelected: (direction?: 1 | -1) => void;
  setSelectedRotation: (rotationY: number, recordHistory?: boolean) => void;
  removeSelected: () => void;

  addOpening: (type: OpeningType) => void;
  selectOpening: (id: string | null) => void;
  updateOpening: (id: string, patch: Partial<RoomOpening>, recordHistory?: boolean) => void;
  removeOpening: (id: string) => void;

  setFeedback: (snap: SnapFeedback, collisionId?: string | null, collisionPush?: boolean) => void;
  undo: () => void;
  redo: () => void;
  saveLocal: () => void;
  loadLocal: () => void;
  resetProject: () => void;
}

const history = new SnapshotHistory();
const initialVertices = roomTemplate('rectangle', 5.2, 3.8);
const defaultRoom: RoomState = {
  width: 5.2,
  depth: 3.8,
  height: 2.6,
  wallColor: '#eeeae1',
  floorFinish: 'light-oak',
  shapeKind: 'rectangle',
  vertices: initialVertices
};

function defaultWallId(room: RoomState, preference: 'horizontal' | 'vertical') {
  const walls = getRoomWalls(room);
  return [...walls]
    .filter((wall) => preference === 'horizontal' ? wall.horizontal : !wall.horizontal)
    .sort((a, b) => b.length - a.length)[0]?.id ?? walls[0]?.id ?? '';
}

const defaultOpenings: RoomOpening[] = [
  { id: 'window-1', type: 'window', variant: 'double-window', wallId: defaultWallId(defaultRoom, 'horizontal'), offset: 2.9, width: 1.4, height: 1.2, sillHeight: 0.85 },
  { id: 'door-1', type: 'door', variant: 'single-door', wallId: defaultWallId(defaultRoom, 'vertical'), offset: 2.85, width: 0.9, height: 2.08, sillHeight: 0 }
];
const defaultObjects: PlacedObject[] = [];

const snapshotOf = (state: PlannerSnapshot): PlannerSnapshot => ({
  room: structuredClone(state.room),
  openings: structuredClone(state.openings),
  objects: structuredClone(state.objects)
});

function cardinalWallId(room: RoomState, wall: RoomWall) {
  const walls = getRoomWalls(room);
  const horizontal = walls.filter((w) => w.horizontal);
  const vertical = walls.filter((w) => !w.horizontal);
  if (wall === 'north') return [...horizontal].sort((a, b) => a.start.z - b.start.z)[0]?.id;
  if (wall === 'south') return [...horizontal].sort((a, b) => b.start.z - a.start.z)[0]?.id;
  if (wall === 'west') return [...vertical].sort((a, b) => a.start.x - b.start.x)[0]?.id;
  return [...vertical].sort((a, b) => b.start.x - a.start.x)[0]?.id;
}

function ensureRoom(raw: Partial<RoomState>): RoomState {
  const width = Math.max(2.2, Math.min(Number(raw.width) || defaultRoom.width, 20));
  const depth = Math.max(2.2, Math.min(Number(raw.depth) || defaultRoom.depth, 20));
  const vertices = Array.isArray(raw.vertices) && raw.vertices.length >= 4
    ? raw.vertices.map((v, i) => ({ id: v.id || `v${i}`, x: Number(v.x), z: Number(v.z) }))
    : roomTemplate('rectangle', width, depth);
  const room = syncRoomBounds({
    ...defaultRoom,
    ...raw,
    width,
    depth,
    height: Math.max(2.1, Math.min(Number(raw.height) || defaultRoom.height, 4.2)),
    shapeKind: raw.shapeKind ?? (vertices.length === 4 ? 'rectangle' : 'custom'),
    vertices
  } as RoomState, vertices);
  if (room.width > 20 || room.depth > 20) return scaleRoom(room, Math.min(room.width, 20), Math.min(room.depth, 20));
  return room;
}

function defaultOpeningVariant(type: OpeningType): OpeningVariant {
  if (type === 'door') return 'single-door';
  if (type === 'opening') return 'wall-opening';
  return 'single-window';
}

function openingPreset(type: OpeningType, variant: OpeningVariant, room: RoomState) {
  if (variant === 'double-window') return { width: 1.8, height: 1.25, sillHeight: 0.85 };
  if (variant === 'full-height-window') return { width: 1.2, height: Math.max(0.6, room.height), sillHeight: 0 };
  if (variant === 'high-window') return { width: 1.35, height: 0.65, sillHeight: Math.max(0.7, room.height - 0.85) };
  if (variant === 'sliding-window') return { width: 2.4, height: Math.max(0.6, room.height), sillHeight: 0 };
  if (variant === 'double-door') return { width: 1.6, height: 2.08, sillHeight: 0 };
  if (variant === 'door-frame') return { width: 0.95, height: 2.1, sillHeight: 0 };
  if (variant === 'glass-door') return { width: 0.9, height: 2.08, sillHeight: 0 };
  if (variant === 'glass-double-door') return { width: 1.6, height: 2.08, sillHeight: 0 };
  if (variant === 'wall-opening') return { width: 1.2, height: 1.2, sillHeight: 0.75 };
  if (variant === 'single-door') return { width: 0.9, height: 2.08, sillHeight: 0 };
  return { width: 1.2, height: 1.2, sillHeight: 0.85 };
}

function normalizeOpening(opening: RoomOpening & { wall?: RoomWall }, room: RoomState): RoomOpening {
  let wallId = opening.wallId;
  if (!getWall(room, wallId) && opening.wall) wallId = cardinalWallId(room, opening.wall) ?? '';
  let wall = getWall(room, wallId);
  if (!wall) {
    wall = [...getRoomWalls(room)].sort((a, b) => b.length - a.length)[0] ?? null;
    wallId = wall?.id ?? '';
  }
  const maxLen = wall?.length ?? 1;
  const minWidth = opening.type === 'opening' ? 0.10 : 0.45;
  const minHeight = opening.type === 'opening' ? 0.10 : 0.40;
  const width = Math.max(minWidth, Math.min(opening.width, Math.max(minWidth, maxLen - 0.2)));
  const offset = Math.max(width / 2 + 0.05, Math.min(opening.offset, maxLen - width / 2 - 0.05));
  const variant = opening.variant ?? defaultOpeningVariant(opening.type);
  const forcedFloor = opening.type === 'door' || variant === 'full-height-window' || variant === 'sliding-window';
  const sillHeight = forcedFloor ? 0 : Math.max(0, opening.sillHeight);
  const maxHeight = Math.max(minHeight, room.height - sillHeight);
  const height = Math.max(minHeight, Math.min(opening.height, maxHeight));
  return { id: opening.id, type: opening.type, variant, wallId, width, offset, height, sillHeight };
}

function normalizeSnapshot(snapshot: PlannerSnapshot): PlannerSnapshot {
  const room = ensureRoom(snapshot.room);
  const openings = snapshot.openings.map((o) => normalizeOpening(o as RoomOpening & { wall?: RoomWall }, room));
  const objects = snapshot.objects.map((o) => {
    const product = PRODUCTS[o.productId];
    if (!product) return o;
    const size = rotatedFootprint(product, o.rotationY);
    const nearest = findNearestValidPosition(room, size.width, size.depth, { x: o.x, z: o.z });
    return nearest ? { ...o, ...nearest } : o;
  });
  return { room, openings, objects };
}

function findSpawnPosition(productId: ProductKind, snapshot: PlannerSnapshot) {
  const product = PRODUCTS[productId];
  const bounds = roomBounds(snapshot.room.vertices);
  const moving: PlacedObject = {
    id: 'spawn',
    productId,
    x: (bounds.minX + bounds.maxX) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
    rotationY: 0
  };
  const step = 0.28;
  const centreX = moving.x;
  const centreZ = moving.z;

  for (let radius = 0; radius < 18; radius += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
        const rawX = centreX + dx * step;
        const rawZ = centreZ + dz * step;
        const result = resolvePlacement(moving, rawX, rawZ, snapshot.room, snapshot.objects, { enterSnapDistance: 0 });
        const candidate = { ...moving, x: result.x, z: result.z };
        if (!result.colliding && !snapshot.objects.some((o) => objectsOverlap(candidate, o, 0.01))) return { x: result.x, z: result.z };
      }
    }
  }

  const nearest = findNearestValidPosition(snapshot.room, product.width, product.depth, { x: centreX, z: centreZ });
  return nearest ?? { x: centreX, z: centreZ };
}

export const usePlannerStore = create<PlannerStore>((set, get) => ({
  room: defaultRoom,
  openings: defaultOpenings,
  objects: defaultObjects,
  mode: 'build',
  buildView: 'plan',
  planView: 'perspective',
  measurementSystem: 'metric',
  selectedId: null,
  selectedOpeningId: null,
  selectedWallId: null,
  activeSnap: { kind: 'none' },
  collisionId: null,
  collisionPush: false,
  showClearance: false,
  showRoomDimensions: false,
  showProductDimensions: false,
  showSpacingDimensions: false,

  setMode: (mode) => set({ mode, selectedId: null, selectedOpeningId: null, selectedWallId: null, activeSnap: { kind: 'none' }, collisionId: null }),
  setBuildView: (buildView) => set({ buildView }),
  setPlanView: (planView) => set({ planView }),
  setMeasurementSystem: (measurementSystem) => set({ measurementSystem }),
  setShowClearance: (showClearance) => set({ showClearance }),
  setShowRoomDimensions: (showRoomDimensions) => set({ showRoomDimensions }),
  setShowProductDimensions: (showProductDimensions) => set({ showProductDimensions }),
  setShowSpacingDimensions: (showSpacingDimensions) => set({ showSpacingDimensions }),

  addObject: (productId) => {
    const before = snapshotOf(get());
    const id = `${productId}-${crypto.randomUUID().slice(0, 8)}`;
    const pos = findSpawnPosition(productId, before);
    const object: PlacedObject = { id, productId, x: pos.x, z: pos.z, rotationY: 0 };
    set((state) => ({ objects: [...state.objects, object], selectedId: id, planView: 'perspective' }));
    history.push(before);
  },

  duplicateSelected: () => {
    const id = get().selectedId;
    const source = get().objects.find((o) => o.id === id);
    if (!source) return;
    const before = snapshotOf(get());
    const copy: PlacedObject = { ...source, id: `${source.productId}-${crypto.randomUUID().slice(0, 8)}` };
    const resolved = resolvePlacement(copy, source.x + 0.28, source.z + 0.28, get().room, get().objects, { enterSnapDistance: 0.06 });
    copy.x = resolved.x;
    copy.z = resolved.z;
    if (resolved.rotationY != null) copy.rotationY = resolved.rotationY;
    set((state) => ({ objects: [...state.objects, copy], selectedId: copy.id }));
    history.push(before);
  },

  select: (id) => set({ selectedId: id, selectedOpeningId: null, selectedWallId: null }),
  updateObject: (id, patch) => set((state) => ({ objects: state.objects.map((o) => o.id === id ? { ...o, ...patch } : o) })),
  commitSnapshot: (before) => {
    const current = snapshotOf(get());
    if (JSON.stringify(before) !== JSON.stringify(current)) history.push(before);
  },

  setRoom: (room) => set((state) => normalizeSnapshot({ room, openings: state.openings, objects: state.objects })),
  setRoomVertices: (vertices, shapeKind = 'custom') => set((state) => normalizeSnapshot({
    room: syncRoomBounds({ ...state.room, shapeKind }, vertices),
    openings: state.openings,
    objects: state.objects
  })),
  setRoomTemplate: (shape) => {
    const before = snapshotOf(get());
    const current = get().room;
    const room = ensureRoom({ ...current, shapeKind: shape, vertices: roomTemplate(shape, current.width, current.depth) });
    const normalized = normalizeSnapshot({ room, openings: [], objects: get().objects });
    set({ ...normalized, selectedOpeningId: null, selectedWallId: null });
    history.push(before);
  },
  updateRoom: (patch) => {
    const before = snapshotOf(get());
    let room = get().room;
    const nextWidth = patch.width == null ? room.width : Math.max(2.2, Math.min(patch.width, 20));
    const nextDepth = patch.depth == null ? room.depth : Math.max(2.2, Math.min(patch.depth, 20));
    if (patch.width != null || patch.depth != null) room = scaleRoom(room, nextWidth, nextDepth);
    room = ensureRoom({ ...room, ...patch, width: room.width, depth: room.depth, vertices: room.vertices });
    const normalized = normalizeSnapshot({ room, openings: get().openings, objects: get().objects });
    set(normalized);
    history.push(before);
  },
  resizeWallById: (id, length, recordHistory = true) => {
    const before = recordHistory ? snapshotOf(get()) : null;
    const vertices = resizeWallCentered(get().room, id, length);
    if (!vertices) return false;
    const normalized = normalizeSnapshot({ room: syncRoomBounds({ ...get().room, shapeKind: 'custom' }, vertices), openings: get().openings, objects: get().objects });
    set(normalized);
    if (before) history.push(before);
    return true;
  },
  splitWallById: (id) => {
    const room = get().room;
    const wall = getWall(room, id);
    if (!wall) return false;
    const before = snapshotOf(get());
    const newVertexId = `v-${crypto.randomUUID().slice(0, 8)}`;
    const vertices = splitWall(room, id, newVertexId);
    if (!vertices) return false;
    const nextRoom = syncRoomBounds({ ...room, shapeKind: 'custom' }, vertices);
    const walls = getRoomWalls(nextRoom);
    const firstId = `wall-${wall.start.id}-${newVertexId}`;
    const secondId = `wall-${newVertexId}-${wall.end.id}`;
    const half = wall.length / 2;
    const remapped = get().openings.map((opening) => {
      if (opening.wallId !== id) return opening;
      if (opening.offset <= half) return { ...opening, wallId: firstId };
      return { ...opening, wallId: secondId, offset: opening.offset - half };
    });
    const normalized = normalizeSnapshot({ room: nextRoom, openings: remapped, objects: get().objects });
    const newWalls = new Set(walls.map((candidate) => candidate.id));
    set({ ...normalized, selectedWallId: newWalls.has(firstId) ? firstId : null, selectedOpeningId: null });
    history.push(before);
    return true;
  },

  selectWall: (selectedWallId) => set({ selectedWallId, selectedOpeningId: null, selectedId: null }),

  rotateSelected: (direction = 1) => {
    const id = get().selectedId;
    const object = get().objects.find((o) => o.id === id);
    if (!object) return;
    const before = snapshotOf(get());
    const nextRotation = object.rotationY + direction * Math.PI / 2;
    const others = get().objects.filter((o) => o.id !== id);
    const probe = { ...object, rotationY: nextRotation };
    const resolved = resolvePlacement(probe, object.x, object.z, get().room, others, { enterSnapDistance: 0.08 });
    set((state) => ({ objects: state.objects.map((o) => o.id === id ? { ...o, rotationY: nextRotation, x: resolved.x, z: resolved.z } : o) }));
    history.push(before);
  },

  setSelectedRotation: (rotationY, recordHistory = true) => {
    const id = get().selectedId;
    const object = get().objects.find((o) => o.id === id);
    if (!object) return;
    const before = recordHistory ? snapshotOf(get()) : null;
    const twoPi = Math.PI * 2;
    const normalizedRotation = ((rotationY % twoPi) + twoPi) % twoPi;
    const others = get().objects.filter((o) => o.id !== id);
    const probe = { ...object, rotationY: normalizedRotation };
    const resolved = resolvePlacement(probe, object.x, object.z, get().room, others, { enterSnapDistance: 0 });
    set((state) => ({ objects: state.objects.map((o) => o.id === id ? { ...o, rotationY: normalizedRotation, x: resolved.x, z: resolved.z } : o) }));
    if (before) history.push(before);
  },

  removeSelected: () => {
    const id = get().selectedId;
    if (!id) return;
    const before = snapshotOf(get());
    set((state) => ({ objects: state.objects.filter((o) => o.id !== id), selectedId: null }));
    history.push(before);
  },

  addOpening: (type) => {
    const before = snapshotOf(get());
    let wall = get().selectedWallId ? getWall(get().room, get().selectedWallId!) : null;
    if (!wall) {
      const preferred = getRoomWalls(get().room).filter((w) => type === 'door' ? !w.horizontal : w.horizontal);
      wall = [...(preferred.length ? preferred : getRoomWalls(get().room))].sort((a, b) => b.length - a.length)[0] ?? null;
    }
    if (!wall) return;
    const variant = defaultOpeningVariant(type);
    const preset = openingPreset(type, variant, get().room);
    const opening: RoomOpening = normalizeOpening({
      id: `${type}-${crypto.randomUUID().slice(0, 8)}`,
      type,
      variant,
      wallId: wall.id,
      offset: wall.length / 2,
      ...preset
    }, get().room);
    set((state) => ({ openings: [...state.openings, opening], selectedOpeningId: opening.id, selectedWallId: wall!.id, selectedId: null }));
    history.push(before);
  },

  selectOpening: (id) => {
    const opening = get().openings.find((o) => o.id === id);
    set({ selectedOpeningId: id, selectedWallId: opening?.wallId ?? null, selectedId: null });
  },
  updateOpening: (id, patch, recordHistory = true) => {
    // Live opening drags/sliders call this with recordHistory=false. Avoid cloning the
    // complete project on every pointer event; the interaction already captured one
    // snapshot at drag start and commits it once on pointer-up.
    const before = recordHistory ? snapshotOf(get()) : null;
    set((state) => ({ openings: state.openings.map((o) => {
      if (o.id !== id) return o;
      const nextType = patch.type ?? o.type;
      const nextVariant = patch.variant ?? (patch.type && patch.type !== o.type ? defaultOpeningVariant(nextType) : o.variant);
      const shouldPreset = patch.variant != null || (patch.type != null && patch.type !== o.type);
      const preset = shouldPreset ? openingPreset(nextType, nextVariant, state.room) : {};
      return normalizeOpening({ ...o, ...preset, ...patch, type: nextType, variant: nextVariant }, state.room);
    }) }));
    if (before) history.push(before);
  },
  removeOpening: (id) => {
    const before = snapshotOf(get());
    set((state) => ({ openings: state.openings.filter((o) => o.id !== id), selectedOpeningId: state.selectedOpeningId === id ? null : state.selectedOpeningId }));
    history.push(before);
  },

  setFeedback: (activeSnap, collisionId = null, collisionPush = false) => set({ activeSnap, collisionId, collisionPush }),

  undo: () => {
    const current = snapshotOf(get());
    const next = history.undo(current);
    if (next) set({ ...normalizeSnapshot(next), selectedId: null, selectedOpeningId: null, selectedWallId: null, activeSnap: { kind: 'none' }, collisionId: null, collisionPush: false });
  },
  redo: () => {
    const current = snapshotOf(get());
    const next = history.redo(current);
    if (next) set({ ...normalizeSnapshot(next), selectedId: null, selectedOpeningId: null, selectedWallId: null, activeSnap: { kind: 'none' }, collisionId: null, collisionPush: false });
  },

  saveLocal: () => localStorage.setItem('room-planner-project-v3', JSON.stringify(snapshotOf(get()))),
  loadLocal: () => {
    const raw = localStorage.getItem('room-planner-project-v3') ?? localStorage.getItem('room-planner-project-v2') ?? localStorage.getItem('room-planner-project');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PlannerSnapshot> & { room?: Partial<RoomState>; openings?: Array<RoomOpening & { wall?: RoomWall }> };
      if (!parsed.room || !Array.isArray(parsed.objects)) return;
      const migratedObjects = parsed.objects
        .map((object) => {
          const legacyId = String(object.productId);
          const productId = (legacyId === 'table' ? 'dining-table' : legacyId) as ProductKind;
          return { ...object, productId };
        })
        .filter((object) => object.productId in PRODUCTS);
      const room = ensureRoom(parsed.room);
      const upgraded: PlannerSnapshot = {
        room,
        openings: Array.isArray(parsed.openings) ? parsed.openings.map((o) => normalizeOpening(o, room)) : [],
        objects: migratedObjects
      };
      set({ ...normalizeSnapshot(upgraded), selectedId: null, selectedOpeningId: null, selectedWallId: null, activeSnap: { kind: 'none' }, collisionId: null });
    } catch {
      // Ignore malformed local data in the prototype.
    }
  },

  resetProject: () => {
    const before = snapshotOf(get());
    set({
      room: structuredClone(defaultRoom),
      openings: structuredClone(defaultOpenings),
      objects: [],
      selectedId: null,
      selectedOpeningId: null,
      selectedWallId: null,
      activeSnap: { kind: 'none' },
      collisionId: null,
      collisionPush: false,
      mode: 'build',
      buildView: 'plan',
      planView: 'perspective'
    });
    history.push(before);
  }
}));

export const getSnapshot = (): PlannerSnapshot => snapshotOf(usePlannerStore.getState());
