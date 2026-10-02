import { createHotStore } from './core/hotStore';
import type { AiApplyResult, AiProposal } from './ai/types';
import { applyAiProposal as executeAiProposal, snapshotRevision } from './core/aiProposal';
import { PRODUCTS, rotatedFootprint } from './core/products';
import { isPlacementValid, objectsOverlap, overlapsInteriorWall, resolvePlacement, resolveRotationPlacement } from './core/placement';
import { SnapshotHistory } from './core/history';
import { architectureRoom, deriveSpaces, resolveDividers, spaceAtPoint, validateDividers, validateInteriorOpenings } from './core/spaces';
import { normalizeFloorFinish } from './core/roomFinishes';
import { BASEBOARD_STYLES } from './core/architecturalStyles';
import { clampSunAngle, normalizeSunAzimuth, SUN_DEFAULT_AZIMUTH, SUN_DEFAULT_ELEVATION, SUN_ELEVATION_MAX, SUN_ELEVATION_MIN } from './core/sun';
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
  UnplacedObject,
  ProductKind,
  RoomOpening,
  RoomShapeKind,
  RoomState,
  RoomVertex,
  RoomWall,
  SnapFeedback,
  BuildWorkspaceView,
  PlanCameraView,
  MeasurementSystem,
  RoomLighting,
  SunStylePreset,
  InteriorDivider,
  NamedSpace,
  DividerAnchor
} from './core/types';

interface PlannerStore extends PlannerSnapshot {
  mode: AppMode;
  buildView: BuildWorkspaceView;
  planView: PlanCameraView;
  interiorWallView: 'up' | 'down';
  measurementSystem: MeasurementSystem;
  selectedId: string | null;
  selectedOpeningId: string | null;
  selectedWallId: string | null;
  selectedDividerId: string | null;
  selectedSpaceId: string | null;
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
  setInteriorWallView: (view: 'up' | 'down') => void;
  setMeasurementSystem: (system: MeasurementSystem) => void;
  setShowClearance: (show: boolean) => void;
  setShowRoomDimensions: (show: boolean) => void;
  setShowProductDimensions: (show: boolean) => void;
  setShowSpacingDimensions: (show: boolean) => void;
  setRoomLighting: (patch: Partial<RoomLighting>, recordHistory?: boolean) => void;

  addObject: (productId: ProductKind) => void;
  placeUnplacedObject: (id: string) => void;
  removeFurniture: (id: string) => void;
  duplicateSelected: () => void;
  select: (id: string | null) => void;
  updateObject: (id: string, patch: Partial<PlacedObject>) => void;
  commitSnapshot: (before: PlannerSnapshot) => void;
  applyAiProposal: (proposal: AiProposal) => AiApplyResult;
  setRoom: (room: RoomState) => void;
  setRoomVertices: (vertices: RoomVertex[], shapeKind?: RoomShapeKind) => void;
  setRoomTemplate: (shape: Exclude<RoomShapeKind, 'custom'>) => void;
  updateRoom: (patch: Partial<RoomState>) => void;
  resizeWallById: (wallId: string, length: number, recordHistory?: boolean) => boolean;
  splitWallById: (wallId: string) => boolean;
  selectWall: (id: string | null) => void;
  selectDivider: (id: string | null) => void;
  selectSpace: (id: string | null) => void;
  addDivider: (kind: InteriorDivider['kind'], start: DividerAnchor, end: DividerAnchor) => boolean;
  updateDivider: (id: string, patch: Partial<InteriorDivider>, recordHistory?: boolean) => boolean;
  removeDivider: (id: string) => void;
  updateSpace: (id: string, patch: Partial<NamedSpace>) => void;
  syncSpaces: (before: PlannerSnapshot) => void;
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
  loadLocal: () => boolean;
  resetProject: () => void;
}

