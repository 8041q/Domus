import { getRoomWalls } from './roomGeometry';
import type { RoomState, RoomWallSegment } from './types';

const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** Shade substantial corners; a short panel or an almost straight joint has no seam. */
export function wallCornerShading(room: RoomState, wall: RoomWallSegment) {
  const walls = getRoomWalls(room);
  const index = walls.findIndex((candidate) => candidate.id === wall.id);
  if (index < 0) return { start: 0, end: 0 };
  const length = smooth((wall.length - 0.9) / 0.6);
  const strength = (neighbour: RoomWallSegment) => {
    const dot = wall.tangent.x * neighbour.tangent.x + wall.tangent.z * neighbour.tangent.z;
    const turn = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    return length * smooth((turn - 20) / 40);
  };
  return { start: strength(walls[(index - 1 + walls.length) % walls.length]),
    end: strength(walls[(index + 1) % walls.length]) };
}
