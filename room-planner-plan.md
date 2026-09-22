# Room Planner — Technical & Prototype Plan

## 1. Product Goal

Build a smooth, browser-based, feature-rich room planner inspired by IKEA's manual room builder, with a strong foundation for future AI-assisted recommendations and layout intelligence.

The application should allow users to:

- Create rooms manually by dragging walls and corners.
- Enter exact measurements when needed.
- Add doors, windows, openings, and architectural constraints.
- Place, move, rotate, align, and configure furniture using existing 3D models.
- Experience smooth snapping and placement behavior that reacts to walls and nearby objects.
- Receive deterministic layout guidance such as clearance warnings and accessibility recommendations.
- Save, reload, share, and eventually convert a design into a quote/cart.
- Add AI later without making AI responsible for geometry, measurements, or core placement logic.

---

## 2. Guiding Architecture Principle

The planner will be built as a **CAD-lite design engine with a web UI**, not as a normal website with a 3D viewer attached.

The system is split into four independent cores:

1. **Room Engine** — room topology, walls, openings, dimensions, floors.
2. **Placement Engine** — snapping, collisions, clearances, constraints, alignment.
3. **Rendering Engine** — Three.js scene rendering and interaction visuals.
4. **Design Intelligence Engine** — deterministic rules first, AI assistance later.

The renderer should visualize state, not own business logic.

### Product workflow separation

The user experience is deliberately split into two focused workspaces that share the same semantic project state:

1. **Build Room** — dimensions, wall manipulation, doors/windows, ceiling height, wall finish, and flooring. Furniture is hidden here so architectural editing stays calm and unambiguous.
2. **Furnish Room** — product catalogue, drag/drop placement, snapping, collision response, clearance guidance, rotation, duplication, and layout work. Room geometry becomes read-only here, with a clear **Edit room** path back to the builder.

This separation is a UX decision, not a data split. Both workspaces operate on one project model, so future room scanning, AI recommendations, quoting, and collaboration can use the same underlying geometry.

---

## 3. Recommended Technology Stack

### Frontend

- **TypeScript** — all application and engine code.
- **React** — UI shell, panels, dialogs, product catalog, properties, project flow.
- **Vite** — development/build tooling.
- **Three.js** — 3D rendering and scene interaction.
- **WebGPU where available**, with WebGL2 fallback through Three.js.
- **Zustand** — high-level application state.
- **Immer** — ergonomic immutable state updates where useful.
- **Zod** — runtime validation for room/project/product data.

### Geometry / Interaction

- Custom TypeScript room geometry engine.
- Custom TypeScript placement/snapping engine.
- **Rapier 3D (WASM)** for collision/proximity queries where useful.
- **three-mesh-bvh** or equivalent BVH acceleration for raycasts and geometry queries.

### 3D Asset Pipeline

- Runtime format: **GLB / glTF**.
- Mesh compression: Meshopt and/or Draco.
- Texture compression: KTX2 / Basis Universal.
- Optional LOD generation for large product models.
- Separate metadata file/record per product for dimensions, snap points, clearances, category, etc.

### Backend

Prototype can initially be frontend-only with local project persistence.

Production direction:

- **Node.js + TypeScript** backend.
- REST or tRPC-style API.
- **PostgreSQL** for products, projects, users, rules, pricing, saved designs.
- S3-compatible object storage + CDN for GLB files and textures.

### Future AI Layer

- Python service only where model/tooling ecosystems require it.
- LLM/VLM API integration for conversational design assistance.
- pgvector or a dedicated vector database if semantic catalog retrieval becomes useful.
- AI must call deterministic geometry/rule functions rather than invent measurements.

---

## 4. High-Level System Design