// Lazy 2D/3D views and renderer bridges must retain the same store after HMR.
// Preserve history alongside the store, then refresh action implementations below.
const history: SnapshotHistory = import.meta.hot?.data.history ?? new SnapshotHistory();
const initialVertices = roomTemplate('rectangle', 5.2, 3.8);
const defaultRoom: RoomState = {
  width: 5.2,
  depth: 3.8,
  height: 2.6,
  wallColor: '#f2f2f3',
  ceilingColor: '#f2f2f3',
  baseboardColor: '#f2f2f3',
  baseboardStyle: 'flat',
  baseboardMaterial: 'paint',
  floorFinish: 'carpet-011',
  lighting: {
    enabled: true,
    sunRaysEnabled: true,
    sunStylePreset: 'paired-suns',
    sunAzimuth: SUN_DEFAULT_AZIMUTH,
    sunElevation: SUN_DEFAULT_ELEVATION
  },
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
const defaultSpaces: NamedSpace[] = [{ id: 'space-1', name: 'Room', seed: { x: 2.6, z: 1.9 }, floorFinish: defaultRoom.floorFinish, wallColor: defaultRoom.wallColor }];

const snapshotOf = (state: PlannerSnapshot): PlannerSnapshot => ({
  room: structuredClone(state.room),
  openings: structuredClone(state.openings),
  dividers: structuredClone(state.dividers),
  spaces: structuredClone(state.spaces),
  objects: structuredClone(state.objects),
  unplacedObjects: structuredClone(state.unplacedObjects)
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
  // Preserve the rendered appearance of projects saved before the style names
  // were corrected. The old "cinematic-grade" value enabled the paired-suns
  // environment; "paired-shadows" selected the shadows-only style.
  const savedSunStyle = raw.lighting?.sunStylePreset as string | undefined;
  const sunStylePreset: SunStylePreset = savedSunStyle === 'cinematic-grade' || savedSunStyle === 'paired-suns'
    ? 'paired-suns'
    : 'cinematic-shadows';
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
    height: Math.max(1, Math.min(Number(raw.height) || defaultRoom.height, 3.3)),
    wallColor: typeof raw.wallColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.wallColor) ? raw.wallColor : defaultRoom.wallColor,
    ceilingColor: typeof raw.ceilingColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.ceilingColor) ? raw.ceilingColor : defaultRoom.ceilingColor,
    baseboardColor: typeof raw.baseboardColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.baseboardColor) ? raw.baseboardColor : defaultRoom.baseboardColor,
    baseboardStyle: BASEBOARD_STYLES.some((style) => style.id === raw.baseboardStyle) ? raw.baseboardStyle : defaultRoom.baseboardStyle,
    // Older projects stored this option as "terrazzo". Keep those projects
    // compatible, but the option now means "match the selected floor material".
    baseboardMaterial: (raw as { baseboardMaterial?: unknown }).baseboardMaterial === 'materials'
      || (raw as { baseboardMaterial?: unknown }).baseboardMaterial === 'terrazzo'
      ? 'materials'
      : 'paint',
    floorFinish: normalizeFloorFinish(raw.floorFinish),
    lighting: {
      enabled: typeof raw.lighting?.enabled === 'boolean' ? raw.lighting.enabled : defaultRoom.lighting.enabled,
      sunRaysEnabled: typeof raw.lighting?.sunRaysEnabled === 'boolean'
        ? raw.lighting.sunRaysEnabled
        : defaultRoom.lighting.sunRaysEnabled,
      sunStylePreset,
      sunAzimuth: normalizeSunAzimuth(raw.lighting?.sunAzimuth),
      sunElevation: clampSunAngle(raw.lighting?.sunElevation, SUN_DEFAULT_ELEVATION, SUN_ELEVATION_MIN, SUN_ELEVATION_MAX)
    },
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
  if (variant === 'single-hung-window') return { width: 1.2, height: 1.35, sillHeight: 0.8 };
  if (variant === 'full-height-window') return { width: 1.2, height: Math.max(0.6, room.height), sillHeight: 0 };
  if (variant === 'high-window') return { width: 1.35, height: 0.65, sillHeight: Math.max(0.7, room.height - 0.85) };
  if (variant === 'sliding-window') return { width: 2.4, height: Math.max(0.6, room.height), sillHeight: 0 };
  if (variant === 'double-door') return { width: 1.6, height: 2.08, sillHeight: 0 };
  if (variant === 'door-frame') return { width: 0.95, height: 2.1, sillHeight: 0 };
  if (variant === 'glass-door') return { width: 0.9, height: 2.08, sillHeight: 0 };
  if (variant === 'semi-glass-door') return { width: 0.9, height: 2.08, sillHeight: 0 };
  if (variant === 'glass-double-door') return { width: 1.6, height: 2.08, sillHeight: 0 };
  if (variant === 'wall-opening') return { width: 1.2, height: 1.2, sillHeight: 0.75 };
  if (variant === 'single-door') return { width: 0.9, height: 2.08, sillHeight: 0 };
  return { width: 1.2, height: 1.2, sillHeight: 0.85 };
}

function normalizeOpening(opening: RoomOpening & { wall?: RoomWall }, room: RoomState, dividers: InteriorDivider[] = []): RoomOpening {
  let wallId = opening.wallId;
  if (!getWall(room, wallId) && opening.wall) wallId = cardinalWallId(room, opening.wall) ?? '';
  let wall: { id: string; length: number } | null = getWall(room, wallId);
  if (!wall && opening.type !== 'window') wall = resolveDividers(room, dividers).find((divider) => divider.id === wallId && divider.kind === 'wall') ?? null;
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
  const forcedFloor = opening.type === 'door' || (opening.type === 'opening' && wallId.startsWith('divider-'))
    || variant === 'full-height-window' || variant === 'sliding-window';
  const sillHeight = forcedFloor ? 0 : Math.max(0, opening.sillHeight);
  const maxHeight = Math.max(minHeight, room.height - sillHeight);
  const height = Math.max(minHeight, Math.min(opening.height, maxHeight));
  return { id: opening.id, type: opening.type, variant, wallId, width, offset, height, sillHeight,
    ...(opening.type === 'door' && opening.doorFlipped != null ? { doorFlipped: opening.doorFlipped === true } : {}) };
}

