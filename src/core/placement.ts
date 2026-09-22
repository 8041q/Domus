import { PRODUCTS, rotatedFootprint } from './products';
import {
  getRoomWalls,
  getWall,
  wallPoint,
  pointInRoom,
  projectRectInsideRoom,
  rectFitsRoom,
  roomBounds
} from './roomGeometry';
import type {
  ClearanceIssue,
  PlacedObject,
  PlacementResult,
  RoomState,
  SnapAxisFeedback,
  SnapFeedback,
  Vec2
} from './types';

export interface PlacementOptions {
  enterSnapDistance?: number;
  exitSnapDistance?: number;
  collisionGap?: number;
  previousSnap?: SnapFeedback;
  /** When true, wall-affinity products can gently align their back to a nearby wall. */
  spatialWallSnap?: boolean;
  /** Precision override: keep room bounds, but do not push away from other products. */
  allowOverlap?: boolean;
}

export interface ClearanceZone {
  width: number;
  depth: number;
  /** Local offset of the zone centre from the product origin. */
  offsetX: number;
  offsetZ: number;
  centre: Vec2;
  rotationY: number;
  corners: Vec2[];
}

export interface ClearanceRegion {
  side: 'front' | 'back' | 'left' | 'right';
  width: number;
  depth: number;
  centre: Vec2;
  rotationY: number;
  corners: Vec2[];
}