```text
┌─────────────────────────────────────────────────────────────┐
│                      React / TypeScript UI                  │
│  Toolbar | Catalog | Properties | Measurements | Warnings  │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                         Design State                        │
│  room | openings | placed objects | selection | history    │
└──────────────┬──────────────────────┬───────────────────────┘
               │                      │
       ┌───────▼────────┐     ┌───────▼────────────┐
       │   Room Engine  │     │  Placement Engine  │
       │ topology       │     │ snapping           │
       │ dimensions     │     │ collision checks   │
       │ wall geometry  │     │ clearances         │
       │ openings       │     │ constraints        │
       └───────┬────────┘     └────────┬───────────┘
               │                       │
               └──────────┬────────────┘
                          │
               ┌──────────▼───────────┐
               │   Three.js Renderer  │
               │ WebGPU / WebGL2      │
               │ gizmos / helpers     │
               └──────────┬───────────┘
                          │
               ┌──────────▼───────────┐
               │ Design Intelligence  │
               │ deterministic rules  │
               │ AI tools later       │
               └──────────────────────┘
```

---

## 5. Core Data Model

### 5.1 Project

```ts
export interface PlannerProject {
  id: string;
  version: number;
  name: string;
  units: 'mm' | 'cm' | 'm';
  room: RoomDefinition;
  objects: PlacedObject[];
  settings: PlannerSettings;
}
```

### 5.2 Room

Represent the floor plan as a 2D planar graph.

```ts
export interface RoomVertex {
  id: string;
  x: number;
  y: number;
}

export interface WallSegment {
  id: string;
  startVertexId: string;
  endVertexId: string;
  thickness: number;
  height: number;
}

export interface RoomDefinition {
  vertices: RoomVertex[];
  walls: WallSegment[];
  openings: WallOpening[];
  floorElevation: number;
  ceilingHeight: number;
}
```

### 5.3 Openings

```ts
export interface WallOpening {
  id: string;
  wallId: string;
  type: 'door' | 'window' | 'opening';
  offset: number;
  width: number;
  height: number;
  sillHeight?: number;
}
```

### 5.4 Product Definition

A product is more than a GLB model.

```ts
export interface ProductDefinition {
  id: string;
  sku: string;
  name: string;
  category: string;
  modelUrl: string;

  dimensions: {
    width: number;
    depth: number;
    height: number;
  };

  placement: {
    mode: 'floor' | 'wall' | 'ceiling' | 'free';
    allowRotation: boolean;
    rotationStepDeg?: number;
    alignBackToWall?: boolean;
  };

  footprint: Array<{ x: number; y: number }>;
  snapAnchors: SnapAnchor[];
  clearances: ClearanceRule[];
  tags: string[];
}
```

### 5.5 Placed Object

```ts
export interface PlacedObject {
  id: string;
  productId: string;
  position: { x: number; y: number; z: number };
  rotationY: number;
  scale: { x: number; y: number; z: number };
  configuration?: Record<string, string | number | boolean>;
}
```

---

## 6. Coordinate & Unit Conventions

Choose conventions once and never improvise later.

Recommended:

- Internal linear unit: **meters**.
- 2D room plane: **X/Z** in 3D, but expose a consistent 2D `{x, y}` abstraction inside the room engine.
- Vertical axis: **Y**.
- Furniture origin: preferably center-bottom or another normalized origin defined by asset metadata.
- Rotation: radians internally.
- UI measurements may display mm/cm/m depending on project settings.

All imported 3D models must be normalized to the same unit convention.

---

## 7. Room Engine Responsibilities

The Room Engine owns:

- Room vertices.
- Wall segments.
- Wall thickness and height.
- Opening attachment and placement.
- Room closure/topology validation.
- Floor polygon generation.
- Wall mesh generation inputs.
- Measurement calculations.
- Corner behavior.
- Wall movement and resizing.
- Conversion between 2D editing space and 3D coordinates.

The Room Engine must not depend on Three.js scene objects.

### Required operations

```ts
moveVertex(vertexId, target)
moveWall(wallId, delta)
setWallLength(wallId, length)
addWall(start, end)
removeWall(wallId)
addOpening(wallId, opening)
moveOpening(openingId, offset)
resizeOpening(openingId, width, height)
getRoomPolygon()
validateRoom()
getWallNormal(wallId)
getWallLength(wallId)
```

---

## 8. Placement Engine Responsibilities

This is one of the highest-value components in the product.

It should own:

