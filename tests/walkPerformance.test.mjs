import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { createTestServer } from './helpers/vite.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { roomTemplate, getRoomWalls } = await vite.ssrLoadModule('/src/core/roomGeometry.ts');

function renderFixture(view) {
  const calls = { renders: [], helpers: [], clipping: 0, ceiling: 0, cutaway: 0, requested: 0 };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, {
    disposed: false, stateSyncPending: false, animationFrame: 1, firstFrameRendered: true,
    currentCameraView: view, restingPixelRatio: 1, controlsInteracting: false,
    camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(),
    outlinePass: { selectedObjects: [] },
    renderer: {
      autoClear: true, getPixelRatio: () => 1,
      render(_scene, camera) { calls.renders.push(camera.layers.mask); },
      setRenderTarget() {}
    },
    controls: { update: () => false }, walkControls: { update: () => false },
    requestRender() { calls.requested++; },
    updateCameraClipping() { calls.clipping++; },
    updateCeilingVisibility() { calls.ceiling++; },
    updateCutawayWalls() { calls.cutaway++; }
  });
  for (const name of ['layoutArchitectureSpacing', 'updateMeasurementLabelOrientation', 'updateMeasurementLabelScale',
    'updateMeasurementLineGaps', 'updateSpacingMeasurementLines']) scene[name] = () => calls.helpers.push(name);
  return { scene, calls };
}

test('Walk renders one scene pass without hidden helper layout or camera-dependent presentation work', () => {
  const { scene, calls } = renderFixture('walk');
  scene.controls.update = () => { throw new Error('Orbit controls must stay idle during Walk'); };
  scene.renderFrame();
  assert.deepEqual(calls.renders, [1], 'the hidden annotation layer does not need a second scene render');
  assert.deepEqual(calls.helpers, [], 'hidden dimensions must not project labels and rebuild line gaps');
  assert.equal(calls.clipping, 0, 'the enclosing Walk clipping range remains valid throughout the room');
  assert.equal(calls.ceiling, 0, 'the Walk ceiling is fixed until architecture changes');
  assert.equal(calls.requested, 0, 'an idle Walk does not request another animation frame');
});

test('planner views retain helper layout, cutaway updates and the annotation overlay', () => {
  const { scene, calls } = renderFixture('free');
  scene.renderFrame();
  assert.deepEqual(calls.renders, [1, 2]);
  assert.equal(calls.helpers.length, 6);
  assert.equal(calls.clipping, 1); assert.equal(calls.ceiling, 1); assert.equal(calls.cutaway, 1);
  assert.equal(calls.requested, 0);
});

test('sparse Walk motion keeps render quality steady until the final idle frame', (t) => {
  let now = 0, moving = true, ratio = 1.6;
  t.mock.method(performance, 'now', () => now);
  const { scene, calls } = renderFixture('walk');
  const rendererRatios = [], composerRatios = [];
  scene.restingPixelRatio = ratio;
  scene.renderer.getPixelRatio = () => ratio;
  scene.renderer.setPixelRatio = (value) => { ratio = value; rendererRatios.push(value); };
  scene.composer = { setPixelRatio: (value) => composerRatios.push(value) };
  scene.walkControls.update = () => moving;
  scene.renderFrame();
  assert.equal(ratio, 1);
  moving = false; now = 16; scene.renderFrame();
  assert.equal(ratio, 1, 'an intervening frame without a pointer event does not resize GPU buffers');
  moving = true; now = 33; scene.renderFrame();
  moving = false; now = 49; scene.renderFrame();
  now = 116; scene.renderFrame();
  assert.deepEqual(rendererRatios, [1], 'a later pointer sample extends the settling interval');
  const scheduled = calls.requested;
  now = 134; scene.renderFrame();
  assert.deepEqual(rendererRatios, [1, 1.6]);
  assert.deepEqual(composerRatios, rendererRatios);
  assert.equal(calls.requested, scheduled, 'the full-quality final frame stops requesting more frames');
  now = 150; scene.renderFrame();
  assert.deepEqual(rendererRatios, [1, 1.6]);
  assert.equal(calls.requested, scheduled);
});

test('ordinary Walk frames skip architecture projection and traversal; forced updates still reveal rebuilt walls', () => {
  const room = { vertices: roomTemplate('rectangle', 6, 5), height: 2.6 };
  const snapshot = { room, dividers: [], openings: [], spaces: [], objects: [], unplacedObjects: [] };
  const calls = { snapshots: 0, shadows: 0, interior: 0, highlights: 0, spacing: 0 };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, {
    currentCameraView: 'walk', wallHiddenState: new Map(), options: { interactiveArchitecture: false },
    wallsGroup: new THREE.Group(), floorGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(),
    sceneSnapshot() { calls.snapshots++; return snapshot; },
    invalidateShadows() { calls.shadows++; }, updateInteriorWallView() { calls.interior++; },
    syncOpeningHighlight() { calls.highlights++; }, updateArchitectureSpacingVisibility() { calls.spacing++; }
  });
  for (const wall of getRoomWalls(room)) {
    const object = new THREE.Group(); object.userData.cutawayWallId = wall.id; object.visible = false;
    scene.wallsGroup.add(object); scene.wallHiddenState.set(wall.id, true);
  }
  for (let frame = 0; frame < 120; frame++) scene.updateCutawayWalls();
  assert.deepEqual(calls, { snapshots: 0, shadows: 0, interior: 0, highlights: 0, spacing: 0 });
  scene.updateCutawayWalls(true);
  assert.deepEqual(calls, { snapshots: 1, shadows: 1, interior: 1, highlights: 1, spacing: 1 });
  assert.ok(scene.wallsGroup.children.every((object) => object.visible));
  assert.ok([...scene.wallHiddenState.values()].every((hidden) => !hidden));
});

test('the Walk clipping range covers the whole room without changing as the walker moves', () => {
  const room = { vertices: roomTemplate('rectangle', 180, 160), height: 4 };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { currentCameraView: 'walk', camera: new THREE.PerspectiveCamera(65, 1.5, 5, 100) });
  scene.camera.position.set(0.3, 1.6, 0.3); scene.updateCameraClipping(room);
  const far = scene.camera.far;
  assert.equal(scene.camera.near, 0.08);
  assert.ok(far >= Math.hypot(180, 160, 4));
  scene.camera.position.set(90, 1.6, 80); scene.updateCameraClipping(room);
  assert.equal(scene.camera.far, far);
  scene.camera.position.set(179.7, 1.6, 159.7); scene.updateCameraClipping(room);
  assert.equal(scene.camera.far, far);
});
