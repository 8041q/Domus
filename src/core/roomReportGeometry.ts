import { getRoomWalls, openingsOnWall } from './roomGeometry';
import { getPhysicalWalls } from './spaces';
import type { PlanCameraView, PlannerSnapshot, RoomWallSegment } from './types';

export type ReportSide = Exclude<PlanCameraView, 'free' | 'top'>;
export interface OpeningCoverage { id: string; name: string; start: number; end: number; bottom: number; top: number }
export interface ReportBoundary {
  label: string; walls: RoomWallSegment[]; length: number; span: number; height: number;
  grossArea: number; netArea: number; openings: OpeningCoverage[]; openingCount: number; curved: boolean;
}
export interface ReportViewSummary {
  view: ReportSide; hiddenWallIds: string[]; boundaries: ReportBoundary[];
  length: number; span: number; height: number; grossArea: number; netArea: number; openingCount: number;
}

/** Exact union of wall-local aperture rectangles, including overlapping apertures. */
export function coverageArea(rectangles: OpeningCoverage[]) {
  const xs = [...new Set(rectangles.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const strips = rectangles.filter((r) => r.start < xs[i] && r.end > xs[i - 1])
      .map((r) => [r.bottom, r.top]).sort((a, b) => a[0] - b[0]);
    let bottom = 0, top = 0, height = 0;
    for (const strip of strips) {
      if (strip[0] > top) { height += top - bottom; [bottom, top] = strip; }
      else top = Math.max(top, strip[1]);
    }
    height += top - bottom; area += (xs[i] - xs[i - 1]) * height;
  }
  return area;
}

export function reportBoundary(snapshot: PlannerSnapshot, walls: RoomWallSegment[], label: string, view: ReportSide): ReportBoundary {
  let length = 0, deduction = 0;
  const pieces: OpeningCoverage[] = [];
  const typeCounters = { door: 0, window: 0, opening: 0 };
  const labels = new Map(snapshot.openings.map((o) => [o.id, `${o.type[0].toUpperCase()}${o.type.slice(1)} ${++typeCounters[o.type]}`]));
  for (const wall of walls) {
    const wallOpenings = wall.id.startsWith('divider-')
      ? snapshot.openings.filter((opening) => opening.wallId === wall.id)
      : openingsOnWall(snapshot.room, snapshot.openings, wall.id);
    const coverage = wallOpenings.map((o) => ({
      id: o.id, name: labels.get(o.id)!, start: Math.max(0, o.offset - o.width / 2), end: Math.min(wall.length, o.offset + o.width / 2),
      bottom: Math.max(0, o.sillHeight), top: Math.min(snapshot.room.height, o.sillHeight + o.height)
    })).filter((r) => r.end > r.start && r.top > r.bottom);
    deduction += coverageArea(coverage);
    pieces.push(...coverage.map((r) => ({ ...r, start: r.start + length, end: r.end + length })));
    length += wall.length;
  }
  // Merge adjoining pieces of one aperture without merging separate perimeter-wrap pieces.
  const openings: OpeningCoverage[] = [];
  for (const piece of pieces.sort((a, b) => a.start - b.start)) {
    const previous = [...openings].reverse().find((r) => r.id === piece.id && Math.abs(r.end - piece.start) < 1e-6 && r.bottom === piece.bottom && r.top === piece.top);
    if (previous) previous.end = piece.end; else openings.push({ ...piece });
  }
  const axis = view === 'front' || view === 'back' ? 'x' : 'z';
  const coordinates = walls.flatMap((wall) => [wall.start[axis], wall.end[axis]]);
  const grossArea = length * snapshot.room.height;
  return { label, walls, length, span: coordinates.length ? Math.max(...coordinates) - Math.min(...coordinates) : 0,
    height: snapshot.room.height, grossArea, netArea: Math.max(0, grossArea - deduction), openings,
    openingCount: new Set(openings.map((o) => o.id)).size, curved: snapshot.room.shapeKind === 'circle' && walls.every((wall) => !wall.id.startsWith('divider-')) };
}

/** One entry per physical wall, independent of any camera cutaway. */
export function roomWallMeasurements(snapshot: PlannerSnapshot): ReportBoundary[] {
  const perimeterCount = getRoomWalls(snapshot.room).length;
  return getPhysicalWalls(snapshot.room, snapshot.dividers).map((wall, index) => reportBoundary(snapshot, [wall],
    index < perimeterCount ? `Wall ${index + 1}` : `Interior wall ${index - perimeterCount + 1}`, 'front'));
}

/** Consume the renderer's actual cutaway set; never infer hidden walls from a view name. */
export function roomViewSummary(snapshot: PlannerSnapshot, view: ReportSide, hiddenWallIds: string[]): ReportViewSummary {
  const walls = getRoomWalls(snapshot.room), hidden = new Set(hiddenWallIds);
  const runs: RoomWallSegment[][] = [];
  const visibleIndex = walls.findIndex((wall) => !hidden.has(wall.id));
  let current: RoomWallSegment[] = [];
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[(visibleIndex + 1 + i + walls.length) % walls.length];
    if (hidden.has(wall.id)) {
      const previous = current.at(-1);
      // Polygon corners describe separate sides even when both walls are hidden.
      // A tessellated circle remains one continuous curved side.
      if (previous && snapshot.room.shapeKind !== 'circle'
        && previous.tangent.x * wall.tangent.x + previous.tangent.z * wall.tangent.z < 1 - 1e-8) {
        runs.push(current); current = [];
      }
      current.push(wall);
    }
    else if (current.length) { runs.push(current); current = []; }
  }
  if (current.length) runs.push(current);
  const title = view[0].toUpperCase() + view.slice(1);
  const boundaries = runs.map((run, index) => reportBoundary(snapshot, run, `Side ${index + 1}`, view));
  const allWalls = boundaries.flatMap((b) => b.walls);
  const combined = reportBoundary(snapshot, allWalls, title, view);
  return { view, hiddenWallIds: allWalls.map((wall) => wall.id), boundaries, length: combined.length, span: combined.span,
    height: combined.height, grossArea: combined.grossArea, netArea: combined.netArea, openingCount: combined.openingCount };
}
