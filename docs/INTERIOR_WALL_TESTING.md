# Interior walls and named spaces: validation

Validated on 4 October 2026. Run the regression suite with `npm test` and the production gate with `npm run build`.

## Results

- 78 automated tests pass across `tests/interiorSpaces.test.mjs`, `tests/interiorEdgeCases.test.mjs`, `tests/viewSync.test.mjs`, `tests/buildRoomInteractions.test.mjs` and `tests/featureSwitch.test.mjs`.
- The geometry tests include 80 reproducible crossing networks using seed `20261002`, plus room template matrices.
- TypeScript compilation and Vite production build pass. Vite still reports its large 3D bundle warning.
- The browser smoke tests passed in a separate temporary localhost tab. No unexpected warning or error logs were returned at the final check (the deliberately injected failure was logged as expected).

## Coverage

| Area | Scenarios and assertions |
| --- | --- |
| Room shapes | Rectangle, angled corner, L shape and recess; translation, rotation and reversed winding; valid chords conserve area and have interior seeds. |
| Divider networks | Physical and invisible dividers, T junctions, crossing junctions, three walls meeting at one point, corner-to-corner walls and a 64-space grid. Face counts, positive areas, unique boundary keys and stable identities are checked. |
| Invalid geometry | Missing/cyclic connections, perimeter overlap, concave-notch crossings and collinear overlap down to 6 mm are rejected; exact endpoint continuation is accepted. |
| Perimeter edits | Nested connections follow wall movement; splitting a supporting perimeter wall preserves endpoints through undo and redo; resizing retains names and finishes without a review. |
| Automatic spaces | Splits inherit their containing space’s finishes; merges, descendant removal and same-count reassignment commit immediately and remain undoable. Saves include the assigned spaces and workflow steps stay available. |
| Doors | Placement avoids solid junctions and other doors; an overfilled wall remains unchanged. Doors can move or be removed while furniture overlaps their divider. Exterior/interior flips preserve location and size through history/save/load. All six door variants are checked from both faces, including double/glazed leaves and frame-only passages. Flipped model metadata is present in GLB. |
| Furniture | Rotated furniture at 0°, 45° and 90°; 12 cm snap entry and 20 cm exit on either interior face; exterior snaps retain 18 mm / 21 mm; continued and fast drags across solid dividers, door gaps and invisible boundaries; wall-affinity release; exterior and product collisions; spacing rays; oversized shell placement remains unplaced. |
| Finishes | Per-side wall colour changes at junctions; immediately adjacent finishes in narrow spaces; threshold detection when an invisible boundary crosses a doorway; matching door material; no threshold for frame-only doors, open passages or matching finishes. |
| Rendering/export | Upward floor normals, complete shared seams, world-space texture UVs, no duplicate slab top, interior wall materials and threshold geometry. Floor finishes stop at the slab's inner miter edge in rotated, reversed, angled and concave rooms; a thin space under the wall produces no protruding surface. Rendered areas match the inset slab. Binary GLB is generated and inspected for named floors, clipped floor bounds, interior walls and threshold nodes. |
| Furniture placement | Insertion searches the whole shell regardless of the finish selector and prefers clear points; a narrow selected space cannot prevent adding a sofa elsewhere. Dropping furniture follows its new space, retains the camera preset and supports undo/redo and save/load. Divider-straddling furniture survives load and rotation. |
| Window light | Persistent shadow geometry blocks solid walls and opaque doors while allowing passages, frame-only doors and glazed panes; invisible boundaries have no blocker. Window fill lights/shadow maps are retained on movement and disposed when removed, disabled or the scene is disposed. |
| Interior wall views | Flat full-height or 22 cm profiles, including short and angled dividers. Cap geometry is closed, lowered lintels disappear, jambs/thresholds remain, exterior visibility stays the same, and exported walls retain full height. |
| Camera modes | Orbit from Top, Front, Back, Left and Right switches to Free cam without changing wall mode, view direction or framing. Zoom and pan preserve each preset. |
| View synchronization | Vite recognizes a self-accepting store update boundary; actual store re-evaluation retains project/UI references, subscribers and history while refreshing actions. Existing and remounted scenes retain shell areas, named floors and divider sections across reloads and view switches. |
| Build interactions | A 400-sample corner burst applies once per frame; final flush preserves undo/redo; cleared samples never apply. Opening projection retains its wall and grab offset, flushes before release, and produces one history edit. Identical samples send no store notifications. Moving/flipping an opening retains floors and unrelated walls; moving across walls cleans the old assembly; interior thresholds are replaced once without duplicates. |
| Persistence | Decorated multi-space round trip, undo/redo, legacy single-space saves, cardinal-wall opening migration, malformed save rejection without changing the current project. |

