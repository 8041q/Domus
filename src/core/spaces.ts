import { getRoomWalls, isValidRoom, pointInRoom, polygonArea } from './roomGeometry';
import type { DividerAnchor, InteriorDivider, NamedSpace, PlannerSnapshot, RoomOpening, RoomState, RoomWallSegment, Vec2 } from './types';

const EPS = 1e-6;
const close = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z) < 1e-5;
const mix = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
const cross = (a: Vec2, b: Vec2) => a.x * b.z - a.z * b.x;

export interface ResolvedDivider extends InteriorDivider { a: Vec2; b: Vec2; length: number }
export interface DerivedSpace extends NamedSpace { polygon: Vec2[]; area: number; boundaryKey: string }

export function resolveDividers(room: RoomState, dividers: InteriorDivider[]): ResolvedDivider[] {
  const cache = new Map<string, ResolvedDivider>();
  const visiting = new Set<string>();
  const byId = new Map(dividers.map((divider) => [divider.id, divider]));
  const resolveAnchor = (anchor: DividerAnchor): Vec2 | null => {
    if (!anchor || (anchor.kind !== 'perimeter' && anchor.kind !== 'divider') || typeof anchor.id !== 'string') return null;
    if (!Number.isFinite(anchor.t) || anchor.t < -EPS || anchor.t > 1 + EPS) return null;
    if (anchor.kind === 'perimeter') {
      const wall = getRoomWalls(room).find((item) => item.id === anchor.id);
      return wall ? mix(wall.start, wall.end, anchor.t) : null;
    }
    const parent = resolve(anchor.id);
    return parent ? mix(parent.a, parent.b, anchor.t) : null;
  };
  const resolve = (id: string): ResolvedDivider | null => {
    if (cache.has(id)) return cache.get(id)!;
    const divider = byId.get(id);
    if (!divider || visiting.has(id)) return null;
    visiting.add(id);
    const a = resolveAnchor(divider.start);
    const b = resolveAnchor(divider.end);
    visiting.delete(id);
    if (!a || !b || close(a, b)) return null;
    const result = { ...divider, a, b, length: Math.hypot(b.x - a.x, b.z - a.z) };
    cache.set(id, result);
    return result;
  };
  return dividers.flatMap((divider) => resolve(divider.id) ?? []);
}

export function closestBoundaryAnchor(room: RoomState, dividers: InteriorDivider[], point: Vec2, maxDistance = 0.22, excludeId?: string) {
  const lines = [
    ...getRoomWalls(room).map((wall) => ({ kind: 'perimeter' as const, id: wall.id, a: wall.start, b: wall.end })),
    ...resolveDividers(room, dividers).filter((divider) => divider.id !== excludeId)
      .map((divider) => ({ kind: 'divider' as const, id: divider.id, a: divider.a, b: divider.b }))
  ];
  let best: { anchor: DividerAnchor; point: Vec2; distance: number } | null = null;
  for (const line of lines) {
    const dx = line.b.x - line.a.x;
    const dz = line.b.z - line.a.z;
    const length2 = dx * dx + dz * dz;
    if (length2 < EPS) continue;
    const t = Math.max(0, Math.min(1, ((point.x - line.a.x) * dx + (point.z - line.a.z) * dz) / length2));
    const projected = mix(line.a, line.b, t);
    const distance = Math.hypot(point.x - projected.x, point.z - projected.z);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { anchor: { kind: line.kind, id: line.id, t }, point: projected, distance };
    }
  }
  return best;
}

function lineIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const r = { x: b.x - a.x, z: b.z - a.z };
  const s = { x: d.x - c.x, z: d.z - c.z };
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null;
  const delta = { x: c.x - a.x, z: c.z - a.z };
  const t = cross(delta, s) / den;
  const u = cross(delta, r) / den;
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? { t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) } : null;
}

