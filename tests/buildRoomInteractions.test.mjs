import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { createFrameQueue } = await vite.ssrLoadModule('/src/core/frameQueue.ts');
const { usePlannerStore, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { getPhysicalWalls } = await vite.ssrLoadModule('/src/core/spaces.ts');

function fakeFrames(apply) {
  const callbacks = new Map();
  let id = 0;
  const queue = createFrameQueue(apply, (callback) => { callbacks.set(++id, callback); return id; }, (id) => callbacks.delete(id));
  return { queue, callbacks, tick: () => { const batch = [...callbacks.values()]; callbacks.clear(); batch.forEach((callback) => callback(0)); } };
}

test('corner pointer bursts apply once per frame and flush the final position before history', () => {
  const store = usePlannerStore;
  store.getState().resetProject();
  const before = getSnapshot();
  let updates = 0;
  const frames = fakeFrames((x) => {
    updates++;
    store.getState().setRoomVertices(before.room.vertices.map((v, i) => i === 0 ? { ...v, x } : v));
  });
  for (let i = 0; i < 400; i++) frames.queue.push(-i / 100);
  assert.equal(updates, 0);
  assert.equal(frames.callbacks.size, 1);
  frames.tick();
  assert.equal(updates, 1);
  frames.queue.push(-4.2);
  frames.queue.flush();
  store.getState().syncSpaces(before);
  assert.equal(store.getState().room.vertices[0].x, -4.2);
  assert.equal(frames.callbacks.size, 0);
  store.getState().undo();
  assert.deepEqual(JSON.parse(JSON.stringify(getSnapshot())), JSON.parse(JSON.stringify(before)));
  store.getState().redo();
  assert.equal(store.getState().room.vertices[0].x, -4.2);
  frames.queue.push(-5);
  frames.queue.clear();
  frames.tick();
  assert.equal(updates, 2);
});

test('door flips round trip on exterior/interior walls and preserve dimensions, location and undo', () => {
  const values = new Map();
  const priorStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const store = usePlannerStore;
    store.getState().resetProject();
    store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 }, { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 });
    store.getState().selectDivider(store.getState().dividers[0].id);
    store.getState().addOpening('door');
    for (const door of store.getState().openings.filter((opening) => opening.type === 'door')) {
      store.getState().updateOpening(door.id, { doorFlipped: true });
      const flipped = store.getState().openings.find((opening) => opening.id === door.id);
      assert.deepEqual(flipped, { ...door, doorFlipped: true });
      store.getState().undo();
      assert.deepEqual(store.getState().openings.find((opening) => opening.id === door.id), door);
      store.getState().redo();
      assert.deepEqual(store.getState().openings.find((opening) => opening.id === door.id), flipped);
    }
    const saved = getSnapshot();
    store.getState().saveLocal();
    store.getState().resetProject();
    assert.equal(store.getState().loadLocal(), true);
    assert.deepEqual(getSnapshot(), saved);
    const legacy = structuredClone(saved);
    legacy.openings.forEach((opening) => delete opening.doorFlipped);
    values.set('room-planner-project-v4', JSON.stringify(legacy));
    assert.equal(store.getState().loadLocal(), true);
    assert.ok(store.getState().openings.every((opening) => !opening.doorFlipped));
    legacy.openings.find((opening) => opening.type === 'door').doorFlipped = 'yes';
    values.set('room-planner-project-v4', JSON.stringify(legacy));
    const valid = getSnapshot();
    assert.equal(store.getState().loadLocal(), false);
    assert.deepEqual(getSnapshot(), valid);
  } finally { globalThis.localStorage = priorStorage; }
});

