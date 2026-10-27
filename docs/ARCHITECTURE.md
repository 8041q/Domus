# Domus Architecture

This document describes the application as it exists today. The experimental AI
path and its stricter deployment boundary are detailed in [AI.md](AI.md).

## Runtime and dependencies

Domus is a local-first TypeScript application built with React 19 and Vite 7.
Zustand owns application state; Three.js renders the 3D workspace. A small Node
middleware plugin adds experimental AI routes to Vite's development and preview
servers. The shared UI and semantic CSS tokens have no component-framework
dependency.

The local production server is compiled from `server/index.ts`. IndexedDB stores
room documents, compact asset binaries, per-tab drafts and migration metadata. There
is no authentication layer,
physics engine, runtime-validation library, or provider SDK. The AI gateway uses
native `fetch` and fixed provider endpoints.

The model catalogue plugin scans `public/models/` and its subfolders. It reads
GLB metadata and transformed geometry, assigns persistent UUIDs in
`model-catalogue.json`, and exposes the result as `virtual:domus-models` for builds
and `/api/model-catalogue` for dev/preview. Development file-watcher events update
the shared catalogue store without replacing room state; preview refreshes via
the API. `npm run models:rescan -- [server-url]` calls
`POST /api/model-catalogue/rescan`, bypasses file timestamp caching, and publishes
the result through the same serialized importer. Missing files lose their
definitions and aliases; only retired UUIDs remain to prevent reuse. Client
cleanup runs before view subscribers: deleted-model instances are removed from
live rooms and history, and renderer asset caches are released. Saved-room
imports filter missing references. A re-added or renamed file receives a new ID.
Physical dimensions
come from geometry; optional display dimensions are confined to catalogue and
selection UI. The Blender add-on and server share `blender_addon/catalogue_schema.json`.

```text
React workspaces
      │ commands and selectors
      ▼
Zustand store ── snapshot history / browser save
      │ PlannerSnapshot
      ├──────────────► 2D canvas
      └──────────────► PlannerScene / Three.js ──► WebGL

Plan Room AI panel ──► /api/ai middleware ──► Gemini / OpenAI / Ollama
```

The renderer is a consumer of project state, not the project database. Core
geometry and placement code therefore works without reading Three.js meshes.

## Project state

`PlannerSnapshot` is the portable project boundary:

```ts
interface PlannerSnapshot {
  room: RoomState;
  openings: RoomOpening[];
  dividers: InteriorDivider[];
  spaces: NamedSpace[];
  objects: PlacedObject[];
}
```

- `RoomState` contains an ordered polygon, dimensions, finishes, baseboard
  settings, and lighting settings.
- Each opening belongs to a stable wall-segment ID and stores its wall offset,
  size, sill height, type, and architectural variant. Doors may store `doorFlipped`
  to reverse their facing and hinge/latch direction; older saves default to the
  original direction.
- Interior dividers attach to perimeter walls or existing dividers. Physical walls
  and invisible boundaries form a planar graph; its bounded faces are named spaces
  with independent floor finishes and wall colours.
- Each placed object references a catalogue product and stores position and Y
  rotation.

Viewport mode, selections, camera preset, active snap feedback, and annotation
toggles are UI state and are not part of a saved snapshot.

AI provider/model preferences are also separate from the snapshot. Cloud
credentials are AES-GCM encrypted in IndexedDB with a browser-local,
non-exportable Web Crypto key; they never travel with room saves or GLB files.

The store normalizes loaded data, supplies defaults for fields added after an
older save, remaps known legacy product IDs, and projects furniture back into a
valid room position when possible. The current project database is `domus-projects-v2`. Old localStorage libraries,
drafts and single-slot saves remain readable as migration inputs and are retained
as backups.
Legacy sun-style values are also mapped to the corrected style names while
preserving the lighting each saved room displayed.

During development, `store.ts` accepts hot updates and retains the existing
Zustand store and snapshot history in Vite's hot data. `core/hotStore.ts` replaces
action implementations while retaining all project/UI values and the store's
identity, so cached lazy views and live renderer subscriptions keep reading the
same project. This avoids a store reset or full-page invalidation when this data
module is updated. Production startup still creates a fresh store normally.

Undo and redo use cloned semantic snapshots. Continuous drags update live but
commit the state captured at pointer-down once, producing one history entry per
gesture.

## Workspaces

### Build Room

Build Room owns room topology and architectural openings. Its 2D canvas handles
wall, corner, divider, and split-wall interactions against a world-anchored
drafting grid. Wall edits preserve world coordinates; angled walls and negative
coordinates are valid.