## 4 October: feature switch and view recovery

- Room height is present in Build 2D and absent in Build 3D.
- Both flag configurations compile. Disabled mode hides division drawing,
  editing-space/name controls and interior wall-view buttons. Global sage wall
  colour and wood flooring still update the whole 3D room.
- Automated checks cover disabled renderer/export geometry, furniture insertion,
  snapping/spacing targets, guarded mutations, save/load, undo/redo, and restoring
  the complete interior data when re-enabled.
- A temporary exception injected at the end of scene initialization verified the
  error controls in Build 3D and Plan Room. Returning to 2D preserved a newly
  drawn divider and both space areas. The temporary exception was removed.
- Six successive Build 2D → Build 3D → Plan Room → Build 3D cycles with an
  interior wall and door passed with no unexpected warnings/errors. Walls up/down
  worked on every cycle. Re-enabling the flag restored the same divider layout.
- The original intermittent white-page exception was not reproduced with the
  default room or the tested divider/door layouts. Failures during mount, state
  synchronization, animation, context loss, or lazy view loading now have recovery
  paths; further root-cause diagnosis needs a failing layout/error log.

## Earlier browser smoke tests

- Build Room's 2D view shows wall layout tools and no opening creation/editor;
  3D shows opening controls and no room-shape/divider drawing tools. Repeated corner
  and divider endpoint drags changed the layout and could be grabbed again.
- Added an interior door in 3D; flipped it and the existing exterior door. Moved
  the interior door and exterior window twice each; positions followed their walls.
  Selected an interior wall in 3D, added an open passage and dragged its pick surface.
  Windows are disabled for the selected interior wall. No user project was saved.
- Before the reload fix, a store code update reset the edited layout to the default
  room. With the fix, an outer wall expanded from 5.20 m to 5.80 m and two connected
  interior walls (three spaces, 22.0 m²) survive code updates in both 2D and 3D.
- Switched between Build Room 2D, Build Room 3D and Plan Room repeatedly after those
  updates. The same three-space geometry appears in all views. Undo removes the
  branch and redo restores it after the reloads; the final Plan Room scene matches.

- The Editing space list opens below its trigger (list top 133 px, trigger bottom
  121 px in the measured desktop viewport). Mouse selection, ArrowDown opening,
  ArrowUp navigation, Enter selection and Escape dismissal were verified.
- Interior wall snap tests use 12 cm entry and 20 cm release on either face;
  exterior snaps remain 18 mm / 21 mm. Shift bypasses the interior snap band,
  and doorway gaps do not attract furniture.

- Created a connected physical divider and door in a temporary localhost tab.
- Walls up renders the complete divider and door. Walls down renders only flat,
  gray capped wall sections and low jambs. Exterior cutaway behaviour stays the same.
- Added a chair from Top view, moved it to a solid section away from the door, and
  dragged through the divider in both directions. The selector follows the dropped
  item’s space; wall clearance notes still appear where appropriate.
- Orbiting Front and Right switches to Free cam while retaining Walls down. Wall
  toggles preserve the camera mode.
- All eight wall/camera buttons fit a measured 1280 × 720 viewport without scrolling
  (toolbar client width and scroll width both 614 px). Final console check returned
  no warnings or errors. Screenshots were saved for both wall modes.

## Earlier browser smoke tests (before the latest view/placement revision)

