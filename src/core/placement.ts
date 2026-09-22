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
// Room vertices describe the wall centreline. Furniture should stop at the visible
// interior wall face, not half-way through the 5 cm structural wall. Keep the same
// 2 mm visual/contact allowance used before the wall thickness change.
const WALL_FACE_INSET = 0.027;

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
  // Use the actual rotated floor footprints for collision tests. The earlier AABB-only
  // test created large invisible collision zones whenever an item was rotated.
  return polygonsOverlap(objectFootprintCorners(a, padding), objectFootprintCorners(b, padding));
}

type Candidate = SnapAxisFeedback & { distance: number };

function snapDistance(kind: Candidate['kind'], phase: 'enter' | 'exit', override?: number) {
  if (override != null) return override;
  // Deliberately tiny magnetic thresholds. Keep these values stable: collision
  // response/dragging is handled separately and must not be faked by a large snap radius.
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

function objectFitsVisibleRoom(candidate: PlacedObject, room: RoomState) {
  const footprint = objectFootprintCorners(candidate);
  if (!pointInRoom({ x: candidate.x, z: candidate.z }, room) || !footprint.every((point) => pointInRoom(point, room))) return false;

  // Room vertices are wall centrelines, while furniture collides with the visible
  // interior finish. Enforce that face offset only for walls whose finite segment
  // overlaps the footprint; this also behaves sensibly around concave room shapes.
  for (const wall of getRoomWalls(room)) {
    const along = (candidate.x - wall.start.x) * wall.tangent.x + (candidate.z - wall.start.z) * wall.tangent.z;
    const halfAlong = supportAlong(candidate, wall.tangent);
    if (along < -halfAlong || along > wall.length + halfAlong) continue;
    const signedCentre = (candidate.x - wall.start.x) * wall.inward.x + (candidate.z - wall.start.z) * wall.inward.z;
    const required = supportAlong(candidate, wall.inward) + WALL_FACE_INSET;
    if (signedCentre < required - 0.0015) return false;
  }
  return true;
}

function placementValid(candidate: PlacedObject, room: RoomState, others: PlacedObject[], gap: number, allowOverlap = false) {
  if (!objectFitsVisibleRoom(candidate, room)) return false;
  if (allowOverlap) return true;
  return !others.some((other) => objectsOverlap(candidate, other, gap));
}

interface SweepResult {
  x: number;
  z: number;
  blocked: boolean;
  hit?: PlacedObject;
  roomBlocked?: boolean;
}

/**
 * Move from the object's current position toward a target without tunnelling.
 * The old resolver teleported an overlapping AABB to whichever side happened to
 * need the smallest correction. At pointer speed that could look like the item
 * froze and then reappeared beyond a wall/object. This sweep always advances from
 * the last visible position, so contact is continuous.
 */
function sweepToTarget(
  moving: PlacedObject,
  target: Vec2,
  room: RoomState,
  others: PlacedObject[],
  gap: number,
  allowOverlap: boolean
): SweepResult {
  const dx = target.x - moving.x;
  const dz = target.z - moving.z;
  const distance = Math.hypot(dx, dz);
  if (distance < EPS) return { x: moving.x, z: moving.z, blocked: false };

  // Sampling prevents a fast pointer from crossing a thin obstacle in one event.
  const steps = Math.max(1, Math.ceil(distance / 0.025));
  let last = { x: moving.x, z: moving.z };
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const probe = { ...moving, x: moving.x + dx * t, z: moving.z + dz * t };
    if (placementValid(probe, room, others, gap, allowOverlap)) {
      last = { x: probe.x, z: probe.z };
      continue;
    }

    // Refine the first contact within this small segment.
    let low = (step - 1) / steps;
    let high = t;
    for (let i = 0; i < 12; i += 1) {
      const mid = (low + high) / 2;
      const candidate = { ...moving, x: moving.x + dx * mid, z: moving.z + dz * mid };
      if (placementValid(candidate, room, others, gap, allowOverlap)) low = mid;
      else high = mid;
    }
    const contact = { ...moving, x: moving.x + dx * low, z: moving.z + dz * low };
    const blockedProbe = { ...moving, x: moving.x + dx * high, z: moving.z + dz * high };
    const hit = allowOverlap ? undefined : others.find((other) => objectsOverlap(blockedProbe, other, gap));
    const roomBlocked = !objectFitsVisibleRoom(blockedProbe, room);
    return { x: contact.x, z: contact.z, blocked: true, hit, roomBlocked };
  }
  return { x: last.x, z: last.z, blocked: false };
}

