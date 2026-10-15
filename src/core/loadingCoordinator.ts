import { LOADING_FADE_MS, LOADING_MINIMUM_MS } from './loadingTiming';

export type LoadingPhase = 'view' | 'models' | 'textures' | 'export' | 'assistant';
export interface LoadingTask<Action = unknown> {
  phase: LoadingPhase;
  label: string;
  detail?: string;
  progress?: { completed: number; total: number; unit?: string };
  blocking?: boolean;
  error?: boolean;
  action?: Action;
}
export interface LoadingSnapshot<Action = unknown> {
  visible: boolean;
  leaving: boolean;
  pending: number;
  blocking: boolean;
  message: LoadingTask<Action> | null;
}
const priority: Record<LoadingPhase, number> = { export: 100, view: 80, models: 60, textures: 50, assistant: 40 };

/** Tracks real operations independently. Presentation belongs to the complete
 * flow, never to an individual phase/component or a queue of stale messages. */
export function createLoadingCoordinator<Action = unknown>(clock = {
  now: () => Date.now(),
  schedule: (callback: () => void, ms: number) => setTimeout(callback, ms),
  cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
}) {
  const tasks = new Map<symbol, LoadingTask<Action>>();
  const listeners = new Set<() => void>();
  const empty = (): LoadingSnapshot<Action> => ({ visible: false, leaving: false, pending: 0, blocking: false, message: null });
  let snapshot = empty();
  let shownAt = 0;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let fade: ReturnType<typeof setTimeout> | undefined;
  const cancelTimers = () => {
    if (hold !== undefined) clock.cancel(hold);
    if (fade !== undefined) clock.cancel(fade);
    hold = fade = undefined;
  };
  const publish = (next: LoadingSnapshot<Action>) => { snapshot = next; for (const listener of listeners) listener(); };
  const reconcile = () => {
    cancelTimers();
    const all = [...tasks.values()];
    const pending = all.filter(task => !task.error);
    const candidates = pending.length ? pending : all;
    const current = candidates.sort((a, b) => priority[b.phase] - priority[a.phase])[0];
    if (current) {
      if (!snapshot.visible || snapshot.leaving) shownAt = clock.now();
      let message = current;
      // Exports await these assets. Describe that dependency without pretending
      // the underlying model/material work has stopped.
      if (current.phase === 'export') {
        const models = pending.find(task => task.phase === 'models');
        const textures = pending.find(task => task.phase === 'textures');
        if (models || textures) message = { ...current,
          detail: models ? 'Loading furniture for the export' : 'Loading room materials for the export',
          progress: models?.progress };
      }
      publish({ visible: true, leaving: false, pending: pending.length,
        blocking: pending.some(task => task.blocking), message });
      return;
    }
    if (!snapshot.visible) return;
    // Work has finished; retain the message for the presentation minimum.
    // A new phase cancels these timers and replaces the existing card.
    publish({ ...snapshot, pending: 0, blocking: false });
    hold = clock.schedule(() => {
      publish({ ...snapshot, leaving: true });
      fade = clock.schedule(() => publish(empty()), LOADING_FADE_MS);
    }, Math.max(0, LOADING_MINIMUM_MS - (clock.now() - shownAt)));
  };
  const clear = () => { cancelTimers(); tasks.clear(); publish(empty()); };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    start(task: LoadingTask<Action>) {
      const token = Symbol(task.phase);
      tasks.set(token, task); reconcile();
      return {
        update(next: LoadingTask<Action>) { if (tasks.has(token)) { tasks.set(token, next); reconcile(); } },
        finish() { if (tasks.delete(token)) reconcile(); }
      };
    },
    clear,
    dispose() { cancelTimers(); tasks.clear(); snapshot = empty(); }
  };
}
