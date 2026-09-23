# Domus performance optimization notes

## Focus

This pass focused on the Build Room interaction path, initial loading, the 3D renderer, and resource cleanup / memory-retention risks.

## Main changes

### Build Room / 2D

- Opening drag and slider updates no longer deep-clone the whole planner state when history recording is disabled.
- Canvas backing dimensions are only changed when the actual pixel size changes, avoiding repeated buffer reallocations during redraws.
- Wall-label placement now tries a bounded local search first and falls back to the previous full search only for difficult layouts.
- Drag gestures cache the canvas bounding rectangle instead of calling `getBoundingClientRect()` on every pointer move.

### 3D renderer

- Removed deep-cloning of the room/openings/furniture snapshot from the render loop.
- Replaced the permanent 60 FPS render loop with demand-driven rendering. Rendering continues while OrbitControls are actively moving/damping, then goes idle.
- Store subscriptions only trigger 3D scene synchronization for state that can actually change the rendered scene.
- Cutaway-wall and opening-highlight work is skipped when the relevant state has not changed.
- GLTF export support is dynamically imported only when export is requested.

### Loading / bundle

- `PlanRoom` is lazy-loaded.
- `Viewport3D` (and therefore Three.js) is lazy-loaded when the 3D view is opened instead of being part of the initial Build Room load.
- The GLTF exporter is split into a separate on-demand chunk.

### Cleanup / memory-retention safeguards

- Added stronger Three.js disposal and WebGL context cleanup when the 3D viewport unmounts.
- Async floor-texture loads now detect a disposed scene and release late-arriving textures rather than retaining them.
- OrbitControls listeners, requestAnimationFrame work, ResizeObserver and store subscriptions are explicitly cleaned up.
- Toast timers are de-duplicated and cleared on application unmount.

## Validation

`npm run build` succeeds with the supplied Linux `node_modules`.

### Initial JS bundle

Baseline initial JS:
- 976.46 kB minified
- 268.52 kB gzip

Optimized initial JS:
- 293.34 kB minified
- 92.63 kB gzip

That is approximately a 70.0% minified reduction and a 65.5% gzip reduction in initial JavaScript. The Three.js viewport is now a deferred chunk and loads only when 3D is used.

### Opening-update microbenchmark

Targeted benchmark: 750 furniture objects and 3,000 non-history opening updates.

- Baseline: 1,635.11 ms (~1,835 updates/sec)
- Optimized: 47.11 ms (~63,685 updates/sec)

This is an artificial store-level benchmark, not an FPS measurement, but it demonstrates removal of the full-state clone from the live edit path.

## Browser profiling limitation

A real Chromium smoke/profile run was attempted. The managed Chromium environment in the sandbox blocks localhost/file application pages (`ERR_BLOCKED_BY_ADMINISTRATOR`), so an end-to-end browser heap snapshot could not be completed here. The static/resource-lifecycle audit found and fixed concrete retention risks, but this should not be interpreted as proof that no application-specific leak can ever occur under every browser workflow.
