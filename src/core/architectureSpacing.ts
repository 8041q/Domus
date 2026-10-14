import { getRoomWalls, wallPoint } from './roomGeometry';
import { openingFrameOverhang } from './architecturalStyles';
import { getPhysicalWalls } from './spaces';
import type { PlannerSnapshot, Vec2 } from './types';

export type ArchitectureMeasurement = {
  id: string; kind: 'wall-gap' | 'item-gap'; row: number;
  start: Vec2; end: Vec2; distance: number;
};

/** Two gap rows, always outside the selected aperture: corners and nearest targets. */
export function architectureSpacingMeasurements(snapshot: PlannerSnapshot, selectedId: string): ArchitectureMeasurement[] {
  const opening = snapshot.openings.find((opening) => opening.id === selectedId);
  if (!opening) return [];
  const walls = getPhysicalWalls(snapshot.room, snapshot.dividers);
  const anchor = walls.find((wall) => wall.id === opening.wallId);
  if (!anchor) return [];
  const interior = anchor.id.startsWith('divider-');
  const perimeter = interior ? [anchor] : getRoomWalls(snapshot.room);
  const starts: number[] = [];
  let cursor = 0;
  for (const wall of perimeter) { starts.push(cursor); cursor += wall.length; }
  const length = cursor;
  const wallStarts = new Map(perimeter.map((wall, index) => [wall.id, starts[index]]));
  const centre = wallStarts.get(opening.wallId)! + opening.offset;
  const halfWidth = opening.width / 2 + openingFrameOverhang(opening);
  const selected = { start: centre - halfWidth, end: centre + halfWidth };

  // Locate both full-frame edges, including across the perimeter seam. Each gap
  // follows its edge's straight wall run; split sections do not create corners.
  const locate = (distance: number) => {
    const cycle = interior ? 0 : Math.floor(distance / length);
    const local = interior ? Math.max(0, Math.min(length, distance)) : distance - cycle * length;
    const index = perimeter.findIndex((wall, i) => local < starts[i] + wall.length - 1e-9);
    const safeIndex = index < 0 ? perimeter.length - 1 : index;
    return { index: safeIndex, start: starts[safeIndex] + cycle * length };
  };
  const pointAt = (distance: number) => {
    const location = locate(distance);
    return wallPoint(perimeter[location.index], distance - location.start);
  };
  const leftEdge = locate(selected.start - 1e-8), rightEdge = locate(selected.end + 1e-8);
  let boundaryStart = interior ? 0 : leftEdge.start;
  let boundaryEnd = interior ? length : rightEdge.start + perimeter[rightEdge.index].length;
  const aligned = (a: typeof anchor, b: typeof anchor) => a.tangent.x * b.tangent.x + a.tangent.z * b.tangent.z > 1 - 1e-8;
  if (!interior) {
    for (const side of [-1, 1]) {
      const edge = side < 0 ? leftEdge : rightEdge;
      let index = edge.index;
      for (let count = 0; count < perimeter.length - 1; count++) {
        index = (index + side + perimeter.length) % perimeter.length;
        if (!aligned(perimeter[index], perimeter[edge.index])) break;
        if (side < 0) boundaryStart -= perimeter[index].length;
        else boundaryEnd += perimeter[index].length;
      }
    }
  }
  const result: ArchitectureMeasurement[] = [];
  const add = (id: string, kind: ArchitectureMeasurement['kind'], row: number, start: number, end: number) => {
    if (end - start < 0.005) return;
    result.push({ id, kind, row, start: pointAt(start), end: pointAt(end), distance: end - start });
  };
  add('left-wall', 'wall-gap', 1, boundaryStart, selected.start);
  add('right-wall', 'wall-gap', 1, selected.end, boundaryEnd);
  const others = snapshot.openings.filter((other) => other.id !== opening.id && wallStarts.has(other.wallId)).flatMap((other) => {
    const middle = wallStarts.get(other.wallId)! + other.offset;
    const half = other.width / 2 + openingFrameOverhang(other);
    return (interior ? [0] : [-length, 0, length]).map((shift) => ({ start: middle - half + shift, end: middle + half + shift }));
  });
  const left = others.filter((other) => other.end > boundaryStart && other.end <= selected.start + 1e-6).sort((a, b) => b.end - a.end)[0];
  const right = others.filter((other) => other.start < boundaryEnd && other.start >= selected.end - 1e-6).sort((a, b) => a.start - b.start)[0];
  add('left-item', left ? 'item-gap' : 'wall-gap', 0, left?.end ?? boundaryStart, selected.start);
  add('right-item', right ? 'item-gap' : 'wall-gap', 0, selected.end, right?.start ?? boundaryEnd);
  return result;
}
