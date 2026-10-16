# Door and window GLBs

Architectural inserts live in `public/internal/architecture/openings/`. Keep
furniture in `public/models/`; the furniture importer recursively scans only that
directory. These folders contain local assets and are ignored by Git, so copy the
architectural folder along with other public assets when deploying elsewhere.

`src/renderer/openingModels.ts` maps existing opening styles to the supplied files.
Full-height windows, solid double doors and empty door frames currently have no
replacement. They use the original generator in `PlannerScene.addOpeningFrame`,
which is retained intact. Generated geometry is also shown while an insert loads
and remains available if loading fails. Reload after supplying a missing file.

GLBs are cloned from a shared cache, rotated into the wall plane, centred, and
grounded at the opening sill. Width and height resize independently to the aperture
bounds. The supplied models use segmented geometry resizing: clear spans and
panels stretch while jambs, rails, bevels and small disconnected fittings retain
their dimensions. The entire assembly shares one continuous deformation,
including the panel cutouts behind handles and the glazing inside a leaf.
Door handles keep their physical size and follow their authored fractional
height as the door height changes. Single-leaf door handles and their surrounding
cutouts keep a fixed inset from the latch edge when widening the door. Runtime
part-name rules account for GLTFLoader's removal of punctuation from node names.
The high window protects its full nested reveal on both jambs. Authored depth
remains unchanged, including handles and projecting trim.
Door flips, cutaway visibility, selection, interior-wall lowering and the Frames
export group also apply to imported inserts. Wall cuts and the simplified sun
glazing masks still use the semantic opening dimensions/styles.

The existing editor limits remain: doors/windows are at least 0.45 m wide and
0.40 m high, their top fits below the room ceiling, and placement must clear wall
ends/corners and other openings. There is no additional GLB scale-factor cap.
Room height currently tops out at 3.3 m.

The supplied GLBs contain no animations or morph targets. Resize rules are tuned
to these nine assets, including their centre mullions and internal rails. Very
small openings can still crowd fittings: protected spans compress only when
needed to leave a small clear span, and hardware stays inside the aperture.
Panel textures still follow the resized surface. There is no universal
distortion-free range for arbitrary future GLBs; inspect each new asset and tune
its rules. Depth is not an editor control and is deliberately not stretched to
the wall thickness. Existing saved opening dimensions are preserved.

`openingMaterials.ts` repairs glazing exported as opaque default-metal shaders
and adjusts the affected black/coated metal finishes. Architectural materials
receive neutral reflections in both room lighting modes. These corrections are
applied to the cached runtime assets; source GLBs remain untouched and furniture
materials are unaffected.
Painted frames and leaves use a restrained satin finish, with polished clearcoat
removed and reduced environment reflections; hardware retains a little sheen.

Baseboards terminate at the imported frame's aperture edge. While loading or
using a generated fallback, they instead clear the generator's projecting casing.
The wall rebuild after loading updates these joins together with the frame.

Long triangles are split at the deformation boundaries before resizing, so
neighbouring panel faces, cutouts and bevels follow the same path. That topology
is prepared once and cached with the source geometry. Resizing updates positions
and transforms the authored normals; it does not recalculate smoothing across
the model's seams. No extra mesh draw calls are introduced.

Transparent architectural panes are excluded from selection outlines. Thin
panes use opacity with a single transparent pass, avoiding an extra scene render
for refraction. The
selected/hovered rendering path uses up to four MSAA samples, matching the
ordinary viewport's antialiasing without increasing pixel ratio or adding a
fullscreen antialias filter. This adds bounded work while outlines are visible;
the ordinary render path and reduced pixel budget during movement remain.

For visual review, run the Vite development server and open
`/scripts/opening-model-review.html`. It compares source proportions/materials,
whole-object scaling, and the corrected insert. Select each style,
change dimensions, inspect handle/frame close-ups, reverse the view, or preview
it selected in a temporary room. It also measures selected rendering with and
without MSAA on the local device. The
comparison sheet is saved in `docs/opening-model-comparisons.png`.
The reported stretched cases are in `docs/opening-stretched-details.png`.
The fixed latch-edge inset is shown in `docs/opening-semi-glazed-fixed.png`;
the floor-height window/baseboard joins are in `docs/opening-baseboard-review.jpg`.

To add another style, put its GLB in the internal folder and add a mapping with
an optional Y-axis orientation correction. The current `double_glass_door.glb`
needs a quarter turn because its width is exported along Z. File names are kept
as supplied, including `hight_top_window.glb`.