function projectionInterval(points: Vec2[], axis: Vec2) {
  const values = points.map((point) => point.x * axis.x + point.z * axis.z);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function collisionNormal(a: PlacedObject, b: PlacedObject, padding: number): Vec2 | null {
  const pa = objectFootprintCorners(a, padding);
  const pb = objectFootprintCorners(b, padding);
  let bestAxis: Vec2 | null = null;
  let bestOverlap = Infinity;
  for (const points of [pa, pb]) {
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const length = Math.hypot(dx, dz) || 1;
      const axis = { x: -dz / length, z: dx / length };
      const aa = projectionInterval(pa, axis);
      const bb = projectionInterval(pb, axis);
      const overlap = Math.min(aa.max, bb.max) - Math.max(aa.min, bb.min);
      if (overlap <= 0) return null;
      if (overlap < bestOverlap) {
        bestOverlap = overlap;
        bestAxis = axis;
      }
    }
  }
  if (!bestAxis) return null;
  const towardsA = { x: a.x - b.x, z: a.z - b.z };
  if (bestAxis.x * towardsA.x + bestAxis.z * towardsA.z < 0) {
    bestAxis = { x: -bestAxis.x, z: -bestAxis.z };
  }
  return bestAxis;
}

function supportAlong(object: PlacedObject, normal: Vec2) {
  const product = PRODUCTS[object.productId];
  const xAxis = rotatePoint(1, 0, object.rotationY);
  const zAxis = rotatePoint(0, 1, object.rotationY);
  return Math.abs(xAxis.x * normal.x + xAxis.z * normal.z) * product.width / 2
    + Math.abs(zAxis.x * normal.x + zAxis.z * normal.z) * product.depth / 2;
}

function nearestContactWall(object: PlacedObject, room: RoomState, extra = 0.04) {
  let best: { wall: ReturnType<typeof getRoomWalls>[number]; gap: number } | null = null;
  for (const wall of getRoomWalls(room)) {
    const along = (object.x - wall.start.x) * wall.tangent.x + (object.z - wall.start.z) * wall.tangent.z;
    const halfAlong = supportAlong(object, wall.tangent);
    if (along < -halfAlong - 0.08 || along > wall.length + halfAlong + 0.08) continue;
    const signedCentre = (object.x - wall.start.x) * wall.inward.x + (object.z - wall.start.z) * wall.inward.z;
    const gap = signedCentre - supportAlong(object, wall.inward) - WALL_FACE_INSET;
    if (gap > extra) continue;
    if (!best || gap < best.gap) best = { wall, gap };
  }
  return best;
}