Door/window/passage creation and editing are available only in 3D. The 2D layout
retains their plan symbols as context. 3D picking selects visible physical walls;
windows remain restricted to the exterior. Leaf doors have a Flip button, and
their closed leaf, panels, handles, casings and hinges are modelled on both sides.
Door flips keep the aperture and threshold unchanged and survive history/save/load
and GLB export.

Pointer samples are coalesced by `core/frameQueue.ts`; the final sample is flushed
before history is committed. Corner and opening drags retain the initial grab
offset. Opening drags stay on their existing wall; use the Wall selector to move
them to another wall. Pointer cancellation and focus loss release drag controls.
Opening edits rebuild only the affected old/new walls and reuse window-fill lights
and their shadow maps. Adjacent space lookups share one derived layout per wall
rebuild, and repeated identical geometry samples do not notify the store.

Divider edits commit immediately, assigning stable space IDs and automatically
inheriting the containing space’s finishes for new faces. Names and finishes are
edited in Plan Room. Interior wall endpoints remain attached to their supporting
boundaries when the perimeter moves.

The optional 3D preview uses the same `PlannerScene`, with furniture interaction
off and architectural picking on. It always passes `sunRays={false}`, so editing
an opening cannot create or update the directional sun-mask rig. Neutral room,
window-fill, and ceiling lighting remain active.

### Plan Room

Plan Room owns finishes, presentation, and furniture layout. The catalogue is
defined as semantic product data with dimensions, collision footprints,
interaction tags, wall affinity, and clearances. Models are currently generated
procedurally by the renderer.

The top-left editing-space selector controls finish edits. Selecting a floor or
an existing item also selects its space; dropping furniture in another space
follows that space. The finishes panel opens from its toolbar button. The space selector uses an
anchored list below its trigger, with mouse and keyboard selection, Escape and
outside-click dismissal; it does not use the OS-positioned native select menu. Space and
divider changes schedule a scene refresh, including floor materials and per-side
wall colours. Rendered space floors are clipped to the slab's inner miter edge by
`renderer/floorGeometry.ts`, including concave shells. Semantic space outlines and
areas stay on wall centre lines. The same clipped surfaces are used in GLB exports.
Design and Room finishes use the same draggable panel component;
each stores its position in local storage and clamps it to the available workspace
when reopened or resized. These UI preferences are separate from project history.

New furniture searches valid destinations throughout the exterior shell without
requiring a selected space or changing the camera preset. Insertion prefers clear
points away from interior walls, then allows divider overlap if needed. Items that
cannot fit the shell or other furniture remain unplaced. During dragging, interior
walls are soft targets: a 12 cm entry / 20 cm exit snap gap applies to interior walls; exterior snaps retain 18 mm / 21 mm;
continued dragging releases the snap and crosses the wall. Exterior bounds and
product collision rules still apply. Interior walls remain spacing and clearance
targets; invisible boundaries provide neither collision nor snapping.

Interior walls have invisible shadow geometry independent of camera cutaways.
It blocks window sunlight and fill lights, with apertures for open passages and
glazed door panes. Window fill lights use shadow maps when physical dividers exist.

Walls up shows full-height physical dividers; Walls down shows flat 22 cm sections.
Neither mode depends on camera angle, furniture selection or editing space.
Dropped sections have closed neutral gray poché caps, original per-side finishes,
and low door jambs. Existing floor thresholds stay visible. Exterior cutaway logic
is independent and unchanged. Presentation meshes are excluded from export;
canonical walls and doors retain full height for GLB, and daylight blockers use
the complete architecture.

Free cam is independent of wall presentation. An orbit from Top, Front, Back,
Left or Right switches to Free cam while retaining the view direction and framing.
Zoom and pan retain the fixed preset; the wall toggle does not reset the camera.

Walk is a separate first-person camera view. It keeps the camera at eye level
and routes keyboard movement and floor-plane panning through the same semantic
wall collision rules. Primary drag grabs the panorama; secondary drag pans, and
the visible Look/Pan switch provides a primary-button alternative. WASD and arrow
keys move only while the viewport has focus. Focus loss cancels movement. Walk
temporarily shows full walls and ceiling and hides editing helpers and furniture
selection. Leaving Walk restores the prior planner camera and wall display
preference. Its position and input state are renderer state rather than saved
project data.

Walk batches pointer input and resolves one combined horizontal movement per
frame. Keyboard acceleration and braking use elapsed time. Wheel, trackpad pinch,
touch pinch and zoom buttons adjust a bounded 30–85° field of view without moving
the camera; zoomed-in drags have lower sensitivity. Touch tracks both pointers,
distinguishes two-finger pan from pinch after a small intent threshold, and
rebases when fingers lift. One finger uses the selected Look/Pan tool. Compact
Explore hides authoring tools and sizes the workspace to the visual viewport.
Blur, hidden tabs and input composition
clear pending motion. Cached wall bases and bounds reject distant collision
candidates before continuous sweeps; recovery searches near the walker and can
fall back outside an unusably narrow editing space.

