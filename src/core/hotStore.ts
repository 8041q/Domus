import { create, type StateCreator, type StoreApi, type UseBoundStore } from 'zustand';

/** Keep existing subscribers and renderer bridges connected during a code reload. */
export function createHotStore<T extends object>(initialize: StateCreator<T>, previous?: UseBoundStore<StoreApi<T>>) {
  if (!previous) return create<T>(initialize);

  // Keep all project/UI values and their references. Install the new actions so
  // code changes take effect without replacing the store or resetting its data.
  const refreshed = initialize(previous.setState, previous.getState, previous);
  const actions = Object.fromEntries(Object.entries(refreshed).filter(([, value]) => typeof value === 'function')) as Partial<T>;
  previous.setState(actions);
  return previous;
}
