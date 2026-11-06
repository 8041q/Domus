# Domus branding

The house and four-pane window retain the supplied logo's identity. The production
version uses flat fills, aligned geometry, sturdier window mullions, softened outer
corners, and the app's existing yellow (`#facc15`) with charcoal (`#20201e`) and white.

## Assets

All public assets are in `public/brand/`:

| Asset | Use |
| --- | --- |
| `app-icon.svg`, `icon-1024.png` | Rounded yellow tile; app header, startup, general app artwork |
| `logo-mark.svg` / `.png` | Transparent full-colour symbol; PNG is 1024 × 1024 |
| `logo-mono-dark.svg` / `.png` | Charcoal silhouette with transparent cutouts for print and light backgrounds |
| `logo-mono-light.svg` / `.png` | White silhouette with transparent cutouts for dark backgrounds |
| `wordmark.svg` / `.png` | Horizontal symbol and outlined IBM Plex Sans lettering, 960 × 256 |
| `wordmark-light.svg` / `.png` | Light wordmark for charcoal backgrounds |
| `favicon.svg`, `icon-16.png` | Simplified single window for readability at 16 px |
| `icon-32.png`, `icon-48.png` | Full-detail small icons |
| `apple-touch-icon.png` | Opaque, square 180 px source; the operating system supplies the corner mask |
| `icon-192.png`, `icon-512.png` | Standard web app icons |
| `icon-maskable-192.png`, `icon-maskable-512.png` | Full-bleed yellow; symbol inside the central 80% safe circle |
| `social-card.svg` / `.png` | Sharing artwork, 1200 × 630 |

`public/favicon.ico` contains 16, 32 and 48 px images. `public/site.webmanifest`
references the standard and maskable icons. This manifest supplies install artwork;
it does not add offline functionality. The public server derives absolute social
image URLs from its existing `DOMUS_ORIGIN` setting.

Use the full mark at 28 px and above; use the simplified favicon for tiny contexts.
Keep the mark's proportions, preserve its clear space, and use monochrome variants
when only one ink is available. Avoid stretching or adding effects. The white
wordmark and monochrome symbols have transparent cutouts and can sit on different
background colours.

## Regeneration

Run `npm run brand:generate`. This uses the existing Three.js OpenType parser for
outlined lettering and Playwright Chromium for SVG-to-PNG rendering. If needed,
install the browser with `npx playwright install chromium`. Font licensing is in
`public/fonts/ibm-plex-sans/OFL.txt`. The shared geometry and palette live in
`src/brand/mark.json`; PDF report footers draw directly from that same geometry,
without network requests or image loading delays.

The built-in imagegen tool refined the attached reference first. Its raster concept
is kept locally at `private/branding/refined-concept.png`; deterministic vector
production assets were then built from that direction. The local review sheet is
`private/branding/brand-preview.png`. These private review files are ignored and
excluded from public builds.

Built-in imagegen prompt (transparent background enabled):

> Use case: logo-brand. Asset type: refined master logo symbol for Domus, a room planner. Image 1 is the edit target and identity reference. Refine this exact isometric architectural house/corner mark for professional production use. Preserve its recognizable silhouette: two wall planes meeting at a tall central vertical corner, left wall white with a charcoal outline, right wall charcoal with a four-pane white window. Preserve original orientation. Improve strict isometric geometry: matching 30-degree top edges, clean aligned edges, consistent robust border and window mullion weights, balanced optical spacing, slightly softened outer corners only. Make four window panes generous and legible. Flat solid charcoal #20201e and white #ffffff only, with no gradients, texture, shadows, glow or photographic artifacts. Remove the yellow rounded square and surrounding white backdrop; output just the isolated house symbol on real transparent background. Large centered single mark with modest clear space, square image. No text, no multiple options, no presentation board. This is a careful refinement, not a different logo.

Public releases must still be made with `npm run package:public`; never deploy the
workspace or include `og_models/`.
