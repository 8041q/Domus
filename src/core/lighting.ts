import type { RoomLighting } from './types';

export const LIGHTING_CONTROLS = [
  { key: 'ceilingBrightness', label: 'Ceiling brightness', min: 0, max: 2, step: 0.05 },
  { key: 'ceilingWarmth', label: 'Ceiling warmth', min: 0, max: 1, step: 0.05 },
  { key: 'ambientBrightness', label: 'Ambient fill', min: 0, max: 2, step: 0.05 },
  { key: 'sunlightStrength', label: 'Sunlight strength', min: 0, max: 2, step: 0.05 }
] as const;

export function normalizeLightingControls(lighting?: Partial<RoomLighting>) {
  const bounded = (value: unknown, fallback: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback;
  return {
    ceilingBrightness: bounded(lighting?.ceilingBrightness, 1, 2),
    ceilingWarmth: bounded(lighting?.ceilingWarmth, 0.5, 1),
    sunlightStrength: bounded(lighting?.sunlightStrength, 1, 2),
    ambientBrightness: bounded(lighting?.ambientBrightness, 1, 2)
  };
}

/** Moods are starting points, not a second source of truth for edited values. */
export const LIGHTING_MOODS: { id: string; label: string; lighting: Partial<RoomLighting> }[] = [
  { id: 'daylight', label: 'Neutral daylight', lighting: {
    enabled: true, sunRaysEnabled: true, sunStylePreset: 'cinematic-shadows', sunElevation: 45,
    ceilingBrightness: 0.35, ceilingWarmth: 0.2, sunlightStrength: 0.8, ambientBrightness: 0.85
  } },
  { id: 'evening', label: 'Warm evening', lighting: {
    enabled: true, sunRaysEnabled: true, sunStylePreset: 'paired-suns', sunElevation: 12,
    ceilingBrightness: 1.5, ceilingWarmth: 0.9, sunlightStrength: 0.45, ambientBrightness: 0.3
  } },
  { id: 'overcast', label: 'Soft overcast', lighting: {
    enabled: false, sunRaysEnabled: false, sunStylePreset: 'cinematic-shadows', sunElevation: 45,
    ceilingBrightness: 0, ceilingWarmth: 0.2, sunlightStrength: 0, ambientBrightness: 0.8
  } }
];