Walk renders the scene once and skips hidden measurement layout and the text
overlay. Its enclosed walls and ceiling update when architecture changes, and a
stable clipping range covers the whole room. A short quality-settling interval
avoids resizing render targets between sparse mouse samples; the final frame
restores full resolution, then the renderer sleeps while idle.

Walk collision follows the full semantic architecture, independently of visual
cutaways. Windows and closed door leaves remain solid; bare passages and door
frames allow traversal when the viewer fits. The outer floor polygon remains a
hard boundary even at exterior apertures.

Placement resolves in core code before rendering. It keeps oriented footprints
inside arbitrary room polygons, applies magnetic wall/object/centre snaps, and
checks product-specific overlap and clearance rules. Holding Shift during an
item drag permits free movement and intentional overlap.

The compact shell uses the same mounted editor, store and commands as desktop.
`mobileWorkspace.ts` owns transient task, sheet, snap and selection-handle state;
none of these fields enter project documents. Layout follows a media query
(820px width, or a short coarse-pointer landscape viewport). Editing follows each
event's pointer type, so touch and mouse can coexist on larger screens.
`MobileSheet` portals reusable tool content into the main workspace. The shell
tracks `visualViewport` for keyboard-aware sizing and safe-area padding. A shared
transient history entry dismisses the top mobile menu/dialog/sheet on Back.

`core/planTouch.ts` and `renderer/SceneTouchControls.ts` arbitrate selection,
editing and navigation. Only an already-selected touch target starts editing;
empty-space drags navigate. A second pointer restores the pre-edit semantic
snapshot through `cancelInteraction` before rebasing pan/pinch navigation.
Cancellation leaves undo/redo untouched; completion records one semantic change.
Each gesture captures a project generation so deferred work cannot overwrite a
New/Open/Import replacement. Resizing keeps 2D world centre/scale and the mounted
3D camera. Explore and Finishes turn off furniture editing through the scene
bridge without rebuilding the renderer.

## Geometry and architecture

`core/roomGeometry.ts` provides templates, bounds, polygon tests, wall lookup,
wall/corner movement, centred wall resizing, splitting, and room scaling.
`core/placement.ts` owns oriented footprints, snapping, collision resolution,
clearance regions, and spacing measurements. These deterministic functions are
shared by the 2D and 3D interfaces and are the authority for future automation.

Perimeter walls are rebuilt from the semantic polygon; interior walls are built
from divider edges. Openings create real voids and
their frames, glazing, thresholds, and baseboard interruptions are derived from
the opening definition. Spaces receive separate floor surfaces with metre-based
UVs; differently finished spaces meet cleanly at open boundaries and use the
existing door material for an interior doorway threshold.

## Experimental AI path

The lazily loaded Plan Room AI panel sends app-owned messages, the current
snapshot, product metadata, and a snapshot revision to `/api/ai/turn`. Provider
adapters translate Gemini `generateContent`, OpenAI Responses, and Ollama chat
results into one JSON contract. `/api/ai/models` discovers available models and
`/api/ai/config` exposes only approved Ollama endpoints.

Executable proposals are deliberately narrow: at most eight furniture add,
move, rotate, or remove operations. The browser rejects stale revisions,
unknown IDs, invalid numbers, and placements that fail the same exact geometry
and clearance checks used by direct interaction. Validation occurs against a
clone; either the complete proposal becomes one undoable history entry or the
project remains unchanged. AI cannot change architecture, openings, finishes,
lighting, saved projects, or exports.

Ollama defaults to the application server's `127.0.0.1:11434`. Deployments may
add exact endpoints through `OLLAMA_ALLOWED_ENDPOINTS`; arbitrary URLs are
rejected. Cloud destinations are hard-coded in the gateway.

## 3D renderer and lifecycle

`Viewport3D` bridges store actions to one imperative `PlannerScene`. Plan Room
and the 3D renderer are loaded lazily so the initial Build Room 2D workflow does
not pay the full Three.js cost.

The scene uses a WebGL renderer with native antialiasing, OrbitControls, real
shadow maps, and an outline composer only when a furniture selection needs it.
Measurements render on a separate overlay layer to keep their canvas text crisp.

Rendering is demand-driven. Store updates, resize events, pointer interaction,
camera damping, and completed texture loads request frames; an idle scene runs
no continuous animation loop. Floor map sets are loaded atomically and cached
so a previous finish stays visible until the next one is ready.

Disposal is explicit. Unmounting releases observers, DOM and control listeners,
geometries, materials, cached floor textures, shadow maps, post-processing
targets, the cinematic environment target, and the WebGL context.

