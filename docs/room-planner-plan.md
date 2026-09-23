# Room Planner - Technical & Prototype Plan

## 1. Product Goal

Build a smooth, browser-based, feature-rich room planner, room builder, with a strong foundation for future AI-assisted recommendations and layout intelligence.

The application should allow users to:

- Create rooms manually by dragging walls and corners.
- Enter exact measurements when needed.
- Add doors, windows, openings, and architectural constraints.
- Place, move, rotate, align, and configure furniture using existing 3D models.
- Experience smooth snapping and placement behavior that reacts to walls and nearby objects.
- Receive deterministic layout guidance such as clearance warnings and accessibility recommendations.
- Save, reload, share, and eventually convert a design into a quote/cart.
- Add AI later without making AI responsible for geometry, measurements, or core placement logic.

## 2. Guiding Architecture Principle

The planner will be built as a **CAD-lite design engine with a web UI**, not as a normal website with a 3D viewer attached.

The system is split into four independent cores:

1. **Room Engine** - room topology, walls, openings, dimensions, floors.
2. **Placement Engine** - snapping, collisions, clearances, constraints, alignment.
3. **Rendering Engine** - Three.js scene rendering and interaction visuals.
4. **Design Intelligence Engine** - deterministic rules first, AI assistance later.

The renderer should visualize state, not own business logic.

### Product workflow separation

The user experience is deliberately split into two focused workspaces that share the same semantic project state:

1. **Build Room** - dimensions, wall manipulation, doors/windows, ceiling height, wall finish, and flooring. Furniture is hidden here so architectural editing stays calm and unambiguous.
2. **Plan Room** - product catalogue, drag/drop placement, snapping, collision response, clearance guidance, rotation, duplication, and layout work. Room geometry becomes read-only here, with a clear **Edit room** path back to the builder.

This separation is a UX decision, not a data split. Both workspaces operate on one project model, so future room scanning, AI recommendations, quoting, and collaboration can use the same underlying geometry.


## 3. Recommended Technology Stack

### Frontend

- **TypeScript** - all application and engine code.
- **React** - UI shell, panels, dialogs, product catalog, properties, project flow.
- **Vite** - development/build tooling.
- **Three.js** - 3D rendering and scene interaction.
- **WebGPU where available**, with WebGL2 fallback through Three.js.
- **Zustand** - high-level application state.
- **Immer** - ergonomic immutable state updates where useful.
- **Zod** - runtime validation for room/project/product data.

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

## 5. Coordinate & Unit Conventions

Choose conventions once and never improvise later.

Recommended:

- Internal linear unit: **meters**.
- 2D room plane: **X/Z** in 3D, but expose a consistent 2D `{x, y}` abstraction inside the room engine.
- Vertical axis: **Y**.
- Furniture origin: preferably center-bottom or another normalized origin defined by asset metadata.
- Rotation: radians internally.
- UI measurements may display mm/cm/m depending on project settings.

All imported 3D models must be normalized to the same unit convention.


## 6. Room Engine Responsibilities

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

## 7. Placement Engine Responsibilities

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

## 8. Spatial Queries & Performance

The planner should avoid comparing every object with every other object during every pointer move.

Use spatial acceleration:

- Broad-phase spatial grid, quadtree, or AABB index for nearby placed objects.
- BVH for mesh raycasting where needed.
- Lightweight footprints for most placement logic.
- Rapier colliders for precise intersection/proximity when necessary.

Use 2D footprint collision for most furniture placement because it is cheaper and more predictable than full mesh collision.

Use full 3D collision only for cases where vertical geometry matters.

## 9. Furniture/Product Metadata

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

## 10. Rules / Design Intelligence Layer

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


## 11. Future AI Architecture

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

## 12. Rendering Architecture

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

## 13. Camera & Navigation

Should include:

- Perspective 3D camera.
- Orbit.
- Pan.
- Zoom.
- Sensible target/focus behavior.
- "Focus selected" action.
- Isometric-ish default room view.

Later:

- First-person/walk mode with VR.

## 14. Input / Interaction Design

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

## 15. Undo / Redo Architecture

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


## 16. Persistence Format

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


## 17. 3D Asset Preparation Pipeline

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

## 18. Performance Targets

Targets:

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

## 19. Future Implementations

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
- VR

## 20. Key Technical Decisions

### Decision 1 - TypeScript everywhere practical

Core engine, renderer integration, UI, backend, schemas, and tooling should use TypeScript unless another language clearly provides a specialized advantage.

### Decision 2 - Three.js is a renderer, not the source of truth

The app owns semantic state.

### Decision 3 - Deterministic geometry before AI

Measurements, collisions, clearances, and valid placement must come from geometry/rules.

### Decision 4 - Product metadata is first-class

A GLB alone is insufficient for intelligent placement.

### Decision 5 - 2D logic drives most room semantics

Most room design behavior should operate on floor-plan geometry and product footprints, even when visualized in 3D.

### Decision 6 - Smoothness over visual excess in prototype

The first prototype should prioritize interaction quality over photorealistic rendering.

---

## 21. Risks to Manage Early

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

## 22. What to build next

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


## Phase 7 - architectural editor cleanup

Phase 7 keeps the two-workspace architecture and focuses on Build Room precision.

### Interaction requirements now implemented

- Screen-anchored checker/grid during direct room manipulation.
- Pointer cursor on moveable architectural targets; grabbing cursor during active drag.
- Selection-blue hover state independent of selection state.
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

## Phase 8 - coordinate and camera stabilization

Phase 8 freezes the architectural assumptions before the next core-focus milestone.

### Stable world coordinates

Room geometry is no longer normalized after direct edits. `room.width` and `room.depth` are derived bounds only; vertices may occupy negative or positive world coordinates. `scaleRoom` operates around the current room center, while `moveWall`, `moveCorner` and centered wall resizing preserve unaffected world positions. This eliminates the origin-edge failure where moving one wall translated the rest of the plan.

The 2D builder now keeps a stable drafting transform across geometry edits. Its checker is a real world-space grid (metric 0.5 m major / 0.1 m minor; imperial 1 ft major / 6 in minor), so dimensional changes visibly consume different grid distances. Auto-fit is reserved for template changes and actual viewport resize.

### Camera crossing model

The renderer no longer projects the camera away from wall geometry. Instead, wall-level visibility has a camera-crossing hysteresis zone around the 0.10 m structural core. While crossing, the complete wall assembly is hidden; once clearly on either side, regular Cutaway view classification applies. Camera coordinates remain untouched, eliminating OrbitControls jitter while still preventing the camera-inside-wall colour-fill failure.

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
