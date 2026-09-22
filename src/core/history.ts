import type { PlannerSnapshot } from './types';

export class SnapshotHistory {
  private past: PlannerSnapshot[] = [];
  private future: PlannerSnapshot[] = [];
  constructor(private readonly limit = 80) {}

  push(snapshot: PlannerSnapshot) {
    const last = this.past.at(-1);
    if (last && JSON.stringify(last) === JSON.stringify(snapshot)) return;
    this.past.push(structuredClone(snapshot));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: PlannerSnapshot): PlannerSnapshot | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(structuredClone(current));
    return structuredClone(previous);
  }

  redo(current: PlannerSnapshot): PlannerSnapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(structuredClone(current));
    return structuredClone(next);
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}
