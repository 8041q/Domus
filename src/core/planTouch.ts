import type { RoomState } from './types';

export interface PlanViewTransform { scale: number; ox: number; oz: number }
export interface PlanTouchPoint { id: number; x: number; y: number }
export interface PlanTouchAction {
  move: (point: PlanTouchPoint) => void;
  finish: () => void;
  cancel: () => void;
  tap?: () => void;
}
interface Callbacks {
  begin: (point: PlanTouchPoint) => PlanTouchAction | null;
  view: () => PlanViewTransform;
  navigate: (view: PlanViewTransform) => void;
  release: (id: number) => void;
}

/** Keep a world point under the two-finger centroid while panning and zooming. */
export function pinchPlanView(view: PlanViewTransform, start: { x: number; y: number; distance: number }, current: { x: number; y: number; distance: number }): PlanViewTransform {
  const scale = Math.max(6, Math.min(180, view.scale * current.distance / Math.max(1, start.distance)));
  const factor = scale / view.scale;
  return { scale, ox: current.x - (start.x - view.ox) * factor, oz: current.y - (start.y - view.oz) * factor };
}

/** Resize a canvas without discarding its zoom or the world point at its centre. */
export function resizedPlanView<T extends PlanViewTransform & { width: number; height: number }>(view: T, width: number, height: number): T {
  return { ...view, ox: view.ox + (width - view.width) / 2, oz: view.oz + (height - view.height) / 2, width, height };
}

/** Preview rollback and undo keep the camera; new projects and new preset topologies fit. */
export function shouldRefitPlanView(previous: Pick<RoomState, 'shapeKind' | 'vertices' | 'width'>, next: Pick<RoomState, 'shapeKind' | 'vertices' | 'width'>, previousGeneration: number, nextGeneration: number): boolean {
  if (previousGeneration !== nextGeneration) return true;
  if (next.shapeKind === 'custom') return false;
  if (previous.shapeKind === 'circle' && next.shapeKind === 'circle' && previous.width !== next.width) return true;
  return previous.vertices.length !== next.vertices.length
    || previous.vertices.some((vertex, index) => vertex.id !== next.vertices[index]?.id);
}

/** Enlarged touch targets resolve by visible distance, with selection breaking ties. */
export function nearestPlanTouchTarget<T>(candidates: Array<{ target: T; distance: number; selected?: boolean }>): T | null {
  let nearest: typeof candidates[number] | undefined;
  for (const candidate of candidates) {
    if (!nearest || candidate.distance < nearest.distance - 0.5
      || Math.abs(candidate.distance - nearest.distance) <= 0.5 && candidate.selected && !nearest.selected) nearest = candidate;
  }
  return nearest?.target ?? null;
}

/** Touch selection, editing, and navigation share one cancellable gesture owner. */
export class PlanTouchController {
  private points = new Map<number, PlanTouchPoint>();
  private action: PlanTouchAction | null = null;
  private start: PlanTouchPoint | null = null;
  private moved = false;
  private navigating = false;
  private origin: { view: PlanViewTransform; pair: { x: number; y: number; distance: number } } | null = null;
  constructor(public callbacks: Callbacks) {}

  private pair() {
    const [a, b] = [...this.points.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) } : null;
  }

  down(point: PlanTouchPoint) {
    if (this.points.has(point.id) || this.points.size >= 2 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    this.points.set(point.id, point);
    if (this.points.size === 1) {
      this.start = point;
      this.moved = false;
      this.action = this.callbacks.begin(point);
    } else {
      const action = this.action;
      this.action = null;
      action?.cancel();
      if (this.points.size !== 2) return false;
      this.navigating = true;
      this.origin = { view: { ...this.callbacks.view() }, pair: this.pair()! };
    }
    return true;
  }

  move(point: PlanTouchPoint) {
    if (!this.points.has(point.id) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    this.points.set(point.id, point);
    const pair = this.pair();
    if (pair && this.origin) {
      this.callbacks.navigate(pinchPlanView(this.origin.view, this.origin.pair, pair));
    } else if (!this.navigating && this.action && this.start) {
      this.moved ||= Math.hypot(point.x - this.start.x, point.y - this.start.y) >= 8;
      if (this.moved) this.action.move(point);
    }
  }

  up(point: PlanTouchPoint) {
    if (!this.points.has(point.id)) return;
    this.move(point);
    if (!this.navigating && this.points.size === 1) {
      const action = this.action;
      this.action = null;
      if (this.moved) action?.finish();
      else { action?.cancel(); action?.tap?.(); }
    }
    this.points.delete(point.id);
    this.callbacks.release(point.id);
    if (!this.points.size) { this.origin = null; this.start = null; this.navigating = false; this.moved = false; }
  }

  has(id: number) { return this.points.has(id); }
  get active() { return this.points.size > 0; }
  cancel() {
    const action = this.action;
    this.action = null;
    const ids = [...this.points.keys()];
    this.points.clear(); this.origin = null; this.start = null; this.navigating = false; this.moved = false;
    action?.cancel();
    for (const id of ids) this.callbacks.release(id);
  }
}