- Dragging logic.
- Candidate placement generation.
- Snap detection.
- Snap scoring.
- Snap hysteresis.
- Wall alignment.
- Object-to-object alignment.
- Edge and center alignment.
- Grid snapping where enabled.
- Collision prevention/notification.
- Placement constraints.
- Clearance checks.
- Valid/invalid placement state.

### Placement pipeline

```text
Pointer position
      ↓
Project pointer onto placement surface
      ↓
Generate raw target transform
      ↓
Query nearby walls / objects / anchors
      ↓
Generate snap candidates
      ↓
Score candidates
      ↓
Apply snap hysteresis
      ↓
Collision / constraint checks
      ↓
Resolve final transform
      ↓
Render feedback
```

### Snap candidate examples

- Back edge to wall.
- Left edge to neighboring object right edge.
- Right edge to neighboring object left edge.
- Centers aligned.
- Front faces aligned.
- Shared cabinet-module anchor points.
- Wall center.
- Corner placement.
- User grid.

### Snap hysteresis

Use separate thresholds for entering and exiting a snap state.

Example:

- Enter snap at 50 mm.
- Exit snap at 80 mm.

This prevents jitter and makes dragging feel deliberate.

### Snap scoring

A candidate score can include:

```text
score =
  distanceWeight
+ alignmentWeight
+ semanticCompatibilityWeight
+ currentSnapBonus
- collisionPenalty
```

Never rely on nearest-distance alone.

---

## 9. Spatial Queries & Performance

The planner should avoid comparing every object with every other object during every pointer move.

Use spatial acceleration:

- Broad-phase spatial grid, quadtree, or AABB index for nearby placed objects.
- BVH for mesh raycasting where needed.
- Lightweight footprints for most placement logic.
- Rapier colliders for precise intersection/proximity when necessary.

Use 2D footprint collision for most furniture placement because it is cheaper and more predictable than full mesh collision.

Use full 3D collision only for cases where vertical geometry matters.

---

## 10. Furniture/Product Metadata

Every product should have structured planner metadata.

Minimum metadata:

- SKU/product ID.
- Width/depth/height.
- Category.
- Placement mode.
- Footprint.
- Origin convention.
- Snap anchors.
- Wall affinity.
- Rotation constraints.
- Required/recommended clearance zones.
- Compatible neighboring products.
- Optional module/series information.

Example:

```json
{
  "sku": "CABINET-1200",
  "dimensions": {
    "width": 1.2,
    "depth": 0.6,
    "height": 0.9
  },
  "placement": {
    "mode": "floor",
    "alignBackToWall": true
  },
  "snapAnchors": [
    { "id": "left", "type": "product-edge", "side": "left" },
    { "id": "right", "type": "product-edge", "side": "right" },
    { "id": "back", "type": "wall", "side": "back" }
  ],
  "clearances": [
    { "side": "front", "distance": 1.0, "severity": "recommended" }
  ]
}
```

---

## 11. Rules / Design Intelligence Layer

This layer should exist before AI.

Rules should be deterministic and inspect current geometry.

Examples:

- Minimum door swing clearance.
- Recommended walking path width.
- Furniture too close to a door/window.
- Cabinet blocks another cabinet door.
- Dining table has insufficient chair clearance.
- Product exceeds wall space.
- Product collides with another object.
- Product blocks circulation route.

Example result:

```ts
export interface DesignIssue {
  id: string;
  ruleId: string;
  severity: 'info' | 'warning' | 'error';
  objectIds: string[];
  measurement?: {
    actual: number;
    recommended?: number;
    minimum?: number;
  };
  messageKey: string;
  suggestedActions?: SuggestedAction[];
}
```

Rules should return structured data rather than prose.

---

## 12. Future AI Architecture

AI will not calculate geometry itself.

It will use tools exposed by the planner engine.

Potential tools:

```ts
measureDistance(aId, bId)
getAvailableWallSpace(wallId)
getFreeFloorRegions()
getObjectClearances(objectId)
findCollisions(objectId)
findProductsThatFit(region, constraints)
findValidPlacements(productId, constraints)
moveObject(objectId, transform)
rotateObject(objectId, angle)
getDesignIssues()
optimizeLayout(criteria)
```