function normalizeSnapshot(snapshot: Omit<PlannerSnapshot, 'dividers' | 'spaces'> & Partial<Pick<PlannerSnapshot, 'dividers' | 'spaces'>>): PlannerSnapshot {
  const room = ensureRoom(snapshot.room);
  const dividers = (snapshot.dividers ?? usePlannerStore.getState()?.dividers ?? []).filter((divider) => divider && (divider.kind === 'wall' || divider.kind === 'open'));
  const spaces = (snapshot.spaces ?? usePlannerStore.getState()?.spaces ?? defaultSpaces).map((space) => ({
    id: space.id, name: space.name || 'Space', seed: space.seed, boundaryKey: space.boundaryKey,
    floorFinish: normalizeFloorFinish(space.floorFinish), wallColor: /^#[0-9a-f]{6}$/i.test(space.wallColor) ? space.wallColor : room.wallColor
  }));
  const wallIds = new Set([...getRoomWalls(room).map((wall) => wall.id), ...dividers.filter((divider) => divider.kind === 'wall').map((divider) => divider.id)]);
  const openings = snapshot.openings.filter((opening) => (wallIds.has(opening.wallId) || (!opening.wallId && (opening as RoomOpening & { wall?: RoomWall }).wall)) && (opening.type !== 'window' || !opening.wallId?.startsWith('divider-')))
    .map((o) => normalizeOpening(o as RoomOpening & { wall?: RoomWall }, room, dividers));
  const objects = snapshot.objects.map((o) => {
    const product = PRODUCTS[o.productId];
    if (!product) return o;
    const size = rotatedFootprint(product, o.rotationY);
    const nearest = findNearestValidPosition(room, size.width, size.depth, { x: o.x, z: o.z });
    return nearest ? { ...o, ...nearest } : o;
  });
  return { room, openings, dividers, spaces, objects, unplacedObjects: snapshot.unplacedObjects };
}

function validInteriorArchitecture(snapshot: PlannerSnapshot) {
  return validateInteriorOpenings(snapshot.room, snapshot.dividers, snapshot.openings)
    && snapshot.objects.every((object) => isPlacementValid(object, architectureRoom(snapshot), []));
}

function findSpawnPosition(productId: ProductKind, snapshot: PlannerSnapshot) {
  const bounds = roomBounds(snapshot.room.vertices);
  const room = architectureRoom(snapshot);
  const moving: PlacedObject = {
    id: 'spawn',
    productId,
    x: (bounds.minX + bounds.maxX) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
    rotationY: 0
  };
  const step = 0.1;
  const centreX = moving.x;
  const centreZ = moving.z;
  const fits = (x: number, z: number) => isPlacementValid({ ...moving, x, z }, room, snapshot.objects);

  const maxRadius = Math.ceil(Math.max(bounds.width, bounds.depth) / (2 * step));
  // Prefer a clear initial position anywhere in the shell. If no such point
  // exists, dividers may be crossed just as they can during furniture dragging.
  for (const avoidWalls of [true, false]) {
    for (let radius = 0; radius <= maxRadius; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
          const x = centreX + dx * step;
          const z = centreZ + dz * step;
          if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
          if (fits(x, z) && (!avoidWalls || !overlapsInteriorWall({ ...moving, x, z }, room))) return { x, z };
        }
      }
    }
  }

  return null;
}

