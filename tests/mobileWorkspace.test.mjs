import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTestServer } from './helpers/vite.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { usePlannerStore: store, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { useMobileWorkspace: mobile } = await vite.ssrLoadModule('/src/mobileWorkspace.ts');

test('mobile tasks share one document and preserve selection between Plan tasks', () => {
  store.getState().resetProject();
  mobile.getState().setTask('furniture');
  assert.equal(store.getState().mode, 'plan');
  store.getState().addObject('chair');
  const selected = store.getState().selectedId, before = getSnapshot();
  mobile.getState().setTask('finishes');
  assert.equal(store.getState().selectedId, selected);
  assert.equal(mobile.getState().sheet, 'finishes');
  mobile.getState().setTask('explore');
  assert.equal(store.getState().planView, 'walk');
  assert.equal(mobile.getState().sheet, null);
  mobile.getState().setTask('furniture');
  assert.equal(store.getState().selectedId, selected); assert.equal(store.getState().planView, 'free');
  assert.deepEqual(getSnapshot(), before);
  mobile.getState().setFineSnap(true); mobile.getState().setFreeMove(true); mobile.getState().setCornerId('v0');
  assert.deepEqual(getSnapshot(), before, 'UI preferences do not enter portable snapshots');
});

test('cancelling an edit restores exact semantics without consuming the redo stack or resetting UI', () => {
  store.getState().resetProject(); store.getState().updateRoom({ height: 2.8 }); store.getState().undo();
  store.getState().setBuildView('3d'); store.getState().selectWall('wall-v0-v1');
  const before = getSnapshot();
  store.getState().updateRoom({ height: 3.1 }, false);
  store.getState().cancelInteraction({ ...before, selectedId: 'extraneous UI field' });
  assert.deepEqual(getSnapshot(), before);
  assert.equal(store.getState().selectedWallId, 'wall-v0-v1'); assert.equal(store.getState().buildView, '3d');
  store.getState().redo(); assert.equal(store.getState().room.height, 2.8);
});

test('committing a no-op scene snapshot does not add a spurious undo entry for UI fields', () => {
  store.getState().resetProject(); store.getState().updateRoom({ height: 3 });
  store.getState().commitSnapshot({ ...getSnapshot(), selectedId: 'selected-chair', measurementSystem: 'metric', showClearance: true });
  store.getState().undo(); assert.equal(store.getState().room.height, 2.6);
});

test('stale gesture cancellation cannot overwrite a replacement project', () => {
  store.getState().resetProject();
  const before = { ...getSnapshot(), projectGeneration: store.getState().projectGeneration };
  store.getState().resetProject(); store.getState().updateRoom({ height: 3.2 });
  const replacement = getSnapshot();
  store.getState().cancelInteraction(before);
  assert.deepEqual(getSnapshot(), replacement);
  store.getState().commitSnapshot(before);
  store.getState().undo(); assert.equal(store.getState().room.height, 2.6);
});

test('finish changes and history preserve an exact rotated placement in an irregular room', () => {
  store.getState().resetProject(); store.getState().setRoomTemplate('l-shape');
  store.getState().addObject('sofa'); store.getState().rotateSelected();
  const before = getSnapshot();
  assert.notEqual(before.objects[0].rotationY, 0);
  assert.equal(store.getState().updateRoom({ wallColor: '#fff6e9' }), true);
  assert.deepEqual(getSnapshot().objects, before.objects);
  store.getState().undo(); assert.deepEqual(getSnapshot(), before);
  store.getState().redo(); assert.deepEqual(getSnapshot().objects, before.objects);
});