Example future flow:

```text
User: "Can I fit another armchair near the window?"

AI
 ↓
asks geometry engine for free space
 ↓
queries catalog for matching products
 ↓
tests valid placements
 ↓
checks clearances and collisions
 ↓
returns grounded recommendation
```

The AI should explain results generated by geometry/rules, not fabricate them.

---

## 13. Rendering Architecture

Three.js rendering should be isolated behind an adapter/service layer.

Recommended modules:

```text
renderer/
  PlannerRenderer.ts
  SceneManager.ts
  CameraController.ts
  LightingManager.ts
  AssetManager.ts
  SelectionRenderer.ts
  PlacementFeedbackRenderer.ts
  MeasurementRenderer.ts
  RoomMeshRenderer.ts
```

Scene layers/groups:

```text
scene
├── room
│   ├── floor
│   ├── walls
│   └── openings
├── products
├── interaction
│   ├── selection outlines
│   ├── gizmos
│   ├── snap indicators
│   └── collision warnings
└── helpers
    ├── measurements
    └── grid
```

---

## 14. Camera & Navigation

Prototype should include:

- Perspective 3D camera.
- Orbit.
- Pan.
- Zoom.
- Sensible target/focus behavior.
- "Focus selected" action.
- Isometric-ish default room view.

Later:

- First-person/walk mode.
- 2D top-down floor-plan mode.
- Orthographic editing camera.

---

## 15. Input / Interaction Design

Primary interactions:

### Room editing

- Select wall.
- Drag wall perpendicular to itself.
- Drag corner/vertex.
- Type exact wall length.
- Add/remove wall.
- Add door/window.
- Drag opening along wall.

### Product placement

- Drag product from catalog into room.
- Preview footprint before drop.
- Snap to wall/object.
- Rotate using handle or keyboard shortcut.
- Nudge using keyboard arrows.
- Duplicate/delete.

### Selection feedback

- Selected outline.
- Bounding rectangle/footprint.
- Rotation handle.
- Dimension hints.
- Active snap indicator.
- Collision/clearance warning visualization.

---

## 16. Undo / Redo Architecture

Do not implement undo by cloning the entire Three.js scene.

Use a command/history system over application state.

Examples:

```ts
interface Command {
  execute(): void;
  undo(): void;
}
```

Commands might include:

- MoveObjectCommand.
- RotateObjectCommand.
- AddObjectCommand.
- RemoveObjectCommand.
- MoveWallCommand.
- ResizeOpeningCommand.

Continuous drags should collapse into one history entry from drag start to drag end.

---

## 17. Persistence Format

Saved projects should contain semantic data, not renderer internals.

Store:

- Room graph.
- Openings.
- Product references.
- Object transforms.
- Product configuration.
- Planner version.

Do not store:

- Three.js Object3D serialization.
- Runtime meshes.
- GPU data.

Version the project schema from day one to allow migrations later.

---

## 18. 3D Asset Preparation Pipeline

Before importing products into the planner, validate:

1. GLB/glTF format.
2. Real-world dimensions.
3. Correct orientation.
4. Standardized origin/pivot.
5. Material compatibility.
6. Triangle count.
7. Texture size.
8. Normal/tangent correctness.
9. No unnecessary hidden geometry.
10. Proper naming of configurable parts if needed.

Recommended output:

```text
product-id/
├── model.glb
├── thumbnail.webp
├── metadata.json
└── optional-lods/
```

An automated validation/conversion script should eventually produce warnings for invalid assets.

---

## 19. Performance Targets

Prototype targets:

- 60 FPS during common interactions on a modern laptop.
- Drag latency should feel immediate.
- Room wall edits update within one animation frame where possible.
- Product snapping should not trigger expensive full-scene operations.
- GLB assets loaded asynchronously and cached.

Production targets should include mobile/tablet testing.

Performance strategies:

