export const SUN_AZIMUTH_MIN = 0;
export const SUN_AZIMUTH_MAX = 360;
export const SUN_SINGLE_WINDOW_LIMIT = 89;
export const SUN_ELEVATION_MIN = 12;
export const SUN_ELEVATION_MAX = 82;
export const SUN_DEFAULT_AZIMUTH = 0;
export const SUN_DEFAULT_ELEVATION = 19;

export function normalizeSunAzimuth(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return SUN_DEFAULT_AZIMUTH;
  const orbit = ((number % 360) + 360) % 360;
  return orbit === 0 && number > 0 ? 360 : orbit;
}

export function effectiveSunAzimuth(azimuth: number, windowCount: number) {
  const orbit = normalizeSunAzimuth(azimuth);
  if (windowCount !== 1) return orbit;
  const signed = orbit > 180 ? orbit - 360 : orbit;
  return Math.max(-SUN_SINGLE_WINDOW_LIMIT, Math.min(signed, SUN_SINGLE_WINDOW_LIMIT));
}

export function clampSunAngle(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(number, max)) : fallback;
}