export interface SpacingMeasurement {
  side: 'front' | 'back' | 'left' | 'right';
  distance: number;
  origin: Vec2;
  end: Vec2;
  direction: Vec2;
  target: 'wall' | 'object';
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const EPS = 1e-7;

export function objectAabb(object: PlacedObject, padding = 0) {
  const product = PRODUCTS[object.productId];
  const size = rotatedFootprint(product, object.rotationY);
  return {
    minX: object.x - size.width / 2 - padding,
    maxX: object.x + size.width / 2 + padding,
    minZ: object.z - size.depth / 2 - padding,
    maxZ: object.z + size.depth / 2 + padding,
    width: size.width,
    depth: size.depth
  };
}

export function objectsOverlap(a: PlacedObject, b: PlacedObject, padding = 0): boolean {
  if (PRODUCTS[a.productId].collision === false || PRODUCTS[b.productId].collision === false) return false;
  const aa = objectAabb(a, padding);
  const bb = objectAabb(b, padding);
  return aa.minX < bb.maxX && aa.maxX > bb.minX && aa.minZ < bb.maxZ && aa.maxZ > bb.minZ;
}

type Candidate = SnapAxisFeedback & { distance: number };

function snapDistance(kind: Candidate['kind'], phase: 'enter' | 'exit', override?: number) {
  if (override != null) return override;
  // Phase 6: snapping is a very light assist. It should confirm an intention, never create one.
  const defaults = {
    wall: { enter: 0.018, exit: 0.021 },
    object: { enter: 0.010, exit: 0.013 },
    center: { enter: 0.008, exit: 0.010 }
  } as const;
  return defaults[kind][phase];
}

function chooseAxisSnap(
  previous: SnapAxisFeedback | undefined,
  candidates: Candidate[],
  enterOverride?: number,
  exitOverride?: number
) {
  if (previous) {
    const same = candidates.find((c) => c.kind === previous.kind && c.targetId === previous.targetId && Math.abs(c.value - previous.value) < 1e-5);
    if (same && same.distance <= snapDistance(same.kind, 'exit', exitOverride)) return same;
  }
  return candidates
    .filter((c) => c.distance <= snapDistance(c.kind, 'enter', enterOverride))
    .sort((a, b) => a.distance - b.distance)[0];
}

function rangesNear(aMin: number, aMax: number, bMin: number, bMax: number, tolerance = 0.12) {
  return aMin <= bMax + tolerance && aMax >= bMin - tolerance;
}

function makeFeedback(x?: Candidate, z?: Candidate): SnapFeedback {
  if (!x && !z) return { kind: 'none' };
  if (x && z) return { kind: 'multi', x, z, label: `${x.label} · ${z.label}` };
  const one = x ?? z!;
  return { kind: one.kind, x, z, label: one.label };
}

function pushOutOfCollisions(candidate: PlacedObject, others: PlacedObject[], room: RoomState, gap: number) {
  let x = candidate.x;
  let z = candidate.z;
  let pushed = false;
  const size = rotatedFootprint(PRODUCTS[candidate.productId], candidate.rotationY);

  for (let pass = 0; pass < 5; pass += 1) {
    const current = { ...candidate, x, z };
    const hit = others.find((o) => objectsOverlap(current, o, gap));
    if (!hit) break;

    const a = objectAabb(current, gap);
    const b = objectAabb(hit, gap);
    const shifts = [
      { axis: 'x' as const, delta: b.minX - a.maxX },
      { axis: 'x' as const, delta: b.maxX - a.minX },
      { axis: 'z' as const, delta: b.minZ - a.maxZ },
      { axis: 'z' as const, delta: b.maxZ - a.minZ }
    ].sort((p, q) => Math.abs(p.delta) - Math.abs(q.delta));

    let applied = false;
    for (const shift of shifts) {
      const nx = shift.axis === 'x' ? x + shift.delta : x;
      const nz = shift.axis === 'z' ? z + shift.delta : z;
      if (!rectFitsRoom(room, nx, nz, size.width, size.depth)) continue;
      x = nx;
      z = nz;
      pushed = true;
      applied = true;
      break;
    }
    if (!applied) break;
  }

  const finalObject = { ...candidate, x, z };
  return {
    x,
    z,
    pushed,
    colliding: others.some((o) => objectsOverlap(finalObject, o, gap))
  };
}

function addWallSnapCandidates(
  room: RoomState,
  x: number,
  z: number,
  halfW: number,
  halfD: number,
  xCandidates: Candidate[],
  zCandidates: Candidate[]
) {
  for (const wall of getRoomWalls(room)) {
    // Axis snaps are deliberately only used when the wall itself is essentially axis aligned.
    // Angled walls are handled by spatialWallAlignment so we never fake an X/Z snap to a diagonal.
    if (Math.abs(wall.tangent.x) > 0.995) {
      const projection = (x - wall.start.x) * wall.tangent.x + (z - wall.start.z) * wall.tangent.z;
      if (projection < halfW - 0.04 || projection > wall.length - halfW + 0.04) continue;
      const value = wall.start.z + wall.inward.z * halfD;
      zCandidates.push({ kind: 'wall', targetId: wall.id, axis: 'z', value, distance: Math.abs(z - value), label: 'Wall' });
    } else if (Math.abs(wall.tangent.z) > 0.995) {
      const projection = (x - wall.start.x) * wall.tangent.x + (z - wall.start.z) * wall.tangent.z;
      if (projection < halfD - 0.04 || projection > wall.length - halfD + 0.04) continue;
      const value = wall.start.x + wall.inward.x * halfW;
      xCandidates.push({ kind: 'wall', targetId: wall.id, axis: 'x', value, distance: Math.abs(x - value), label: 'Wall' });
    }
  }
}

function normalizeAngle(angle: number) {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
}

function angleDelta(a: number, b: number) {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(d, Math.PI * 2 - d);
}

/**
 * Spatial wall snapping is deliberately conservative: only wall-affinity products,
 * already roughly facing the wall, are auto-aligned. This prevents the planner from
 * rotating furniture merely because it passed near a wall.
 */
function spatialWallAlignment(moving: PlacedObject, rawX: number, rawZ: number, room: RoomState) {
  const product = PRODUCTS[moving.productId];
  if (!product.wallAffinity) return null;
  let best: { wallId: string; rotationY: number; x: number; z: number; distance: number } | null = null;

  for (const wall of getRoomWalls(room)) {
    // Product local +Z is its front. Point the front into the room, leaving its back against the wall.
    const targetRotation = normalizeAngle(Math.atan2(wall.inward.x, wall.inward.z));
    if (angleDelta(moving.rotationY, targetRotation) > Math.PI / 15) continue; // ~12°: user intent must already be clear.

    const halfDepth = product.depth / 2;
    const halfAlong = product.width / 2;
    const rawProjection = (rawX - wall.start.x) * wall.tangent.x + (rawZ - wall.start.z) * wall.tangent.z;
    const along = clamp(rawProjection, halfAlong, Math.max(halfAlong, wall.length - halfAlong));
    if (wall.length < product.width - 0.02) continue;
    const onWall = wallPoint(wall, along);
    const target = {
      x: onWall.x + wall.inward.x * halfDepth,
      z: onWall.z + wall.inward.z * halfDepth
    };
    const distance = Math.hypot(rawX - target.x, rawZ - target.z);
    if (distance > 0.014) continue;
    if (!best || distance < best.distance) best = { wallId: wall.id, rotationY: targetRotation, x: target.x, z: target.z, distance };
  }
  return best;
}

export function resolvePlacement(
  moving: PlacedObject,
  rawX: number,
  rawZ: number,
  room: RoomState,
  others: PlacedObject[],
  options: PlacementOptions = {}
): PlacementResult {
  const enter = options.enterSnapDistance;
  const exit = options.exitSnapDistance;
  const collisionGap = options.collisionGap ?? 0.012;

  let working = moving;
  let spatialWallId: string | undefined;
  if (options.spatialWallSnap !== false && enter !== 0) {
    const alignment = spatialWallAlignment(moving, rawX, rawZ, room);
    if (alignment) {
      working = { ...moving, rotationY: alignment.rotationY };
      rawX = alignment.x;
      rawZ = alignment.z;
      spatialWallId = alignment.wallId;
    }
  }

  const product = PRODUCTS[working.productId];
  const size = rotatedFootprint(product, working.rotationY);
  const halfW = size.width / 2;
  const halfD = size.depth / 2;
  const bounds = roomBounds(room.vertices);

  let x = clamp(rawX, bounds.minX + halfW, bounds.maxX - halfW);
  let z = clamp(rawZ, bounds.minZ + halfD, bounds.maxZ - halfD);

  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreZ = (bounds.minZ + bounds.maxZ) / 2;
  const xCandidates: Candidate[] = [
    { kind: 'center', axis: 'x', value: centreX, distance: Math.abs(x - centreX), label: 'Room centre' }
  ];
  const zCandidates: Candidate[] = [
    { kind: 'center', axis: 'z', value: centreZ, distance: Math.abs(z - centreZ), label: 'Room centre' }
  ];
  addWallSnapCandidates(room, x, z, halfW, halfD, xCandidates, zCandidates);

  const movingBox = { minX: x - halfW, maxX: x + halfW, minZ: z - halfD, maxZ: z + halfD };
  for (const other of others) {
    if (PRODUCTS[other.productId].collision === false && product.collision !== false) continue;
    const ob = objectAabb(other);
    if (rangesNear(movingBox.minZ, movingBox.maxZ, ob.minZ, ob.maxZ)) {
      xCandidates.push(
        { kind: 'object', targetId: other.id, axis: 'x', value: ob.minX - halfW, distance: Math.abs(x - (ob.minX - halfW)), label: 'Edges aligned' },
        { kind: 'object', targetId: other.id, axis: 'x', value: ob.maxX + halfW, distance: Math.abs(x - (ob.maxX + halfW)), label: 'Edges aligned' },
        { kind: 'object', targetId: other.id, axis: 'x', value: other.x, distance: Math.abs(x - other.x), label: 'Centres aligned' }
      );
    }
    if (rangesNear(movingBox.minX, movingBox.maxX, ob.minX, ob.maxX)) {
      zCandidates.push(
        { kind: 'object', targetId: other.id, axis: 'z', value: ob.minZ - halfD, distance: Math.abs(z - (ob.minZ - halfD)), label: 'Edges aligned' },
        { kind: 'object', targetId: other.id, axis: 'z', value: ob.maxZ + halfD, distance: Math.abs(z - (ob.maxZ + halfD)), label: 'Edges aligned' },
        { kind: 'object', targetId: other.id, axis: 'z', value: other.z, distance: Math.abs(z - other.z), label: 'Centres aligned' }
      );
    }
  }

  const xSnap = chooseAxisSnap(options.previousSnap?.x, xCandidates, enter, exit);
  const zSnap = chooseAxisSnap(options.previousSnap?.z, zCandidates, enter, exit);
  if (xSnap) x = xSnap.value;
  if (zSnap) z = zSnap.value;

  const inside = projectRectInsideRoom(room, size.width, size.depth, { x: moving.x, z: moving.z }, { x, z });
  x = inside.x;
  z = inside.z;

  const collisionProbe = { ...working, x, z };
  const pushed = options.allowOverlap
    ? { x, z, pushed: false, colliding: others.some((other) => objectsOverlap(collisionProbe, other, collisionGap)) }
    : pushOutOfCollisions(collisionProbe, others, room, collisionGap);
  const finalXSnap = xSnap && Math.abs(pushed.x - xSnap.value) <= 0.008 ? xSnap : undefined;
  const finalZSnap = zSnap && Math.abs(pushed.z - zSnap.value) <= 0.008 ? zSnap : undefined;
  let snap = makeFeedback(finalXSnap, finalZSnap);
  if (spatialWallId) snap = { kind: 'wall', label: 'Wall aligned' };

  return {
    x: pushed.x,
    z: pushed.z,
    rotationY: working.rotationY,
    colliding: pushed.colliding,
    pushedByCollision: pushed.pushed,
    snap
  };
}

export function rotatePoint(x: number, z: number, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Match THREE.Object3D.rotation.y: positive Y rotation turns local +Z toward world +X.
  return { x: x * c + z * s, z: -x * s + z * c };
}

export function objectFootprintCorners(object: PlacedObject, padding = 0): Vec2[] {
  const p = PRODUCTS[object.productId];
  const halfW = p.width / 2 + padding;
  const halfD = p.depth / 2 + padding;
  return [
    { x: -halfW, z: -halfD },
    { x: halfW, z: -halfD },
    { x: halfW, z: halfD },
    { x: -halfW, z: halfD }
  ].map((point) => {
    const rotated = rotatePoint(point.x, point.z, object.rotationY);
    return { x: object.x + rotated.x, z: object.z + rotated.z };
  });
}

export function clearanceZone(object: PlacedObject): ClearanceZone {
  const p = PRODUCTS[object.productId];
  const width = p.width + p.clearance.sides * 2;
  const depth = p.depth + p.clearance.front + p.clearance.back;
  const offsetX = 0;
  const offsetZ = (p.clearance.front - p.clearance.back) / 2;
  const rotatedOffset = rotatePoint(offsetX, offsetZ, object.rotationY);
  const centre = { x: object.x + rotatedOffset.x, z: object.z + rotatedOffset.z };
  const halfW = width / 2;
  const halfD = depth / 2;
  const corners = [
    { x: -halfW, z: -halfD },
    { x: halfW, z: -halfD },
    { x: halfW, z: halfD },
    { x: -halfW, z: halfD }
  ].map((point) => {
    const rotated = rotatePoint(point.x, point.z, object.rotationY);
    return { x: centre.x + rotated.x, z: centre.z + rotated.z };
  });
  return { width, depth, offsetX, offsetZ, centre, rotationY: object.rotationY, corners };
}


/**
 * Passage/use-space is represented as independent bands, not one oversized outer rectangle.
 * This keeps front circulation, rear service space and side clearances semantically separate.
 */
export function clearanceRegions(object: PlacedObject): ClearanceRegion[] {
  const p = PRODUCTS[object.productId];
  const specs: Array<{ side: ClearanceRegion['side']; width: number; depth: number; offsetX: number; offsetZ: number }> = [];
  if (p.clearance.front > 0) specs.push({ side: 'front', width: p.width, depth: p.clearance.front, offsetX: 0, offsetZ: p.depth / 2 + p.clearance.front / 2 });
  if (p.clearance.back > 0) specs.push({ side: 'back', width: p.width, depth: p.clearance.back, offsetX: 0, offsetZ: -(p.depth / 2 + p.clearance.back / 2) });
  if (p.clearance.sides > 0) {
    specs.push({ side: 'left', width: p.clearance.sides, depth: p.depth, offsetX: -(p.width / 2 + p.clearance.sides / 2), offsetZ: 0 });
    specs.push({ side: 'right', width: p.clearance.sides, depth: p.depth, offsetX: p.width / 2 + p.clearance.sides / 2, offsetZ: 0 });
  }
  return specs.map((spec) => {
    const localCentre = rotatePoint(spec.offsetX, spec.offsetZ, object.rotationY);
    const centre = { x: object.x + localCentre.x, z: object.z + localCentre.z };
    const halfW = spec.width / 2;
    const halfD = spec.depth / 2;
    const corners = [
      { x: -halfW, z: -halfD },
      { x: halfW, z: -halfD },
      { x: halfW, z: halfD },
      { x: -halfW, z: halfD }
    ].map((point) => {
      const rotated = rotatePoint(point.x, point.z, object.rotationY);
      return { x: centre.x + rotated.x, z: centre.z + rotated.z };
    });
    return { side: spec.side, width: spec.width, depth: spec.depth, centre, rotationY: object.rotationY, corners };
  });
}

/** Compatibility helper for older UI code. Prefer clearanceZone for rendering. */
export function clearanceAabb(object: PlacedObject) {
  const zone = clearanceZone(object);
  return {
    minX: Math.min(...zone.corners.map((v) => v.x)),
    maxX: Math.max(...zone.corners.map((v) => v.x)),
    minZ: Math.min(...zone.corners.map((v) => v.z)),
    maxZ: Math.max(...zone.corners.map((v) => v.z))
  };
}

function projectPolygon(points: Vec2[], axis: Vec2) {
  const values = points.map((p) => p.x * axis.x + p.z * axis.z);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function polygonsOverlap(a: Vec2[], b: Vec2[]) {
  const axes: Vec2[] = [];
  for (const points of [a, b]) {
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const len = Math.hypot(dx, dz) || 1;
      axes.push({ x: -dz / len, z: dx / len });
    }
  }
  return axes.every((axis) => {
    const pa = projectPolygon(a, axis);
    const pb = projectPolygon(b, axis);
    return pa.max > pb.min + EPS && pb.max > pa.min + EPS;
  });
}

export function clearanceIssues(object: PlacedObject, room: RoomState, others: PlacedObject[]): ClearanceIssue[] {
  const regions = clearanceRegions(object);
  if (!regions.length) return [];
  const issues: ClearanceIssue[] = [];
  const seen = new Set<string>();
  for (const region of regions) {
    const samples = [
      ...region.corners,
      region.centre,
      ...region.corners.map((corner, index) => {
        const next = region.corners[(index + 1) % region.corners.length];
        return { x: (corner.x + next.x) / 2, z: (corner.z + next.z) / 2 };
      })
    ];
    if (!samples.every((sample) => pointInRoom(sample, room))) {
      const key = `room-${region.side}`;
      if (!seen.has(key)) {
        seen.add(key);
        issues.push({ type: 'room', message: `${region.side[0].toUpperCase()}${region.side.slice(1)} recommended clearance extends beyond the room.` });
      }
    }
    for (const other of others) {
      if (PRODUCTS[other.productId].collision === false) continue;
      if (!polygonsOverlap(region.corners, objectFootprintCorners(other))) continue;
      const key = `${other.id}-${region.side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        type: 'object',
        targetId: other.id,
        message: `${region.side[0].toUpperCase()}${region.side.slice(1)} clearance overlaps ${PRODUCTS[other.productId].name}.`
      });
    }
  }
  return issues;
}

function cross(a: Vec2, b: Vec2) {
  return a.x * b.z - a.z * b.x;
}

function raySegmentDistance(origin: Vec2, direction: Vec2, a: Vec2, b: Vec2) {
  const edge = { x: b.x - a.x, z: b.z - a.z };
  const denom = cross(direction, edge);
  if (Math.abs(denom) < EPS) return null;
  const delta = { x: a.x - origin.x, z: a.z - origin.z };
  const t = cross(delta, edge) / denom;
  const u = cross(delta, direction) / denom;
  if (t < 0 || u < -EPS || u > 1 + EPS) return null;
  return t;
}

function sideOriginAndDirection(object: PlacedObject, side: SpacingMeasurement['side']) {
  // Unidirectional drafting: spacing rays stay on world X/Z axes even when the item rotates.
  const direction: Vec2 = side === 'front'
    ? { x: 0, z: 1 }
    : side === 'back'
      ? { x: 0, z: -1 }
      : side === 'left'
        ? { x: -1, z: 0 }
        : { x: 1, z: 0 };
  const centre = { x: object.x, z: object.z };
  const polygon = objectFootprintCorners(object);
  let boundaryDistance = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const distance = raySegmentDistance(centre, direction, polygon[i], polygon[(i + 1) % polygon.length]);
    if (distance != null && distance >= 0 && distance < boundaryDistance) boundaryDistance = distance;
  }
  if (!Number.isFinite(boundaryDistance)) boundaryDistance = 0;
  return {
    origin: { x: centre.x + direction.x * boundaryDistance, z: centre.z + direction.z * boundaryDistance },
    direction
  };
}

export function spacingMeasurements(object: PlacedObject, room: RoomState, others: PlacedObject[]): SpacingMeasurement[] {
  const roomWalls = getRoomWalls(room);
  const objectPolygons = others
    .filter((other) => PRODUCTS[other.productId].collision !== false)
    .map((other) => objectFootprintCorners(other));
  const measurements: SpacingMeasurement[] = [];

  for (const side of ['front', 'back', 'left', 'right'] as const) {
    const { origin, direction } = sideOriginAndDirection(object, side);
    let bestDistance = Infinity;
    let target: 'wall' | 'object' = 'wall';

    for (const wall of roomWalls) {
      const distance = raySegmentDistance(origin, direction, wall.start, wall.end);
      if (distance != null && distance > 0.003 && distance < bestDistance) {
        bestDistance = distance;
        target = 'wall';
      }
    }
    for (const polygon of objectPolygons) {
      for (let i = 0; i < polygon.length; i += 1) {
        const distance = raySegmentDistance(origin, direction, polygon[i], polygon[(i + 1) % polygon.length]);
        if (distance != null && distance > 0.003 && distance < bestDistance) {
          bestDistance = distance;
          target = 'object';
        }
      }
    }

    if (Number.isFinite(bestDistance) && bestDistance < 8) {
      measurements.push({
        side,
        distance: bestDistance,
        origin,
        end: { x: origin.x + direction.x * bestDistance, z: origin.z + direction.z * bestDistance },
        direction,
        target
      });
    }
  }
  return measurements;
}

export function wallLength(id: string, room: RoomState) {
  const wall = getWall(room, id);
  if (wall) return wall.length;
  if (id === 'north' || id === 'south') return room.width;
  if (id === 'east' || id === 'west') return room.depth;
  return 0;
}
