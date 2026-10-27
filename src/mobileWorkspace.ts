import { useEffect, useRef, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { usePlannerStore } from './store';

export type MobileTask = 'room' | 'furniture' | 'finishes' | 'explore';
export type MobileSheetId = 'room' | 'catalogue' | 'selection' | 'finishes' | 'design' | 'assistant';
export type MobileSheetSize = 'peek' | 'half' | 'expanded';
const COMPACT_QUERY = '(max-width: 820px), (pointer: coarse) and (max-height: 520px)';
const compactSnapshot = () => typeof window !== 'undefined' && window.matchMedia(COMPACT_QUERY).matches;
function subscribeCompact(change: () => void) {
  const media = window.matchMedia(COMPACT_QUERY);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}
export function useCompactWorkspace() {
  return useSyncExternalStore(subscribeCompact, compactSnapshot, () => false);
}

interface MobileWorkspaceState {
  task: MobileTask;
  sheet: MobileSheetId | null;
  size: MobileSheetSize;
  fineSnap: boolean;
  freeMove: boolean;
  cornerId: string | null;
  setTask: (task: MobileTask) => void;
  openSheet: (sheet: MobileSheetId, size?: MobileSheetSize) => void;
  closeSheet: () => void;
  setSize: (size: MobileSheetSize) => void;
  setFineSnap: (value: boolean) => void;
  setFreeMove: (value: boolean) => void;
  setCornerId: (id: string | null) => void;
}

/** Workspace preferences never enter portable room documents or undo history. */
export const useMobileWorkspace = create<MobileWorkspaceState>((set, get) => ({
  task: 'room', sheet: 'room', size: 'peek', fineSnap: false, freeMove: false, cornerId: null,
  setTask: task => {
    const planner = usePlannerStore.getState();
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (task === 'room') { if (planner.mode !== 'build') planner.setMode('build'); }
    else {
      if (planner.mode !== 'plan') planner.setMode('plan');
      if (task === 'explore') planner.setPlanView('walk');
      else if (planner.planView === 'walk') planner.setPlanView('free');
    }
    set({ task, sheet: task === 'room' ? 'room' : task === 'furniture' ? 'catalogue' : task === 'finishes' ? 'finishes' : null,
      size: task === 'room' && get().task !== 'room' ? 'peek' : 'half' });
  },
  openSheet: (sheet, size = 'half') => set({ sheet, size }),
  closeSheet: () => set({ sheet: null }),
  setSize: size => set({ size }),
  setFineSnap: fineSnap => set({ fineSnap }),
  setFreeMove: freeMove => set({ freeMove }),
  setCornerId: cornerId => set({ cornerId })
}));

type BackLayer = { id: symbol; close: () => void };
const backLayers: BackLayer[] = [];
let installed = false, sentinel = false, removing = false;
const HISTORY_KEY = '__domusMobilePanel';
function syncBackEntry() {
  if (removing || !backLayers.length || sentinel) return;
  try {
    window.history.pushState({ ...window.history.state, [HISTORY_KEY]: true }, '');
    sentinel = true;
  } catch { /* Close buttons remain available when history is restricted. */ }
}
function onPanelBack() {
  sentinel = false;
  if (removing) removing = false;
  else backLayers.at(-1)?.close();
  // React removes the dismissed layer before restoring a sentinel for an
  // underlying sheet. Replacing one sheet with another uses the same path.
  window.setTimeout(syncBackEntry, 0);
}

/** One transient history entry lets device Back dismiss the top UI surface. */
export function useMobileBack(onClose: () => void, enabled: boolean) {
  const compact = useCompactWorkspace();
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!enabled || !compact) return;
    if (!installed) { window.addEventListener('popstate', onPanelBack); installed = true; }
    const layer = { id: Symbol(), close: () => latest.current() };
    backLayers.push(layer);
    syncBackEntry();
    return () => {
      const index = backLayers.findIndex(value => value.id === layer.id);
      if (index >= 0) backLayers.splice(index, 1);
      if (!backLayers.length && sentinel && window.history.state?.[HISTORY_KEY]) {
        removing = true; sentinel = false; window.history.back();
      }
    };
  }, [enabled, compact]);
}
