import type { OpeningVariant } from './types';
let revisions: Record<string, string> = {};
export const setArchitecturalRevisions = (value: Record<string, string>) => { revisions = value; };
export const architecturalRevision = (file: string) => revisions[file];

/** Kept outside /models so architectural inserts never enter the furniture catalogue. */
export const OPENING_MODELS: Partial<Record<OpeningVariant, { file: string; rotationY?: number }>> = {
  'single-window': { file: 'single_glass_window.glb' },
  'double-window': { file: 'double_glass_window.glb' },
  'single-hung-window': { file: 'single_hung_window.glb' },
  'high-window': { file: 'hight_top_window.glb' },
  'sliding-window': { file: 'sliding_glass_pathway.glb' },
  'single-door': { file: 'single_door.glb' },
  'glass-door': { file: 'glass_door.glb' },
  'semi-glass-door': { file: 'semi_glass_door.glb' },
  // This export's width runs along Z; the other assets face along Z already.
  'glass-double-door': { file: 'double_glass_door.glb', rotationY: Math.PI / 2 }
};

