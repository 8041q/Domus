export const APP_FONT_FAMILY = '"IBM Plex Sans", sans-serif';
export const REPORT_FONT_FAMILY = APP_FONT_FAMILY;
// Match --font-strong-spacing in styles.css.
const STRONG_LETTER_SPACING_EM = 0.04;

/** Use identical spacing for canvas width measurements and painted labels. */
export function setCanvasFont(ctx: CanvasRenderingContext2D, size: number, weight = 400, spaced = weight >= 600) {
  ctx.font = `${weight} ${size}px ${APP_FONT_FAMILY}`;
  ctx.letterSpacing = `${spaced ? size * STRONG_LETTER_SPACING_EM : 0}px`;
}

const pendingFonts = new WeakMap<FontFaceSet, Promise<void>>();
const pendingInterfaceFonts = new WeakMap<FontFaceSet, Promise<void>>();

/** Finish all interface weights before creating canvas measurement labels. */
export function loadInterfaceFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') return Promise.resolve();
  const fonts = document.fonts, pending = pendingInterfaceFonts.get(fonts);
  if (pending) return pending;
  const faces = [
    new FontFace('IBM Plex Sans', `url("${new URL('../assets/fonts/ibm-plex-sans/semibold.ttf', import.meta.url).href}")`, { weight: '600' }),
    new FontFace('IBM Plex Sans', `url("${new URL('../assets/fonts/ibm-plex-sans/bold.ttf', import.meta.url).href}")`, { weight: '700' })
  ];
  const ready = Promise.all([loadReportFonts(), ...faces.map(face => face.load())]).then(() => {
    faces.forEach(face => fonts.add(face));
  }).catch((cause: unknown) => {
    pendingInterfaceFonts.delete(fonts);
    throw new Error('Could not load the interface font.', { cause });
  });
  pendingInterfaceFonts.set(fonts, ready);
  return ready;
}

/** Load bundled faces before measuring text or drawing the report canvases. */
export function loadReportFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') return Promise.resolve();
  const fonts = document.fonts, pending = pendingFonts.get(fonts);
  if (pending) return pending;
  const faces = [
    new FontFace('IBM Plex Sans', `url("${new URL('../assets/fonts/ibm-plex-sans/regular.ttf', import.meta.url).href}")`, { weight: '400' }),
    new FontFace('IBM Plex Sans', `url("${new URL('../assets/fonts/ibm-plex-sans/medium.ttf', import.meta.url).href}")`, { weight: '500' })
  ];
  const ready = Promise.all(faces.map(face => face.load())).then(loaded => {
    loaded.forEach(face => fonts.add(face));
  }).catch((cause: unknown) => {
    pendingFonts.delete(fonts);
    throw new Error('Could not load the PDF report font. Please retry the export.', { cause });
  });
  pendingFonts.set(fonts, ready);
  return ready;
}
