# Domus

Domus is a browser-based room builder and layout planner. It keeps the room,
openings, finishes, and furniture as semantic data and uses Three.js only to
render and interact with that data.

The application is local-first. It has no accounts, database, or cloud sync.
An opt-in experimental AI assistant is available through a small gateway that
runs with Vite during local development and preview.

## What it does

### Build Room

- Start from rectangle, angled-corner, L-shaped, or recessed room templates.
- Drag walls and corners in a dimensioned 2D workspace; split a wall by adding a
  corner.
- Draw connected interior walls or open boundaries to create named spaces.
- New spaces inherit their containing space’s finishes automatically; place doors in interior walls.
- Set room height in 2D and work in metric or imperial units.
- Add, position, resize, and restyle windows, doors, and custom openings.
- Inspect the architecture in a neutral 3D preview. Direct sun light is
  intentionally disabled in this workspace.

### Plan Room

- Place, move, rotate, duplicate, and remove furniture, including registered GLB models.
- Use wall, object, and room-centre snapping with deterministic collision and
  clearance checks.
- Switch between Free cam, Top, Front, Right, Back, and Left views, with interior walls up or down.
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

You need Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

Vite serves the app at `http://localhost:5173` by default.

The experimental AI gateway is available with both `npm run dev` and
`npm run preview`. Open Plan Room and choose **AI Experimental**. Cloud keys are
encrypted in this browser and are never added to room project files.

Ollama defaults to `http://127.0.0.1:11434` on the machine running Domus. Exact
additional endpoints can be approved when starting the server:

```bash
OLLAMA_ALLOWED_ENDPOINTS=http://192.168.1.50:11434 npm run dev
```

Create and preview a production build with:

```bash
npm run build
npm run preview
```

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
- **Download draft** and **Import Draft** provide portable `.domus.json`
  backups. Imported rooms open as unsaved copies; legacy snapshot JSON also works.

New, Open and Import ask you to Save, Discard or Cancel when the current room has
unsaved changes. Failed saves keep the current room and stop the replacement.
Opening another room starts fresh undo history. Names cannot duplicate an existing
saved room, and stale saves from another tab are rejected; use Save as to keep both.

A debounced recovery draft restores the latest layout after reloading, including
unsaved changes. Recovery is shared across tabs in the same browser origin; the
latest draft wins. A changed layout also triggers the browser's leave-page warning.
Explicit named saves are separate from recovery. Old single-slot saves migrate to
**Recovered room**, and their original browser keys are retained as backups.
Clearing site data removes saved rooms and recovery drafts. Download a room file
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
Missing real-life sizes are explicitly labelled; measured geometry remains in the
technical schedule alongside catalogue references, positions and rotation.
Long lists use banded rows and repeated headers; unplaced furniture is listed separately.
Architectural schedules include hidden-wall measurements, aperture coverage and
existing clearance recommendations. It then includes
five landscape room views: Top, Front, Right, Back and Left, with loaded furniture and
finishes. Editing helpers and selection outlines are excluded, and the current
camera view and selection are restored afterward. Each side reports its actual
cutaway boundary length, projected span, height and gross/net wall area, with a
matching small plan key. Top reports the footprint, floor area and perimeter.
Report positions use the bounding box's front-left corner (X right, Z back, Y up)
and document the Domus coordinate offset. Model scaling and placement still use
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
Removing a GLB cleans its catalogue/registry entry and instances in open rooms.
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
- Saved rooms are local to one browser origin; portable room files are the backup and transfer mechanism.
- The renderer requires a browser with WebGL support.
- AI assistance is experimental, furniture-only, non-streaming, and intended
  for trusted local use. A static `dist` deployment does not provide its API
  routes; a production host must supply the gateway and add authentication,
  quotas, and abuse protection before public use.
- Multi-user projects, authentication, and cloud services are not implemented.

## Developer guides

- [Architecture](docs/ARCHITECTURE.md) — current state, data flow, renderer, and
  lifecycle.
- [Experimental AI](docs/AI.md) — setup, providers, safety boundaries, and
  current limitations.
