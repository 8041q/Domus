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
their dimensions. Handles translate with their leaf/jamb instead of stretching;
door handles keep their authored height where space permits. Authored depth
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
small openings can still crowd fittings: protected spans compress when they
would consume more than 80% of an axis, and handles are kept inside the aperture.
Panel textures still follow the resized surface. There is no universal
distortion-free range for arbitrary future GLBs; inspect each new asset and tune
its rules. Depth is not an editor control and is deliberately not stretched to
the wall thickness. Existing saved opening dimensions are preserved.

`openingMaterials.ts` repairs glazing exported as opaque default-metal shaders
and adjusts the affected black/coated metal finishes. Architectural materials
receive neutral reflections in both room lighting modes. These corrections are
applied to the cached runtime assets; source GLBs remain untouched and furniture
materials are unaffected.

For visual review, run the Vite development server and open
`/scripts/opening-model-review.html`. It compares source proportions/materials,
the previous whole-object scaling, and the corrected insert. Select each style,
change dimensions, reverse the view, or preview it in a temporary room. The
comparison sheet is saved in `docs/opening-model-comparisons.png`.

To add another style, put its GLB in the internal folder and add a mapping with
an optional Y-axis orientation correction. The current `double_glass_door.glb`
needs a quarter turn because its width is exported along Z. File names are kept
as supplied, including `hight_top_window.glb`.
