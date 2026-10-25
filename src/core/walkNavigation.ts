import { DOOR_FRAME_WIDTH } from './architecturalStyles';
import { getRoomWalls, pointInRoom, roomBounds } from './roomGeometry';
import { deriveSpaces, resolveDividers } from './spaces';
import type { PlannerSnapshot, Vec2 } from './types';

export const WALK_RADIUS = 0.20;
export const WALK_EYE_HEIGHT = 1.60;
const WALL_THICKNESS = 0.05;
const EPSILON = 1e-7;
const SKIN = 0.0001;

interface WalkWall {
  start: Vec2;
  end: Vec2;
  length: number;
  tx: number;
  tz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
export interface WalkNavigation {
  snapshot: PlannerSnapshot;
  radius: number;
  eyeHeight: number;
  bodyHeight: number;
  clearance: number;
  walls: WalkWall[];
  bounds: ReturnType<typeof roomBounds>;
}

function collisionWall(start: Vec2, end: Vec2): WalkWall {
  const dx = end.x - start.x, dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  return { start, end, length, tx: length > EPSILON ? dx / length : 0, tz: length > EPSILON ? dz / length : 0,
    minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x), minZ: Math.min(start.z, end.z), maxZ: Math.max(start.z, end.z) };
}

/** Build collision geometry from architecture, independently of visual wall cutaways. */
export function createWalkNavigation(snapshot: PlannerSnapshot, options: { radius?: number; eyeHeight?: number } = {}): WalkNavigation {
  const radius = Math.max(0.05, Number.isFinite(options.radius) ? options.radius! : WALK_RADIUS);
  const eyeHeight = Math.max(0.1, Math.min(Number.isFinite(options.eyeHeight) ? options.eyeHeight! : WALK_EYE_HEIGHT, snapshot.room.height - 0.18));
  const bodyHeight = Math.min(eyeHeight + 0.15, snapshot.room.height - 0.03);
  // Exterior apertures still bound the walkable floor: the planner has no floor outside.
  const walls: WalkWall[] = getRoomWalls(snapshot.room).map((wall) => collisionWall(wall.start, wall.end));
  for (const divider of resolveDividers(snapshot.room, snapshot.dividers)) {
    if (divider.kind !== 'wall') continue;
    const tangent = { x: (divider.b.x - divider.a.x) / divider.length, z: (divider.b.z - divider.a.z) / divider.length };
    const point = (distance: number) => ({ x: divider.a.x + tangent.x * distance, z: divider.a.z + tangent.z * distance });
    const gaps = snapshot.openings.filter((opening) => opening.wallId === divider.id
      && (opening.type === 'opening' || (opening.type === 'door' && opening.variant === 'door-frame'))
      && opening.sillHeight <= 0.03
      && opening.height + opening.sillHeight - (opening.type === 'door' ? DOOR_FRAME_WIDTH / 2 : 0) >= bodyHeight)
      .map((opening) => {
        // Door jambs occupy some of the aperture; a bare wall opening has no frame.
        const jamb = opening.type === 'door' ? DOOR_FRAME_WIDTH / 2 : 0;
        return { start: Math.max(0, opening.offset - opening.width / 2 + jamb), end: Math.min(divider.length, opening.offset + opening.width / 2 - jamb) };
      }).filter((gap) => gap.end > gap.start).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const gap of gaps) {
      if (gap.start > cursor) walls.push(collisionWall(point(cursor), point(gap.start)));
      cursor = Math.max(cursor, gap.end);
    }
    if (cursor < divider.length) walls.push(collisionWall(point(cursor), point(divider.length)));
  }
  return { snapshot, radius, eyeHeight, bodyHeight, clearance: radius + WALL_THICKNESS / 2, walls, bounds: roomBounds(snapshot.room.vertices) };
}

