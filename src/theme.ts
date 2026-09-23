/**
 * Planner-wide visual source of truth.
 *
 * Canvas drafting, Three.js helpers, and the DOM UI all consume these values.
 * `applyThemeTokens` exposes the same values as CSS custom properties so styles.css
 * never needs a second copy of interaction/annotation colors.
 */
export const PLANNER_THEME = {
  interaction: '#facc15',
  'interaction-strong': '#eab308',
  'interaction-soft': '#fef3c7',
  'dimension-text': '#111111',
  'dimension-line': '#686868',
  'product-dimension-line': '#3f3f46',
  'spacing-line': '#111111',
  'dimension-card-background': '#ffffff',
  'dimension-card-border': '#d4d4d8',
  'clearance-fill': '#ffd54a',
  'clearance-edge': '#b77900'
} as const;

export type PlannerThemeToken = keyof typeof PLANNER_THEME;

export function themeColor(token: PlannerThemeToken) {
  return PLANNER_THEME[token];
}

export function themeHex(token: PlannerThemeToken) {
  return Number.parseInt(themeColor(token).slice(1), 16);
}

export function themeRgba(token: PlannerThemeToken, alpha: number) {
  const number = themeHex(token);
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function applyThemeTokens(root: HTMLElement = document.documentElement) {
  for (const [token, value] of Object.entries(PLANNER_THEME)) {
    root.style.setProperty(`--${token}`, value);
  }
}

/**
 * Shared planner sizing/legibility metrics.
 * Change these values to tune all equivalent annotations from one place.
 */
export const PLANNER_METRICS = {
  // 3D annotations reserve this much world-space room in a dimension line.
  // Their visible size is controlled by the screen-pixel target below so zooming
  // in/out does not make labels become enormous or unreadably tiny.
  'dimension-label-height': 0.15,
  'dimension-label-screen-px': 24,
  'dimension-label-min-world-height': 0.055,
  'dimension-label-max-world-height': 0.19,
  'dimension-texture-font-px': 64,
  'dimension-text-outline-px': 5,
  // Spacing labels need extra separation from furniture/floor textures. Room labels keep the base outline above.
  'spacing-dimension-text-outline-px': 8,
  // Product badges are intentionally smaller than room/spacing annotations.
  'product-dimension-label-height': 0.10,
  'product-dimension-label-screen-px': 16,
  'product-dimension-card-radius-px': 10,
  'product-dimension-card-padding-x-px': 16,
  'product-dimension-card-padding-y-px': 10,
  'builder-wall-label-height-px': 38,
  'builder-wall-length-font-px': 14,
  'builder-wall-id-font-px': 11
} as const;

export type PlannerMetricToken = keyof typeof PLANNER_METRICS;

export function themeMetric(token: PlannerMetricToken) {
  return PLANNER_METRICS[token];
}

