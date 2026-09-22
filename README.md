# Domus - Room Planner Prototype

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
- The supplied dependency bundle was used to run a full TypeScript + Vite production build successfully after the GLB export changes.

## Blender / GLB export organization

`Export GLB` now builds a semantic export scene rather than serializing the live dollhouse view.
Camera cutaways and `helperGroup` UI are therefore irrelevant to the output.

The portable glTF hierarchy is:

```text
DomusRoom
├── Walls
│   ├── Wall 1
│   ├── Wall 2
│   └── ...
├── Floors
│   ├── Floor
│   ├── Baseboard 1
│   └── ...
├── Frames
│   ├── Window 1
│   ├── Door 1
│   └── ...
├── Ceiling
│   └── Ceiling
└── Furniture
    ├── 3-seat sofa
    └── ...
```

Every logical item receives a centred parent pivot. Leaf static meshes are also re-centred safely where possible, while multipart model hierarchy is preserved. The parent contains `domusCategory` and `domusItemId` glTF extras so downstream tools can retain semantic identity.

### Future models and ceiling lights

The exporter automatically includes new direct children added to the physical scene groups:

- `floorGroup` -> `Floors`
- `wallsGroup` -> `Walls` unless explicitly tagged as another semantic category
- `ceilingGroup` -> `Ceiling`
- `objectGroup` -> `Furniture`

A future ceiling-light fixture implemented as one `THREE.Group` under `ceilingGroup` will therefore export automatically as one multipart item. When several independent scene meshes should be treated as one logical item (as happens with wall segments, baseboard runs, and window/door frame parts), tag them with `tagExportPart`. Complete model groups can use `tagExportRoot`.


## Floor finish assets

The floor finish picker uses real PBR texture sets rather than generated canvas patterns. The persisted finish ids remain unchanged for snapshot compatibility, but the visible choices are **Wood floor**, **Floating floor**, **Dark grey carpet**, and **Vinyl**.

Each finish defines a base-colour map, OpenGL normal map, roughness map, physical texture width, source link and matte fallback in `src/core/roomFinishes.ts`. `PlannerScene` maps those textures with metre-based UVs, so changing the room dimensions does not stretch the flooring. The currently loaded maps are also used by `GLTFExporter`, keeping the Blender handoff on standard PBR material channels. Normal strength and planner environment intensity are tuned per material so the normal/roughness response reads clearly instead of every floor appearing polished.

Finish loading is atomic. Selecting another finish leaves the currently rendered floor untouched until the requested base-colour, normal and roughness maps have all settled, then swaps the channels together. On the very first load a matte representative fallback is shown immediately, never an empty/uninitialised texture. Successfully loaded texture sets are cached, so editing room geometry does not cause repeated texture flashes.

The wood, laminate and vinyl sets are CC0 assets from Poly Haven. The dark carpet keeps ambientCG Carpet 011's CC0 fibre/normal/roughness data and derives a neutral charcoal base colour from its photographic albedo. Source/licence metadata stays alongside each finish definition in code.

## Builder plan annotation layout

Builder measurements deliberately use separate visual lanes: wall length/name labels start outside the room, while the `+` split-wall controls start inside. Wall-label placement is collision-aware and scored by actual screen travel rather than a rigid horizontal-then-vertical order. Horizontal motion remains slightly cheaper, but a substantially shorter vertical or diagonal move can win. This keeps compact recesses readable without sending a label far away simply to preserve one axis.

Moved labels use a subtle leader line back to the wall. Those leaders are now part of layout geometry: a candidate is rejected when its connector would cross an already placed connector, run through another label/annotation, or when its label box would cut an existing connector. Connectors attach to the nearest edge of the label rather than its centre. In an extreme layout where no legal connector exists, the connector is omitted instead of drawing crossed lines.

Wall-label rectangles are also a hard non-overlap constraint. The layout searches the full usable viewport rather than falling back to an overlapping local candidate, and its collision rectangle is based on the measured two-line text size plus padding. If an exceptionally small viewport has literally no legal text slot, that one measurement is omitted rather than drawn over another label.

Corner handles, interior-angle text and the natural split-button positions are treated as layout blockers. Split controls then get their own collision pass, also avoid committed leader lines, and can move deeper into the room (with only a small along-wall adjustment as a last resort); hit testing uses the final drawn position. This prevents the `+` affordance and wall/angle text from occupying the same pixels in tight edge cases.

The room area is no longer painted into the top-left corner of the plan. It lives in the builder toolbar beside the 2D/3D control, so it cannot collide with walls or corner angles. Split-wall controls use one shared adaptive visibility rule for drawing and hit testing; they remain available on shorter walls than before, but still hide when there is not enough screen space between the two corner handles.
