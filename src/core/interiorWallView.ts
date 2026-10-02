import type { RoomWallSegment } from './types';

export type InteriorWallView = 'up' | 'down';
export const DROPPED_WALL_HEIGHT = 0.22;
export type WallProfile = Array<{ x: number; height: number }>;

/** Interior wall presentation is independent of camera angle and editing space. */
export function interiorWallProfile(wall: RoomWallSegment, roomHeight: number, mode: InteriorWallView): WallProfile {
  const height = mode === 'down' ? Math.min(DROPPED_WALL_HEIGHT, roomHeight) : roomHeight;
  return [{ x: 0, height }, { x: wall.length, height }];
}

export function profileHeight(profile: WallProfile, x: number) {
  if (x <= profile[0].x) return profile[0].height;
  for (let i = 1; i < profile.length; i++) if (x <= profile[i].x) {
    const a = profile[i - 1], b = profile[i];
    return a.height + (b.height - a.height) * (x - a.x) / (b.x - a.x);
  }
  return profile.at(-1)!.height;
}
