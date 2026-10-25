import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createTestServer } from './helpers/vite.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(async () => { await vite.close(); });
const { FEATURES } = await vite.ssrLoadModule('/src/config/features.ts');
FEATURES.interiorWalls = true;
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { WalkControls } = await vite.ssrLoadModule('/src/renderer/WalkControls.ts');
const { roomTemplate, getRoomWalls } = await vite.ssrLoadModule('/src/core/roomGeometry.ts');
const { isWalkPositionValid } = await vite.ssrLoadModule('/src/core/walkNavigation.ts');
const { deriveSpaces } = await vite.ssrLoadModule('/src/core/spaces.ts');

function snapshot() {
  return { room: { vertices: roomTemplate('rectangle', 6, 5), width: 6, depth: 5, height: 2.6,
    shapeKind: 'rectangle', floorFinish: 'carpet-011', wallColor: '#eee', ceilingColor: '#fff', baseboardColor: '#fff',
    baseboardStyle: 'flat', baseboardMaterial: 'paint', lighting: { enabled: true, sunRaysEnabled: false, sunStylePreset: 'paired-suns', sunAzimuth: 0, sunElevation: 30 } },
    dividers: [], openings: [], spaces: [], objects: [], unplacedObjects: [],
    selectedId: 'selected-chair', interiorWallView: 'down', showRoomDimensions: false, showProductDimensions: true };
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
function createScene(initial = snapshot()) {
  let state = initial;
  const events = [];
  const camera = new THREE.PerspectiveCamera(15, 1.5, 0.1, 120);
  camera.position.set(8, 6, 9);
  const controls = new OrbitControls(camera);
  controls.target.set(3, 1.3, 2.5);
  controls.maxDistance = 50;
  controls.enableDamping = true;
  controls.update();
  const attributes = new Map();
  const renderer = { domElement: { setAttribute: (name, value) => attributes.set(name, value) },
    ratio: 2, size: [900, 600], getPixelRatio() { return this.ratio; }, setPixelRatio(value) { this.ratio = value; },
    getSize(target) { return target.set(...this.size); }, setSize(x, y) { this.size = [x, y]; } };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { camera, controls, renderer, scene: new THREE.Scene(), options: { showFurniture: true, interactiveArchitecture: false },
    bridge: { getSnapshot: () => state, cameraViewChanged: (view) => events.push(view) },
    walkControls: { enabled: false, setEnabled(value) { this.enabled = value; } },
    currentCameraView: 'free', walkNavigation: null, walkReturnView: null, controlsInteracting: false,
    pointerMoves: { clear() {} }, onWindowBlur() {}, requestRender() {}, disposed: false,
    helperGroup: new THREE.Group(), floorGroup: new THREE.Group(), wallsGroup: new THREE.Group(), ceilingGroup: new THREE.Group(),
    architecturalShadeGroup: new THREE.Group(), lightFixtureGroup: new THREE.Group(), interiorViewGroup: new THREE.Group(),
    interiorViewKey: '', ceilingVisible: false, wallHiddenState: new Map(),
    outlinePass: { selectedObjects: [new THREE.Group()] }, objectModels: new Map([['selected-chair', new THREE.Group()]]),
    moveHint: { hidden: false }, floorTextureReady: Promise.resolve(), spaceFloorReady: [], productModelRequests: new Map(), productModelErrors: new Set() });
  const roomDimensions = new THREE.Group(); roomDimensions.userData.helperRole = 'roomDimensions'; scene.helperGroup.add(roomDimensions);
  const shade = new THREE.Group(); shade.userData.ceilingShade = true; scene.architecturalShadeGroup.add(shade);
  for (const wall of getRoomWalls(initial.room)) {
    const object = new THREE.Group(); object.userData.cutawayWallId = wall.id; object.visible = false; scene.wallsGroup.add(object);
    scene.wallHiddenState.set(wall.id, true);
  }
  return { scene, events, attributes, getState: () => state, setState: (next) => { state = next; } };
}
function pose(scene) {
  return { position: scene.camera.position.clone(), quaternion: scene.camera.quaternion.clone(), target: scene.controls.target.clone(),
    fov: scene.camera.fov, maxDistance: scene.controls.maxDistance, damping: scene.controls.enableDamping };
}
function assertPose(scene, saved) {
  assert.ok(scene.camera.position.distanceTo(saved.position) < 1e-10, 'restore camera position');
  assert.ok(scene.camera.quaternion.angleTo(saved.quaternion) < 1e-7, 'restore camera orientation');
  assert.ok(scene.controls.target.distanceTo(saved.target) < 1e-10, 'restore orbit target');
  assert.equal(scene.camera.fov, saved.fov); assert.equal(scene.controls.maxDistance, saved.maxDistance);
  assert.equal(scene.controls.enableDamping, saved.damping);
}
const middleWall = { id: 'divider-middle', kind: 'wall', start: { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 }, end: { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 } };

