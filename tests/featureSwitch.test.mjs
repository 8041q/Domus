import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { FEATURES } = await vite.ssrLoadModule('/src/config/features.ts');
const { activeArchitecture } = await vite.ssrLoadModule('/src/core/activeArchitecture.ts');
const { usePlannerStore: store, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { architectureRoom } = await vite.ssrLoadModule('/src/core/spaces.ts');
const { overlapsInteriorWall, resolvePlacement, spacingMeasurements } = await vite.ssrLoadModule('/src/core/placement.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { BuildRoom } = await vite.ssrLoadModule('/src/BuildRoom.tsx');
const { PlanRoom } = await vite.ssrLoadModule('/src/PlanRoom.tsx');
const { returnToLayout } = await vite.ssrLoadModule('/src/ViewErrorBoundary.tsx');

function dividedProject() {
  FEATURES.interiorWalls = true;
  store.getState().resetProject();
  assert.equal(store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 }, { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 }), true);
  const id = store.getState().dividers[0].id;
  store.getState().selectDivider(id);
  store.getState().addOpening('door');
  store.getState().updateSpace(store.getState().spaces[0].id, { name: 'Reception', floorFinish: 'wood-floor-057', wallColor: '#aabbcc' });
  return getSnapshot();
}

function geometryScene(snapshot) {
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, {
    bridge: { getSnapshot: () => snapshot }, wallSpaces: undefined,
    wallsGroup: new THREE.Group(), floorGroup: new THREE.Group(), ceilingGroup: new THREE.Group(), objectGroup: new THREE.Group(), interiorViewGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(),
    spaceFloorReady: [], spaceFloorMaterials: new Set(), floorMapResults: new Map(),
    createFloorMaterial: () => new THREE.MeshStandardMaterial(), applyFloorMaps: () => {},
    loadFloorFinishMaps: async () => ({}), requestRender: () => {},
  });
  return scene;
}

test('disabled interior feature projects a single global-finish shell without changing saved data', () => {
  const before = dividedProject();
  FEATURES.interiorWalls = false;
  try {
    const projected = activeArchitecture({ ...before, selectedSpaceId: before.spaces[0].id, selectedOpeningId: before.openings.at(-1).id, interiorWallView: 'down' });
    assert.equal(projected.dividers.length, 0);
    assert.equal(projected.spaces.length, 1);
    assert.equal(projected.spaces[0].name, 'Room');
    assert.equal(projected.spaces[0].floorFinish, before.room.floorFinish);
    assert.equal(projected.spaces[0].wallColor, before.room.wallColor);
    assert.equal(projected.selectedOpeningId, null);
    assert.equal(projected.interiorWallView, 'up');
    assert.ok(projected.openings.every((opening) => !opening.wallId.startsWith('divider-')));
    assert.deepEqual(getSnapshot(), before);
    assert.equal(architectureRoom(before).dividers.length, 0);
    const scene = geometryScene(before);
    scene.rebuildWalls(scene.sceneSnapshot());
    assert.ok(!scene.wallsGroup.children.some((mesh) => mesh.userData.interiorSection));
    assert.ok(!scene.wallsGroup.children.some((mesh) => mesh.name.startsWith('Threshold')));
    assert.ok(!scene.collectExportItems().some((item) => item.id?.startsWith('divider-')));
    scene.disposeGroup(scene.wallsGroup);
    scene.disposeGroup(scene.architecturalShadeGroup);
  } finally { FEATURES.interiorWalls = true; }
  assert.equal(activeArchitecture(before), before);
  assert.deepEqual(getSnapshot(), before);
});

test('disabled feature cannot create or edit hidden divisions, spaces or interior doors', () => {
  const before = dividedProject();
  const divider = before.dividers[0];
  const door = before.openings.find((opening) => opening.wallId === divider.id);
  FEATURES.interiorWalls = false;
  try {
    assert.equal(store.getState().addDivider('open', divider.start, divider.end), false);
    assert.equal(store.getState().updateDivider(divider.id, { kind: 'open' }), false);
    store.getState().removeDivider(divider.id);
    store.getState().updateSpace(before.spaces[0].id, { name: 'Hidden mutation' });
    store.getState().selectDivider(divider.id);
    store.getState().selectSpace(before.spaces[0].id);
    store.getState().updateOpening(door.id, { offset: 1.1 });
    store.getState().removeOpening(door.id);
    assert.equal(store.getState().selectedSpaceId, null);
    assert.equal(store.getState().selectedDividerId, null);
    assert.deepEqual(getSnapshot(), before);
    store.getState().addOpening('door');
    assert.ok(!store.getState().openings.at(-1).wallId.startsWith('divider-'));
    store.getState().updateRoom({ floorFinish: 'wood-floor-057', wallColor: '#112233', height: 2.8 });
    assert.equal(activeArchitecture(getSnapshot()).spaces[0].wallColor, '#112233');
    assert.deepEqual(store.getState().spaces, before.spaces);
    assert.deepEqual(store.getState().dividers, before.dividers);
    store.getState().undo();
    assert.equal(store.getState().room.wallColor, before.room.wallColor);
    store.getState().redo();
    assert.equal(store.getState().room.wallColor, '#112233');
  } finally { FEATURES.interiorWalls = true; }
});