/** Distances where another divider meets or crosses this one. */
export function dividerJunctionDistances(room: RoomState, dividers: InteriorDivider[], id: string, physicalOnly = false): number[] {
  const resolved = resolveDividers(room, dividers);
  const divider = resolved.find((item) => item.id === id);
  if (!divider) return [];
  return resolved.flatMap((other) => {
    if (other.id === id || (physicalOnly && other.kind !== 'wall')) return [];
    const hit = lineIntersection(divider.a, divider.b, other.a, other.b);
    return hit && hit.t > EPS && hit.t < 1 - EPS ? [hit.t * divider.length] : [];
  });
}

function pointInPolygon(point: Vec2, polygon: Vec2[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function faceSeed(polygon: Vec2[]) {
  const area = polygonArea(polygon);
  let x = 0, z = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const factor = a.x * b.z - b.x * a.z;
    x += (a.x + b.x) * factor;
    z += (a.z + b.z) * factor;
  }
  const centroid = { x: x / (6 * area), z: z / (6 * area) };
  if (pointInPolygon(centroid, polygon)) return centroid;
  const a = polygon[0], b = polygon[1];
  const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
  return { x: (a.x + b.x) / 2 - dz / length * 0.001, z: (a.z + b.z) / 2 + dx / length * 0.001 };
}

/** Build bounded faces of the perimeter/divider planar graph. Door gaps remain graph edges. */
function deriveSpaceFaces(room: RoomState, dividers: InteriorDivider[]) {
  const perimeter = getRoomWalls(room).map((wall) => ({ a: wall.start as Vec2, b: wall.end as Vec2, id: '' }));
  const resolved = resolveDividers(room, dividers);
  if (resolved.length !== dividers.length) return [];
  const segments = [...perimeter, ...resolved.map(({ a, b, id }) => ({ a, b, id }))];
  const cuts = segments.map(() => [0, 1]);
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const hit = lineIntersection(segments[i].a, segments[i].b, segments[j].a, segments[j].b);
      if (!hit) continue;
      cuts[i].push(hit.t);
      cuts[j].push(hit.u);
    }
  }
  const nodes: Vec2[] = [];
  const nodeId = (point: Vec2) => {
    const index = nodes.findIndex((candidate) => close(candidate, point));
    if (index >= 0) return index;
    nodes.push(point);
    return nodes.length - 1;
  };
  const outgoing = new Map<number, Array<{ from: number; to: number; angle: number; used: boolean; side: string }>>();
  const addEdge = (from: number, to: number, side: string) => {
    const a = nodes[from], b = nodes[to];
    const list = outgoing.get(from) ?? [];
    if (!list.some((edge) => edge.to === to)) list.push({ from, to, angle: Math.atan2(b.z - a.z, b.x - a.x), used: false, side });
    outgoing.set(from, list);
  };
  segments.forEach((segment, i) => {
    const sorted = [...new Set(cuts[i].map((t) => Math.round(t * 1e8) / 1e8))].sort((a, b) => a - b);
    for (let k = 0; k < sorted.length - 1; k++) {
      const a = nodeId(mix(segment.a, segment.b, sorted[k]));
      const b = nodeId(mix(segment.a, segment.b, sorted[k + 1]));
      if (a !== b) { addEdge(a, b, segment.id ? `${segment.id}:left` : ''); addEdge(b, a, segment.id ? `${segment.id}:right` : ''); }
    }
  });
  outgoing.forEach((list) => list.sort((a, b) => a.angle - b.angle));
  const faces: Array<{ polygon: Vec2[]; boundaryKey: string }> = [];
  for (const list of outgoing.values()) for (const start of list) {
    if (start.used) continue;
    const polygon: Vec2[] = [];
    const sides = new Set<string>();
    let edge = start;
    for (let guard = 0; guard < nodes.length * 4; guard++) {
      if (edge.used) break;
      edge.used = true;
      polygon.push(nodes[edge.from]);
      if (edge.side) sides.add(edge.side);
      const next = outgoing.get(edge.to)!;
      const reverse = next.findIndex((candidate) => candidate.to === edge.from);
      edge = next[(reverse - 1 + next.length) % next.length];
      if (edge === start) break;
    }
    if (edge === start && polygon.length >= 3 && polygonArea(polygon) > EPS) {
      const seed = faceSeed(polygon);
      if (pointInRoom(seed, room, false)) faces.push({ polygon, boundaryKey: [...sides].sort().join('|') || 'shell' });
    }
  }
  return faces;
}