function stubStateRendering(scene) {
  Object.assign(scene, { lastRoomKey: '', lastOpeningsKey: '', lastRenderedOpenings: [], lastHelperKey: '', lastSpacingHelperKey: '', lastSnapHelperKey: '',
    helperStateKey: () => '', spacingHelperStateKey: () => '', snapHelperStateKey: () => '' });
  for (const method of ['rebuildRoom', 'updateShadowBounds', 'syncSunsetAngles', 'syncObjects', 'syncHelperTransforms', 'applyRoomLighting', 'syncArchitectureSpacing']) scene[method] = () => {};
}

test('walk enters at human height with a broad FOV, complete architecture and hidden editing overlays', () => {
  const state = snapshot(); state.dividers = [middleWall]; deepFreeze(state);
  const { scene, attributes } = createScene(state);
  const interior = new THREE.Mesh(new THREE.BoxGeometry(5, 2.6, 0.05), Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial()));
  interior.userData.cutawayWallId = middleWall.id;
  interior.userData.interiorSection = { start: 0, end: 5, bottom: 0, top: 2.6 };
  interior.visible = false; scene.wallsGroup.add(interior);
  const before = JSON.stringify(state);
  scene.setCameraView('walk');
  assert.equal(scene.currentCameraView, 'walk'); assert.equal(scene.walkControls.enabled, true); assert.equal(scene.controls.enabled, false);
  assert.equal(scene.camera.position.y, 1.6); assert.equal(scene.camera.fov, 65);
  assert.equal(isWalkPositionValid(scene.walkNavigation, scene.camera.position), true);
  const direction = new THREE.Vector3(); scene.camera.getWorldDirection(direction); assert.ok(Math.abs(direction.y) < 1e-10);
  assert.equal(scene.ceilingGroup.visible, true); assert.equal(scene.lightFixtureGroup.visible, true);
  assert.ok([...scene.wallHiddenState.values()].every((hidden) => hidden === false));
  assert.ok(scene.wallsGroup.children.every((object) => object.visible));
  assert.equal(interior.visible, true); assert.equal(scene.interiorViewGroup.children.length, 0);
  assert.equal(scene.helperGroup.visible, false); assert.equal(scene.moveHint.hidden, true);
  assert.deepEqual(scene.outlinePass.selectedObjects, []); assert.equal(attributes.get('aria-label'), 'Walk through room');
  assert.equal(JSON.stringify(state), before, 'walking never changes the semantic project or stored wall view');
  scene.setCameraView('free');
  assert.equal(interior.visible, false, 'the stored lowered-wall view returns on exit');
  assert.ok(scene.interiorViewGroup.children.length > 0);
});

test('walk camera translations collide with walls and remain horizontal', () => {
  const { scene } = createScene(); scene.setCameraView('walk');
  const orientation = scene.camera.quaternion.clone();
  scene.moveWalkCamera(-100, 0);
  assert.ok(Math.abs(scene.camera.position.x - scene.walkNavigation.clearance) < 0.001);
  assert.equal(scene.camera.position.y, 1.6); assert.equal(isWalkPositionValid(scene.walkNavigation, scene.camera.position), true);
  assert.equal(scene.camera.quaternion.angleTo(orientation), 0);
  scene.leaveWalkView(); const before = scene.camera.position.clone(); scene.moveWalkCamera(20, 20);
  assert.equal(scene.camera.position.distanceTo(before), 0, 'walk movement is ignored after leaving');
});

test('exiting walk to Free cam restores the previous pose, lens, target and damping', () => {
  const { scene, attributes } = createScene(); const saved = pose(scene);
  scene.setCameraView('walk'); scene.moveWalkCamera(1, -1); scene.camera.rotation.set(0.2, 1, 0);
  scene.setCameraView('free');
  assertPose(scene, saved); assert.equal(scene.currentCameraView, 'free'); assert.equal(scene.controls.enabled, true);
  assert.equal(scene.walkControls.enabled, false); assert.equal(scene.walkNavigation, null); assert.equal(scene.walkReturnView, null);
  assert.equal(scene.helperGroup.visible, true); assert.equal(attributes.get('aria-label'), '3D room view');
  assert.equal(scene.outlinePass.selectedObjects.length, 1, 'normal selected-object outline returns');
});

