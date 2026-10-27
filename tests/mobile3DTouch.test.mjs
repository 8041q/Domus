import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createTestServer } from './helpers/vite.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { SceneTouchControls } = await vite.ssrLoadModule('/src/renderer/SceneTouchControls.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { usePlannerStore, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');

function canvas() {
  const captures = new Set(), document = new EventTarget();
  const element = Object.assign(new EventTarget(), {
    style: {}, ownerDocument: document, clientWidth: 900, clientHeight: 600,
    getRootNode: () => document,
    focus() {}, setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id)
  });
  return { element, captures };
}
function event(id, x, y = 100) {
  return { pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y, pageX: x, pageY: y,
    preventDefault() {}, stopImmediatePropagation() {} };
}
function fixture(selected = false) {
  const { element, captures } = canvas();
  const calls = [], model = { x: 1 }, history = [];
  let target = { kind: 'object', id: 'chair', selected, editable: true }, before = 1;
  const controller = new SceneTouchControls(element, {
    pick: () => target,
    select: next => calls.push(['select', next?.id ?? null]),
    beginEdit: (_target, start) => { before = model.x; calls.push(['begin', start.clientX]); return true; },
    moveEdit: sample => { model.x = sample.clientX; calls.push(['edit', sample.pointerId]); },
    commitEdit: () => { history.push(before); calls.push(['commit']); },
    cancelEdit: () => { model.x = before; calls.push(['cancel']); },
    startNavigation: points => calls.push(['navigate', points.map(sample => [sample.pointerId, sample.clientX])]),
    moveNavigation: sample => calls.push(['orbit', sample.pointerId]),
    stopNavigation: () => calls.push(['stop'])
  });
  return { controller, calls, model, history, captures, setTarget: next => { target = next; } };
}

test('3D touch selects on a tap and cannot drag an unselected item', () => {
  const f = fixture();
  f.controller.pointerDown(event(1, 100));
  assert.deepEqual(f.calls, [], 'touch down does not select or mutate');
  f.controller.pointerUp(event(1, 103));
  assert.deepEqual(f.calls[0], ['select', 'chair']); assert.equal(f.model.x, 1); assert.equal(f.history.length, 0);
  f.calls.length = 0;
  f.controller.pointerDown(event(2, 100)); f.controller.pointerMove(event(2, 130)); f.controller.pointerUp(event(2, 140));
  assert.ok(f.calls.some(call => call[0] === 'navigate'));
  assert.ok(!f.calls.some(call => call[0] === 'begin' || call[0] === 'select'));
  assert.equal(f.model.x, 1); assert.equal(f.captures.size, 0);
});

test('selected item edits begin after an eight-pixel threshold and commit once with the final sample', () => {
  const f = fixture(true);
  f.controller.pointerDown(event(1, 100)); f.controller.pointerMove(event(1, 107));
  assert.equal(f.model.x, 1); assert.equal(f.calls.length, 0);
  f.controller.pointerMove(event(1, 109));
  assert.deepEqual(f.calls[0], ['begin', 100]); assert.equal(f.model.x, 109);
  f.controller.pointerMove(event(9, 1000)); f.controller.pointerUp(event(9, 1000));
  assert.equal(f.model.x, 109); assert.equal(f.history.length, 0, 'unowned pointers never complete the transaction');
  f.controller.pointerUp(event(1, 150));
  assert.equal(f.model.x, 150); assert.deepEqual(f.history, [1]); assert.equal(f.captures.size, 0);
});

test('adding a second finger rolls back the edit before rebasing navigation at current pointer positions', () => {
  const f = fixture(true);
  f.controller.pointerDown(event(1, 100)); f.controller.pointerMove(event(1, 140));
  assert.equal(f.model.x, 140);
  f.controller.pointerDown(event(2, 220));
  assert.equal(f.model.x, 1); assert.deepEqual(f.history, []);
  const cancellation = f.calls.findIndex(call => call[0] === 'cancel');
  const navigation = f.calls.findIndex(call => call[0] === 'navigate');
  assert.ok(cancellation >= 0 && cancellation < navigation);
  assert.deepEqual(f.calls[navigation], ['navigate', [[1, 140], [2, 220]]]);
  f.controller.pointerMove(event(2, 240));
  assert.equal(f.model.x, 1); assert.deepEqual(f.calls.at(-1), ['orbit', 2]);
  f.controller.pointerUp(event(1, 140));
  assert.deepEqual(f.calls.findLast(call => call[0] === 'navigate'), ['navigate', [[2, 240]]]);
  f.controller.pointerUp(event(2, 240)); assert.equal(f.captures.size, 0);
  assert.ok(!f.calls.some(call => call[0] === 'select'), 'pinch endings cannot select a wall or item');
});