export const usePlannerStore = createHotStore<PlannerStore>((set, get) => ({
  room: defaultRoom,
  openings: defaultOpenings,
  dividers: [],
  spaces: defaultSpaces,
  objects: defaultObjects,
  unplacedObjects: [],
  mode: 'build',
  buildView: 'plan',
  planView: 'free',
  interiorWallView: 'up',
  measurementSystem: 'metric',
  selectedId: null,
  selectedOpeningId: null,
  selectedWallId: null,
  selectedDividerId: null,
  selectedSpaceId: null,
  activeSnap: { kind: 'none' },
  collisionId: null,
  collisionPush: false,
  showClearance: false,
  showRoomDimensions: false,
  showProductDimensions: false,
  showSpacingDimensions: false,

  setMode: (mode) => set((state) => ({
    mode,
    planView: mode === 'plan' && state.mode !== 'plan' ? 'free' : state.planView,
    selectedId: null,
    selectedOpeningId: null,
    selectedWallId: null,
    selectedDividerId: null,
    selectedSpaceId: mode === 'plan' ? state.selectedSpaceId ?? state.spaces[0]?.id ?? null : null,
    activeSnap: { kind: 'none' },
    collisionId: null
  })),
  setBuildView: (buildView) => set({ buildView }),
  setPlanView: (planView) => set({ planView }),
  setInteriorWallView: (interiorWallView) => set({ interiorWallView }),
  setMeasurementSystem: (measurementSystem) => set({ measurementSystem }),
  setShowClearance: (showClearance) => set({ showClearance }),
  setShowRoomDimensions: (showRoomDimensions) => set({ showRoomDimensions }),
  setShowProductDimensions: (showProductDimensions) => set({ showProductDimensions }),
  setShowSpacingDimensions: (showSpacingDimensions) => set({ showSpacingDimensions }),
  setRoomLighting: (patch, recordHistory = true) => {
    const before = recordHistory ? snapshotOf(get()) : null;
    set((state) => ({ room: ensureRoom({ ...state.room, lighting: { ...state.room.lighting, ...patch } }) }));
    if (before) history.push(before);
  },

  addObject: (productId) => {
    const before = snapshotOf(get());
    const id = `${productId}-${crypto.randomUUID().slice(0, 8)}`;
    const pos = findSpawnPosition(productId, before);
    if (!pos) {
      set((state) => ({ unplacedObjects: [...state.unplacedObjects, { id, productId }] }));
      history.push(before);
      return;
    }
    const object: PlacedObject = { id, productId, x: pos.x, z: pos.z, rotationY: 0 };
    set((state) => ({ objects: [...state.objects, object], selectedId: id,
      selectedSpaceId: spaceAtPoint(before, object)?.id ?? state.selectedSpaceId }));
    history.push(before);
  },

  placeUnplacedObject: (id) => {
    const item = get().unplacedObjects.find((object) => object.id === id);
    if (!item) return;
    const before = snapshotOf(get());
    const pos = findSpawnPosition(item.productId, before);
    if (!pos) return;
    const object: PlacedObject = { ...item, x: pos.x, z: pos.z, rotationY: 0 };
    set((state) => ({
      objects: [...state.objects, object],
      unplacedObjects: state.unplacedObjects.filter((candidate) => candidate.id !== id),
      selectedId: id,
      selectedSpaceId: spaceAtPoint(before, object)?.id ?? state.selectedSpaceId
    }));
    history.push(before);
  },

  removeFurniture: (id) => {
    if (!get().objects.some((object) => object.id === id) && !get().unplacedObjects.some((object) => object.id === id)) return;
    const before = snapshotOf(get());
    set((state) => ({
      objects: state.objects.filter((object) => object.id !== id),
      unplacedObjects: state.unplacedObjects.filter((object) => object.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId
    }));
    history.push(before);
  },

  duplicateSelected: () => {
    const id = get().selectedId;
    const source = get().objects.find((o) => o.id === id);
    if (!source) return;
    const before = snapshotOf(get());
    const copy: PlacedObject = { ...source, id: `${source.productId}-${crypto.randomUUID().slice(0, 8)}` };
    const resolved = resolvePlacement(copy, source.x + 0.28, source.z + 0.28, architectureRoom(get()), get().objects, { enterSnapDistance: 0.06 });
    copy.x = resolved.x;
    copy.z = resolved.z;
    if (resolved.rotationY != null) copy.rotationY = resolved.rotationY;
    set((state) => ({ objects: [...state.objects, copy], selectedId: copy.id }));
    history.push(before);
  },

  select: (id) => set((state) => {
    const object = state.objects.find((object) => object.id === id);
    return { selectedId: id, selectedOpeningId: null, selectedWallId: null, selectedDividerId: null,
      selectedSpaceId: object ? spaceAtPoint(snapshotOf(state), object)?.id ?? state.selectedSpaceId : state.selectedSpaceId };
  }),
  updateObject: (id, patch) => set((state) => ({ objects: state.objects.map((o) => o.id === id ? { ...o, ...patch } : o) })),
  commitSnapshot: (before) => {
    const current = snapshotOf(get());
    if (JSON.stringify(before) !== JSON.stringify(current)) {
      history.push(before);
      const selected = current.objects.find((object) => object.id === get().selectedId);
      if (selected) set({ selectedSpaceId: spaceAtPoint(current, selected)?.id ?? get().selectedSpaceId });
    }
  },
  applyAiProposal: (proposal) => {
    const before = snapshotOf(get());
    if (snapshotRevision(before) !== proposal.baseRevision) {
      return { ok: false, error: 'The room changed after this proposal was created. Ask the AI to try again.' };
    }
    const result = executeAiProposal(before, proposal);
    if (result.error) return { ok: false, error: result.error };
    set({
      ...result.snapshot,
      selectedId: null,
      selectedOpeningId: null,
      selectedWallId: null,
      activeSnap: { kind: 'none' },
      collisionId: null,
      collisionPush: false
    });
    history.push(before);
    return { ok: true };
  },

  setRoom: (room) => set((state) => normalizeSnapshot({ room, openings: state.openings, objects: state.objects, unplacedObjects: state.unplacedObjects })),
  setRoomVertices: (vertices, shapeKind = 'custom') => {
    const state = get();
    if (state.room.shapeKind === shapeKind && vertices.length === state.room.vertices.length
      && vertices.every((vertex, index) => vertex.id === state.room.vertices[index].id
        && vertex.x === state.room.vertices[index].x && vertex.z === state.room.vertices[index].z)) return;
    const room = syncRoomBounds({ ...state.room, shapeKind }, vertices);
    if (!validateDividers(room, state.dividers)) return;
    const candidate = normalizeSnapshot({ room, openings: state.openings, dividers: state.dividers, spaces: state.spaces,
      objects: state.objects, unplacedObjects: state.unplacedObjects });
    if (!validInteriorArchitecture(candidate)) return;
    if (!candidate.objects.every((object) => isPlacementValid(object, architectureRoom(candidate), candidate.objects.filter((other) => other.id !== object.id)))) return;
    set(candidate);
  },
  setRoomTemplate: (shape) => {
    const before = snapshotOf(get());
    const current = get().room;
    const room = ensureRoom({ ...current, shapeKind: shape, vertices: roomTemplate(shape, current.width, current.depth) });
    const currentObjects = get().objects;
    const normalized = normalizeSnapshot({
      room,
      openings: [],
      dividers: [],
      spaces: before.spaces,
      objects: [],
      unplacedObjects: [
        ...get().unplacedObjects,
        ...currentObjects.map(({ id, productId }): UnplacedObject => ({ id, productId }))
      ]
    });
    set({ ...normalized, selectedId: null, selectedOpeningId: null, selectedWallId: null, selectedDividerId: null, selectedSpaceId: null, activeSnap: { kind: 'none' }, collisionId: null, collisionPush: false });
    get().syncSpaces(before);
  },
  updateRoom: (patch) => {
    const before = snapshotOf(get());
    let room = get().room;
    const nextWidth = patch.width == null ? room.width : Math.max(2.2, Math.min(patch.width, 20));
    const nextDepth = patch.depth == null ? room.depth : Math.max(2.2, Math.min(patch.depth, 20));
    if (patch.width != null || patch.depth != null) room = scaleRoom(room, nextWidth, nextDepth);
    room = ensureRoom({ ...room, ...patch, width: room.width, depth: room.depth, vertices: room.vertices });
    if (!validateDividers(room, get().dividers)) return;
    const normalized = normalizeSnapshot({ room, openings: get().openings, objects: get().objects, unplacedObjects: get().unplacedObjects });
    if (!validInteriorArchitecture(normalized)) return;
    if (!normalized.objects.every((object) => isPlacementValid(object, architectureRoom(normalized), normalized.objects.filter((other) => other.id !== object.id)))) return;
    set(normalized);
    if (patch.width != null || patch.depth != null) get().syncSpaces(before);
    else history.push(before);
  },
  resizeWallById: (id, length, recordHistory = true) => {
    const before = recordHistory ? snapshotOf(get()) : null;
    const vertices = resizeWallCentered(get().room, id, length);
    if (!vertices) return false;
    const room = syncRoomBounds({ ...get().room, shapeKind: 'custom' }, vertices);
    if (!validateDividers(room, get().dividers)) return false;
    const normalized = normalizeSnapshot({ room, openings: get().openings, objects: get().objects, unplacedObjects: get().unplacedObjects });
    if (!validInteriorArchitecture(normalized)) return false;
    if (!normalized.objects.every((object) => isPlacementValid(object, architectureRoom(normalized), normalized.objects.filter((other) => other.id !== object.id)))) return false;
    set(normalized);
    if (before) get().syncSpaces(before);
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
    const remappedDividers = get().dividers.map((divider) => {
      const remap = (anchor: DividerAnchor): DividerAnchor => {
        if (anchor.kind !== 'perimeter' || anchor.id !== id) return anchor;
        return anchor.t <= 0.5
          ? { ...anchor, id: firstId, t: anchor.t * 2 }
          : { ...anchor, id: secondId, t: (anchor.t - 0.5) * 2 };
      };
      return { ...divider, start: remap(divider.start), end: remap(divider.end) };
    });
    if (!validateDividers(nextRoom, remappedDividers)) return false;
    const normalized = normalizeSnapshot({ room: nextRoom, openings: remapped, dividers: remappedDividers, spaces: get().spaces, objects: get().objects, unplacedObjects: get().unplacedObjects });
    const newWalls = new Set(walls.map((candidate) => candidate.id));
    set({ ...normalized, selectedWallId: newWalls.has(firstId) ? firstId : null, selectedOpeningId: null });
    history.push(before);
    return true;
  },

  selectWall: (selectedWallId) => set({ selectedWallId, selectedDividerId: null, selectedSpaceId: null, selectedOpeningId: null, selectedId: null }),
  selectDivider: (selectedDividerId) => set({ selectedDividerId, selectedWallId: null, selectedSpaceId: null, selectedOpeningId: null, selectedId: null }),
  selectSpace: (selectedSpaceId) => set({ selectedSpaceId, selectedDividerId: null, selectedWallId: null, selectedOpeningId: null, selectedId: null }),
  addDivider: (kind, start, end) => {
    const before = snapshotOf(get());
    const divider: InteriorDivider = { id: `divider-${crypto.randomUUID().slice(0, 8)}`, kind, start, end };
    const dividers = [...get().dividers, divider];
    if (!validateDividers(get().room, dividers) || deriveSpaces({ ...before, dividers }).length <= deriveSpaces(before).length) return false;
    if (!validInteriorArchitecture({ ...before, dividers })) return false;
    if (!before.objects.every((object) => isPlacementValid(object, architectureRoom({ ...before, dividers }), before.objects.filter((other) => other.id !== object.id)))) return false;
    set({ dividers, selectedDividerId: divider.id, selectedSpaceId: null, selectedWallId: null, selectedOpeningId: null });
    get().syncSpaces(before);
    return true;
  },
  updateDivider: (id, patch, recordHistory = true) => {
    const before = recordHistory ? snapshotOf(get()) : null;
    const dividers = get().dividers.map((divider) => divider.id === id ? { ...divider, ...patch, id } : divider);
    if (JSON.stringify(dividers) === JSON.stringify(get().dividers)) return true;
    if (!validateDividers(get().room, dividers)) return false;
    if (patch.kind === 'open' && get().openings.some((opening) => opening.wallId === id)) return false;
    const candidate = normalizeSnapshot({ ...get(), dividers });
    if (!validInteriorArchitecture(candidate)) return false;
    if (!candidate.objects.every((object) => isPlacementValid(object, architectureRoom(candidate), candidate.objects.filter((other) => other.id !== object.id)))) return false;
    set({ dividers, openings: candidate.openings });
    if (before) get().syncSpaces(before);
    return true;
  },
  removeDivider: (id) => {
    const before = snapshotOf(get());
    const removed = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const divider of get().dividers) if (!removed.has(divider.id) && (removed.has(divider.start.id) || removed.has(divider.end.id))) { removed.add(divider.id); changed = true; }
    }
    set({ dividers: get().dividers.filter((divider) => !removed.has(divider.id)), openings: get().openings.filter((opening) => !removed.has(opening.wallId)), selectedDividerId: null });
    get().syncSpaces(before);
  },
  updateSpace: (id, patch) => {
    const before = snapshotOf(get());
    set({ spaces: get().spaces.map((space) => space.id === id ? { ...space, ...patch, id } : space) });
    history.push(before);
  },
  syncSpaces: (before) => {
    const current = snapshotOf(get());
    const derived = deriveSpaces(current);
    const usedNames = new Set(derived.filter((space) => !space.id.startsWith('unassigned-')).map((space) => space.name));
    let nextName = 1;
    const spaces = derived.map((space) => {
      const isNew = space.id.startsWith('unassigned-');
      const parent = isNew ? spaceAtPoint(before, space.seed) : null;
      while (usedNames.has(`Space ${nextName}`)) nextName++;
      const name = isNew ? `Space ${nextName++}` : space.name;
      usedNames.add(name);
      return { id: isNew ? `space-${crypto.randomUUID().slice(0, 8)}` : space.id,
        name, seed: space.seed, boundaryKey: space.boundaryKey,
        floorFinish: parent?.floorFinish ?? space.floorFinish, wallColor: parent?.wallColor ?? space.wallColor };
    });
    set({ spaces, selectedSpaceId: spaces.some((space) => space.id === get().selectedSpaceId) ? get().selectedSpaceId : null });
    if (JSON.stringify(before) !== JSON.stringify(snapshotOf(get()))) history.push(before);
  },

  rotateSelected: (direction = 1) => {
    const id = get().selectedId;
    const object = get().objects.find((o) => o.id === id);
    if (!object) return;
    const before = snapshotOf(get());
    const nextRotation = object.rotationY + direction * Math.PI / 2;
    const others = get().objects.filter((o) => o.id !== id);
    const resolved = resolveRotationPlacement(object, nextRotation, architectureRoom(get()), others);
    set((state) => ({
      objects: state.objects.map((o) => o.id === id ? { ...o, rotationY: resolved.rotationY } : o),
      activeSnap: { kind: 'none' },
      collisionId: resolved.colliding ? id : null,
      collisionPush: false
    }));
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
    const resolved = resolveRotationPlacement(object, normalizedRotation, architectureRoom(get()), others);
    set((state) => ({
      objects: state.objects.map((o) => o.id === id ? { ...o, rotationY: resolved.rotationY } : o),
      activeSnap: { kind: 'none' },
      collisionId: resolved.colliding ? id : null,
      collisionPush: false
    }));
    if (before) history.push(before);
  },

  removeSelected: () => {
    const id = get().selectedId;
    if (!id) return;
    get().removeFurniture(id);
  },

  addOpening: (type) => {
    const before = snapshotOf(get());
    let wall: { id: string; length: number } | null = type !== 'window' && get().selectedDividerId
      ? resolveDividers(get().room, get().dividers).find((divider) => divider.id === get().selectedDividerId && divider.kind === 'wall') ?? null
      : get().selectedWallId ? getWall(get().room, get().selectedWallId!) : null;
    if (!wall) {
      const preferred = getRoomWalls(get().room).filter((w) => type === 'door' ? !w.horizontal : w.horizontal);
      wall = [...(preferred.length ? preferred : getRoomWalls(get().room))].sort((a, b) => b.length - a.length)[0] ?? null;
    }
    if (!wall) return;
    const variant = defaultOpeningVariant(type);
    const preset = openingPreset(type, variant, get().room);
    if (type === 'opening' && wall.id.startsWith('divider-')) { preset.height = Math.min(get().room.height, 2.1); preset.sillHeight = 0; }
    const opening: RoomOpening = normalizeOpening({
      id: `${type}-${crypto.randomUUID().slice(0, 8)}`,
      type,
      variant,
      wallId: wall.id,
      offset: wall.length / 2,
      ...preset
    }, get().room, get().dividers);
    if (wall.id.startsWith('divider-')) {
      const possible = Array.from({ length: Math.ceil(wall.length / 0.05) + 1 }, (_, index) => index * 0.05)
        .sort((a, b) => Math.abs(a - wall!.length / 2) - Math.abs(b - wall!.length / 2));
      const offset = possible.find((value) => validateInteriorOpenings(get().room, get().dividers, [...get().openings, { ...opening, offset: value }]));
      if (offset == null) return;
      opening.offset = offset;
    }
    set((state) => ({ openings: [...state.openings, opening], selectedOpeningId: opening.id, selectedWallId: wall!.id, selectedId: null }));
    history.push(before);
  },

  selectOpening: (id) => {
    const opening = get().openings.find((o) => o.id === id);
    set({ selectedOpeningId: id, selectedWallId: opening?.wallId ?? null,
      selectedDividerId: opening?.wallId.startsWith('divider-') ? opening.wallId : null, selectedSpaceId: null, selectedId: null });
  },
  updateOpening: (id, patch, recordHistory = true) => {
    // Live opening drags/sliders call this with recordHistory=false. Avoid cloning the
    // complete project on every pointer event; the interaction already captured one
    // snapshot at drag start and commits it once on pointer-up.
    const before = recordHistory ? snapshotOf(get()) : null;
    const state = get();
    const openings = state.openings.map((o) => {
      if (o.id !== id) return o;
      const nextType = patch.type ?? o.type;
      if (nextType === 'window' && (patch.wallId ?? o.wallId).startsWith('divider-')) return o;
      const nextVariant = patch.variant ?? (patch.type && patch.type !== o.type ? defaultOpeningVariant(nextType) : o.variant);
      const shouldPreset = patch.variant != null || (patch.type != null && patch.type !== o.type);
      const preset: Partial<Pick<RoomOpening, 'width' | 'height' | 'sillHeight'>> = shouldPreset ? openingPreset(nextType, nextVariant, state.room) : {};
      if (nextType === 'opening' && o.wallId.startsWith('divider-') && shouldPreset) {
        preset.height = Math.min(state.room.height, 2.1);
        preset.sillHeight = 0;
      }
      return normalizeOpening({ ...o, ...preset, ...patch, type: nextType, variant: nextVariant }, state.room, state.dividers);
    });
    if (openings.every((opening, index) => {
      const previous = state.openings[index];
      return Object.entries(opening).every(([key, value]) => value === previous[key as keyof RoomOpening])
        && Object.entries(previous).every(([key, value]) => value === opening[key as keyof RoomOpening]);
    })) return;
    // Moving an aperture cannot change the divider network or furniture bounds.
    if (!validateInteriorOpenings(state.room, state.dividers, openings)) return;
    set({ openings });
    if (before) history.push(before);
  },
  removeOpening: (id) => {
    const before = snapshotOf(get());
    const openings = get().openings.filter((o) => o.id !== id);
    if (!validInteriorArchitecture({ ...before, openings })) return;
    set((state) => ({ openings, selectedOpeningId: state.selectedOpeningId === id ? null : state.selectedOpeningId }));
    history.push(before);
  },

  setFeedback: (activeSnap, collisionId = null, collisionPush = false) => set({ activeSnap, collisionId, collisionPush }),

  undo: () => {
    const current = snapshotOf(get());
    const next = history.undo(current);
    if (next) set({ ...normalizeSnapshot(next), selectedId: null, selectedOpeningId: null, selectedWallId: null, selectedDividerId: null, selectedSpaceId: null, activeSnap: { kind: 'none' }, collisionId: null, collisionPush: false });
  },
  redo: () => {
    const current = snapshotOf(get());
    const next = history.redo(current);
    if (next) set({ ...normalizeSnapshot(next), selectedId: null, selectedOpeningId: null, selectedWallId: null, selectedDividerId: null, selectedSpaceId: null, activeSnap: { kind: 'none' }, collisionId: null, collisionPush: false });
  },

  saveLocal: () => localStorage.setItem('room-planner-project-v4', JSON.stringify(snapshotOf(get()))),
  loadLocal: () => {
    const raw = localStorage.getItem('room-planner-project-v4') ?? localStorage.getItem('room-planner-project-v3') ?? localStorage.getItem('room-planner-project-v2') ?? localStorage.getItem('room-planner-project');
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as Partial<PlannerSnapshot> & { room?: Partial<RoomState>; openings?: Array<RoomOpening & { wall?: RoomWall }> };
      if (!parsed.room || !Array.isArray(parsed.objects)) return false;
      if (parsed.spaces != null && (!Array.isArray(parsed.spaces) || !parsed.spaces.every((space) => space
        && typeof space.id === 'string' && typeof space.name === 'string' && space.seed
        && Number.isFinite(space.seed.x) && Number.isFinite(space.seed.z))
        || new Set(parsed.spaces.map((space) => space.id)).size !== parsed.spaces.length)) return false;
      if (parsed.openings != null && (!Array.isArray(parsed.openings) || !parsed.openings.every((opening) => opening
        && typeof opening.id === 'string' && ['door', 'window', 'opening'].includes(opening.type)
        && Number.isFinite(opening.width) && opening.width > 0 && Number.isFinite(opening.height) && opening.height > 0
        && Number.isFinite(opening.offset) && Number.isFinite(opening.sillHeight) && opening.sillHeight >= 0
        && (opening.doorFlipped == null || typeof opening.doorFlipped === 'boolean')))) return false;
      const migratedObjects = parsed.objects
        .map((object) => {
          const legacyId = String(object.productId);
          const productId = (legacyId === 'table' ? 'dining-table' : legacyId) as ProductKind;
          return { ...object, productId };
        })
        .filter((object) => object.productId in PRODUCTS);
      const unplacedObjects = Array.isArray(parsed.unplacedObjects)
        ? parsed.unplacedObjects.filter((object): object is UnplacedObject =>
          typeof object?.id === 'string' && typeof object?.productId === 'string' && object.productId in PRODUCTS
            && !migratedObjects.some((placed) => placed.id === object.id))
        : [];
      const room = ensureRoom(parsed.room);
      const upgraded: PlannerSnapshot = {
        room,
        openings: Array.isArray(parsed.openings) ? parsed.openings : [],
        dividers: Array.isArray(parsed.dividers) ? parsed.dividers : [],
        spaces: Array.isArray(parsed.spaces) && parsed.spaces.length ? parsed.spaces : [{ ...defaultSpaces[0], seed: { x: (roomBounds(room.vertices).minX + roomBounds(room.vertices).maxX) / 2, z: (roomBounds(room.vertices).minZ + roomBounds(room.vertices).maxZ) / 2 }, floorFinish: room.floorFinish, wallColor: room.wallColor }],
        objects: migratedObjects,
        unplacedObjects
      };
      if (!validateDividers(room, upgraded.dividers)) return false;
      if (!validateInteriorOpenings(room, upgraded.dividers, upgraded.openings)) return false;
      if (!validInteriorArchitecture(normalizeSnapshot(upgraded))) return false;
      set({ ...normalizeSnapshot(upgraded), selectedId: null, selectedOpeningId: null, selectedWallId: null, selectedDividerId: null, selectedSpaceId: null, activeSnap: { kind: 'none' }, collisionId: null });
      return true;
    } catch {
      return false;
    }
  },

  resetProject: () => {
    const before = snapshotOf(get());
    set({
      room: structuredClone(defaultRoom),
      openings: structuredClone(defaultOpenings),
      dividers: [],
      spaces: structuredClone(defaultSpaces),
      objects: [],
      unplacedObjects: [],
      selectedId: null,
      selectedOpeningId: null,
      selectedWallId: null,
      selectedDividerId: null,
      selectedSpaceId: null,
      activeSnap: { kind: 'none' },
      collisionId: null,
      collisionPush: false,
      mode: 'build',
      buildView: 'plan',
      planView: 'free',
      interiorWallView: 'up'
    });
    history.push(before);
  }
}), import.meta.hot?.data.store);

// Self-accept this data module so Vite does not invalidate lazy view boundaries
// and fall back to a page reload. All views retain the hook above; refreshed
// actions notify their existing subscriptions.
import.meta.hot?.accept();
import.meta.hot?.dispose((data) => {
  data.store = usePlannerStore;
  data.history = history;
});

export const getSnapshot = (): PlannerSnapshot => snapshotOf(usePlannerStore.getState());