- Avoid React re-rendering every pointer frame.
- Keep transient drag state inside engine/controller layers.
- Commit final transforms to application state at appropriate intervals/end of gesture.
- Use instancing for repeated simple geometry when possible.
- Use LODs for complex products.
- Compress textures and geometry.
- Use footprints/AABBs for broad-phase queries.

---

## 20. Suggested Repository Structure

```text
room-planner/
├── apps/
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── components/
│       │   ├── features/
│       │   └── main.tsx
│       └── ...
│
├── packages/
│   ├── core/
│   │   ├── room/
│   │   ├── placement/
│   │   ├── geometry/
│   │   ├── rules/
│   │   ├── history/
│   │   └── project/
│   │
│   ├── renderer-three/
│   │   ├── scene/
│   │   ├── room/
│   │   ├── products/
│   │   ├── interaction/
│   │   └── measurements/
│   │
│   ├── product-schema/
│   │
│   └── shared/
│
├── assets/
│   └── sample-products/
│
└── tooling/
    └── asset-pipeline/
```

A monorepo layout is recommended so the geometry/placement engine remains cleanly separated from the React app and Three.js renderer.

---

## 21. Prototype Scope — Phase 1

The first prototype should intentionally be narrow.

### Must have

1. Launch with a rectangular room.
2. Render walls and floor in 3D.
3. Orbit/pan/zoom camera.
4. Select a wall.
5. Drag a wall to resize room.
6. Drag room corner/vertex.
7. Display live dimensions.
8. Load at least 2–3 GLB furniture models.
9. Drag/place furniture on floor.
10. Move existing furniture with mouse.
11. Rotate furniture.
12. Snap furniture back edge to a wall.
13. Snap furniture edges to nearby furniture.
14. Prevent/indicate obvious collisions.
15. Show snap feedback visually.
16. Undo/redo object movement and wall edits.
17. Save/load project JSON locally.

### Nice to have in prototype

- Add a door.
- Add a window.
- Simple clearance zone visualization.
- 2D top-down toggle.
- Keyboard nudging.
- Duplicate selected product.

### Explicitly not needed in the first prototype

- Authentication.
- Ecommerce integration.
- AI.
- Multiplayer collaboration.
- Photorealistic lighting.
- AR.
- Photo scanning.
- Large product catalog.
- Final production UI design.

---

## 22. Prototype Milestones

### Milestone 1 — Engine Skeleton

Deliverables:

- TypeScript monorepo.
- Core data schemas.
- Room graph model.
- Basic project state.
- Unit conventions.
- Tests for geometry helpers.

Success criterion:

A rectangular room can be represented, mutated, serialized, and validated without rendering.

### Milestone 2 — 3D Room Editing

Deliverables:

- Three.js renderer.
- Floor and wall geometry.
- Camera controls.
- Wall/vertex picking.
- Wall and corner dragging.
- Dimension labels.

Success criterion:

User can reshape a room smoothly with the mouse.

### Milestone 3 — Product Placement

Deliverables:

- GLB loading.
- Product metadata.
- Product selection.
- Product dragging.
- Rotation.
- Basic wall snapping.

Success criterion:

User can place and move real product models naturally.

### Milestone 4 — Smart Snapping

Deliverables:

- Nearby-object spatial search.
- Object-to-object snapping.
- Snap scoring.
- Snap hysteresis.
- Collision detection.
- Placement feedback.

Success criterion:

Moving furniture feels stable, predictable, and polished rather than jittery.

### Milestone 5 — Rules & Persistence

Deliverables:

- Clearance rules.
- Warning visualization.
- Undo/redo.
- Project save/load.
- Versioned schema.

Success criterion:

Prototype behaves like the foundation of a real planner rather than a rendering demo.

---

## 23. Testing Strategy

### Unit tests

Focus heavily on:

- Segment math.
- Wall lengths/normals.
- Polygon generation.
- Footprint overlap.
- Snap scoring.
- Snap hysteresis.
- Clearance calculations.
- Serialization/migrations.

### Integration tests

- Move wall and verify dependent geometry.
- Place furniture and snap to wall.
- Move two objects together and verify snap behavior.
- Collision response.
- Undo/redo sequence.
- Save/load project integrity.