test('switching from walk to a fixed preset uses its usual framing and re-enables orbit controls', () => {
  const { scene } = createScene(); scene.setCameraView('front'); scene.setCameraView('walk'); scene.setCameraView('top');
  assert.equal(scene.currentCameraView, 'top'); assert.equal(scene.controls.enabled, true); assert.equal(scene.walkControls.enabled, false);
  assert.equal(scene.camera.fov, 32); assert.equal(scene.camera.position.x, 3); assert.equal(scene.camera.position.y, 12);
  assert.equal(scene.controls.target.y, 1.3); assert.equal(scene.ceilingGroup.visible, false);
  scene.setCameraView('walk'); scene.setCameraView('right');
  assert.equal(scene.currentCameraView, 'right'); assert.ok(Math.abs(scene.camera.position.y - 1.3) < 1e-10); assert.ok(scene.camera.position.x > 6);
});

test('architecture refresh relocates a walker out of new walls and updates eye height', () => {
  const context = createScene(); const { scene } = context;
  scene.setCameraView('walk'); assert.equal(scene.camera.position.x, 3);
  const changed = structuredClone(context.getState()); changed.dividers = [middleWall]; changed.room.height = 1.4;
  context.setState(changed); stubStateRendering(scene); scene.renderFromState();
  assert.equal(scene.currentCameraView, 'walk'); assert.equal(scene.controls.enabled, false);
  assert.equal(isWalkPositionValid(scene.walkNavigation, scene.camera.position), true);
  assert.ok(Math.abs(scene.camera.position.x - 3) >= scene.walkNavigation.clearance);
  assert.ok(scene.camera.position.y < 1.3); assert.equal(scene.helperGroup.visible, false);
});

test('architecture recovery stays near a walker who crossed out of the selected editing space', () => {
  const state = snapshot();
  state.dividers = [middleWall];
  state.openings = [{ id: 'passage', wallId: middleWall.id, type: 'opening', variant: 'wall-opening',
    offset: 2.5, width: 1.2, height: 2.1, sillHeight: 0 }];
  state.spaces = deriveSpaces(state);
  state.selectedSpaceId = state.spaces.find((space) => space.seed.x < 3).id;
  const context = createScene(state); const { scene } = context;
  scene.setCameraView('walk');
  assert.ok(scene.camera.position.x < 3, 'entry prefers the selected left space');
  scene.moveWalkCamera(4.5 - scene.camera.position.x, 2.5 - scene.camera.position.z);
  assert.ok(Math.abs(scene.camera.position.x - 4.5) < 1e-10, 'the walker crosses the passage into the right space');
  const changed = structuredClone(state);
  changed.dividers.push({ id: 'divider-new', kind: 'wall',
    start: { kind: 'perimeter', id: 'wall-v0-v1', t: 0.75 }, end: { kind: 'perimeter', id: 'wall-v2-v3', t: 0.25 } });
  context.setState(changed);
  const before = scene.camera.position.clone();
  scene.refreshWalkNavigation(changed);
  assert.equal(isWalkPositionValid(scene.walkNavigation, scene.camera.position), true);
  assert.ok(scene.camera.position.x > 3, 'recovery remains in the current side of the room');
  assert.ok(scene.camera.position.distanceTo(before) < 0.4, 'recovery moves only far enough to clear the new wall');
  assert.equal(state.selectedSpaceId, changed.selectedSpaceId, 'recovery does not change finish editing selection');
});

test('an outline with no body clearance leaves the usable planner camera unchanged', () => {
  const state = snapshot(); state.room.vertices = [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 0.3, z: 0 }, { id: 'c', x: 0.3, z: 5 }, { id: 'd', x: 0, z: 5 }];
  const { scene, events } = createScene(state); const saved = pose(scene);
  scene.setCameraView('walk');
  assertPose(scene, saved); assert.equal(scene.currentCameraView, 'free'); assert.equal(scene.controls.enabled, true);
  assert.equal(scene.walkControls.enabled, false); assert.equal(scene.helperGroup.visible, true); assert.deepEqual(events, ['free']);
});

