# Domus Architecture

This document describes the application as it exists today. The experimental AI
path and its stricter deployment boundary are detailed in [AI.md](AI.md).

## Runtime and dependencies

Domus is a local-first TypeScript application built with React 19 and Vite 7.
Zustand owns application state; Three.js renders the 3D workspace. A small Node
middleware plugin adds experimental AI routes to Vite's development and preview
servers. The shared UI and semantic CSS tokens have no component-framework
dependency.

There is no standalone production server, database, authentication layer,
physics engine, runtime-validation library, or provider SDK. The AI gateway uses
native `fetch` and fixed provider endpoints.

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
  objects: PlacedObject[];
}
```

- `RoomState` contains an ordered polygon, dimensions, finishes, baseboard
  settings, and lighting settings.
- Each opening belongs to a stable wall-segment ID and stores its wall offset,
  size, sill height, type, and architectural variant.
- Each placed object references a catalogue product and stores position and Y
  rotation.

Viewport mode, selections, camera preset, active snap feedback, and annotation
toggles are UI state and are not part of a saved snapshot.

AI provider/model preferences are also separate from the snapshot. Cloud
credentials are AES-GCM encrypted in IndexedDB with a browser-local,
non-exportable Web Crypto key; they never travel with room saves or GLB files.

The store normalizes loaded data, supplies defaults for fields added after an
older save, remaps known legacy product IDs, and projects furniture back into a
valid room position when possible. The active key is
`room-planner-project-v3`; two older keys remain readable.
Legacy sun-style values are also mapped to the corrected style names while
preserving the lighting each saved room displayed.

Undo and redo use cloned semantic snapshots. Continuous drags update live but
commit the state captured at pointer-down once, producing one history entry per
gesture.

## Workspaces

### Build Room

Build Room owns room topology and architectural openings. Its 2D canvas handles
wall, corner, opening, and split-wall interactions against a world-anchored
drafting grid. Wall edits preserve world coordinates; angled walls and negative
coordinates are valid.

The optional 3D preview uses the same `PlannerScene`, with furniture interaction
off and architectural picking on. It always passes `sunRays={false}`, so editing
an opening cannot create or update the directional sun-mask rig. Neutral room,
window-fill, and ceiling lighting remain active.

### Plan Room

Plan Room owns finishes, presentation, and furniture layout. The catalogue is
defined as semantic product data with dimensions, collision footprints,
interaction tags, wall affinity, and clearances. Models are currently generated
procedurally by the renderer.

Placement resolves in core code before rendering. It keeps oriented footprints
inside arbitrary room polygons, applies magnetic wall/object/centre snaps, and
checks product-specific overlap and clearance rules. Holding Shift during an
item drag permits free movement and intentional overlap.

## Geometry and architecture

`core/roomGeometry.ts` provides templates, bounds, polygon tests, wall lookup,
wall/corner movement, centred wall resizing, splitting, and room scaling.
`core/placement.ts` owns oriented footprints, snapping, collision resolution,
clearance regions, and spacing measurements. These deterministic functions are
shared by the 2D and 3D interfaces and are the authority for future automation.

Walls are rebuilt from the semantic polygon. Openings create real voids and
their frames, glazing, thresholds, and baseboard interruptions are derived from
the opening definition. Floor textures use metre-based UVs so room resizing
does not stretch them.

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
that could pre-shadow glazing on an adjacent wall. Disabling sun rays disposes
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
  boundary. AI routes exist only in Vite development and preview; a static
  production host must provide an equivalent secured gateway.
- Snapshot normalization is handwritten rather than schema-driven.
- The procedural catalogue is intentionally small and has no external asset or
  pricing service.
- The deferred Three.js bundle is large enough for Vite to emit its standard
  chunk-size warning during production builds.
