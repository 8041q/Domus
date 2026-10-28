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
- Export room architecture and finishes as GLB, excluding placed furniture.

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
GLBs in `private/models` (legacy `public/models` is relocated by the build). Originals stay intact; the catalogue still measures the
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
fingerprint; missing, incomplete or stale copies are unavailable until rebuilt. Originals are never served. Published viewing revisions are retained independently.
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
npm run start:local
```

`npm run start:local` serves the built app and its catalogue/experimental AI routes at
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

Browser checks build the app and run an isolated local server on port 5199 and a
master-free public deployment on port 5200.
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
alternative. On phones, choose **Explore** to enter Walk; **View → Free cam**
switches to orbit. `Esc` or **Exit walk** returns to the previous
planner camera. Walk shows full-height walls and the ceiling; your wall display
preference returns when you leave. Furniture editing shortcuts are paused while
walking. Walls, windows and closed doors block movement. Bare passages and door
frames can be crossed when there is enough clearance, while the outer floor
boundary always keeps you inside the room.

Build Room walls, corners, and openings can be dragged directly. Selecting an
item opens its numeric controls for precise edits.

On screens up to 820px wide, and short landscape touch screens, the same editor
uses a canvas-first phone interface. **Room**, **Furniture**, **Finishes**, and
**Explore** switch tasks. Tools share one bottom sheet: tap or swipe its heading
to resize it, close it to reveal the whole room, or use device Back to dismiss
the top sheet or menu. Sheets scroll independently of the room. Project actions
remain available from the header, including local saves and portable files.

With touch, tap a wall, corner, opening, or item to select it before dragging it
to edit. Drag empty space to navigate, or use two fingers to pan and pinch zoom.
A second finger cancels an unfinished edit before navigating; the cancelled edit
does not use an undo step. Selected geometry has numeric fields and explicit
split/remove actions. **Fine snap** replaces the Build Room Shift modifier, and
**Free move** replaces Shift while moving furniture. Adding furniture selects it
and collapses its tools so placement stays visible. Items that cannot fit remain
listed in the catalogue for removal or placement after the room changes.

## Saving and export

Use **Project** in the header to manage rooms:

- **New room** creates a named preset with a door and window. Circle rooms have
  a diameter input and slider; resizing preserves their circular shape and opening sizes.
- **Save** saves the current room under the entered name. Keep its name to
  update it, or enter a new name to keep a separate copy. Ctrl/Cmd+S opens this dialog;
  Ctrl/Cmd+Shift+S suggests a copy name.
- **Open saved room** lists all rooms saved in this browser, with their last save time.
  Each row has a delete icon with confirmation. Deleting the active saved room
  keeps your working layout open as an unsaved room.
- **Export room** creates one `.glb` file. Other 3D software opens its architecture,
  doors/windows, materials and textures. Domus also reads the editable layout,
  project details and exact furniture references embedded in the GLB metadata.
  Furniture geometry is excluded. Send the same file to another user; reopening
  furniture in Domus requires internet access to the same model library. Keep the
  original exported file: another editor may discard the Domus metadata when resaving.
- **Import room** explains accepted formats before choosing a file: Domus `.glb`,
  older `.domus` files and layout JSON. Regular GLB models without Domus room data
  are rejected without replacing the current room. It also accepts legacy model-containing archives.
  Embedded models are validated but never rendered or saved. Known asset hashes
  resolve to published revisions; unresolved items retain their data as placeholders.
- **Storage & recovery** (inside Open saved room) shows browser/model usage and
  offers recovery drafts, discarding of closed-tab drafts, and cleanup of assets
  unreferenced by saves or drafts.

New, Open and Import ask you to Save, Discard or Cancel when the current room has
unsaved changes. Failed saves keep the current room and stop the replacement.
Opening another room starts fresh undo history. Names cannot duplicate an existing
saved room, and stale saves from another tab are rejected; use Save to keep both.

A debounced recovery draft restores the same tab's latest layout after reloading,
including unsaved changes. Drafts are isolated by tab. A duplicated tab receives
its own identity; drafts from other tabs are offered under Open saved room → Storage & recovery. A changed layout also triggers the browser's leave-page warning.
Named saves and recovery drafts use IndexedDB transactions with revision checks.
New saves contain references only. Old embedded assets remain until explicit cleanup.
A failed connection or import leaves the current room intact. Missing individual
revisions retain item positions and dimensions with a warning; they are never silently
replaced by the newest catalogue item. Clearing site data removes local saves and
recovery drafts; keep downloaded room files as backups. Cloud backup is not provided.

**Project → Export room** includes architectural GLB geometry: walls, floor,
baseboards, doors/windows, ceiling, materials and textures. Placed furniture geometry is
excluded, regardless of visibility or selection. Furniture references remain in the editable room metadata. PDF reports retain furniture.
There is no private staff workflow or furniture-containing GLB export.

### Publishing and hosting

`npm run build` relocates legacy `public/models` masters to `private/models` and
architectural masters to `private/openings`, then prepares viewing derivatives.
Both source and destination existing is an error requiring manual consolidation.
Optimization failures never make originals public. Published furniture revisions,
opening revisions and the active catalogue live in `.domus-published/`; back up
this entire directory and retain it across deployments. Retirement removes an item
from new placement, while previous room references remain usable indefinitely.

Build a clean public deployment on the workstation that holds the masters:

```bash
npm run package:public -- /path/to/new-release
```

The destination must not exist. The command builds and publishes automatically,
then copies only the app, all retained display revisions, public metadata, a
self-contained `server.mjs` and a checksummed `release.json` inventory. Private
sources, processing caches, local maintenance tools and Node dependencies are
excluded. Transfer only this package to the public server; do not deploy the
workspace or `server-dist/local.mjs`.

Run from the packaged directory using Node 24, behind an HTTPS reverse proxy that
preserves the configured Host:

```bash
cd /path/to/new-release
DOMUS_ORIGIN=https://planner.example.com node server.mjs --host 0.0.0.0 --port 5173
```

Startup validates the complete inventory and published library before listening.
Unexpected files, symlinks, missing assets, damaged assets or local-only settings
cause startup to fail. Keep the deployment read-only and place logs, environment
files and uploads outside it. Repair failed releases by rebuilding the package.
Retain the workstation's full `.domus-published/` library when preparing future
releases so older rooms keep their exact revisions.

The public entry point has no source scanner, optimizer or maintenance handlers;
it cannot switch to local mode. `npm start` now selects the public entry point and
refuses an unpackaged workspace; use `start:local` for local work. Vite and `start:local` are
trusted loopback-only developer tools. Published display geometry remains
extractable by old or modified browsers. Masters are protected by their absence
from the deployment; public display URLs and room references remain compatible.

**Project → Project details** edits the project name, revision, status, preparer,
room purpose, site, company and client information, and notes. Clients can be
companies or individuals, with multiple named contacts and separate phone/email
fields. Use + Add contact and the minus button to manage contacts; older single-field
contacts are retained when opening existing rooms. These details are kept with saves,
recovery drafts and draft imports/exports; use Save to persist changes.

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
`private/models/` (subfolders work); the dev/preview server imports it automatically
and assigns a persistent unique ID. Folder changes update the catalogue without
source edits. Keep the generated `model-catalogue.json` with project backups.
Removing a master retires its catalogue entry. Open and saved rooms retain published
revisions; reopening retrieves those exact versions from durable server storage.
Retired revisions do not reappear in the placement catalogue.
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
  GLBs in `private/models/` are processed locally. Public hosting requires the runtime
  and durable published library; a static-only deployment cannot resolve room files.
- Saved rooms are local to one browser origin; portable Domus `.glb` files are the backup and transfer mechanism. Browser storage is not an external backup.
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