test('disabled feature removes interior furniture snap, spacing and insertion targets', () => {
  const snapshot = dividedProject();
  const room = { ...snapshot.room, dividers: snapshot.dividers, openings: [] };
  const object = { id: 'chair', productId: 'chair', x: 2.6, z: 0.6, rotationY: 0 };
  assert.equal(overlapsInteriorWall(object, room), true);
  FEATURES.interiorWalls = false;
  try {
    assert.equal(overlapsInteriorWall(object, room), false);
    const placed = resolvePlacement(object, object.x, object.z, room, []);
    assert.ok(!JSON.stringify(placed.snap).includes('divider-'));
    assert.ok(spacingMeasurements(object, room, []).every((measurement) => !measurement.targetId?.startsWith('divider-')));
  } finally { FEATURES.interiorWalls = true; }
});

test('disabled save/load retains named finishes and interior door data for re-enabling', () => {
  const before = dividedProject();
  const values = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  FEATURES.interiorWalls = false;
  try {
    store.getState().saveLocal();
    store.getState().resetProject();
    assert.equal(store.getState().loadLocal(), true);
    assert.deepEqual(getSnapshot(), before);
    assert.equal(activeArchitecture(getSnapshot()).dividers.length, 0);
  } finally { FEATURES.interiorWalls = true; globalThis.localStorage = previous; }
  assert.deepEqual(activeArchitecture(getSnapshot()), before);
});

test('render failures are reported and returning to 2D preserves the complete project', () => {
  const before = dividedProject();
  store.getState().setMode('plan');
  store.getState().setBuildView('3d');
  const scene = Object.create(PlannerScene.prototype);
  const failure = new Error('Simulated WebGL render failure');
  let reported;
  scene.options = { onError: (error) => { reported = error; } };
  scene.renderFrame = () => { throw failure; };
  scene.renderSafely();
  assert.equal(reported, failure);
  returnToLayout();
  assert.equal(store.getState().mode, 'build');
  assert.equal(store.getState().buildView, 'plan');
  assert.deepEqual(getSnapshot(), before);
});


test('disabled UI retains 2D height and hides interior layout, space and wall-view tools', () => {
  dividedProject();
  try {
    store.getState().setBuildView('plan');
    assert.match(renderToString(createElement(BuildRoom)), /Room height in metres/);
    FEATURES.interiorWalls = false;
    store.getState().setBuildView('plan');
    const builder = renderToString(createElement(BuildRoom));
    assert.doesNotMatch(builder, /Interior divisions|Draw a division|Space 1/);
    assert.match(builder, /Room height in metres/);
    const planner = renderToString(createElement(PlanRoom));
    assert.doesNotMatch(planner, /Editing space|Walls up|Walls down/);
    assert.match(planner, /Free cam/);
  } finally { FEATURES.interiorWalls = true; }
});

test('partial graphics initialization can be disposed once without leaking its context or canvas', () => {
  const before = dividedProject();
  const scene = geometryScene(before);
  for (const key of ['ceilingGroup', 'lightFixtureGroup', 'interiorLightGroup', 'daylightGroup', 'sunsetGroup', 'contactShadowGroup', 'objectGroup', 'helperGroup']) scene[key] = new THREE.Group();
  Object.assign(scene, { floorFinishRequest: 0, floorMapAssets: new Set(), floorMapCache: new Map(), openingMoves: { clear() {} },
    scene: new THREE.Scene(), container: { removeChild: () => calls.push('canvas') } });
  const calls = [];
  scene.renderer = { domElement: { parentNode: scene.container, removeEventListener() {} },
    dispose: () => calls.push('renderer'), forceContextLoss: () => calls.push('context') };
  // Composer, controls and ResizeObserver have not been created yet.
  const previousWindow = globalThis.window;
  globalThis.window = { removeEventListener() {} };
  try {
    scene.dispose();
    scene.dispose();
    assert.deepEqual(calls, ['renderer', 'context', 'canvas']);
    assert.equal(scene.disposed, true);
  } finally { globalThis.window = previousWindow; }
});