test('a walk render updates walk movement without allowing OrbitControls to overwrite it', () => {
  const { scene } = createScene(); scene.setCameraView('walk');
  const before = scene.camera.position.clone();
  scene.walkControls.update = () => { scene.moveWalkCamera(0.1, 0); return true; };
  scene.controls.update = () => { throw new Error('OrbitControls must stay idle while walking'); };
  Object.assign(scene, { restingPixelRatio: 2, firstFrameRendered: true, animationFrame: 1, composer: { setPixelRatio() {} } });
  scene.renderer.render = () => {}; scene.renderer.setRenderTarget = () => {};
  for (const method of ['layoutArchitectureSpacing', 'updateMeasurementLabelOrientation', 'updateMeasurementLabelScale',
    'updateMeasurementLineGaps', 'updateSpacingMeasurementLines']) scene[method] = () => {};
  scene.renderFrame();
  assert.ok(Math.abs(scene.camera.position.x - before.x - 0.1) < 1e-10);
  assert.equal(scene.camera.position.y, 1.6); assert.equal(scene.helperGroup.visible, false);
});

test('removing all body clearance during a walk safely returns to the planner', () => {
  const context = createScene(); const { scene, events } = context; const saved = pose(scene);
  scene.setCameraView('walk');
  const changed = structuredClone(context.getState());
  changed.room.vertices = changed.room.vertices.map((vertex) => ({ ...vertex, x: vertex.x * 0.05 }));
  context.setState(changed); stubStateRendering(scene); scene.renderFromState();
  assert.equal(scene.currentCameraView, 'free'); assert.equal(scene.walkControls.enabled, false); assert.equal(scene.controls.enabled, true);
  assertPose(scene, saved); assert.deepEqual(events, ['free']);
});

test('resetting an active walk synchronizes the look controller and clears held movement', () => {
  const { scene } = createScene();
  const document = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const window = new EventTarget(); document.defaultView = window;
  const canvas = Object.assign(new EventTarget(), { ownerDocument: document, style: { cursor: '' }, setAttribute() {}, focus() { document.activeElement = canvas; } });
  scene.renderer.domElement = canvas;
  scene.walkControls = new WalkControls(scene.camera, canvas, { move: (x, z) => scene.moveWalkCamera(x, z), change() {}, exit() {} });
  const emit = (target, type, fields) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
  };
  const drag = (y) => {
    emit(canvas, 'pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    emit(window, 'pointermove', { pointerId: 1, clientX: 0, clientY: y });
    emit(window, 'pointerup', { pointerId: 1 });
    scene.walkControls.update(0);
  };
  try {
    scene.setCameraView('walk'); drag(100);
    const direction = () => scene.camera.getWorldDirection(new THREE.Vector3()).y;
    assert.ok(direction() < -0.29);
    emit(canvas, 'keydown', { code: 'KeyW', key: 'w' });
    scene.setCameraView('walk');
    assert.ok(Math.abs(direction()) < 1e-10, 'Reset levels the camera');
    assert.equal(scene.walkControls.update(0), false, 'Reset clears held movement');
    drag(1);
    assert.ok(Math.abs(direction() + Math.sin(0.003)) < 1e-10, 'the next drag starts from the reset orientation');
  } finally { scene.walkControls.dispose(); }
});

test('a failed PDF capture restores the current walk pose and its return camera', async () => {
  const state = snapshot(); state.selectedId = null;
  const { scene, attributes } = createScene(state); const plannerPose = pose(scene);
  scene.setCameraView('walk'); scene.moveWalkCamera(1, -1); scene.camera.rotation.set(0.2, 1, 0);
  const walkPose = pose(scene), returnView = scene.walkReturnView, navigation = scene.walkNavigation;
  const aspect = scene.camera.aspect, near = scene.camera.near, far = scene.camera.far;
  scene.renderer.render = () => {
    assert.equal(scene.controls.enabled, false, 'capture keeps planner controls disabled');
    assert.equal(scene.helperGroup.visible, false, 'capture hides editing helpers after leaving walk');
    throw new Error('GPU capture failed');
  };
  await assert.rejects(scene.exportPDF('Walk capture'), /GPU capture failed/);
  assertPose(scene, walkPose); assert.equal(scene.camera.aspect, aspect); assert.equal(scene.camera.near, near); assert.equal(scene.camera.far, far);
  assert.equal(scene.currentCameraView, 'walk'); assert.equal(scene.walkControls.enabled, true); assert.equal(scene.controls.enabled, false);
  assert.equal(scene.walkReturnView, returnView); assert.equal(scene.walkNavigation, navigation); assert.equal(scene.helperGroup.visible, false);
  assert.equal(attributes.get('aria-label'), 'Walk through room'); assert.equal(scene.renderer.ratio, 2); assert.deepEqual(scene.renderer.size, [900, 600]);
  scene.setCameraView('free'); assertPose(scene, plannerPose);
});