1. Drew a connected interior wall; two spaces appeared immediately, with no review dialog.
2. Continued directly to Plan Room and assigned Reception wood/sage and Office terrazzo/blue. Both floors and their adjacent wall faces updated in 3D.
3. Selected each space by clicking its floor in Top view. The selected space drives Room finishes, retaining each space’s values; the panel is opened explicitly from its toolbar button.
4. Opened Design and Room finishes together. Dragged each header; closing, reopening and a full refresh restored the recorded positions. Positions are stored separately from project state.
5. Earlier architecture checks verified interior door selection/dragging from 1.90 m to 2.39 m, an invisible boundary with a clean wood/terrazzo seam, and furniture staying on its side of a solid divider.
6. Used the new top-left selector to edit Reception and Office, then added a chair and sofa to the respective spaces. Both appeared on their respective floors and Top view stayed active. Room finishes contains the space name field without a duplicate space selector.
7. A solid division between the exterior window and Office blocks direct daylight in the 3D cutaway. Selector, toolbar and the complete finishes panel fit a measured 1280 × 720 viewport; the panel has no internal overflow.
8. Compared Cutaway and Walls down on a two-space layout with different finishes, an interior door and furniture. Cutaway shows diagonal, gray capped sections toward Reception; Walls down shows low wall stubs and door edges, retaining the threshold. Changing the selected space and camera direction updates the reveal. The exterior shell retains its established camera cutaway behavior.
9. Rechecked the revised cutaway from both oblique sides and near head-on. It shows one short return beside the rear supporting wall, then a lowered run; near head-on it flattens rather than making a central valley with raised ends.

## Failures found and corrected

- Interior door clicks selected the divider before the opening hit test. Door selection now takes priority within its gap.
- The review workflow was removed following the revised UX requirement. Space metadata now commits automatically with geometry edits and uses the same undo/redo history.
- Legacy cardinal-wall doors were filtered out before migration. They now reach the migration step.
- Null anchors, invalid divider kinds, duplicate space IDs and malformed dimensions could be accepted or fail unpredictably. The load path now rejects these cases atomically.
- Collinear divider overlaps below 1 cm were accepted. Positive overlaps beyond the geometry tolerance are now rejected.
- Snap, contact and spacing calculations account for opening height; interior walls are now soft furniture targets as requested.
- Wall-side finish probes could skip narrow spaces. They now sample immediately beside the centreline.
- Threshold detection looked only at a doorway's centre. It now checks each interval separated by divider junctions along the doorway.
- Furniture spawning used a swept drag from the room centre, which can lie inside a divider, and could fall back to an invalid position. New items now test destinations directly; items with no valid destination remain in the existing unplaced furniture list.
- Interior wall meshes did not cast shadows and window fill lights disabled shadows. Persistent wall shadow geometry now survives cutaways and window fill lights use shadows when physical divisions exist.

## Revised Plan Room behaviour

- New spaces inherit the containing space’s floor finish and wall colour; names are assigned automatically and edited in Plan Room.
- Space/divider updates now schedule a 3D refresh. Previously, updating space finishes changed the store but left the viewport stale.
- Direct floor clicks select the corresponding space, while orbit gestures preserve the current selection.
- The top-left editing-space selector replaces the selector in Room finishes and controls finish edits. Furniture insertion searches the whole shell; selection and dropping furniture follow its current space.
- Walls up and Walls down are independent of Free cam and fixed camera presets. Interior diagonal cutaways were removed at the user's request. The exterior cutaway remains unchanged.
- Furniture can overlap and cross physical dividers once the existing snap gap releases. Exterior bounds, other product collisions, wall spacing and clearance feedback remain active. Door thresholds are unchanged.
- Design and Room finishes share a movable popout layout. Dragging and keyboard arrow movement persist separate panel positions; workspace resize clamps them into view. Clicking the room keeps the panels open so users can change spaces without reopening controls.
- Both panels show their full contents without internal scrolling. At a measured 1280 × 720 viewport, their complete bounds fit the workspace and content scroll heights equal content heights. Fields, colour rows and section gaps use a compact, consistent layout.

## Limits of this validation

The dense grid is a geometry correctness case, not a frame-rate benchmark. Browser checks used the local desktop browser; touch devices and other browser engines were not exercised. GLB checks inspect generated geometry and metadata, without a separate third-party viewer interoperability test.