### Interaction tests

Automated browser tests can later verify:

- Dragging.
- Selection.
- Keyboard controls.
- Dialogs and property editing.

---

## 24. Key Technical Decisions

### Decision 1 — TypeScript everywhere practical

Core engine, renderer integration, UI, backend, schemas, and tooling should use TypeScript unless another language clearly provides a specialized advantage.

### Decision 2 — Three.js is a renderer, not the source of truth

The app owns semantic state.

### Decision 3 — Deterministic geometry before AI

Measurements, collisions, clearances, and valid placement must come from geometry/rules.

### Decision 4 — Product metadata is first-class

A GLB alone is insufficient for intelligent placement.

### Decision 5 — 2D logic drives most room semantics

Most room design behavior should operate on floor-plan geometry and product footprints, even when visualized in 3D.

### Decision 6 — Smoothness over visual excess in prototype

The first prototype should prioritize interaction quality over photorealistic rendering.

---

## 25. Risks to Manage Early

### Asset inconsistency

Different model scales, pivots, and orientations can make placement logic unreliable.

Mitigation: normalize assets and enforce a strict metadata schema.

### Snapping becomes overly aggressive

Too many snap targets can make furniture difficult to control.

Mitigation: score candidates, use semantic filters, and implement hysteresis.

### React performance issues

Updating React state on every pointer movement can cause unnecessary rerenders.

Mitigation: transient interaction state lives outside React render flow.

### Overusing physics

Physics engines may produce game-like behavior rather than design-tool behavior.

Mitigation: use physics for queries, not for deciding furniture motion.

### Mixing geometry and rendering

If room logic depends on Three.js meshes, future AI, 2D mode, testing, and backend validation become harder.

Mitigation: keep geometry/core packages renderer-independent.

---

## 26. What We Should Build Next

The next implementation step should be a **small but real vertical slice**:

1. Create TypeScript/Vite/React project.
2. Add Three.js renderer.
3. Create a rectangular room from semantic room data.
4. Generate floor + four walls.
5. Add camera controls.
6. Add wall picking.
7. Drag one wall and regenerate the room live.
8. Add a simple box representing furniture.
9. Drag the box on the floor.
10. Snap the box to walls.

Only after this interaction feels solid should we introduce real GLB assets and more advanced object-to-object snapping.

---

## 27. Prototype Success Definition

The first prototype is successful when a user can:

> Open the planner, resize a room naturally by dragging its walls, place furniture, move and rotate it smoothly, feel it snap predictably to walls and nearby objects, receive simple collision/clearance feedback, undo mistakes, and save the design.

If that feels polished, the architecture is ready for doors/windows, configurable products, larger catalogs, layout rules, and eventually AI-assisted design.



---

## 28. Phase 3 Implementation Status — Completed

The prototype has now moved beyond a rectangular-room assumption.

Implemented:

- Orthogonal polygon room model with stable vertex and wall-segment IDs.
- Rectangle, L-shape, and recessed-room templates.
- Direct wall dragging with 90° topology preserved.
- Direct corner dragging with adjacent walls updated together.
- 5 cm drag grid plus 1 cm precision modifier.
- Per-wall dimensions and exact selected-wall length editing.
- Real polygon area calculation.
- Openings attached to arbitrary wall segment IDs.
- Opening migration from the previous north/east/south/west representation.
- True polygon floor geometry in Three.js.
- Procedural 3D walls and opening holes for non-rectangular rooms.
- Furniture placement constrained to the actual room polygon.
- Wall snapping based on real segment geometry and inward normals.
- V3 local project persistence with migration from earlier prototype formats.

This completes the originally planned room-geometry milestone at prototype quality.

### Next engineering phase

The next phase should deepen **semantic behaviour**, not simply add more visual controls:

1. Door hinge/swing semantics and swept-area clearance.
2. Product snap anchors and relationship rules.
3. Wall-affinity auto-orientation and mounting constraints.
4. Walkability/path-width analysis.
5. Deterministic room diagnostics that can later be exposed as AI tools.
6. GLB asset adapter with metadata validation and procedural fallback models.

