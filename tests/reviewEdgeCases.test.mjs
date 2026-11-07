import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTestServer } from './helpers/vite.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { usePlannerStore: store, emptyRoomSnapshot, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { isPlacementValid, resolvePlacement } = await vite.ssrLoadModule('/src/core/placement.ts');
const { PRODUCTS, withRoomProducts } = await vite.ssrLoadModule('/src/core/products.ts');
const { snapshotRevision } = await vite.ssrLoadModule('/src/core/aiProposal.ts');
const state = () => store.getState();
const rugs = count => Array.from({ length: count }, (_, i) => ({ id: `rug-${i}`, productId: 'rug', x: 2.6, z: 1.9, rotationY: 0 }));

test('duplicates keep rotation, start collision-free, move normally and undo as one action', () => {
  state().openProject(emptyRoomSnapshot()); state().addObject('chair');
  state().updateObject(state().selectedId, { rotationY: Math.PI / 4 });
  const before = getSnapshot(), original = before.objects[0];
  state().duplicateSelected();
  const copy = state().objects.find(object => object.id !== original.id);
  assert.equal(copy.rotationY, original.rotationY);
  assert.equal(state().selectedId, copy.id);
  assert.equal(isPlacementValid(copy, state().room, [original]), true);
  const moved = resolvePlacement(copy, copy.x + .1, copy.z + .1, state().room, [original]);
  assert.ok(Math.hypot(moved.x - copy.x, moved.z - copy.z) > .01);
  state().undo(); assert.deepEqual(getSnapshot(), before);
  state().redo(); assert.equal(state().objects.length, 2);
});

test('a duplicate that cannot fit remains unplaced with one undo step', () => {
  state().openProject(emptyRoomSnapshot());
  withRoomProducts([{ ...PRODUCTS.chair, width: 5, depth: 3.6, collisionFootprint: { width: 5, depth: 3.6 } }], () => {
    state().addObject('chair'); const before = getSnapshot();
    state().duplicateSelected();
    assert.equal(state().objects.length, 1); assert.equal(state().unplacedObjects.length, 1);
    state().undo(); assert.deepEqual(getSnapshot(), before);
  });
});

test('all appearance edits preserve intentional overlaps, while geometry still validates', () => {
  state().openProject(emptyRoomSnapshot());
  store.setState({ objects: [{ id: 'a', productId: 'chair', x: 2, z: 2, rotationY: 0 }, { id: 'b', productId: 'chair', x: 2, z: 2, rotationY: 0 }] });
  const objects = structuredClone(state().objects);
  for (const patch of [{ wallColor: '#123456' }, { ceilingColor: '#654321' }, { floorFinish: 'wood-floor-057' }, { baseboardColor: '#112233' }, { baseboardMaterial: 'materials' }, { baseboardStyle: 'flush' }]) {
    const before = getSnapshot();
    assert.equal(state().updateRoom(patch), true);
    for (const [key, value] of Object.entries(patch)) assert.equal(state().room[key], value);
    assert.deepEqual(state().objects, objects);
    state().undo(); assert.deepEqual(getSnapshot(), before);
  }
  const before = getSnapshot();
  assert.equal(state().updateRoom({ width: 2.2 }), false);
  assert.deepEqual(getSnapshot(), before);
});

test('editing and AI respect placed and unplaced limits without consuming history on rejection', () => {
  state().openProject(emptyRoomSnapshot()); store.setState({ objects: rugs(1999) });
  state().addObject('rug'); assert.equal(state().objects.length, 2000);
  state().addObject('rug'); assert.equal(state().objects.length, 2000); assert.equal(state().unplacedObjects.length, 1);
  const before = getSnapshot();
  state().placeUnplacedObject(before.unplacedObjects[0].id); assert.deepEqual(getSnapshot(), before);
  const applied = state().applyAiProposal({ baseRevision: snapshotRevision(before), summary: 'Add rug', operations: [{ type: 'add-object', productId: 'rug', objectId: '', x: 2.6, z: 1.9, rotationDegrees: 0 }] });
  assert.equal(applied.ok, false); assert.match(applied.error, /limits/); assert.deepEqual(getSnapshot(), before);
  store.setState({ unplacedObjects: Array.from({ length: 2000 }, (_, i) => ({ id: `pending-${i}`, productId: 'rug' })), selectedId: state().objects[0].id });
  const full = getSnapshot(); state().addObject('rug'); state().duplicateSelected(); state().setRoomTemplate('l-shape');
  assert.deepEqual(getSnapshot(), full);
});
