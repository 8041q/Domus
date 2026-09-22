import type { RoomShapeKind, RoomState, RoomVertex, RoomWallSegment, Vec2 } from './types';

const EPS = 1e-6;
export const MIN_WALL_LENGTH = 0.45;

export function wallId(start: RoomVertex, end: RoomVertex) {
  return `wall-${start.id}-${end.id}`;
}

export function roomTemplate(kind: Exclude<RoomShapeKind, 'custom'>, width: number, depth: number): RoomVertex[] {
  const w = Math.max(2.2, width);
  const d = Math.max(2.2, depth);
  if (kind === 'l-shape') {
    return [
      { id: 'v0', x: 0, z: 0 },
      { id: 'v1', x: w, z: 0 },
      { id: 'v2', x: w, z: d * 0.56 },
      { id: 'v3', x: w * 0.62, z: d * 0.56 },
      { id: 'v4', x: w * 0.62, z: d },
      { id: 'v5', x: 0, z: d }
    ];
  }
  if (kind === 'recess') {
    return [
      { id: 'v0', x: 0, z: 0 },
      { id: 'v1', x: w, z: 0 },
      { id: 'v2', x: w, z: d },
      { id: 'v3', x: w * 0.70, z: d },
      { id: 'v4', x: w * 0.70, z: d * 0.74 },
      { id: 'v5', x: w * 0.38, z: d * 0.74 },
      { id: 'v6', x: w * 0.38, z: d },
      { id: 'v7', x: 0, z: d }
    ];
  }
  return [
    { id: 'v0', x: 0, z: 0 },
    { id: 'v1', x: w, z: 0 },
    { id: 'v2', x: w, z: d },
    { id: 'v3', x: 0, z: d }
  ];
}

export function polygonArea(vertices: RoomVertex[]) {
  let sum = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

export function roomBounds(vertices: RoomVertex[]) {
  const xs = vertices.map((v) => v.x);
  const zs = vertices.map((v) => v.z);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...zs) - Math.min(...zs)
  };
}

export function normalizeVertices(vertices: RoomVertex[]) {
  const bounds = roomBounds(vertices);
  if (Math.abs(bounds.minX) < EPS && Math.abs(bounds.minZ) < EPS) return vertices.map((v) => ({ ...v }));
  return vertices.map((v) => ({ ...v, x: v.x - bounds.minX, z: v.z - bounds.minZ }));
}

export function syncRoomBounds(room: RoomState, vertices = room.vertices): RoomState {
  // Keep the room in a stable world coordinate system. Earlier phases normalized
  // the minimum x/z back to zero after every edit, which made an edited wall appear
  // fixed while the rest of the room translated around it. Bounds are metadata only.
  const stable = vertices.map((vertex) => ({ ...vertex }));
  const bounds = roomBounds(stable);
  return {
    ...room,
    width: Math.max(0.1, bounds.width),
    depth: Math.max(0.1, bounds.depth),
    vertices: stable
  };
}

export function scaleRoom(room: RoomState, width: number, depth: number): RoomState {
  const current = roomBounds(room.vertices);
  const sx = current.width > EPS ? width / current.width : 1;
  const sz = current.depth > EPS ? depth / current.depth : 1;
  const cx = (current.minX + current.maxX) / 2;
  const cz = (current.minZ + current.maxZ) / 2;
  return syncRoomBounds(room, room.vertices.map((v) => ({
    ...v,
    x: cx + (v.x - cx) * sx,
    z: cz + (v.z - cz) * sz
  })));
}

export function getRoomWalls(room: RoomState): RoomWallSegment[] {
  const area = polygonArea(room.vertices);
  const orientation = area >= 0 ? 1 : -1;
  return room.vertices.map((start, index) => {
    const end = room.vertices[(index + 1) % room.vertices.length];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    const tangent = length > EPS ? { x: dx / length, z: dz / length } : { x: 1, z: 0 };
    // For positive-area polygons, the interior is to the left of each directed edge.
    const inward = { x: -tangent.z * orientation, z: tangent.x * orientation };
    return {
      id: wallId(start, end),
      index,
      start,
      end,
      length,
      // Retained for compatibility with existing UI heuristics. Angled walls are now fully supported.
      horizontal: Math.abs(dz) <= Math.abs(dx),
      tangent,
      inward
    };
  });
}

export function getWall(room: RoomState, id: string) {
  return getRoomWalls(room).find((wall) => wall.id === id) ?? null;
}

export function wallPoint(wall: RoomWallSegment, distance: number): Vec2 {
  return {
    x: wall.start.x + wall.tangent.x * distance,
    z: wall.start.z + wall.tangent.z * distance
  };
}