The guiding rule remains: deterministic spatial reasoning first; AI explanations and recommendations second.


---

## Phase 4 precision pass — implemented

The fourth prototype phase refines control quality rather than adding broad scope. Furnishing now uses one 3D workspace with Dollhouse/Top/Front/Back/Left/Right camera presets. The dollhouse cutaway is camera-aware, furniture snapping uses much smaller type-specific capture/release zones, selected furniture has continuous rotation with magnetic 90° stops, and finishes have moved from room construction into furnishing.

Build Room now supports a Metric/Imperial display preference, a 20 m maximum span, per-wall length sliders, subtle Wall N labels beside dimensions, and human-readable Door N / Window N identifiers. Door/window position previews are animation-frame-coalesced, while the renderer rebuilds walls/openings independently from the floor to reduce slider jank.

The underlying architectural decisions remain unchanged: metres/radians are canonical internally, user units are presentation-only, room geometry is a semantic polygon with arbitrary straight wall angles, openings refer to stable wall IDs, and AI remains downstream of deterministic geometry/rule APIs.


---

## Phase 5 precision & presentation pass — implemented

The fifth prototype phase further reduces magnetic snapping and changes the free-movement modifier to **Shift** across platforms. Snap capture/release thresholds are now intentionally small, and spatial wall auto-alignment only applies to wall-affinity products that are already approximately facing the wall.

The clearance model was replaced with oriented product-relative geometry. A product's front/back/side use space now rotates with the product and is checked using oriented polygons. The furnishing renderer also exposes optional room dimensions, 3D product W/D/H dimensions, and ray-based nearest item/wall spacing measurements.

The dollhouse renderer now uses actual sectional hiding instead of opacity fading: foreground wall geometry and all attached opening visuals disappear together. Wall thickness, white skirting/perimeter trim and a shallow floor slab improve the physical cutaway read. Lighting uses a neutral darker background, image-based room-environment lighting, soft shadows and screen-space ambient occlusion to improve contact and depth cues.

The next precision work should focus on semantic object relationships, oriented collision response, door swing geometry and walkability rather than adding more broad UI modes.


---

## Phase 6 cleanup & precision pass — implemented

Phase 6 deliberately narrows the focus to control quality, geometry generalization and rendering stability.

### Placement interaction

Snap capture zones have been reduced again and snap hysteresis is now minimal. Wall/object/centre assists engage only at very small distances, while the raw pointer target continues to determine when an existing snap releases. Product dragging preserves the original grab offset rather than recentering the product under the pointer. **Shift** is the universal furnish-mode precision override: while held it disables axis snapping, spatial wall auto-alignment and collision push-out immediately, and the UI explicitly reports that free-move mode is active.

### Arbitrary wall angles

The room geometry core now validates general simple polygons instead of requiring orthogonal segments. Corner dragging can create angled walls, moving a wall translates its complete segment parallel to its normal, and exact wall resizing follows the current wall tangent. Derived wall tangents/inward normals remain the single source used by openings, 3D wall generation, dimensions, cutaway logic and spatial wall alignment.

### Physical room section

Wall thickness is standardized at **0.10 m**. The wall body/core is always white, with room colour applied as a thin interior finish plane. The structural floor slab and per-wall footing overlap the wall footprint so the floor and walls read as a connected assembly. This also gives cutaway edges a clean white sectional border.

### Rendering and performance

The full-screen SSAO pass introduced in Phase 5 has been removed because it added substantial GPU cost and could produce visible wall banding. The direct Three.js render path now uses neutral environment illumination, restrained ambient/fill lighting, a firmer 2048² PCF directional shadow and shadow bounds sized to the active room. The stage background is a lighter neutral grey. State-to-scene synchronization during interaction is coalesced to one update per animation frame.

### Drafting overlays

Room dimensions are elevated above wall tops and use plain inline drafting text. Product W/D/H annotation uses a dashed 3D wireframe and suppresses the legacy selection box while active. Item spacing is calculated and rendered as world-axis unidirectional measurements, keeping the annotations stable as the product rotates. Clearance visualization uses separate semantic front/back/left/right bands rather than an oversized aggregate rectangle.