export function isWalkPositionValid(navigation: WalkNavigation, point: Vec2) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return false;
  const clearance = navigation.clearance - EPSILON, bounds = navigation.bounds;
  if (point.x < bounds.minX + clearance || point.x > bounds.maxX - clearance
    || point.z < bounds.minZ + clearance || point.z > bounds.maxZ - clearance) return false;
  // Physical perimeter clearance already excludes the boundary. Avoid the
  // separate point-on-every-segment pass used by general editor containment.
  const vertices = navigation.snapshot.room.vertices;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i], b = vertices[j];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  if (!inside) return false;
  const clearance2 = clearance * clearance;
  for (const wall of navigation.walls) {
    if (point.x < wall.minX - clearance || point.x > wall.maxX + clearance
      || point.z < wall.minZ - clearance || point.z > wall.maxZ + clearance) continue;
    const along = Math.max(0, Math.min(wall.length, (point.x - wall.start.x) * wall.tx + (point.z - wall.start.z) * wall.tz));
    const dx = point.x - wall.start.x - wall.tx * along, dz = point.z - wall.start.z - wall.tz * along;
    if (dx * dx + dz * dz < clearance2) return false;
  }
  return true;
}

/** Prefer the existing camera/selected space, then search for clear floor in concave rooms. */
export function findWalkSpawn(navigation: WalkNavigation, preferred?: Vec2, spaceId?: string | null): Vec2 | null {
  const snapshot = navigation.snapshot;
  const space = spaceId ? deriveSpaces(snapshot).find((candidate) => candidate.id === spaceId) : undefined;
  const spaceRoom = space ? { ...snapshot.room, vertices: space.polygon.map((vertex, index) => ({ ...vertex, id: String(index) })) } : null;
  const inSpace = (point: Vec2) => !spaceRoom || pointInRoom(point, spaceRoom, false);
  const valid = (point: Vec2) => inSpace(point) && isWalkPositionValid(navigation, point);
  const bounds = spaceRoom ? roomBounds(spaceRoom.vertices) : navigation.bounds;
  const centre = { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
  if (preferred && (!Number.isFinite(preferred.x) || !Number.isFinite(preferred.z))) preferred = undefined;
  const target = space?.seed ?? preferred ?? centre;
  // An invalid existing camera position needs the nearest clear floor. A valid
  // room centre can be far away after an architectural edit, so it must compete
  // with nearby candidates instead of short-circuiting that recovery search.
  for (const point of [preferred, space?.seed, ...(preferred ? [] : [centre])]) {
    if (point && valid(point)) return { ...point };
  }
  let best: Vec2 | null = null;
  let bestDistance = Infinity;
  // Cap the coarse grid on large plans; wall probes below cover narrow spaces.
  const step = Math.max(0.10, Math.max(bounds.width, bounds.depth) / 160);
  const consider = (point: Vec2) => {
    const distance = (point.x - target.x) ** 2 + (point.z - target.z) ** 2;
    if (distance < bestDistance && valid(point)) { best = point; bestDistance = distance; }
  };
  // A space can be bounded by invisible dividers, so its bounding box needs no
  // physical-wall inset. The validity check handles real walls and door jambs.
  const inset = space ? 0 : navigation.clearance;
  for (let z = bounds.minZ + inset; z <= bounds.maxZ - inset + EPSILON; z += step) {
    for (let x = bounds.minX + inset; x <= bounds.maxX - inset + EPSILON; x += step) consider({ x, z });
  }
  // Either side of a divider can bound a small face missed by the grid.
  for (const wall of navigation.walls) {
    const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
    const length = Math.hypot(dx, dz);
    if (length < EPSILON) continue;
    const normal = { x: -dz / length, z: dx / length };
    for (let distance = 0; distance <= length; distance += Math.max(0.1, length / 80)) {
      for (const side of [-1, 1]) consider({
        x: wall.start.x + dx * distance / length + normal.x * (navigation.clearance + SKIN) * side,
        z: wall.start.z + dz * distance / length + normal.z * (navigation.clearance + SKIN) * side
      });
    }
  }
  // A narrow selected space should not make the whole project's Walk view
  // unavailable. This fallback is only for spawning, never normal movement.
  return best ?? (space ? findWalkSpawn(navigation, preferred) : null);
}

interface SweepHit { time: number; normal: Vec2 }

/** Earliest contact between a moving point and a capsule around a wall segment. */
function sweepWall(from: Vec2, delta: Vec2, wall: WalkWall, radius: number): SweepHit | null {
  const length = wall.length;
  let best: SweepHit | null = null;
  const consider = (time: number, normal: Vec2) => {
    if (time < -EPSILON || time > 1 + EPSILON || delta.x * normal.x + delta.z * normal.z >= -EPSILON) return;
    if (!best || time < best.time) best = { time: Math.max(0, time), normal };
  };
  if (length > EPSILON) {
    const tx = wall.tx, tz = wall.tz;
    const nx = -tz, nz = tx;
    const distance = (from.x - wall.start.x) * nx + (from.z - wall.start.z) * nz;
    const speed = delta.x * nx + delta.z * nz;
    if (Math.abs(speed) > EPSILON) {
      for (const side of [-1, 1]) {
        const time = (side * radius - distance) / speed;
        const along = (from.x + delta.x * time - wall.start.x) * tx + (from.z + delta.z * time - wall.start.z) * tz;
        if (along >= -EPSILON && along <= length + EPSILON) consider(time, { x: nx * side, z: nz * side });
      }
    }
  }
  const speed2 = delta.x * delta.x + delta.z * delta.z;
  if (speed2 > EPSILON * EPSILON) for (const end of [wall.start, wall.end]) {
    const ox = from.x - end.x, oz = from.z - end.z;
    const b = ox * delta.x + oz * delta.z;
    const discriminant = b * b - speed2 * (ox * ox + oz * oz - radius * radius);
    if (discriminant < 0) continue;
    const time = (-b - Math.sqrt(discriminant)) / speed2;
    const nx = ox + delta.x * time, nz = oz + delta.z * time;
    const normalLength = Math.hypot(nx, nz);
    if (normalLength > EPSILON) consider(time, { x: nx / normalLength, z: nz / normalLength });
  }
  return best;
}

/** Sweep the entire displacement, then slide along contacts, so large wheel/frame steps cannot tunnel. */
export function moveWalkPosition(navigation: WalkNavigation, from: Vec2, displacement: Vec2): Vec2 {
  if (!isWalkPositionValid(navigation, from)) return findWalkSpawn(navigation, from) ?? { ...from };
  if (!Number.isFinite(displacement.x) || !Number.isFinite(displacement.z)) return { ...from };
  let point = { ...from }, remaining = { ...displacement };
  for (let iteration = 0; iteration < 6 && Math.hypot(remaining.x, remaining.z) > EPSILON; iteration++) {
    let hit: SweepHit | null = null;
    const minX = Math.min(point.x, point.x + remaining.x) - navigation.clearance;
    const maxX = Math.max(point.x, point.x + remaining.x) + navigation.clearance;
    const minZ = Math.min(point.z, point.z + remaining.z) - navigation.clearance;
    const maxZ = Math.max(point.z, point.z + remaining.z) + navigation.clearance;
    for (const wall of navigation.walls) {
      if (wall.maxX < minX || wall.minX > maxX || wall.maxZ < minZ || wall.minZ > maxZ) continue;
      const candidate = sweepWall(point, remaining, wall, navigation.clearance);
      if (candidate && (!hit || candidate.time < hit.time)) hit = candidate;
    }
    if (!hit) { point = { x: point.x + remaining.x, z: point.z + remaining.z }; break; }
    const fraction = Math.max(0, hit.time - SKIN / Math.hypot(remaining.x, remaining.z));
    point = { x: point.x + remaining.x * fraction, z: point.z + remaining.z * fraction };
    remaining = { x: remaining.x * (1 - fraction), z: remaining.z * (1 - fraction) };
    const intoWall = remaining.x * hit.normal.x + remaining.z * hit.normal.z;
    if (intoWall < 0) remaining = { x: remaining.x - hit.normal.x * intoWall, z: remaining.z - hit.normal.z * intoWall };
  }
  return isWalkPositionValid(navigation, point) ? point : { ...from };
}
