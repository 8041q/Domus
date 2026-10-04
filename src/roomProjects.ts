import { useEffect, useSyncExternalStore } from 'react';
import { RoomProjects } from './core/roomProjects';
import { emptyRoomSnapshot, getInitialSnapshot, getSnapshot, parseProjectSnapshot, usePlannerStore } from './store';

const previousProjects = import.meta.hot?.data.projects as RoomProjects | undefined;
export const roomProjects = previousProjects ?? new RoomProjects(() => localStorage, {
  initial: getInitialSnapshot, snapshot: getSnapshot, open: (snapshot) => usePlannerStore.getState().openProject(snapshot),
  empty: emptyRoomSnapshot, decode: parseProjectSnapshot,
});
// Preserve project identity and history during development module updates.
if (previousProjects) Object.setPrototypeOf(previousProjects, RoomProjects.prototype);

export function useRoomProjects() {
  const status = useSyncExternalStore(roomProjects.subscribe, roomProjects.getState, roomProjects.getState);
  useEffect(() => {
    roomProjects.initialize();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = usePlannerStore.subscribe((next, previous) => {
      if (next.room === previous.room && next.openings === previous.openings && next.dividers === previous.dividers
        && next.spaces === previous.spaces && next.objects === previous.objects && next.unplacedObjects === previous.unplacedObjects) return;
      clearTimeout(timer);
      // Furniture and wall drags can fire every frame; serialize only after they settle.
      timer = setTimeout(() => { roomProjects.changed(); roomProjects.persistDraft(); }, 250);
    });
    const flush = () => { clearTimeout(timer); roomProjects.changed(); roomProjects.persistDraft(); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (roomProjects.getState().dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', flush);
    return () => {
      unsubscribe(); flush();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('pagehide', flush);
    };
  }, [roomProjects]);
  return status;
}

import.meta.hot?.dispose((data) => { roomProjects.changed(); roomProjects.persistDraft(); data.projects = roomProjects; });
