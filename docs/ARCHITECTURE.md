# Domus Architecture

This document describes the application as it exists today. Planned AI work is
kept separately in [AI.md](AI.md).

## Runtime and dependencies

Domus is a client-only TypeScript application built with React 19 and Vite 7.
Zustand owns application state; Three.js renders the 3D workspace. The shared UI
components and semantic CSS tokens are implemented in the repository without a
component-framework dependency.

There is currently no server, database, authentication layer, physics engine,
runtime validation library, or AI SDK.

```text
React workspaces
      │ commands and selectors
      ▼
Zustand store ── snapshot history / browser save
      │ PlannerSnapshot
      ├──────────────► 2D canvas
      └──────────────► PlannerScene / Three.js ──► WebGL
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

The store normalizes loaded data, supplies defaults for fields added after an
older save, remaps known legacy product IDs, and projects furniture back into a
valid room position when possible. The active key is
`room-planner-project-v3`; two older keys remain readable.

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

- **Paired Shadows** uses equal-energy crisp and soft directional suns whose
  azimuths remain 2° apart while the controls orbit the pair.
- **Cinematic Grade** keeps the same direct suns and adds a subtle procedural
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

- The app is frontend-only and trusts the local browser as its persistence
  boundary.
- Snapshot normalization is handwritten rather than schema-driven.
- The procedural catalogue is intentionally small and has no external asset or
  pricing service.
- The deferred Three.js bundle is large enough for Vite to emit its standard
  chunk-size warning during production builds.
