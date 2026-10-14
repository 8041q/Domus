import { getRoomWalls, openingsOnWall, perimeterDistance, wallPoint } from './roomGeometry';
import { getPhysicalWalls, validateInteriorOpenings } from './spaces';
import type { InteriorDivider, RoomOpening, RoomState, Vec2 } from './types';

export const OPENING_GAP = 0.05;
export const openingClearance = (opening: RoomOpening) => opening.type === 'door' ? 0.07 : opening.type === 'window' ? 0.05 : 0.025;

/** Frames and leaves are rigid. Only empty openings may turn a sharp corner. */
export function openingFitsBoundary(room: RoomState, dividers: InteriorDivider[], opening: RoomOpening) {
  if (opening.wallId.startsWith('divider-')) return validateInteriorOpenings(room, dividers,
    [{ ...opening, width: opening.width + Math.max(0, openingClearance(opening) - OPENING_GAP) * 2 }]);
  const walls = getRoomWalls(room);
  const perimeter = walls.reduce((sum, wall) => sum + wall.length, 0);
  const centre = perimeterDistance(room, opening.wallId, opening.offset);
  if (centre == null || opening.width > perimeter - 0.2) return false;
  if (opening.type === 'opening') return true;
  // Include the casing and a little solid wall at either end, even after resizing.
  const half = opening.width / 2 + openingClearance(opening);
  const runs: Array<{ start: number; tangent: Vec2 }> = [];
  let cursor = 0;
  for (const wall of walls) {
    for (const shift of [-perimeter, 0, perimeter]) {
      const start = cursor + shift;
      if (Math.min(start + wall.length, centre + half) - Math.max(start, centre - half) > 1e-6) {
        runs.push({ start, tangent: wall.tangent });
      }
    }
    cursor += wall.length;
  }
  runs.sort((a, b) => a.start - b.start);
  const curvedDoor = opening.type === 'door' && (room.shapeKind === 'circle' || opening.wrapAround === true);
  let totalTurn = 0;
  for (let index = 1; index < runs.length; index++) {
    const a = runs[index - 1].tangent, b = runs[index].tangent;
    const turn = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z)));
    if (turn > (curvedDoor ? Math.PI / 12 : 1e-5)) return false;
    totalTurn += turn;
  }
  return totalTurn <= (curvedDoor ? Math.PI / 4 + 1e-6 : 1e-5);
}

export function openingPlacementValid(room: RoomState, dividers: InteriorDivider[], opening: RoomOpening, others: RoomOpening[]) {
  if (!openingFitsBoundary(room, dividers, opening)) return false;
  if (!validateInteriorOpenings(room, dividers, [...others, opening])) return false;
  for (const wall of getPhysicalWalls(room, dividers)) {
    const pieces = openingsOnWall(room, [{ ...opening, width: opening.width + openingClearance(opening) * 2 }], wall.id);
    for (const other of others) {
      if (other.id === opening.id || Math.min(opening.sillHeight + opening.height, other.sillHeight + other.height)
        <= Math.max(opening.sillHeight, other.sillHeight) + 1e-6) continue;
      if (pieces.some((piece) => openingsOnWall(room, [{ ...other, width: other.width + openingClearance(other) * 2 }], wall.id).some((candidate) =>
        Math.min(piece.offset + piece.width / 2, candidate.offset + candidate.width / 2)
          - Math.max(piece.offset - piece.width / 2, candidate.offset - candidate.width / 2) > 1e-6))) return false;
    }
  }
  return true;
}

/** Find the nearest legal position while preserving the requested type and size. */
export function fitOpening(room: RoomState, dividers: InteriorDivider[], opening: RoomOpening, others: RoomOpening[]) {
  if (openingPlacementValid(room, dividers, opening, others)) return opening;
  const physical = getPhysicalWalls(room, dividers);
  const anchor = physical.find((wall) => wall.id === opening.wallId);
  if (!anchor) return null;
  const perimeter = getRoomWalls(room).reduce((sum, wall) => sum + wall.length, 0);
  const desired = perimeterDistance(room, opening.wallId, opening.offset);
  const candidates = physical.filter((wall) => opening.wallId.startsWith('divider-') ? wall.id === opening.wallId : !wall.id.startsWith('divider-'))
    .flatMap((wall) => {
      const half = opening.width / 2 + openingClearance(opening);
      const offsets = [opening.offset, wall.length / 2, half, wall.length - half,
        ...others.filter((other) => other.wallId === wall.id).flatMap((other) =>
          [other.offset - other.width / 2 - openingClearance(other) - half,
            other.offset + other.width / 2 + openingClearance(other) + half]),
        ...Array.from({ length: Math.ceil(wall.length / 0.05) + 1 }, (_, index) => index * 0.05)];
      return [...new Set(offsets)].filter((offset) => offset >= 0 && offset <= wall.length).map((offset) => {
        const position = perimeterDistance(room, wall.id, offset);
        const direct = desired != null && position != null ? Math.abs(position - desired) : Math.abs(offset - opening.offset);
        return { opening: { ...opening, wallId: wall.id, offset }, distance: desired != null ? Math.min(direct, perimeter - direct) : direct };
      });
    }).sort((a, b) => a.distance - b.distance);
  return candidates.find((candidate) => openingPlacementValid(room, dividers, candidate.opening, others))?.opening ?? null;
}

/** Shared pointer projection for 2D drags, including corner-wrapping apertures. */
export function openingPositionAtPoint(room: RoomState, dividers: InteriorDivider[], opening: RoomOpening, point: Vec2, grabOffset: number) {
  const walls = getPhysicalWalls(room, dividers).filter((wall) => opening.type !== 'window' || !wall.id.startsWith('divider-'));
  const nearest = walls.map((wall) => {
    const along = Math.max(0, Math.min(wall.length, (point.x - wall.start.x) * wall.tangent.x + (point.z - wall.start.z) * wall.tangent.z));
    const projected = wallPoint(wall, along);
    return { wall, along, distance: Math.hypot(projected.x - point.x, projected.z - point.z) };
  }).sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) return null;
  const distance = perimeterDistance(room, nearest.wall.id, nearest.along);
  return { wall: nearest.wall, offset: nearest.along + grabOffset, distance: distance == null ? null : distance + grabOffset };
}
