import { FEATURES } from '../config/features';
import type { PlannerSnapshot } from './types';

/** Presentation/placement projection only. Saves and undo always retain the full project. */
export function activeArchitecture<T extends PlannerSnapshot>(snapshot: T): T {
  if (FEATURES.interiorWalls) return snapshot;
  const selection = snapshot as T & { selectedOpeningId?: string | null };
  return {
    ...snapshot,
    dividers: [],
    openings: snapshot.openings.filter((opening) => !opening.wallId.startsWith('divider-')),
    spaces: [{ id: 'room', name: 'Room', seed: snapshot.room.vertices[0], boundaryKey: 'shell',
      floorFinish: snapshot.room.floorFinish, wallColor: snapshot.room.wallColor }],
    selectedSpaceId: null,
    selectedDividerId: null,
    selectedOpeningId: snapshot.openings.some((opening) => opening.id === selection.selectedOpeningId
      && opening.wallId.startsWith('divider-')) ? null : selection.selectedOpeningId,
    interiorWallView: 'up',
  };
}
