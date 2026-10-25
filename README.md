# Domus

Domus is a browser-based room builder and layout planner. It keeps the room,
openings, finishes, and furniture as semantic data and uses Three.js only to
render and interact with that data.

The application is local-first. It has no accounts, remote database, or cloud sync.
An opt-in experimental AI assistant is available through a small gateway that
runs with the local production runtime and Vite development/preview servers.

## What it does

### Build Room

- Start from rectangle, angled-corner, L-shaped, or recessed room templates.
- Drag walls and corners in a dimensioned 2D workspace; split a wall by adding a
  corner.
- Draw connected interior walls or open boundaries to create named spaces.
- New spaces inherit their containing space’s finishes automatically; place doors in interior walls.
- Set room height in 2D and work in metric or imperial units.
- Add, position, resize, and restyle windows, doors, and custom openings.
- Door/window GLBs use a separate internal asset folder with generated fallbacks;
  see [architectural models](docs/architectural-models.md) for resizing limits.
- Inspect the architecture in a neutral 3D preview. Direct sun light is
  intentionally disabled in this workspace.

### Plan Room

- Place, move, rotate, duplicate, and remove furniture, including registered GLB models.
- Use wall, object, and room-centre snapping with deterministic collision and
  clearance checks.
- Switch between Free cam, Walk, Top, Front, Right, Back, and Left views, with interior walls up or down.
- Toggle room, product, spacing, and clearance annotations.
- Change PBR floor finishes, wall and ceiling colours, baseboard styles, and
  ceiling-light settings.
- Select a space to edit its name, floor finish and wall colour. Move the Design
  and Room finishes popout panels by their headers; each remembers its location.
- Enable paired suns or just cinematic sun shadows in rooms with
  glazed openings.
- Ask the experimental AI assistant for layout advice or validated furniture
  proposals using Gemini, OpenAI, or a server-reachable Ollama model.
- Export the complete physical room as a semantic GLB.

Both workspaces edit the same project. A change made in Build Room is available
immediately in Plan Room and vice versa.

## Developer feature switches

Set `FEATURES.interiorWalls` in `src/config/features.ts` to `false` to disable
interior walls and named spaces. `FEATURES.aiExperiment` controls the experimental
AI assistant; set it to `false` to hide the panel and refuse client requests,
proposal application and gateway routes (HTTP 503), without deleting existing
AI preferences. Current settings are interior walls disabled and AI enabled. Reload/restart development
or rebuild production after changing it.

When disabled, Build Room shows exterior layout/opening tools and Plan Room edits
one global wall colour and floor finish. Interior divisions, space selection,
per-space finishes, interior doors/thresholds, wall view controls, shadow blockers,
and furniture snap/spacing targets are inactive in 2D, 3D, AI context and GLB export.
Saved interior data and undo snapshots are retained for re-enabling. Existing
hidden connections continue to follow shell edits and project validation protects
them; changing the room template or resetting the project clears them as usual.

3D failures now keep the application available with **Try again** and
**Return to 2D** controls. Failed scene initialization releases its graphics
resources; returning to 2D retains the layout.

## Run locally

Use Node.js 24 LTS (see `.nvmrc`) and npm 10 or newer.

```bash
npm ci
npm run dev
```

Vite serves the app at `http://localhost:5173` by default.

Development startup and production builds prepare compressed viewport copies of
GLBs in `public/models`. Originals stay intact; the catalogue still measures the
source geometry. Generated copies in `public/optimized-models` combine compatible
opaque parts, simplify detail with an error limit, and use Meshopt compression.
Transparent parts retain separate sorting. The first preparation takes longer;
unchanged sources reuse their generated copies.

The running development server detects new, updated and removed model files.
It prepares optimized copies in a separate process and updates open planners
when they are ready. Preview checks for changes when refreshing the catalogue.
Unused generated copies are removed automatically, while identical source copies
can share one cached file. Generated model caches expire after 72 hours from
their last build, including browser caching. The running server removes expired
copies and rebuilds them in the background; if it is closed, cleanup runs at
the next startup. Reading a model does not extend its expiry, and original
GLBs are never deleted by cache cleanup. `npm run models:optimize` and `npm run models:rescan`
remain available for manual recovery. Derivatives are matched to the full source
fingerprint; missing, incomplete or stale copies fall back to the source.
The 3D view prepares detailed picking data in a background
worker, processes pointer movement once per frame, caches unchanged shadows,
and restores full display resolution when movement stops.

Window dragging retains compatible frame/wall buffers, compiled materials and
sun-shadow maps. Its latest pointer sample is drawn in the same animation frame;
store synchronization is folded into rendering to avoid a duplicate update.

