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

## Placement / rendering hardening pass (2026-09-23)

This follow-up preserves the optimization architecture above (lazy-loaded 3D, demand-driven rendering, store subscriptions, and cleanup) while adding targeted placement correctness and image-quality improvements.

### Rotation collision

- Furniture rotation now uses an angular sweep instead of reusing the translation-only resolver.
- Large rotation jumps (including the 90° buttons) check intermediate angles, so an object cannot tunnel through a wall or another blocking object even when the final angle would be clear.
- Contact is refined with a short binary search so rotation stops close to the actual collision angle rather than backing off by the angular sample interval.
- The rotation path runs only during user rotation input; it adds no idle/per-frame work.

### Object interaction rules

- Product definitions now support semantic interaction tags and explicit overlap compatibility.
- Rugs remain non-blocking as before.
- Dining chairs can tuck into dining-table footprints, while they continue to collide with non-tuckable objects such as coffee tables.
- Support-surface metadata is present as the foundation for future vertical placement (for example books/decor on tables) without introducing a Y-position/attachment system before it is actually needed.

### Anti-aliasing

- The post-processing path applies FXAA after the composer on every display, because native renderer MSAA does not cover EffectComposer's off-screen result.
- The existing capped device-pixel-ratio supersampling remains in place, so this does not increase the base render resolution or reintroduce continuous rendering.
- The demand-driven render loop remains unchanged, so the extra fullscreen pass runs only when the scene is already being rendered.

### Validation

- `npm run build` succeeds with the supplied Linux `node_modules`.
- Targeted placement regression tests pass for wall rotation collision, intermediate-angle collision/tunnelling, chair-under-dining-table compatibility, normal blocking pairs, and rug overlap.
- Vite dev server starts successfully and returns HTTP 200 on Linux.
- Headless Chromium GPU/WebGL startup is blocked by the sandbox EGL/ANGLE environment, so visual anti-aliasing quality still requires a real browser/display check.

Bundle comparison against the optimized input project:

- Initial JS: 293.34 kB -> 294.42 kB minified (+1.08 kB); 92.63 kB -> 92.93 kB gzip (+0.30 kB).
- Deferred 3D chunk: 637.34 kB -> 643.77 kB minified (+6.43 kB); 163.74 kB -> 165.25 kB gzip (+1.51 kB), primarily the FXAA shader/pass.


## Collision/contact + annotation quality pass (2026-09-23)

This pass addresses the wall-to-wall auto-rotation edge case and tighter visual contact without changing the free-move behavior or the demand-driven rendering architecture.

### Auto-rotation and stuck-state recovery

- Wall-affinity auto-rotation now validates every small angular step against both room walls and blocking furniture before committing it.
- The wall-contact compensation translation is included in those checks, preventing a sofa from becoming microscopically embedded during a pivot.
- A bounded 2 cm recovery path allows an object that begins in a tiny legacy/rounding penetration to be pulled back out; it is intentionally too short to tunnel through real furniture.

### Collision footprints

- Product definitions can now provide an internal collision footprint independent from the nominal/displayed dimensions.
- Footprints support local X/Z offsets, so asymmetric models can collide against the part that is actually visible rather than a centered oversized rectangle.
- Sofa, armchair and dining-chair colliders were tightened to their procedural visible bases.
- Wall contact, object collision, object edge snapping and wall snapping now all use the same collision footprint data.
- The room-face allowance was reduced to 0.5 mm and the default product-product safety gap to 0.5 mm per collider test, keeping direct contact visually tight without relying on zero-tolerance floating-point contact.

### Annotation text quality

- FXAA is enabled on every screen.
- 3D measurement labels are rendered to 2x-resolution canvas textures.
- Annotation textures use trilinear mipmapping and up to 12x anisotropic filtering, which specifically improves room dimensions / spacing labels viewed at oblique angles.
- Product-dimension badges use the same higher-resolution texture path.

### Validation

- `npm run build` succeeds with the supplied Linux dependencies.
- Targeted placement checks cover asymmetric sofa bounds, manual angular collision, wall-to-wall auto-rotation beside furniture, and escaping a tiny initial penetration.
- The Vite dev server starts successfully and returns HTTP 200 in the Linux environment.
- Compared with the prior improved build, initial JS changes from 294.42 kB to 295.18 kB minified (92.93 kB to 93.27 kB gzip); the deferred 3D chunk changes from 643.77 kB to 643.91 kB minified (165.25 kB to 165.30 kB gzip).