export function deriveSpacePolygons(room: RoomState, dividers: InteriorDivider[]): Vec2[][] {
  return deriveSpaceFaces(room, dividers).map((face) => face.polygon);
}

export function deriveSpaces(snapshot: PlannerSnapshot): DerivedSpace[] {
  const faces = deriveSpaceFaces(snapshot.room, snapshot.dividers);
  const claimed = new Set<string>();
  const reserved = new Set(snapshot.spaces.filter((space) => faces.some((face) => face.boundaryKey === space.boundaryKey)).map((space) => space.id));
  return faces.map(({ polygon, boundaryKey }, index) => {
    const seed = faceSeed(polygon);
    const match = snapshot.spaces.find((space) => !claimed.has(space.id) && space.boundaryKey === boundaryKey)
      ?? snapshot.spaces.find((space) => !claimed.has(space.id) && !reserved.has(space.id) && pointInPolygon(space.seed, polygon))
      ?? (faces.length === 1 && snapshot.spaces.length === 1 ? snapshot.spaces[0] : undefined);
    if (match) claimed.add(match.id);
    return { id: match?.id ?? `unassigned-${index}`, name: match?.name ?? `Space ${index + 1}`,
      seed, boundaryKey, floorFinish: match?.floorFinish ?? snapshot.room.floorFinish,
      wallColor: match?.wallColor ?? snapshot.room.wallColor, polygon, area: Math.abs(polygonArea(polygon)) };
  });
}

export function spaceAtPoint(snapshot: PlannerSnapshot, point: Vec2) {
  return deriveSpaces(snapshot).find((space) => pointInPolygon(point, space.polygon)) ?? null;
}

/** Probe the semantic face beside the centreline, including very narrow spaces. */
export function wallAdjacentSpaces(snapshot: PlannerSnapshot, wall: RoomWallSegment, distance: number, spaces = deriveSpaces(snapshot)) {
  const centre = mix(wall.start, wall.end, distance / wall.length);
  const offset = 1e-4;
  return {
    left: spaces.find((space) => pointInPolygon({ x: centre.x + wall.inward.x * offset, z: centre.z + wall.inward.z * offset }, space.polygon)) ?? null,
    right: spaces.find((space) => pointInPolygon({ x: centre.x - wall.inward.x * offset, z: centre.z - wall.inward.z * offset }, space.polygon)) ?? null
  };
}

export function interiorDoorHasThreshold(snapshot: PlannerSnapshot, opening: RoomOpening) {
  if (opening.type !== 'door' || opening.variant === 'door-frame') return false;
  const wall = getPhysicalWalls(snapshot.room, snapshot.dividers).find((item) => item.id === opening.wallId && snapshot.dividers.some((divider) => divider.id === item.id));
  if (!wall) return false;
  const start = opening.offset - opening.width / 2, end = opening.offset + opening.width / 2;
  const cuts = [start, ...dividerJunctionDistances(snapshot.room, snapshot.dividers, wall.id)
    .filter((distance) => distance > start && distance < end), end].sort((a, b) => a - b);
  return cuts.slice(1).some((distance, index) => {
    const { left, right } = wallAdjacentSpaces(snapshot, wall, (cuts[index] + distance) / 2);
    return !!left && !!right && left.floorFinish !== right.floorFinish;
  });
}