export function pointOnSegment(point: Vec2, a: Vec2, b: Vec2, epsilon = 1e-5) {
  const cross = (point.x - a.x) * (b.z - a.z) - (point.z - a.z) * (b.x - a.x);
  if (Math.abs(cross) > epsilon) return false;
  const dot = (point.x - a.x) * (b.x - a.x) + (point.z - a.z) * (b.z - a.z);
  if (dot < -epsilon) return false;
  const len2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
  return dot <= len2 + epsilon;
}

export function pointInRoom(point: Vec2, room: RoomState, includeBoundary = true) {
  const vertices = room.vertices;
  if (includeBoundary) {
    for (let i = 0; i < vertices.length; i += 1) {
      if (pointOnSegment(point, vertices[i], vertices[(i + 1) % vertices.length])) return true;
    }
  }
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const a = vertices[i];
    const b = vertices[j];
    const intersects = ((a.z > point.z) !== (b.z > point.z)) &&
      (point.x < (b.x - a.x) * (point.z - a.z) / ((b.z - a.z) || EPS) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

export function rectFitsRoom(room: RoomState, x: number, z: number, width: number, depth: number, inset = 0.002) {
  const halfW = Math.max(0, width / 2 - inset);
  const halfD = Math.max(0, depth / 2 - inset);
  const points = [
    { x: x - halfW, z: z - halfD },
    { x: x + halfW, z: z - halfD },
    { x: x + halfW, z: z + halfD },
    { x: x - halfW, z: z + halfD },
    { x, z }
  ];
  return points.every((point) => pointInRoom(point, room));
}

export function projectRectInsideRoom(
  room: RoomState,
  width: number,
  depth: number,
  from: Vec2,
  target: Vec2
): Vec2 {
  if (rectFitsRoom(room, target.x, target.z, width, depth)) return target;
  if (!rectFitsRoom(room, from.x, from.z, width, depth)) {
    const found = findNearestValidPosition(room, width, depth, target);
    return found ?? from;
  }
  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i += 1) {
    const mid = (low + high) / 2;
    const probe = {
      x: from.x + (target.x - from.x) * mid,
      z: from.z + (target.z - from.z) * mid
    };
    if (rectFitsRoom(room, probe.x, probe.z, width, depth)) low = mid;
    else high = mid;
  }
  return {
    x: from.x + (target.x - from.x) * low,
    z: from.z + (target.z - from.z) * low
  };
}

export function findNearestValidPosition(room: RoomState, width: number, depth: number, preferred: Vec2) {
  if (rectFitsRoom(room, preferred.x, preferred.z, width, depth)) return preferred;
  const bounds = roomBounds(room.vertices);
  const step = 0.12;
  let best: Vec2 | null = null;
  let bestDistance = Infinity;
  for (let z = bounds.minZ + depth / 2; z <= bounds.maxZ - depth / 2 + EPS; z += step) {
    for (let x = bounds.minX + width / 2; x <= bounds.maxX - width / 2 + EPS; x += step) {
      if (!rectFitsRoom(room, x, z, width, depth)) continue;
      const distance = (x - preferred.x) ** 2 + (z - preferred.z) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x, z };
      }
    }
  }
  return best;
}

function orient(a: Vec2, b: Vec2, c: Vec2) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2) {
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  if ((o1 > EPS && o2 < -EPS || o1 < -EPS && o2 > EPS) && (o3 > EPS && o4 < -EPS || o3 < -EPS && o4 > EPS)) return true;
  if (Math.abs(o1) <= EPS && pointOnSegment(b1, a1, a2)) return true;
  if (Math.abs(o2) <= EPS && pointOnSegment(b2, a1, a2)) return true;
  if (Math.abs(o3) <= EPS && pointOnSegment(a1, b1, b2)) return true;
  if (Math.abs(o4) <= EPS && pointOnSegment(a2, b1, b2)) return true;
  return false;
}