`npm run models:benchmark -- C8c.glb` compares source/runtime geometry parsing and
picking. This skips texture decoding and GPU rendering; its timings are not an
end-to-end loading or frame-rate measurement.

The experimental AI gateway is available with both `npm run dev` and
`npm run preview`. Open Plan Room and choose **AI Experimental**. Cloud keys are
encrypted in this browser and are never added to room project files.

Ollama defaults to `http://127.0.0.1:11434` on the machine running Domus. Exact
additional endpoints can be approved when starting the server:

```bash
OLLAMA_ALLOWED_ENDPOINTS=http://192.168.1.50:11434 npm run dev
```

Build and run the supported local release with:

```bash
npm run build
npm start
```

`npm start` serves the built app and its catalogue/experimental AI routes at
`http://localhost:5173`. It binds only to a loopback address and refuses an occupied
port. Keep the same hostname and port to retain access to the same browser saves.
`npm run preview` remains a build-preview tool. Use `npm run dev` for source editing.

## Verification

```bash
npm run typecheck
npm test
npx playwright install chromium firefox webkit
npm run test:e2e
```

Browser checks build the app and run an isolated production server on port 5199.
Generated fixtures replace private model files; tests do not scan your model
folder, rewrite your registry, or open your normal saved rooms. CI runs the same
checks on Node 24. Optional checks against private architectural GLBs remain
skipped when those files are absent.

## Main controls

| Action | Control |
| --- | --- |
| Undo | `Ctrl/Cmd + Z` |
| Redo | `Ctrl/Cmd + Y` or `Ctrl/Cmd + Shift + Z` |
| Rotate selected furniture 90° | `R` |
| Remove selected furniture | `Delete` or `Backspace` |
| Orbit the 3D view | Drag empty space with the left mouse button |
| Pan the 3D view | Drag with the right mouse button |
| Zoom | Mouse wheel or trackpad |
| Keep a furniture selection while orbiting | Hold `Shift` and drag empty space |
| Move furniture without snapping | Start dragging it, then hold `Shift` |
| Use the fine Build Room snap | Hold `Shift` while dragging in 2D |

Choose **Walk** to explore the room from eye level with wall collisions. Click the
room, then use `WASD` or arrow keys to move. Drag to look around, right-drag to
pan across the floor, and scroll to zoom. **Look** and **Pan** buttons let you
choose what a primary drag does; **− / +** also control zoom. Zoom magnifies the
view without changing your position. On phones, drag with one finger to look,
drag with two fingers to pan, or pinch to zoom. Choose **Pan** for a one-finger
alternative. Walk fills the phone workspace and brings the catalogue back when
you exit. `Esc` or **Exit walk** returns to the previous
planner camera. Walk shows full-height walls and the ceiling; your wall display
preference returns when you leave. Furniture editing shortcuts are paused while
walking. Walls, windows and closed doors block movement. Bare passages and door
frames can be crossed when there is enough clearance, while the outer floor
boundary always keeps you inside the room.

Build Room walls, corners, and openings can be dragged directly. Selecting an
item opens its numeric controls for precise edits.

## Saving and export

Use **Project** in the header to manage rooms:

- **New room** creates a named preset with a door and window. Circle rooms have
  a diameter input and slider; resizing preserves their circular shape and opening sizes.
- **Save as** saves the current room under the entered name. Keep its name to
  update it, or enter a new name to keep a separate copy. Ctrl/Cmd+S opens this dialog;
  Ctrl/Cmd+Shift+S suggests a copy name.
- **Open room** lists all rooms saved in this browser, with their last save time.
  Each row has a delete icon with confirmation. Deleting the active saved room
  keeps your working layout open as an unsaved room.
- **Download room** creates a portable `.domus` ZIP containing the editable
  layout, product metadata and the compact models used by placed and unplaced
  furniture. It shows the estimated size first. **Import room** opens these files
  as unsaved copies in another browser, even without the original model folder.
- **Download layout only** creates a small `.domus.json` without model binaries.
  Import room also accepts this format and legacy snapshot JSON.
- **Room storage** shows browser/model usage, estimates additional storage and
  offers recovery drafts, discarding of closed-tab drafts, and cleanup of assets
  unreferenced by saves or drafts.

New, Open and Import ask you to Save, Discard or Cancel when the current room has
unsaved changes. Failed saves keep the current room and stop the replacement.
Opening another room starts fresh undo history. Names cannot duplicate an existing
saved room, and stale saves from another tab are rejected; use Save as to keep both.

