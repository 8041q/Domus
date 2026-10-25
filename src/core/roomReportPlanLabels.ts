interface Point { x: number; y: number }
export interface PlanKeyBox { left: number; top: number; right: number; bottom: number }
interface LabelWall { start: Point; end: Point; inward: Point; length: number }
export interface PlanKeyLabelInput { width: number; walls: LabelWall[] }
export interface PlanKeyLabel extends PlanKeyBox { x: number; y: number; anchor: Point; callout: boolean }

function leaderEnd(label: PlanKeyLabel): Point {
  return { x: Math.max(label.left, Math.min(label.right, label.anchor.x)), y: Math.max(label.top, Math.min(label.bottom, label.anchor.y)) };
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8;
}

function overlaps(a: PlanKeyBox, b: PlanKeyBox, gap = 0) {
  return a.right + gap > b.left && a.left < b.right + gap && a.bottom + gap > b.top && a.top < b.bottom + gap;
}

// Clip the entire segment, not just its endpoints: a concave notch can pass
// through a text box even when all four corners lie inside the room.
function crossesBox(a: Point, b: Point, box: PlanKeyBox, gap: number) {
  let low = 0, high = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, box.left - gap, box.right + gap],
    [a.y, b.y - a.y, box.top - gap, box.bottom + gap]
  ]) {
    if (Math.abs(delta) < 1e-8) { if (start < min || start > max) return false; }
    else {
      const t1 = (min - start) / delta, t2 = (max - start) / delta;
      low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2));
      if (low > high) return false;
    }
  }
  return true;
}

function inside(point: Point, polygon: Point[]) {
  let result = false;
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y)) result = !result;
  });
  return result;
}

/** Keep normal wall labels in place; move cramped labels into clear space. */
export function layoutReportPlanLabels(inputs: PlanKeyLabelInput[], polygon: Point[], area: PlanKeyBox, arrow: PlanKeyBox, textHeight = 24, allowPartial = false): Array<PlanKeyLabel | undefined> | null {
  const outlineClear = (box: PlanKeyBox, gap = 4) => polygon.every((a, i) => !crossesBox(a, polygon[(i + 1) % polygon.length], box, gap));
  const fits = (box: PlanKeyBox) => box.left >= area.left + 4 && box.right <= area.right - 4
    && box.top >= area.top + 4 && box.bottom <= area.bottom - 4 && !overlaps(box, arrow, 8) && outlineClear(box);
  const candidates = inputs.map(input => {
    const result: PlanKeyLabel[] = [], halfW = input.width / 2, halfH = textHeight / 2;
    const add = (cx: number, cy: number, anchor: Point, callout = false, roomSide?: boolean) => {
      const box = { x: cx, y: cy - halfH, left: cx - halfW, right: cx + halfW, top: cy - halfH, bottom: cy + halfH, anchor, callout };
      if (fits(box) && (roomSide === undefined || inside({ x: cx, y: cy }, polygon) === roomSide)
        && !result.some(other => Math.abs(other.x - cx) < 1 && Math.abs(other.y - box.y) < 1)) result.push(box);
    };
    let distance = input.walls.reduce((sum, wall) => sum + wall.length, 0) / 2;
    const middle = input.walls.find(wall => { if (distance <= wall.length) return true; distance -= wall.length; return false; }) ?? input.walls[0];
    const at = (wall: LabelWall, fraction: number) => ({ x: wall.start.x + (wall.end.x - wall.start.x) * fraction, y: wall.start.y + (wall.end.y - wall.start.y) * fraction });
    const anchors = [{ wall: middle, point: at(middle, distance / middle.length) }];
    for (const wall of input.walls) for (const fraction of [.5, .25, .75, .1, .9]) anchors.push({ wall, point: at(wall, fraction) });
    // Preserve the familiar outside left/right and inside top/bottom placement
    // when the full text rectangle fits. Try the other side only when needed.
    for (const alternate of [false, true]) for (const { wall, point } of anchors) {
      const n = wall.inward, lateral = Math.abs(n.x) >= Math.abs(n.y) - 1e-8;
      const side = (lateral ? -1 : 1) * (alternate ? -1 : 1);
      for (const extra of [0, 16, 32]) {
        const cx = lateral ? point.x + Math.sign(n.x) * side * ((10 + extra + Math.abs(n.y) * halfH) / Math.abs(n.x) + halfW) : point.x;
        const cy = lateral ? point.y : point.y + Math.sign(n.y) * side * ((10 + extra + Math.abs(n.x) * halfW) / Math.abs(n.y) + halfH);
        add(cx, cy, point, false, side > 0);
      }
    }
    // A short wall or deep recess may have no adjacent space at all. Reserve a
    // clear callout and connect it to the actual measured boundary. An inside
    // callout is useful for a notch whose exterior is too narrow for text.
    const anchor = anchors[0].point;
    const callouts: Array<{ x: number; y: number }> = [];
    for (let cy = area.top + halfH + 4; cy <= area.bottom - halfH - 4; cy += textHeight + 8) {
      for (let cx = area.left + halfW + 4; cx <= area.right - halfW - 4; cx += 16) {
        callouts.push({ x: cx, y: cy });
      }
    }
    callouts.sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y));
    for (const p of callouts) {
      const end = { x: Math.max(p.x - halfW, Math.min(p.x + halfW, anchor.x)), y: Math.max(p.y - halfH, Math.min(p.y + halfH, anchor.y)) };
      if (polygon.some((a, i) => segmentsCross(anchor, end, a, polygon[(i + 1) % polygon.length]))) continue;
      if (crossesBox(anchor, end, arrow, 8)) continue;
      add(p.x, p.y, anchor, true);
    }
    return result;
  });
  const placed: Array<{ index: number; label: PlanKeyLabel }> = [];
  let best: typeof placed = [];
  const order = inputs.map((_, index) => index).sort((a, b) => candidates[a].length - candidates[b].length);
  // Backtrack so an easy early label cannot consume the only space available
  // to a later label. Bound the search for unusually fragmented custom rooms.
  let attempts = 20000;
  const place = (depth: number): boolean => {
    if (depth === inputs.length) return true;
    const index = order[depth];
    for (const candidate of candidates[index]) {
      if (--attempts < 0) return false;
      if (placed.some(({ label: other }) => overlaps(candidate, other, 8)
        || (candidate.callout && crossesBox(candidate.anchor, leaderEnd(candidate), other, 4))
        || (other.callout && crossesBox(other.anchor, leaderEnd(other), candidate, 4))
        || (candidate.callout && other.callout && segmentsCross(candidate.anchor, leaderEnd(candidate), other.anchor, leaderEnd(other))))) continue;
      placed.push({ index, label: candidate });
      if (placed.length > best.length) best = [...placed];
      if (place(depth + 1)) return true;
      placed.pop();
    }
    return false;
  };
  const complete = place(0);
  if (!complete && !allowPartial) return null;
  const result: Array<PlanKeyLabel | undefined> = Array(inputs.length).fill(undefined);
  for (const { index, label } of complete ? placed : best) result[index] = label;
  return result;
}
