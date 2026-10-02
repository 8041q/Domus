import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

// Emulate Vite's retained hot.data and disposal, but evaluate the real store
// module again under a fresh URL just as a browser code update does.
let disposers = [];
let version = 0;
globalThis.__domusViewSyncHot = { data: {}, accept: () => {}, dispose: (callback) => disposers.push(callback) };
const vite = await createServer({
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent',
  plugins: [{ name: 'store-reload-test', enforce: 'pre', transform(code, id, options) {
    if (options?.ssr && /\/src\/store\.ts(?:\?|$)/.test(id)) return code.replaceAll('import.meta.hot', 'globalThis.__domusViewSyncHot');
  } }]
});
after(async () => { await vite.close(); delete globalThis.__domusViewSyncHot; });
async function reloadStore() {
  for (const dispose of disposers) dispose(globalThis.__domusViewSyncHot.data);
  disposers = [];
  return vite.ssrLoadModule(`/src/store.ts?reload=${version++}`);
}
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const geometry = await vite.ssrLoadModule('/src/core/roomGeometry.ts');
let module = await reloadStore();

function createGeometryScene(store) {
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, {
    bridge: { getSnapshot: () => store.getState() }, options: { showFurniture: false, sunRays: false },
    camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3() },
    currentCameraView: 'free', wallHiddenState: new Map(), interiorViewKey: '',
    lastRoomKey: '', lastFloorFinish: null, lastOpeningsKey: '', lastHelperKey: '', lastSnapHelperKey: '', lastSpacingHelperKey: '',
    helperGroup: new THREE.Group(), lightFixtureGroup: new THREE.Group(), floorGroup: new THREE.Group(), wallsGroup: new THREE.Group(), ceilingGroup: new THREE.Group(),
    interiorViewGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(),
    floorMapResults: new Map(), spaceFloorMaterials: new Set(), spaceFloorReady: [],
    createFloorMaterial: () => new THREE.MeshStandardMaterial(), applyFloorMaps: () => {},
    loadFloorFinishMaps: async () => ({ color: null, normal: null, height: null, roughness: null }),
    requestRender: () => {}, helperStateKey: () => '', snapHelperStateKey: () => '', spacingHelperStateKey: () => ''
  });
  for (const method of ['addFloorPerimeterShade', 'rebuildCeilingLighting', 'rebuildWindowDaylighting',
    'rebuildSunset', 'syncSunsetAngles', 'applyRoomLighting', 'updateShadowBounds', 'syncObjects',
    'syncOpeningHighlight', 'syncHelperTransforms', 'updateLightFixtureVisibility']) scene[method] = () => {};
  scene.camera.position.set(12, 12, 12);
  return scene;
}
function inspectLayout(scene) {
  const floors = scene.floorGroup.children.filter((mesh) => mesh.userData.domusSpaceId);
  let area = 0;
  for (const floor of floors) {
    const p = floor.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) area += Math.abs(
      (p.getX(i + 1) - p.getX(i)) * (p.getZ(i + 2) - p.getZ(i))
      - (p.getZ(i + 1) - p.getZ(i)) * (p.getX(i + 2) - p.getX(i))) / 2;
  }
  return { names: floors.map((mesh) => mesh.userData.domusSpaceName).sort(), area,
    dividers: [...new Set(scene.wallsGroup.children.filter((mesh) => mesh.userData.interiorSection)
      .map((mesh) => mesh.userData.cutawayWallId))].sort() };
}
function disposeScene(scene) {
  scene.disposed = true;
  for (const group of [scene.floorGroup, scene.wallsGroup, scene.ceilingGroup, scene.interiorViewGroup, scene.architecturalShadeGroup]) scene.disposeGroup(group);
}

test('Vite recognizes the project store as a hot update boundary instead of forcing a page reload', async () => {
  await vite.transformRequest('/src/store.ts');
  const node = await vite.environments.client.moduleGraph.getModuleByUrl('/src/store.ts');
  assert.equal(node.isSelfAccepting, true);
});

test('store reload keeps project, UI, existing subscribers and undo history while replacing actions', async () => {
  const old = module;
  const store = old.usePlannerStore;
  store.getState().resetProject();
  store.getState().updateRoom({ width: 6.4 });
  assert.equal(store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 },
    { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 }), true);
  store.getState().updateSpace(store.getState().spaces[0].id, { name: 'Reception', floorFinish: 'wood-floor-057' });
  store.getState().addObject('chair');
  store.getState().setMode('plan');
  store.getState().setPlanView('front');
  store.getState().setInteriorWallView('down');
  const before = old.getSnapshot();
  const references = store.getState();
  const oldUpdate = references.updateRoom;
  let observedRoom;
  const unsubscribe = store.subscribe((state) => { observedRoom = state.room; });
  module = await reloadStore();
  assert.equal(module.usePlannerStore, store);
  assert.deepEqual(module.getSnapshot(), before);
  for (const field of ['room', 'dividers', 'spaces', 'objects', 'openings']) assert.equal(store.getState()[field], references[field]);
  assert.equal(store.getState().mode, 'plan');
  assert.equal(store.getState().planView, 'front');
  assert.equal(store.getState().interiorWallView, 'down');
  assert.notEqual(store.getState().updateRoom, oldUpdate, 'Updated actions must be installed');
  module.usePlannerStore.getState().updateRoom({ height: 3.1 });
  assert.equal(old.getSnapshot().room.height, 3.1, 'An old renderer bridge must read the current project');
  assert.equal(observedRoom.height, 3.1, 'An existing subscription must still receive updates');
  store.getState().undo();
  assert.deepEqual(old.getSnapshot(), before);
  store.getState().redo();
  assert.equal(old.getSnapshot().room.height, 3.1);
  unsubscribe();
});

