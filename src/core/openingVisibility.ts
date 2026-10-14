import type { RoomOpening } from './types';

type OpeningVisibility = (opening: RoomOpening) => boolean;
let activeVisibility: OpeningVisibility | undefined;
let revision = 0;
const listeners = new Set<() => void>();
export const openingVisibilityRevision = () => revision;
export function subscribeOpeningVisibility(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyOpeningVisibilityChanged() {
  revision++;
  for (const listener of listeners) listener();
}

/** Use the mounted architecture viewport's current camera and cutaway state. */
export function registerOpeningVisibility(allowed: OpeningVisibility) {
  activeVisibility = allowed;
  notifyOpeningVisibilityChanged();
  return () => {
    if (activeVisibility === allowed) { activeVisibility = undefined; notifyOpeningVisibilityChanged(); }
  };
}

export function openingVisibleInActiveView(opening: RoomOpening) {
  return activeVisibility?.(opening) ?? true;
}
