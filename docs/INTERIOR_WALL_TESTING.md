# Interior walls and named spaces: validation

Validated on 2 October 2026. Run the regression suite with `npm test` and the production gate with `npm run build`.

## Results

- 46 automated tests pass across `tests/interiorSpaces.test.mjs` and `tests/interiorEdgeCases.test.mjs`.
- The geometry tests include 80 reproducible crossing networks using seed `20261002`, plus room template matrices.
- TypeScript compilation and Vite production build pass. Vite still reports its large 3D bundle warning.
- The browser smoke tests passed in a separate temporary localhost tab. No warning or error logs were returned at the final check.

## Coverage

| Area | Scenarios and assertions |
| --- | --- |
| Room shapes | Rectangle, angled corner, L shape and recess; translation, rotation and reversed winding; valid chords conserve area and have interior seeds. |
| Divider networks | Physical and invisible dividers, T junctions, crossing junctions, three walls meeting at one point, corner-to-corner walls and a 64-space grid. Face counts, positive areas, unique boundary keys and stable identities are checked. |
| Invalid geometry | Missing/cyclic connections, perimeter overlap, concave-notch crossings and collinear overlap down to 6 mm are rejected; exact endpoint continuation is accepted. |
| Perimeter edits | Nested connections follow wall movement; splitting a supporting perimeter wall preserves endpoints through undo and redo; resizing retains names and finishes without a review. |
| Automatic spaces | Splits inherit their containing space’s finishes; merges, descendant removal and same-count reassignment commit immediately and remain undoable. Saves include the assigned spaces and workflow steps stay available. |
| Doors | Placement avoids solid junctions and other doors; an overfilled wall remains unchanged. Closing or moving a door occupied by furniture is rejected. |
| Furniture | Door gaps at 0°, 45° and 90°; narrow and low openings; fast drags; physical wall blocking; invisible boundary passage; spacing rays; free furniture overlap still respecting walls; valid spawning and retaining oversized items as unplaced. |
| Finishes | Per-side wall colour changes at junctions; immediately adjacent finishes in narrow spaces; threshold detection when an invisible boundary crosses a doorway; matching door material; no threshold for frame-only doors, open passages or matching finishes. |
| Rendering/export | Upward floor normals, conserved floor mesh areas, identical shared seam vertices, no duplicate slab top, interior wall materials and threshold geometry. Binary GLB is generated and inspected for named floors, interior walls and threshold nodes. |
| Editing-space placement | Furniture centres spawn in the selected space, no fallback into neighbouring spaces; oversized items remain unplaced and can be retried in another space. Selection/deselection retains the active space and additions retain the camera preset. |
| Window light | Persistent shadow geometry blocks solid walls and opaque doors while allowing passages, frame-only doors and glazed panes; invisible boundaries have no blocker. Window fill shadow maps are enabled only with physical dividers and disposed on rebuild. |
| Persistence | Decorated multi-space round trip, undo/redo, legacy single-space saves, cardinal-wall opening migration, malformed save rejection without changing the current project. |

## Browser smoke tests

1. Drew a connected interior wall; two spaces appeared immediately, with no review dialog.
2. Continued directly to Plan Room and assigned Reception wood/sage and Office terrazzo/blue. Both floors and their adjacent wall faces updated in 3D.
3. Selected each space by clicking its floor in Top view. The selected space drives Room finishes, retaining each space’s values; the panel is opened explicitly from its toolbar button.
4. Opened Design and Room finishes together. Dragged each header; closing, reopening and a full refresh restored the recorded positions. Positions are stored separately from project state.
5. Earlier architecture checks verified interior door selection/dragging from 1.90 m to 2.39 m, an invisible boundary with a clean wood/terrazzo seam, and furniture staying on its side of a solid divider.
6. Used the new top-left selector to edit Reception and Office, then added a chair and sofa to the respective spaces. Both appeared on their respective floors and Top view stayed active. Room finishes contains the space name field without a duplicate space selector.
7. A solid division between the exterior window and Office blocks direct daylight in the 3D cutaway. Selector, toolbar and the complete finishes panel fit a measured 1280 × 720 viewport; the panel has no internal overflow.

## Failures found and corrected

- Interior door clicks selected the divider before the opening hit test. Door selection now takes priority within its gap.
- The review workflow was removed following the revised UX requirement. Space metadata now commits automatically with geometry edits and uses the same undo/redo history.
- Legacy cardinal-wall doors were filtered out before migration. They now reach the migration step.
- Null anchors, invalid divider kinds, duplicate space IDs and malformed dimensions could be accepted or fail unpredictably. The load path now rejects these cases atomically.
- Collinear divider overlaps below 1 cm were accepted. Positive overlaps beyond the geometry tolerance are now rejected.
- Furniture could pass beneath openings lower than the item. Gap collision, snap, contact and spacing calculations now include furniture height.
- Wall-side finish probes could skip narrow spaces. They now sample immediately beside the centreline.
- Threshold detection looked only at a doorway's centre. It now checks each interval separated by divider junctions along the doorway.
- Furniture spawning used a swept drag from the room centre, which can lie inside a divider, and could fall back to an invalid position. New items now test destinations directly; items with no valid destination remain in the existing unplaced furniture list.
- Interior wall meshes did not cast shadows and window fill lights disabled shadows. Persistent wall shadow geometry now survives cutaways and window fill lights use shadows when physical divisions exist.

## Revised Plan Room behaviour

- New spaces inherit the containing space’s floor finish and wall colour; names are assigned automatically and edited in Plan Room.
- Space/divider updates now schedule a 3D refresh. Previously, updating space finishes changed the store but left the viewport stale.
- Direct floor clicks select the corresponding space, while orbit gestures preserve the current selection.
- The top-left editing-space selector replaces the selector in Room finishes. New furniture uses that space; selecting existing furniture follows its space. Changing space does not automatically open a panel.
- Design and Room finishes share a movable popout layout. Dragging and keyboard arrow movement persist separate panel positions; workspace resize clamps them into view. Clicking the room keeps the panels open so users can change spaces without reopening controls.
- Both panels show their full contents without internal scrolling. At a measured 1280 × 720 viewport, their complete bounds fit the workspace and content scroll heights equal content heights. Fields, colour rows and section gaps use a compact, consistent layout.

## Limits of this validation

The dense grid is a geometry correctness case, not a frame-rate benchmark. Browser checks used the local desktop browser; touch devices and other browser engines were not exercised. GLB checks inspect generated geometry and metadata, without a separate third-party viewer interoperability test.
