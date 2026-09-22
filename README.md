# Space Studio - Room Planner Prototype

TypeScript-first browser room planner with two focused workflows:

1. **Build Room** - room geometry, dimensions and architectural openings.
2. **Furnish Room** - finishes, product placement, snapping, views and spatial guidance.

Both workflows share one semantic room state. Three.js renders that state; it is not the source of truth.


## Phase 9 - reference-style dollhouse interaction

This pass brings the 3D workspace closer to the supplied reference images/video:

- **Dollhouse dimensions** now follow the visible room silhouette: far/visible walls dimension above the wall top, while cut-away foreground walls dimension around the floor edge. Metric drafting labels use centimetres.
- **Selected products** use a crisp yellow screen-space silhouette rather than a blue bounding box.
- **Product dimensions** use a white dashed 3D measurement cage, white extension lines/anchor points, and dark centimetre badges while keeping the yellow selection outline visible.
- **Wall junctions** overlap their structural cores, finish faces and skirting slightly at true wall ends to remove hairline corner gaps in the dollhouse view.
- **Furniture dragging** is more magnetic: wall-affinity products auto-rotate and settle on the visible interior wall face, object-edge snaps have practical enter/exit hysteresis, rotated collision tests use the real oriented footprint, and Shift still provides immediate free-move/overlap.
- Perspective framing/background were tuned toward the lighter reference presentation, and furniture now exposes a move cursor while draggable.

## Phase 8 - stabilization before core-focus work

This phase intentionally adds very little surface area. It fixes coordinate-system, camera-transition and architectural-opening behavior so the next core phase can build on a predictable baseline.

### Stable room/world coordinates

- Room vertices are no longer normalized back to `(0, 0)` after every wall/corner edit.
- Moving a wall now moves **that wall**, rather than sometimes leaving the edited edge apparently fixed while the rest of the polygon translates.
- Centered wall-length edits preserve the selected wall midpoint in world space.
- Overall width/depth scaling now expands/contracts around the room center instead of rebasing the room to the origin.
- Negative world coordinates are valid; bounds are metadata rather than an implicit coordinate reset.

### Drafting grid rebuilt as a real guide

The Build Room checker is now world-anchored and represents physical dimensions:

- Metric: **50 cm major cells**, 10 cm minor lines.
- Imperial: **1 ft major cells**, 6 in minor lines.
- Direct dragging still snaps at 5 cm / 2 in by default, with Shift precision at 1 cm / 1/2 in.
- The plan viewport keeps a stable drafting scale while dimensions change, so growing a room makes it occupy more guide cells instead of automatically zooming it back to the same apparent size.
- The view is re-fit on an explicit template change or actual canvas resize, not every geometry edit.

### Persistent corner angles

Every room corner now keeps its interior-angle annotation visible. Hovering or dragging a corner promotes that label to electric cyan, but the numeric angle remains available at rest as drafting information.

### Camera / wall crossing without jitter

The previous camera fix physically pushed the camera out of the 10 cm wall core. That solved the wall-colour flood but created visible OrbitControls jitter.

Phase 8 removes camera collision entirely. Instead:

- Camera motion remains continuous.
- Each wall has a small hysteresis-based **crossing transition zone** around its structural core.
- While the camera is physically crossing that zone, the complete wall assembly is cut away temporarily.
- After the camera is clearly inside or outside, normal dollhouse cutaway logic resumes.
- Wall body, interior finish, frames and attached opening visuals share the same wall-level visibility state.

This prevents both the all-wall-colour failure and the camera snapping/jitter introduced by the earlier protection.

### Wall openings are true structural voids

Custom wall openings no longer gain a cyan translucent fill when selected. The invisible 3D picking plane remains ray-pickable but stays visually invisible at all times.

Custom openings also support smaller true custom sizes (down to 10 cm in width/height at prototype level).

### Openings now meet the floor correctly

Architectural openings now affect the wall/floor junction:

- A floor-reaching door/window/custom opening interrupts the white perimeter floor trim.
- The selected floor finish continues through the 10 cm wall thickness as a threshold/bridge.
- Skirting is interrupted whenever an opening reaches into the 7 cm footer zone, even if its bottom is slightly above floor level.
- Full-height openings already remove the wall header automatically; floor-level openings remove the lower wall segment automatically.

This means a custom opening can be a floating hole, a low opening, a floor-level passage, or a full-height passage without fake glass or a white footer running through it.

### 3D presentation

- Wall thickness remains **10 cm**.
- Structural wall body/reveals remain white; only the room-facing finish carries wall colour.
- The 3D stage background is slightly lighter (`#d6d7d4`).
- Phase 6's simpler direct-light/shadow path remains in place; no SSAO post-process was reintroduced.

## Existing Build Room baseline

- Rectangle, L-shape and recessed templates.
- Arbitrary simple polygons and angled walls.
- Direct wall and corner dragging.
- Electric-cyan hover feedback and pointer/grabbing cursors.
- Mid-wall `+` control to insert a real corner and split the wall.
- Metric / Imperial presentation.
- Up to 20 m overall span / selected-wall length.
- Per-wall length labels and `Wall N` IDs.
- Doors, windows and custom wall openings attached to semantic wall IDs.
- 2D and 3D opening dragging.
- Window/door architectural variants.

## Existing Furnish Room baseline

- Procedural placeholder furniture; GLBs are not required.
- Dollhouse, Top, Front, Right, Back and Left views.
- Sectional dollhouse cutaway.
- Direct furniture dragging and arbitrary rotation.
- Light snapping plus Shift free-move.
- Spatial wall auto-alignment.
- Deterministic collision and clearance checks.
- Optional room dimensions, product dimensions and spacing annotations.
- Gesture-level undo/redo and local save/load.

## Technology

- TypeScript
- React
- Vite
- Three.js
- Zustand

The geometry/placement model remains renderer-independent so future AI can consume deterministic room facts rather than infer geometry from pixels.

## Run

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

## Useful controls

- `Ctrl/Cmd + Z` - undo
- `Ctrl/Cmd + Y` - redo
- `R` - rotate selected furniture 90°
- `Delete` / `Backspace` - remove selected furniture
- Drag empty 3D space - orbit
- Mouse wheel / trackpad - zoom
- Hold `Shift` while dragging furniture - free movement / snapping off
- Build Room: drag walls/corners/openings directly
- Build Room: click a wall-centre `+` to create a new corner
- Build Room: Shift while drafting uses the finer snap step

## Validation performed here

- Renderer-independent geometry/units/placement modules pass strict TypeScript compilation.
- Geometry checks confirm a wall can move into negative world coordinates without rebasing the rest of the room.
- Centered wall resizing preserves the wall midpoint.
- All 14 TS/TSX files pass TypeScript syntax/transpile validation.
- The final React/Three dependency-resolved build still requires `npm install`; package-registry access is not available in this environment.