A debounced recovery draft restores the same tab's latest layout after reloading,
including unsaved changes. Drafts are isolated by tab. A duplicated tab receives
its own identity; drafts from other tabs are offered under Room storage. A changed layout also triggers the browser's leave-page warning.
Named saves and compact models use IndexedDB transactions with revision checks.
Each model version is stored once and shared across rooms. Saved assets do not
expire with the 72-hour server cache; source files and original-quality binaries
are never copied into browser saves. Existing libraries, recovery and single-slot
saves migrate without deleting the original browser keys. Models already missing
from old layouts remain unresolved with a warning; restore a catalogue backup or
replace those items to make a complete portable backup.
Clearing site data removes saved rooms, model assets and recovery drafts. Download a room file
for a lasting backup; cloud backup is not provided.

**Project → Export Room** is available in Plan Room. It downloads a GLB of the complete room rather
than the current cutaway: walls, floor, baseboards, frames, ceiling, and
furniture are grouped by semantic category. Cameras, selection outlines,
measurements, and other editing helpers are excluded.

**Project → Project details** edits optional company/client names and contacts,
project reference, preparer, revision, status, room purpose, site/department and notes. These details are kept with saves,
recovery drafts and draft imports/exports; use Save as to persist changes.

**Project → Export to PDF** starts with a room summary, project details,
furniture quantities and entered real-life dimensions, opening sizes and notes.
The interface and its 2D/3D labels use bundled IBM Plex Sans, loaded before the
planner renders. Reports use Regular and Medium; export waits for both
faces to load before measuring text, with no external font service required.
Furniture appears in one inventory with quantities, dimensions, size source and
placement status. Missing real-life sizes use measured geometry and are labelled.
Long lists use banded rows and repeated headers; unplaced furniture is listed separately.
Architectural schedules include every physical wall's measurements, opening coverage and
existing clearance recommendations. It then includes
five landscape room views: Top, Front, Right, Back and Left, with loaded furniture and
finishes. Editing helpers and selection outlines are excluded, and the current
camera view and selection are restored afterward. Each side reports its actual
cutaway boundary length, projected span, height and gross/net wall area, with a
matching plan key. Polygon corners separate coloured sides, with large length
labels; contiguous curved sections remain one side. View measurements sit below
the room image. Top reports the footprint, floor area and perimeter.
Model scaling and placement still use
the measured geometry; exporting a report does not alter either.
Openings can be dragged past
wall ends in Build Room 3D to continue onto adjacent perimeter walls or joined
interior walls. A complete drag is one undo step.

Circular rooms support doors and openings only. Older circular-room windows
become openings while retaining their dimensions and position. Corner shading
fades on short walls (0.9–1.5 m) and shallow turns (20–60°), avoiding circle seams
and false corners on straight walls with added breakpoints.

To prepare your own furniture models, use the [Blender product metadata add-on](docs/BLENDER_METADATA.md).
It works with complete product collections, saves measured geometry separately
from the size shown in the catalogue, and exports GLBs in metres. Copy a GLB into
`public/models/` (subfolders work); the dev/preview server imports it automatically
and assigns a persistent unique ID. Folder changes update the catalogue without
source edits. Keep the generated `model-catalogue.json` with project backups.
Removing a GLB cleans its live catalogue/registry entry and ordinary instances in
open rooms. Previously saved rooms retain their compact model version. Reopening
a saved or imported portable room resolves its archived models within that room;
it does not re-add deleted models to the live catalogue.
Re-adding or renaming it assigns a new ID; retired IDs are never reused. The
Blender add-on and project share the hospital product categories.

If a folder change is missed, run this in another terminal while Domus is running:

```bash
npm run models:rescan
```

It rereads every GLB, preserves existing IDs, reports import problems, and updates
open planners. For preview or a different port, pass the server URL:
`npm run models:rescan -- http://localhost:4173`.

## Current limitations

- Most catalogue furniture uses procedural placeholder models and sample prices.
  GLBs in `public/models/` are imported automatically. Static deployments include
  the models present at build time and require a rebuild for later folder changes.
- Saved rooms are local to one browser origin; portable `.domus` files are the backup and transfer mechanism. Browser storage is not an external backup.
- The renderer requires a browser with WebGL support.
- AI assistance is experimental, furniture-only, non-streaming, and intended
  for trusted local use. A static `dist` deployment does not provide its API
  routes; the supported local runtime supplies the gateway. Public hosting still requires
  authentication, quotas, and abuse protection.
- Multi-user projects, authentication, and cloud services are not implemented.

## Developer guides

- [Architecture](docs/ARCHITECTURE.md) — current state, data flow, renderer, and
  lifecycle.
- [Experimental AI](docs/AI.md) — setup, providers, safety boundaries, and
  current limitations.