export function getPhysicalWalls(room: RoomState, dividers: InteriorDivider[]): RoomWallSegment[] {
  return [...getRoomWalls(room), ...resolveDividers(room, dividers).filter((divider) => divider.kind === 'wall').map((divider, index) => {
    const tangent = { x: (divider.b.x - divider.a.x) / divider.length, z: (divider.b.z - divider.a.z) / divider.length };
    return { id: divider.id, index: room.vertices.length + index,
      start: { ...divider.a, id: `${divider.id}-start` }, end: { ...divider.b, id: `${divider.id}-end` },
      length: divider.length, horizontal: Math.abs(tangent.x) >= Math.abs(tangent.z), tangent,
      inward: { x: -tangent.z, z: tangent.x } };
  })];
}

export function architectureRoom(snapshot: PlannerSnapshot) {
  return { ...snapshot.room, dividers: snapshot.dividers, openings: snapshot.openings };
}

export function validateDividers(room: RoomState, dividers: InteriorDivider[]) {
  if (!room.vertices.every((vertex) => Number.isFinite(vertex.x) && Number.isFinite(vertex.z)) || !isValidRoom(room.vertices)) return false;
  if (!dividers.every((divider) => divider && typeof divider.id === 'string' && divider.id.length > 0
    && (divider.kind === 'wall' || divider.kind === 'open'))) return false;
  if (new Set(dividers.map((divider) => divider.id)).size !== dividers.length) return false;
  const resolved = resolveDividers(room, dividers);
  if (resolved.length !== dividers.length) return false;
  return resolved.every((divider) => {
    if (divider.length < 0.2) return false;
    const cuts = [0, 1, ...getRoomWalls(room).flatMap((wall) => {
      const hit = lineIntersection(divider.a, divider.b, wall.start, wall.end);
      return hit ? [hit.t] : [];
    })].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      if (cuts[i + 1] - cuts[i] > EPS && !pointInRoom(mix(divider.a, divider.b, (cuts[i] + cuts[i + 1]) / 2), room, false)) return false;
    }
    return !resolved.some((other) => {
      if (other.id === divider.id) return false;
      const direction = { x: divider.b.x - divider.a.x, z: divider.b.z - divider.a.z };
      const otherDirection = { x: other.b.x - other.a.x, z: other.b.z - other.a.z };
      if (Math.abs(cross(direction, otherDirection)) > 1e-5 || Math.abs(cross(direction, { x: other.a.x - divider.a.x, z: other.a.z - divider.a.z })) > 1e-5) return false;
      const axis = Math.abs(direction.x) >= Math.abs(direction.z) ? 'x' : 'z';
      const overlap = Math.min(Math.max(divider.a[axis], divider.b[axis]), Math.max(other.a[axis], other.b[axis]))
        - Math.max(Math.min(divider.a[axis], divider.b[axis]), Math.min(other.a[axis], other.b[axis]));
      return overlap > EPS;
    });
  }) && deriveSpacePolygons(room, dividers).length > 0;
}

/** Interior doors must fit the wall and leave physical junctions intact. */
export function validateInteriorOpenings(room: RoomState, dividers: InteriorDivider[], openings: RoomOpening[]) {
  const walls = resolveDividers(room, dividers);
  return openings.every((opening) => {
    const wall = walls.find((divider) => divider.id === opening.wallId);
    if (!wall) return !opening.wallId?.startsWith('divider-');
    const start = opening.offset - opening.width / 2, end = opening.offset + opening.width / 2;
    if (wall.kind !== 'wall' || opening.type === 'window' || !Number.isFinite(start) || !Number.isFinite(end)
      || !Number.isFinite(opening.width) || !Number.isFinite(opening.height) || !Number.isFinite(opening.sillHeight)
      || opening.width <= 0 || opening.height <= 0 || opening.sillHeight < 0
      || start < 0.05 - EPS || end > wall.length - 0.05 + EPS) return false;
    if (dividerJunctionDistances(room, dividers, wall.id, true)
      .some((distance) => distance > start - 0.025 && distance < end + 0.025)) return false;
    return !openings.some((other) => other.id !== opening.id && other.wallId === wall.id
      && Math.min(end, other.offset + other.width / 2) - Math.max(start, other.offset - other.width / 2) > -0.05);
  });
}
