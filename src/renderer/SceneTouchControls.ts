export interface SceneTouchTarget {
  kind: 'object' | 'opening' | 'wall' | 'divider' | 'space';
  id: string;
  selected: boolean;
  editable: boolean;
}

interface TouchCallbacks {
  pick: (event: PointerEvent) => SceneTouchTarget | null;
  select: (target: SceneTouchTarget | null) => void;
  beginEdit: (target: SceneTouchTarget, event: PointerEvent) => boolean;
  moveEdit: (event: PointerEvent) => void;
  commitEdit: (event: PointerEvent) => void;
  cancelEdit: () => void;
  startNavigation: (points: PointerEvent[]) => void;
  moveNavigation: (event: PointerEvent) => void;
  stopNavigation: () => void;
}

/** Touch selects before editing; adding a finger always takes over for navigation. */
export class SceneTouchControls {
  private points = new Map<number, PointerEvent>();
  private candidate: { event: PointerEvent; target: SceneTouchTarget | null } | null = null;
  private editing = false;
  private navigating = false;
  private moved = false;

  constructor(private element: HTMLCanvasElement, private callbacks: TouchCallbacks) {}

  hasPointer(id: number) { return this.points.has(id); }
  get active() { return this.points.size > 0; }

  pointerDown(event: PointerEvent) {
    this.consume(event);
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) || this.points.has(event.pointerId) || this.points.size >= 2) return;
    this.element.focus({ preventScroll: true });
    this.points.set(event.pointerId, event);
    this.element.setPointerCapture?.(event.pointerId);
    if (this.points.size === 1) {
      this.candidate = { event, target: this.callbacks.pick(event) };
      this.moved = false;
      return;
    }
    // Discard queued preview samples before the room is restored. A delayed
    // pointer frame must not reapply the edit after the pinch has begun.
    const editing = this.editing;
    this.editing = false;
    this.candidate = null;
    this.moved = true;
    if (editing) this.callbacks.cancelEdit();
    if (this.points.size) this.startNavigation();
  }

  pointerMove(event: PointerEvent) {
    if (!this.points.has(event.pointerId)) return;
    this.consume(event);
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    this.points.set(event.pointerId, event);
    if (this.navigating) {
      this.callbacks.moveNavigation(event);
      return;
    }
    if (this.editing) {
      this.callbacks.moveEdit(event);
      return;
    }
    const candidate = this.candidate;
    if (!candidate || Math.hypot(event.clientX - candidate.event.clientX, event.clientY - candidate.event.clientY) < 8) return;
    this.moved = true;
    if (candidate.target?.selected && candidate.target.editable && this.callbacks.beginEdit(candidate.target, candidate.event)) {
      this.editing = true;
      this.callbacks.moveEdit(event);
      return;
    }
    // Begin from the original point so crossing the intent threshold does not
    // throw away the first portion of a deliberate orbit.
    this.callbacks.startNavigation([candidate.event]);
    this.navigating = true;
    this.callbacks.moveNavigation(event);
  }

  pointerUp(event: PointerEvent) {
    if (!this.points.has(event.pointerId)) return;
    this.pointerMove(event);
    const target = this.candidate?.target ?? null;
    const tap = !this.editing && !this.navigating && !this.moved;
    this.points.delete(event.pointerId);
    // Remove ownership before callbacks release pointer capture. Its resulting
    // lostpointercapture event must not cancel an already committed edit.
    if (this.editing) this.callbacks.commitEdit(event);
    else if (tap) this.callbacks.select(target);
    this.editing = false;
    this.candidate = null;
    if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    if (this.points.size) this.startNavigation();
    else {
      this.callbacks.stopNavigation();
      this.navigating = false;
      this.moved = false;
    }
  }

  cancel() {
    const editing = this.editing, ids = [...this.points.keys()];
    this.points.clear();
    this.candidate = null;
    this.editing = false;
    this.navigating = false;
    this.moved = false;
    // Store restoration can synchronously notify the scene. Relinquish gesture
    // ownership first so a subscriber cancelling again cannot recurse.
    if (editing) this.callbacks.cancelEdit();
    this.callbacks.stopNavigation();
    for (const id of ids) if (this.element.hasPointerCapture?.(id)) this.element.releasePointerCapture(id);
  }

  private startNavigation() {
    this.callbacks.startNavigation([...this.points.values()]);
    this.navigating = true;
  }

  private consume(event: PointerEvent) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