## Lighting

The base rig combines hemisphere, ambient, directional fill, window-local fill,
ceiling fixtures, material response, and procedural architectural/contact
shading.

Plan Room can additionally project sunlight through glazed openings:

- **Cinematic Shadows** uses equal-energy crisp and soft directional suns whose
  azimuths remain 2° apart while the controls orbit the pair.
- **Paired Suns** keeps the same direct suns and adds a subtle procedural
  warm/cool PMREM environment and complementary fill colours. It does not replace
  the visible scene background.

Invisible exterior masks block each sun everywhere except exact glazing areas.
Their perimeter guards account for soft-shadow filtering while avoiding fins
that could pre-shadow glazing on an adjacent wall. Disabling sun light disposes
the complete rig and returns to the fallback lighting path. The selected style,
angles, and enablement are saved with the room.

## GLB export

Plan Room builds a fresh export scene instead of serializing the live cutaway.
The root is `DomusRoom`, uses metres, and groups logical items under `Walls`,
`Floors`, `Frames`, `Ceiling`, and `Furniture`. Logical parent nodes carry Domus
category and item identifiers as glTF extras.

This separates presentation state from content: hidden cutaway walls are still
exported, while cameras, lights, helpers, annotations, and selection effects are
not. The GLTF exporter is imported only when an export is requested.

## Current engineering constraints

- Room data and AI credentials use the local browser as their persistence
  boundary. The supported local runtime supplies the AI gateway; a public
  production host still needs authentication, quotas and abuse protection.
- Snapshot normalization is handwritten rather than schema-driven.
- The procedural catalogue is intentionally small and has no external asset or
  pricing service.
- The deferred Three.js bundle is large enough for Vite to emit its standard
  chunk-size warning during production builds.

## Durable projects and portable files

`BrowserRoomProjects` owns the asynchronous UI lifecycle. The older `RoomProjects`
class remains the migration decoder for synchronous localStorage formats. The
IndexedDB repository serializes revision/name checks and writes with model binaries
and recovery metadata in one read/write transaction. Failed writes cannot mark a
room clean. Dirty comparison uses semantic key ordering.

`RoomDocumentV2` stores the snapshot and archived product metadata; assets are
referenced by SHA-256. Only compact GLBs are captured. The same blob can serve
multiple products, instances and rooms. Room-scoped product definitions flow
through the existing stable product resolver into placement, rendering, reports
and AI. Archived model URLs are local blob URLs, revoked when the room changes.
They are distinct from the live file catalogue, and stay pinned until the room is
closed. Catalogue deletion and the disposable server optimization cache cannot
remove the blobs held by saved records or recovery drafts.

Portable `.domus` ZIP files hold `room.json` and `assets/<sha256>.glb`. Imports
validate document/geometry, filenames, sizes, embedded resources and content
hashes before replacing work. Portable files have a 1 GiB limit; JSON documents
have a 16 MiB limit. Layouts support up to 2,000 placed and 2,000 unplaced items,
512 perimeter vertices/dividers/spaces, and 1,000 openings. Layout-only JSON
continues to use the version 1 envelope and requires separately available models.

The production runtime uses the same catalogue and experimental AI handlers as
Vite. It serves built assets only, pins its port, validates local Host and browser
Origin headers, and allows WebAssembly without enabling general script eval.
The optimizer and catalogue use separate process locks. Builds scan the catalogue
without changing persistent model identities. Tests use isolated roots and
synthetic products, and browser tests never share the user's origin or registry.

Compact assets use ArrayBuffer records for WebKit compatibility. A size index
lets usage and cleanup inspect metadata and keys without materializing all model
binaries. Interrupted imports retain a separate recoverable draft until the
active-tab draft commits. Closed-tab recoveries can be discarded explicitly; a
lifetime Web Lock prevents deleting another active tab's recovery.

## Reference documents and public model delivery

New `.domus` downloads and local records use document version 3 with a `domus`
catalogue namespace. Product identities combine a stable catalogue UUID and immutable
revision hash covering the viewing binary and product metadata. Opening references
pin published asset hashes. No model binaries or arbitrary fetch URLs are activated
from project files. Legacy archives are validated and matched by approved binary hash,
otherwise retained as unresolved metadata. Migration never deletes legacy browser blobs.

Publishing moves masters outside public assets and copies only derivatives to
`.domus-published`. Published revisions outlive processing cache expiry and catalogue
retirement. Public runtime reads the durable catalogue without scanning source files;
maintenance routes and source routes are unavailable. Deployments must back up and
retain this directory. Architecture GLB export always excludes the Furniture category;
PDF rendering and in-app furniture remain unchanged. There is no privileged export mode.