test('touch cancellation releases every pointer and preserves the last committed model', () => {
  const f = fixture(true);
  f.controller.pointerDown(event(1, 100)); f.controller.pointerMove(event(1, 125)); f.controller.cancel();
  assert.equal(f.model.x, 1); assert.equal(f.history.length, 0); assert.equal(f.captures.size, 0);
  f.controller.pointerMove(event(1, 200)); f.controller.pointerUp(event(1, 200));
  assert.equal(f.model.x, 1);
  f.controller.pointerDown(event(1, 100)); f.controller.pointerDown(event(2, 200)); f.controller.pointerDown(event(3, 300));
  assert.equal(f.captures.size, 2); f.controller.cancel(); assert.equal(f.captures.size, 0);
});

test('synchronous store subscribers can cancel again while a preview is being restored', () => {
  const f = fixture(true), restore = f.controller.callbacks.cancelEdit;
  let cancellations = 0;
  f.controller.callbacks.cancelEdit = () => { cancellations++; restore(); f.controller.cancel(); };
  f.controller.pointerDown(event(1, 100)); f.controller.pointerMove(event(1, 125)); f.controller.cancel();
  assert.equal(cancellations, 1); assert.equal(f.model.x, 1); assert.equal(f.captures.size, 0); assert.equal(f.controller.active, false);
});

test('the OrbitControls touch adapter seeds a takeover without moving the camera, then pans and pinches normally', () => {
  const { element } = canvas(), camera = new THREE.PerspectiveCamera(32, 1.5, 0.1, 100);
  camera.position.set(5, 5, 5);
  const controls = new OrbitControls(camera, element); controls.enableDamping = false;
  controls.target.set(1, 1, 1); controls.update();
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { controls, currentCameraView: 'free', requestRender() {}, controlsInteracting: false });
  try {
    const position = camera.position.clone(), target = controls.target.clone();
    scene.startTouchNavigation([event(1, 100), event(2, 200)]);
    assert.ok(camera.position.equals(position)); assert.ok(controls.target.equals(target));
    controls._onTouchMove(scene.orbitTouchSample(event(2, 240)));
    assert.ok(camera.position.distanceTo(position) > 0.001);
    assert.ok(controls.target.distanceTo(target) > 0.001);
    const moved = camera.position.clone();
    scene.startTouchNavigation([event(2, 240)]);
    assert.ok(camera.position.equals(moved), 'lifting a finger rebases the remaining orbit without a jump');
    scene.stopTouchNavigation(); assert.equal(controls._pointers.length, 0); assert.equal(controls.state, -1);
  } finally { controls.dispose(); }
});

test('cancelling a rendered 3D preview restores the exact snapshot while keeping prior undo history', () => {
  const store = usePlannerStore; store.getState().resetProject();
  store.getState().addObject('chair'); store.getState().updateRoom({ height: 2.9 });
  const before = getSnapshot(), item = before.objects[0];
  store.getState().updateObject(item.id, { x: item.x + 0.5 });
  let cleared = 0, renders = 0;
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { currentCameraView: 'free', controls: { enabled: false }, renderer: { domElement: { style: {} } },
    dragging: { before }, openingDragging: null, pointerMoves: { clear() { cleared++; } }, openingMoves: { clear() { cleared++; } },
    bridge: { cancelDrag: value => store.getState().cancelInteraction(value), feedback() {} },
    renderFromState() { renders++; }, requestRender() {} });
  scene.cancelTouchEdit();
  assert.deepEqual(getSnapshot(), before); assert.equal(scene.dragging, null); assert.equal(scene.controls.enabled, true);
  assert.equal(cleared, 2); assert.equal(renders, 1);
  store.getState().undo(); assert.equal(store.getState().room.height, 2.6, 'cancellation did not consume the previous undo entry');
});