test('existing and remounted 3D scenes retain edited shell and divider geometry across reloads and view switches', async () => {
  const store = module.usePlannerStore;
  store.getState().resetProject();
  store.getState().updateRoom({ width: 6.4 });
  store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 },
    { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 });
  const divider = store.getState().dividers[0];
  store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v3-v0', t: 0.5 },
    { kind: 'divider', id: divider.id, t: 0.5 });
  store.getState().updateSpace(store.getState().spaces[0].id, { name: 'Reception' });
  const scene = createGeometryScene(store);
  scene.renderFromState();
  const before = inspectLayout(scene);
  assert.equal(before.dividers.length, 2);
  assert.equal(before.names.length, 3);
  assert.ok(Math.abs(before.area - 6.35 * 3.75) < 1e-5);
  module = await reloadStore();
  module.usePlannerStore.getState().updateRoom({ width: 7.6 });
  scene.renderFromState();
  assert.ok(Math.abs(inspectLayout(scene).area - 7.55 * 3.75) < 1e-5);
  for (const [mode, buildView] of [['build', '3d'], ['build', 'plan'], ['plan', 'plan'], ['build', '3d']]) {
    store.getState().setMode(mode);
    store.getState().setBuildView(buildView);
    const remounted = createGeometryScene(module.usePlannerStore);
    remounted.renderFromState();
    const layout = inspectLayout(remounted);
    assert.deepEqual(layout.names, before.names);
    assert.deepEqual(layout.dividers, before.dividers);
    const inner = remounted.insetRoomVertices(store.getState(), 0.025);
    assert.ok(Math.abs(layout.area - Math.abs(geometry.polygonArea(inner))) < 1e-5);
    disposeScene(remounted);
  }
  disposeScene(scene);
});

test('moving an opening rebuilds only its affected wall while retaining floors and other walls', () => {
  const store = module.usePlannerStore;
  store.getState().resetProject();
  const scene = createGeometryScene(store);
  scene.renderFromState();
  const opening = store.getState().openings[0];
  const floor = scene.floorGroup.children[0];
  const unrelated = scene.wallsGroup.children.filter((mesh) => mesh.userData.cutawayWallId !== opening.wallId);
  const affected = scene.wallsGroup.children.filter((mesh) => mesh.userData.cutawayWallId === opening.wallId);
  store.getState().updateOpening(opening.id, { offset: opening.offset + 0.2 }, false);
  scene.renderFromState();
  assert.equal(scene.floorGroup.children[0], floor);
  for (const mesh of unrelated) assert.equal(mesh.parent, scene.wallsGroup);
  for (const mesh of affected) assert.equal(mesh.parent, null);
  store.getState().updateOpening(opening.id, { wallId: 'wall-v3-v0', offset: 1.5 }, false);
  scene.renderFromState();
  assert.ok(scene.wallsGroup.children.some((mesh) => mesh.userData.openingId === opening.id && mesh.userData.cutawayWallId === 'wall-v3-v0'));
  assert.ok(!scene.wallsGroup.children.some((mesh) => mesh.userData.openingId === opening.id && mesh.userData.cutawayWallId === opening.wallId));
  disposeScene(scene);
});

test('interior door moves and flips replace one threshold without rebuilding other divider sections', () => {
  const store = module.usePlannerStore;
  store.getState().resetProject();
  store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 }, { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 });
  const dividerId = store.getState().dividers[0].id;
  store.getState().updateSpace(store.getState().spaces[0].id, { floorFinish: 'wood-floor-057' });
  store.getState().selectDivider(dividerId);
  store.getState().addOpening('door');
  const door = store.getState().openings.find((opening) => opening.wallId === dividerId);
  const scene = createGeometryScene(store);
  scene.renderFromState();
  const original = scene.wallsGroup.children.find((mesh) => mesh.name === `Threshold ${door.id}`);
  assert.ok(original);
  const unrelated = scene.wallsGroup.children.filter((mesh) => mesh.userData.cutawayWallId && mesh.userData.cutawayWallId !== dividerId);
  const floors = [...scene.floorGroup.children];
  for (const patch of [{ offset: door.offset + 0.2 }, { doorFlipped: true }, { doorFlipped: false }]) {
    store.getState().updateOpening(door.id, patch, false);
    scene.renderFromState();
    const thresholds = scene.wallsGroup.children.filter((mesh) => mesh.name === `Threshold ${door.id}`);
    assert.equal(thresholds.length, 1);
    assert.equal(thresholds[0].position.z, door.offset + 0.2);
    assert.deepEqual(scene.floorGroup.children, floors);
    for (const mesh of unrelated) assert.equal(mesh.parent, scene.wallsGroup);
  }
  assert.equal(original.parent, null);
  disposeScene(scene);
});