### Rotation

The continuous rotation slider uses 0.1° values, with a narrower magnetic capture around 90° stops. Because physical slider width still limits pointer precision, an exact 0.1° numeric field is provided beside it. Both controls still commit as a single history gesture.

The architecture remains TypeScript-first, with metres/radians canonical internally and deterministic geometry/rules upstream of any future AI recommendation layer.

---

## Phase 7 — architectural editor cleanup

Phase 7 keeps the two-workspace architecture and focuses on Build Room precision.

### Interaction requirements now implemented

- Screen-anchored checker/grid during direct room manipulation.
- Pointer cursor on moveable architectural targets; grabbing cursor during active drag.
- Electric-cyan hover state independent of selection state.
- Live interior-angle readout while moving corners, including reflex angles.
- Mid-wall split handles that insert a semantic vertex and remap openings from the old wall ID onto the new wall segments.
- Selected-wall numeric/slider resizing around the wall midpoint.

### Opening model extension

`RoomOpening` now carries both a broad type (`window | door | opening`) and an architectural variant. Variants currently cover single/double/high/full-height/sliding glazing, single/double/frame/glass doors and a custom wall opening.

The renderer uses the same opening object to generate frames, glazing, panels or an intentionally empty opening. No architectural variant is encoded only in Three.js geometry.

### 3D architecture interaction

Build Room's Three.js viewport can ray-pick opening geometry. An opening drag projects the pointer against visible wall planes and updates `wallId + offset` in semantic state. Width/height/style edits continue through the shared opening inspector.

### Construction model correction

Walls are 0.10 m thick and centred on the semantic room perimeter. The structural mesh is white; room colour is a thin interior finish surface positioned on the interior wall face. The floor/slab overlaps the interior half of the wall core, preventing a visible zero-thickness seam.

### Camera wall protection

The renderer checks the camera against wall segments before each render. If the camera falls inside the wall-core band, it is projected to a safe side of the wall. This prevents inside-wall back-face behaviour from tinting/flooding the viewport.

---

## Phase 8 — coordinate and camera stabilization

Phase 8 freezes the architectural assumptions before the next core-focus milestone.

### Stable world coordinates

Room geometry is no longer normalized after direct edits. `room.width` and `room.depth` are derived bounds only; vertices may occupy negative or positive world coordinates. `scaleRoom` operates around the current room center, while `moveWall`, `moveCorner` and centered wall resizing preserve unaffected world positions. This eliminates the origin-edge failure where moving one wall translated the rest of the plan.

The 2D builder now keeps a stable drafting transform across geometry edits. Its checker is a real world-space grid (metric 0.5 m major / 0.1 m minor; imperial 1 ft major / 6 in minor), so dimensional changes visibly consume different grid distances. Auto-fit is reserved for template changes and actual viewport resize.

### Camera crossing model

The renderer no longer projects the camera away from wall geometry. Instead, wall-level visibility has a camera-crossing hysteresis zone around the 0.10 m structural core. While crossing, the complete wall assembly is hidden; once clearly on either side, regular dollhouse cutaway classification applies. Camera coordinates remain untouched, eliminating OrbitControls jitter while still preventing the camera-inside-wall colour-fill failure.

### Openings and floor junction

Custom wall openings use an invisible ray-pick surface that never gains visible selection opacity. Floor-reaching openings interrupt perimeter trim and receive a floor-finish threshold through the wall thickness. Skirting is clipped whenever an opening overlaps the footer zone. Floating, floor-level and full-height custom voids therefore all derive from the same semantic opening geometry without fake glass or decorative inserts.

### Preparation for the next core phase

The next major work should assume these invariants:

1. World coordinates are stable and never implicitly rebased by editing.
2. Room bounds are derived metadata, not an origin convention.
3. Every wall/opening relation is semantic and renderer-independent.
4. Camera traversal is visual/cutaway behavior, not physics collision.
5. Architectural openings own their wall, vertical extent and floor-junction effects.
6. The drafting grid represents real units and can be trusted as a spatial reference.