test('disabling item editing preserves the camera and hides editing overlays during exploration', () => {
  const camera = new THREE.PerspectiveCamera(32); camera.position.set(5, 5, 5);
  const selected = new THREE.Group(), scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { camera, options: { showFurniture: true, interactiveFurniture: true, interactiveArchitecture: false },
    currentCameraView: 'free', helperGroup: new THREE.Group(), wallsGroup: new THREE.Group(),
    objectModels: new Map([['selected', selected]]), outlinePass: { selectedObjects: [selected] },
    pointerMoves: { clear() {} }, renderer: { domElement: { style: {} } },
    sceneSnapshot: () => ({ selectedId: 'selected' }), requestRender() {} });
  const position = camera.position.clone(), quaternion = camera.quaternion.clone();
  scene.setFurnitureInteraction(false);
  assert.ok(camera.position.equals(position)); assert.ok(camera.quaternion.equals(quaternion));
  assert.equal(scene.helperGroup.visible, false); assert.deepEqual(scene.outlinePass.selectedObjects, []);
  scene.setFurnitureInteraction(true);
  assert.equal(scene.helperGroup.visible, true); assert.deepEqual(scene.outlinePass.selectedObjects, [selected]);
});

test('a stale 3D gesture cannot restore an old project after replacement', () => {
  let cancelled = false, rendered = false;
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { currentCameraView: 'free', controls: { enabled: false }, renderer: { domElement: { style: {} } },
    dragging: { before: { projectGeneration: 1 } }, pointerMoves: { clear() {} }, openingMoves: { clear() {} },
    bridge: { getSnapshot: () => ({ projectGeneration: 2 }), cancelDrag() { cancelled = true; }, feedback() {} },
    renderFromState() { rendered = true; }, requestRender() {} });
  scene.cancelTouchEdit();
  assert.equal(cancelled, false); assert.equal(rendered, false); assert.equal(scene.dragging, null);
});

test('a target changed during the touch intent threshold starts navigation instead of editing another item', () => {
  const { element } = canvas(), scene = Object.create(PlannerScene.prototype);
  let target = { kind: 'object', id: 'selected', selected: true, editable: true }, edits = 0, navigations = 0;
  Object.assign(scene, { renderer: { domElement: element },
    controls: { _onTouchMove() {} }, pickTouchTarget: () => target,
    onPointerDown() { edits++; }, startTouchNavigation() { navigations++; }, stopTouchNavigation() {} });
  const touches = scene.touchControls(); touches.pointerDown(event(1, 100));
  target = { kind: 'object', id: 'different', selected: false, editable: true };
  touches.pointerMove(event(1, 120));
  assert.equal(edits, 0); assert.equal(navigations, 1);
  touches.cancel();
});

test('project replacement drops pending tap ownership before a stale selection or queued edit can run', () => {
  const f = fixture(), scene = Object.create(PlannerScene.prototype);
  f.controller.pointerDown(event(1, 100));
  Object.assign(scene, { sceneTouchControls: f.controller, touchProjectGeneration: 1,
    bridge: { getSnapshot: () => ({ projectGeneration: 2 }) }, requestRender() {} });
  scene.scheduleStateSync();
  assert.equal(f.controller.active, false); assert.equal(f.captures.size, 0); assert.equal(scene.stateSyncPending, true);
  f.controller.pointerUp(event(1, 100));
  assert.ok(!f.calls.some(call => call[0] === 'select' || call[0] === 'commit'));
});

test('responsive 3D resizing updates the projection and buffers while retaining the camera pose, target and lens', () => {
  const camera = new THREE.PerspectiveCamera(43, 1.5, 0.08, 100), sizes = [];
  camera.position.set(3, 4, 5); camera.lookAt(1, 1, 1);
  const controls = { target: new THREE.Vector3(1, 1, 1) }, scene = Object.create(PlannerScene.prototype);
  const position = camera.position.clone(), quaternion = camera.quaternion.clone(), target = controls.target.clone();
  Object.assign(scene, { camera, controls, container: { clientWidth: 390, clientHeight: 640 }, helperGroup: new THREE.Group(),
    renderer: { setSize: (...size) => sizes.push(['renderer', ...size]) },
    composer: { setSize: (...size) => sizes.push(['composer', ...size]) }, requestRender() {} });
  scene.resize();
  assert.equal(camera.aspect, 390 / 640); assert.equal(camera.fov, 43);
  assert.ok(camera.position.equals(position)); assert.ok(camera.quaternion.equals(quaternion)); assert.ok(controls.target.equals(target));
  assert.deepEqual(sizes, [['renderer', 390, 640, false], ['composer', 390, 640]]);
});
