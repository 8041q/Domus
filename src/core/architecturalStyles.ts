import type { BaseboardStyle, RoomOpening } from './types';

export type GlazingArea = { left: number; right: number; bottom: number; top: number };

export const BASEBOARD_STYLES: Array<{
  id: BaseboardStyle;
  name: string;
  description: string;
  /** Profile points are metres outward from the wall face and above the floor. */
  profile: Array<[number, number]>;
}> = [
  { id: 'flat', name: 'Flat', description: 'Clean, simple skirting', profile: [[0, 0], [0.012, 0], [0.012, 0.07], [0, 0.07]] },
  { id: 'flush', name: 'Flush', description: 'Nearly level with the wall', profile: [[0, 0], [0.003, 0], [0.003, 0.085], [0, 0.085]] },
  { id: 'rounded', name: 'Rounded', description: 'Soft bullnose top', profile: [[0, 0], [0.038, 0], [0.038, 0.064], [0.035, 0.078], [0.026, 0.088], [0.014, 0.092], [0, 0.092]] },
  { id: 'stepped', name: 'Stepped', description: 'Two crisp ledges', profile: [[0, 0], [0.035, 0], [0.035, 0.065], [0.046, 0.065], [0.046, 0.082], [0.028, 0.082], [0.028, 0.105], [0, 0.105]] },
  { id: 'sculpted', name: 'Sculpted · classic', description: 'Cove and bead detail', profile: [[0, 0], [0.038, 0], [0.038, 0.075], [0.047, 0.075], [0.047, 0.088], [0.04, 0.094], [0.031, 0.10], [0.026, 0.11], [0.032, 0.122], [0.026, 0.13], [0, 0.13]] },
  { id: 'sculpted-tall', name: 'Sculpted · tall', description: 'Taller layered moulding', profile: [[0, 0], [0.036, 0], [0.036, 0.105], [0.048, 0.105], [0.048, 0.12], [0.036, 0.126], [0.029, 0.139], [0.039, 0.151], [0.039, 0.163], [0.027, 0.171], [0, 0.171]] },
  { id: 'floating', name: 'Floating', description: 'A shadow reveal above the floor', profile: [[0, 0.026], [0.038, 0.026], [0.038, 0.115], [0, 0.115]] },
  { id: 'flash-coving', name: 'Flash coving', description: 'Curved transition to the floor', profile: [[0, 0], [0.066, 0], [0.066, 0.018], [0.056, 0.026], [0.044, 0.038], [0.032, 0.056], [0.02, 0.075], [0, 0.087]] }
];

export const TRIM_COLORS = [
  { name: 'Warm white', value: '#f5f3f0' },
  { name: 'Pure white', value: '#ffffff' },
  { name: 'Ivory', value: '#eee6d5' },
  { name: 'Greige', value: '#c9c1b6' },
  { name: 'Charcoal', value: '#48494b' },
  { name: 'Oak', value: '#ae8260' }
] as const;

export function isSunGlazedOpening(opening: RoomOpening) {
  return opening.type === 'window' || (opening.type === 'door' &&
    (opening.variant === 'glass-door' || opening.variant === 'glass-double-door' || opening.variant === 'semi-glass-door'));
}

/** Exact clear panes, shared by the visible inserts and the sun shadow mask. */
export function glazingAreas(opening: RoomOpening): GlazingArea[] {
  if (!isSunGlazedOpening(opening)) return [];
  const left = opening.offset - opening.width / 2;
  const right = opening.offset + opening.width / 2;
  const bottom = opening.sillHeight;
  const top = bottom + opening.height;
  if (opening.type === 'door') {
    const side = Math.min(0.105, opening.width * 0.19);
    const upper = top - Math.min(0.14, opening.height * 0.18);
    const lower = opening.variant === 'semi-glass-door'
      ? bottom + Math.min(opening.height * 0.52, opening.height - 0.20)
      : bottom + Math.min(0.13, opening.height * 0.16);
    if (opening.variant !== 'glass-double-door') return [{ left: left + side, right: right - side, bottom: lower, top: upper }];
    const middle = opening.offset;
    return [
      { left: left + side, right: middle - 0.055, bottom: lower, top: upper },
      { left: middle + 0.055, right: right - side, bottom: lower, top: upper }
    ];
  }
  const edge = Math.min(0.037, opening.width * 0.085, opening.height * 0.12);
  const paneLeft = left + edge;
  const paneRight = right - edge;
  const paneBottom = bottom + edge;
  const paneTop = top - edge;
  if (opening.variant === 'double-window' || opening.variant === 'sliding-window') {
    const divider = Math.min(0.025, opening.width * 0.035);
    return [
      { left: paneLeft, right: opening.offset - divider, bottom: paneBottom, top: paneTop },
      { left: opening.offset + divider, right: paneRight, bottom: paneBottom, top: paneTop }
    ];
  }
  if (opening.variant === 'single-hung-window') {
    const split = bottom + opening.height * 0.53;
    const rail = Math.min(0.023, opening.height * 0.07);
    return [
      { left: paneLeft, right: paneRight, bottom: paneBottom, top: split - rail },
      { left: paneLeft, right: paneRight, bottom: split + rail, top: paneTop }
    ];
  }
  return [{ left: paneLeft, right: paneRight, bottom: paneBottom, top: paneTop }];
}
