# Project handling verification

Verified on 4 October 2026. `npm test`: 98 passing checks; `npm run build`: successful.

## Behaviour

- New room creates a named, empty rectangle, angled corner, L shape or recess.
  Dimensions stay in the 2D builder. Doors, furniture and interior layout are cleared.
- Save updates the active browser record. Save as creates another ID. Names are
  required, trimmed, limited to 80 characters, and unique among saved records.
- Open room lists names and last-save times. Switching projects clears selection,
  returns to Build 2D, and starts a new undo history.
- New, Open and Import protect edited layouts with Save / Discard / Cancel.
  A failed save stops replacement and leaves the layout and prior save intact.
- Each saved row has an independent delete icon and confirmation. Deleting the
  active save retains the layout and undo history as an unsaved recoverable room.
  Failed writes and changed revisions leave saved records intact. Deleting the last
  migrated room keeps the library empty rather than restoring the legacy backup.
- Ctrl/Cmd+S saves, including a dimension still being typed. Shift opens Save as.
- Room JSON backups include the name and semantic snapshot, with no AI credentials,
  view preferences or selection. Imports validate before replacing the layout and
  open as unsaved copies. Legacy single-slot saves migrate without deleting their
  original keys; legacy cardinal-wall openings remain supported.
- A recovery draft preserves saved identity, saved baseline and unsaved changes.
  Undo back to the saved snapshot clears the dirty status. Camera/UI changes do
  not mark a project dirty. Hot updates retain the active project session.
- Recovery is shared across browser tabs. Explicit record saves reject a stale
  revision after another tab updates that room; Save as can retain both versions.

## Automated cases

Named saves and copies; all New shapes; dirty tracking; recovery of edited and
never-saved rooms; full storage; conflicting tab saves; duplicate/blank names;
legacy migration; malformed files and polygons; invalid library and draft retention;
valid recovery with an unreadable library; hidden interior data round trip;
invalid opening atomicity and undo isolation; initialization around existing edits;
active/inactive deletion, recovery after deletion, failed/stale deletes and an empty
migrated library.

The AI switch is tested with SSR UI checks, a fetch guard, proposal rejection and
HTTP 503 from each local gateway route. No provider requests are made while disabled.

## Browser verification

Used an isolated origin on port 5174 to preserve the user's existing saves:

- Created Studio with an L shape, saved it, edited height, cancelled replacement,
  then saved changes before creating Lounge. Studio reopened with its saved height.
- Save as retained Lounge and Lounge alternative alongside Studio in Open room.
- A fresh page restored the unsaved Lounge draft and its project name.
- Downloaded Studio's room JSON, imported it, and checked that it was an unsaved copy.
- Invalid JSON geometry displayed an error without changing the current layout.
- Save shortcut committed an active height field; a duplicate name displayed an
  error, and a distinct name saved successfully.
- The saved six-wall layout rendered in Plan Room without console errors.
- Each saved row shows a separate trash icon. Clicking it opens confirmation
  without opening the room; Cancel retains the list and layout. Confirmation
  focuses Cancel, and the active-room message explains that its layout stays open.

Browser storage and recovery are local, not cloud backups. Clearing site data
removes them; Download room file is the portable backup mechanism.
