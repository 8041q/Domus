import { openingFrameOverhang } from './architecturalStyles';
import { openingClearance, openingFitsBoundary } from './openingPlacement';
import { getRoomWalls, openingFollowsPerimeter, perimeterDistance, perimeterLocation } from './roomGeometry';
import type { InteriorDivider, RoomOpening, RoomState } from './types';

/** The continuous visible stretch containing the current opening, including a
 * stretch crossing the perimeter seam. Bounds include the complete frame. */
export function openingSliderRange(room: RoomState, opening: RoomOpening, min: number, max: number,
  allowed: (candidate: RoomOpening) => boolean, dividers: InteriorDivider[] = []) {
  const curved = openingFollowsPerimeter(room, opening);
  const position = curved ? perimeterDistance(room, opening.wallId, opening.offset)! : opening.offset;
  const fits = (value: number) => {
    const candidate = { ...opening, ...(curved ? perimeterLocation(room, value) : { offset: value }) };
    return allowed(candidate) && openingFitsBoundary(room, dividers, candidate);
  };
  if (!fits(position)) return { min: position, max: position };
  // Visibility can change as either frame edge or the centre crosses a section.
  const cuts = [min, max];
  if (curved) {
    const half = opening.width / 2 + Math.max(openingFrameOverhang(opening), opening.type === 'opening' ? 0 : openingClearance(opening));
    let cursor = 0;
    for (const wall of getRoomWalls(room)) {
      for (const shift of [-max, 0, max, 2 * max]) {
        for (const edge of [-half, 0, half]) cuts.push(cursor + shift + edge);
      }
      cursor += wall.length;
    }
    cuts.push(position - max, position + max);
  }
  const sorted = [...new Set(cuts.filter(value => curved
    ? value >= position - max && value <= position + max : value >= min && value <= max))].sort((a, b) => a - b);
  // Walk outward only until the first unavailable stretch; skip no hidden gaps.
  const boundary = (direction: -1 | 1) => {
    let good = position;
    const targets = sorted.filter(value => direction * (value - position) > 1e-7);
    if (direction < 0) targets.reverse();
    for (const target of targets) {
      const middle = (good + target) / 2;
      if (!fits(middle) || !fits(target)) {
        let bad = !fits(middle) ? middle : target;
        for (let i = 0; i < 30; i++) {
          const probe = (good + bad) / 2;
          if (fits(probe)) good = probe; else bad = probe;
        }
        return good;
      }
      good = target;
    }
    return good;
  };
  const start = boundary(-1), end = boundary(1);
  if (curved && end - start >= max - 1e-5) return { min, max };
  return { min: start, max: end };
}