### Annotation text / FXAA pipeline fix

Measurement glyphs remain in their existing 3D orientation (room and spacing labels stay world-aligned; product dimension badges keep their existing Sprite behavior). The text objects now render on a dedicated camera layer after the EffectComposer chain. This keeps FXAA enabled for the 3D scene and selection outline while preventing already-rasterized CanvasTexture glyphs from being filtered a second time by screen-space FXAA. The change adds no continuous render loop or extra off-screen render target; the final text composite is a small direct draw of the existing annotation meshes/sprites only when a frame is already requested.

### Annotation overlay regression fix

The first annotation-overlay implementation rendered the same Scene a second time with `renderer.autoClear = false`, but Three.js `WebGLBackground` still force-clears whenever `Scene.background` is a `Color`. That erased the already-composited 3D frame before the text-only layer was drawn. The overlay pass now temporarily suppresses only `scene.background`, explicitly renders to the default framebuffer, and restores the previous camera-layer mask/background/auto-clear state in a `finally` block. No scene geometry, controls, demand-driven scheduling, or FXAA settings were changed by this regression fix.


### Annotation and cutaway tuning (v6)

- Room/spacing labels remain line-aligned and keep the camera-dependent 180° upright flip. They now pitch only around their local X axis toward the camera; dimension lines never rotate with the text.
- Visible annotation size is controlled in `src/theme.ts` by `dimension-label-screen-px` (room/spacing) and `product-dimension-label-screen-px` (product badges). `dimension-texture-font-px` is mainly raster source quality, not the primary visible-size control.
- Cutaway side-wall hiding is controlled in `src/renderer/PlannerScene.ts` by `CUTAWAY_ENTER_FACING` and `CUTAWAY_EXIT_FACING`. Lower `CUTAWAY_ENTER_FACING` values hide walls sooner at shallow angles; `CUTAWAY_EXIT_FACING` should remain lower to retain hysteresis and avoid flicker.

## v8 camera/annotation tuning

- Room-dimension and item-spacing label screen sizes are now independent (`room-dimension-label-screen-px` and `spacing-dimension-label-screen-px`).
- Ceiling visibility in free Cutaway view mode is event-driven from camera elevation with hysteresis (11° enter / 15° exit); it does not add a continuous render loop.
- When the ceiling is visible, only the room-dimension helper group is hidden. Product dimensions, spacing, clearance, and furniture rendering are unaffected.
- Side-view presets force the ceiling on. The first actual OrbitControls camera change returns the view state to Cutaway view without snapping the camera position; low-angle automatic ceiling behavior is re-armed after the camera is raised past the exit threshold.

### Preset navigation + tighter ceiling threshold (v9)

- Front/back/left/right presets now remain active during wheel zoom and panning; only a real camera-direction change (orbit) exits to Cutaway view.
- Preset exit uses camera direction rather than mouse-button assumptions, so touch/alternate OrbitControls inputs behave consistently.
- Automatic Cutaway view ceiling thresholds are now 4° enter / 6° exit elevation, requiring a nearly horizontal view.
- No continuous render loop was added; these checks run only on existing OrbitControls render events.

## Drag interaction + live dimensions pass (2026-09-23)

- Room dimensions and product dimensions are now treated as static/object-attached helpers instead of being destroyed and recreated for every furniture position update.
- Item-spacing helpers are isolated into their own group and refresh at approximately 15 Hz during a live drag, then refresh exactly on pointer-up. Furniture meshes and object-attached product dimensions remain on the immediate render path.
- Snap guide lines update independently from measurement labels, avoiding unrelated canvas-texture/geometry churn.
- Cutaway wall transitions rebuild only room-dimension helpers rather than every active helper.
- Furniture dragging now maps screen X/Y motion into two stable room-floor axes. It no longer switches between floor/X/Z ray planes based on orbit angle, eliminating the side-view one-axis lock and the corner-grab pivot jump caused by mixing a mesh hit point with a different drag plane.
- Shift held before pointer-down starts OrbitControls rotation while preserving the selected object and its dimensions. Shift pressed after a furniture drag starts retains the existing free-move/overlap behavior.
- `npm run build` succeeds with the supplied Linux `node_modules`.