function angleDelta(from: number, to: number) {
  let delta = normalizeAngle(to) - normalizeAngle(from);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function rotateToward(from: number, to: number, maxStep: number) {
  const delta = angleDelta(from, to);
  if (Math.abs(delta) <= maxStep) return normalizeAngle(to);
  return normalizeAngle(from + Math.sign(delta) * maxStep);
}

/**
 * Wall-affinity is contact behaviour, not a large magnetic snap. A sofa that is
 * pushed into a wall gradually pivots until its back is flush, while its centre
 * continues to track the pointer tangentially. This mirrors the reference video
 * and keeps the actual wall snap threshold at 18 mm.
 */
function contactAlignedObject(moving: PlacedObject, rawX: number, rawZ: number, room: RoomState) {
  const product = PRODUCTS[moving.productId];
  if (!product.wallAffinity) return moving;
  const dx = rawX - moving.x;
  const dz = rawZ - moving.z;
  const rawProbe = { ...moving, x: rawX, z: rawZ };
  const currentContact = nearestContactWall(moving, room, 0.025);
  const currentNear = nearestContactWall(moving, room, 0.12);
  const targetContact = nearestContactWall(rawProbe, room, 0.025);
  // Do not rotate an item merely because the pointer jumped to the far side of a
  // wall in one event. First sweep it to actual contact; subsequent events pivot it.
  const contact = currentContact
    ?? (currentNear && targetContact?.wall.id === currentNear.wall.id ? currentNear : null);
  if (!contact) return moving;

  const approach = dx * contact.wall.inward.x + dz * contact.wall.inward.z;
  // Pivot while pressing into the wall or sliding along it. Pulling away should
  // immediately release the contact instead of continuing to rotate by itself.
  if (approach > 0.004) return moving;

  const targetRotation = normalizeAngle(Math.atan2(contact.wall.inward.x, contact.wall.inward.z));
  const travel = Math.hypot(dx, dz);
  const maxStep = clamp(0.035 + travel * 0.55, 0.035, 0.12);
  const nextRotation = rotateToward(moving.rotationY, targetRotation, maxStep);
  if (Math.abs(angleDelta(moving.rotationY, nextRotation)) < 1e-6) return moving;

  const beforeSupport = supportAlong(moving, contact.wall.inward);
  const rotated = { ...moving, rotationY: nextRotation };
  const afterSupport = supportAlong(rotated, contact.wall.inward);
  const shift = Math.max(0, afterSupport - beforeSupport);
  const adjusted = {
    ...rotated,
    x: rotated.x + contact.wall.inward.x * shift,
    z: rotated.z + contact.wall.inward.z * shift
  };
  return objectFitsVisibleRoom(adjusted, room) ? adjusted : moving;
}

function moveWithCollisionSlide(
  moving: PlacedObject,
  target: Vec2,
  room: RoomState,
  others: PlacedObject[],
  gap: number,
  allowOverlap: boolean
) {
  const first = sweepToTarget(moving, target, room, others, gap, allowOverlap);
  if (!first.blocked) return { x: first.x, z: first.z, pushed: false, colliding: false };

  const contactObject = { ...moving, x: first.x, z: first.z };
  const remaining = { x: target.x - first.x, z: target.z - first.z };
  let tangent: Vec2 | null = null;

  if (first.hit && !allowOverlap) {
    const probeDistance = Math.hypot(remaining.x, remaining.z) || 1;
    const probe = {
      ...contactObject,
      x: first.x + remaining.x / probeDistance * 0.004,
      z: first.z + remaining.z / probeDistance * 0.004
    };
    const normal = collisionNormal(probe, first.hit, gap) ?? {
      x: first.x - first.hit.x,
      z: first.z - first.hit.z
    };
    const nLen = Math.hypot(normal.x, normal.z) || 1;
    tangent = { x: -normal.z / nLen, z: normal.x / nLen };
  } else if (first.roomBlocked) {
    const wallContact = nearestContactWall(contactObject, room, 0.12);
    if (wallContact) tangent = wallContact.wall.tangent;
  }

  if (!tangent) return { x: first.x, z: first.z, pushed: true, colliding: true };
  const tangentialAmount = remaining.x * tangent.x + remaining.z * tangent.z;
  const slideTarget = {
    x: first.x + tangent.x * tangentialAmount,
    z: first.z + tangent.z * tangentialAmount
  };
  const second = sweepToTarget(contactObject, slideTarget, room, others, gap, allowOverlap);
  return {
    x: second.x,
    z: second.z,
    pushed: true,
    colliding: second.blocked
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
      const value = wall.start.z + wall.inward.z * (halfD + WALL_FACE_INSET);
      zCandidates.push({ kind: 'wall', targetId: wall.id, axis: 'z', value, distance: Math.abs(z - value), label: 'Wall' });
    } else if (Math.abs(wall.tangent.z) > 0.995) {
      const projection = (x - wall.start.x) * wall.tangent.x + (z - wall.start.z) * wall.tangent.z;
      if (projection < halfD - 0.04 || projection > wall.length - halfD + 0.04) continue;
      const value = wall.start.x + wall.inward.x * (halfW + WALL_FACE_INSET);
      xCandidates.push({ kind: 'wall', targetId: wall.id, axis: 'x', value, distance: Math.abs(x - value), label: 'Wall' });
    }
  }
}

function normalizeAngle(angle: number) {
  const tau = Math.PI * 2;
  return ((angle % tau) + tau) % tau;
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
  const collisionGap = options.collisionGap ?? 0.001;
  const allowOverlap = options.allowOverlap ?? false;

  // Contact rotation is intentionally separate from magnetic snapping. It only
  // activates when a wall-affinity item physically meets a wall.
  const working = options.spatialWallSnap === false || enter === 0
    ? moving
    : contactAlignedObject(moving, rawX, rawZ, room);

  const product = PRODUCTS[working.productId];
  const size = rotatedFootprint(product, working.rotationY);
  const halfW = size.width / 2;
  const halfD = size.depth / 2;
  const bounds = roomBounds(room.vertices);

  // Start from the last visible object position and sweep to the pointer. This is
  // what makes collision response glide instead of teleporting across obstacles.
  const moved = moveWithCollisionSlide(
    working,
    { x: rawX, z: rawZ },
    room,
    others,
    collisionGap,
    allowOverlap
  );
  let x = moved.x;
  let z = moved.z;

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
  const snapTarget = { x: xSnap?.value ?? x, z: zSnap?.value ?? z };

  // Snaps are only millimetres away, but still run through the same continuous
  // solver so snapping can never pull a product through another product/wall.
  const snapped = (xSnap || zSnap) && enter !== 0
    ? moveWithCollisionSlide({ ...working, x, z }, snapTarget, room, others, collisionGap, allowOverlap)
    : { x, z, pushed: false, colliding: false };
  x = snapped.x;
  z = snapped.z;

  const finalXSnap = xSnap && Math.abs(x - xSnap.value) <= 0.003 ? xSnap : undefined;
  const finalZSnap = zSnap && Math.abs(z - zSnap.value) <= 0.003 ? zSnap : undefined;
  const snap = makeFeedback(finalXSnap, finalZSnap);
  const finalObject = { ...working, x, z };

  return {
    x,
    z,
    rotationY: working.rotationY,
    colliding: allowOverlap ? others.some((other) => objectsOverlap(finalObject, other, collisionGap)) : moved.colliding || snapped.colliding,
    pushedByCollision: moved.pushed || snapped.pushed,
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