test('all door leaves have details on both faces and flips rotate the whole assembly about its aperture', () => {
  usePlannerStore.getState().resetProject();
  usePlannerStore.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 }, { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 });
  const snapshot = getSnapshot();
  for (const wall of getPhysicalWalls(snapshot.room, snapshot.dividers).filter((wall) => wall.id === 'wall-v0-v1' || wall.id.startsWith('divider-'))) {
    for (const variant of ['single-door', 'double-door', 'glass-door', 'semi-glass-door', 'glass-double-door', 'door-frame']) {
      const door = { id: 'test-door', type: 'door', variant, wallId: wall.id, offset: wall.length / 2,
        width: variant.includes('double') ? 1.6 : 0.9, height: 2.08, sillHeight: 0 };
      const scene = Object.create(PlannerScene.prototype);
      scene.wallsGroup = new THREE.Group();
      scene.addOpeningFrame(door, { ...snapshot, openings: [door] }, 0.05);
      const normal = scene.wallsGroup.children.map((mesh) => ({ position: mesh.position.clone(), rotation: mesh.rotation.y }));
      const handles = scene.wallsGroup.children.filter((mesh) => mesh.userData.doorHandleSide);
      assert.equal(handles.length, variant === 'door-frame' ? 0 : variant.includes('double') ? 4 : 2);
      for (const side of [-1, 1]) {
        if (variant === 'door-frame') continue;
        assert.ok(handles.some((mesh) => mesh.userData.doorHandleSide === side));
        if (!variant.startsWith('glass')) assert.ok(scene.wallsGroup.children.some((mesh) => mesh.userData.doorDetailSide === side));
      }
      scene.disposeGroup(scene.wallsGroup);
      scene.addOpeningFrame({ ...door, doorFlipped: true }, { ...snapshot, openings: [door] }, 0.05);
      const centre = { x: wall.start.x + wall.tangent.x * door.offset, z: wall.start.z + wall.tangent.z * door.offset };
      scene.wallsGroup.children.forEach((mesh, i) => {
        assert.ok(Math.abs(mesh.position.x + normal[i].position.x - 2 * centre.x) < 1e-8);
        assert.ok(Math.abs(mesh.position.z + normal[i].position.z - 2 * centre.z) < 1e-8);
        assert.equal(mesh.position.y, normal[i].position.y);
        assert.ok(Math.abs(mesh.rotation.y - normal[i].rotation - Math.PI) < 1e-8);
        assert.equal(mesh.userData.domusDoorFlipped, true);
      });
      scene.disposeGroup(scene.wallsGroup);
    }
  }
});

test('opening drags stay on their wall, retain the grab offset and flush before release', () => {
  usePlannerStore.getState().resetProject();
  const before = getSnapshot();
  const opening = before.openings[0];
  const scene = Object.create(PlannerScene.prototype);
  let snapshot = before;
  let commits = 0;
  scene.bridge = { getSnapshot: () => snapshot, updateOpening: (id, patch) => {
    usePlannerStore.getState().updateOpening(id, patch, false); snapshot = getSnapshot();
  }, commitDrag: (saved) => { commits++; usePlannerStore.getState().commitSnapshot(saved); } };
  scene.openingDragging = { id: opening.id, before, grabOffset: 0.17, pointerId: 7 };
  scene.controls = { enabled: false };
  scene.renderer = { domElement: { style: {}, hasPointerCapture: () => false } };
  scene.raycaster = new THREE.Raycaster(new THREE.Vector3(opening.offset, 1.2, 1), new THREE.Vector3(0, 0, -1));
  scene.setPointer = () => {};
  scene.renderFromState = () => {};
  const frames = fakeFrames((event) => scene.moveOpening(event));
  scene.openingMoves = frames.queue;
  frames.queue.push({ pointerId: 7 });
  scene.finishOpeningDrag();
  assert.ok(Math.abs(snapshot.openings[0].offset - opening.offset - 0.17) < 1e-8);
  assert.equal(snapshot.openings[0].wallId, opening.wallId);
  assert.equal(scene.openingDragging, null);
  assert.equal(scene.controls.enabled, true);
  assert.equal(commits, 1);
  frames.tick();
  assert.equal(commits, 1);
  usePlannerStore.getState().undo();
  assert.deepEqual(JSON.parse(JSON.stringify(getSnapshot())), JSON.parse(JSON.stringify(before)));
});

test('repeated identical opening and corner samples do not notify the store', () => {
  usePlannerStore.getState().resetProject();
  const opening = usePlannerStore.getState().openings[0];
  let updates = 0;
  const unsubscribe = usePlannerStore.subscribe(() => updates++);
  for (let i = 0; i < 20; i++) {
    usePlannerStore.getState().updateOpening(opening.id, { offset: opening.offset }, false);
    usePlannerStore.getState().setRoomVertices(usePlannerStore.getState().room.vertices, 'rectangle');
  }
  unsubscribe();
  assert.equal(updates, 0);
});