/** Validates any simple room polygon; walls no longer need to be orthogonal. */
export function isValidRoom(vertices: RoomVertex[]) {
  if (vertices.length < 3 || Math.abs(polygonArea(vertices)) < 0.5) return false;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    if (Math.hypot(b.x - a.x, b.z - a.z) < MIN_WALL_LENGTH) return false;
  }
  for (let i = 0; i < vertices.length; i += 1) {
    const a1 = vertices[i];
    const a2 = vertices[(i + 1) % vertices.length];
    for (let j = i + 1; j < vertices.length; j += 1) {
      const adjacent = j === i || j === (i + 1) % vertices.length || (j + 1) % vertices.length === i;
      // First and last edges share a vertex and are adjacent as well.
      const wrapAdjacent = i === 0 && j === vertices.length - 1;
      if (adjacent || wrapAdjacent) continue;
      const b1 = vertices[j];
      const b2 = vertices[(j + 1) % vertices.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

/** Backwards-compatible alias used by older tests/documentation. */
export const isValidOrthogonalRoom = isValidRoom;

/** Translate a whole wall parallel to itself. This works for both straight and angled walls. */
export function moveWall(room: RoomState, id: string, point: Vec2): RoomVertex[] | null {
  const wall = getWall(room, id);
  if (!wall) return null;
  const delta = (point.x - wall.start.x) * wall.inward.x + (point.z - wall.start.z) * wall.inward.z;
  const next = room.vertices.map((v) => ({ ...v }));
  const a = next[wall.index];
  const b = next[(wall.index + 1) % next.length];
  a.x += wall.inward.x * delta;
  a.z += wall.inward.z * delta;
  b.x += wall.inward.x * delta;
  b.z += wall.inward.z * delta;
  return isValidRoom(next) ? next : null;
}

/** Move only the chosen corner. Adjacent walls are free to become angled. */
export function moveCorner(room: RoomState, vertexId: string, x: number, z: number): RoomVertex[] | null {
  const index = room.vertices.findIndex((v) => v.id === vertexId);
  if (index < 0) return null;
  const next = room.vertices.map((v) => ({ ...v }));
  next[index].x = x;
  next[index].z = z;
  return isValidRoom(next) ? next : null;
}

/** Resize a wall from its start point while preserving that wall's current angle. */
export function resizeWall(room: RoomState, id: string, newLength: number): RoomVertex[] | null {
  const wall = getWall(room, id);
  if (!wall) return null;
  const length = Math.max(MIN_WALL_LENGTH, newLength);
  const next = room.vertices.map((v) => ({ ...v }));
  const endIndex = (wall.index + 1) % next.length;
  next[endIndex].x = wall.start.x + wall.tangent.x * length;
  next[endIndex].z = wall.start.z + wall.tangent.z * length;
  return isValidRoom(next) ? next : null;
}

export function wallProjectionDistance(wall: RoomWallSegment, point: Vec2) {
  return (point.x - wall.start.x) * wall.tangent.x + (point.z - wall.start.z) * wall.tangent.z;
}

export function distanceToWall(wall: RoomWallSegment, point: Vec2) {
  const projected = Math.max(0, Math.min(wall.length, wallProjectionDistance(wall, point)));
  const onWall = wallPoint(wall, projected);
  return Math.hypot(point.x - onWall.x, point.z - onWall.z);
}

/** Resize a wall around its midpoint, moving both endpoints equally along the wall tangent. */
export function resizeWallCentered(room: RoomState, id: string, newLength: number): RoomVertex[] | null {
  const wall = getWall(room, id);
  if (!wall) return null;
  const length = Math.max(MIN_WALL_LENGTH, newLength);
  const next = room.vertices.map((v) => ({ ...v }));
  const startIndex = wall.index;
  const endIndex = (wall.index + 1) % next.length;
  const mid = {
    x: (wall.start.x + wall.end.x) / 2,
    z: (wall.start.z + wall.end.z) / 2
  };
  const half = length / 2;
  next[startIndex].x = mid.x - wall.tangent.x * half;
  next[startIndex].z = mid.z - wall.tangent.z * half;
  next[endIndex].x = mid.x + wall.tangent.x * half;
  next[endIndex].z = mid.z + wall.tangent.z * half;
  return isValidRoom(next) ? next : null;
}

/** Insert a new editable corner at the midpoint of a wall. */
export function splitWall(room: RoomState, id: string, vertexId = `v-${crypto.randomUUID().slice(0, 8)}`): RoomVertex[] | null {
  const wall = getWall(room, id);
  if (!wall || wall.length < MIN_WALL_LENGTH * 2.05) return null;
  const midpoint = wallPoint(wall, wall.length / 2);
  const next = room.vertices.map((v) => ({ ...v }));
  next.splice(wall.index + 1, 0, { id: vertexId, x: midpoint.x, z: midpoint.z });
  return isValidRoom(next) ? next : null;
}

/** Interior angle at a room vertex in degrees, including reflex (>180°) corners. */
export function vertexInteriorAngle(room: RoomState, vertexId: string) {
  const index = room.vertices.findIndex((vertex) => vertex.id === vertexId);
  if (index < 0) return null;
  const current = room.vertices[index];
  const prev = room.vertices[(index - 1 + room.vertices.length) % room.vertices.length];
  const next = room.vertices[(index + 1) % room.vertices.length];
  const inX = current.x - prev.x;
  const inZ = current.z - prev.z;
  const outX = next.x - current.x;
  const outZ = next.z - current.z;
  const inLen = Math.hypot(inX, inZ);
  const outLen = Math.hypot(outX, outZ);
  if (inLen < EPS || outLen < EPS) return null;
  const dot = (inX * outX + inZ * outZ) / (inLen * outLen);
  const cross = (inX * outZ - inZ * outX) / (inLen * outLen);
  const turn = Math.atan2(cross, Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  const orientation = polygonArea(room.vertices) >= 0 ? 1 : -1;
  let interior = 180 - turn * orientation;
  while (interior < 0) interior += 360;
  while (interior >= 360) interior -= 360;
  return interior;
}
