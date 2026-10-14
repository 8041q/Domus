import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { FEATURES } = await vite.ssrLoadModule('/src/config/features.ts');
FEATURES.interiorWalls = true;
const { usePlannerStore: store, getSnapshot, parseProjectSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const geometry = await vite.ssrLoadModule('/src/core/roomGeometry.ts');
const { openingFitsBoundary, openingPlacementValid, fitOpening, openingPositionAtPoint } = await vite.ssrLoadModule('/src/core/openingPlacement.ts');
const { architectureSpacingMeasurements } = await vite.ssrLoadModule('/src/core/architectureSpacing.ts');
const { getPhysicalWalls, resolveDividers } = await vite.ssrLoadModule('/src/core/spaces.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { themeMetric } = await vite.ssrLoadModule('/src/theme.ts');
const { SUN_ELEVATION_MIN } = await vite.ssrLoadModule('/src/core/sun.ts');
const { openingFrameOverhang } = await vite.ssrLoadModule('/src/core/architecturalStyles.ts');

function fresh(shape = 'rectangle') { store.getState().resetProject(); store.getState().setRoomTemplate(shape); }

test('rigid frames cannot bridge a sharp bend, including doors inherited from a custom circular room', () => {
  fresh();
  const room = { ...store.getState().room, shapeKind: 'custom', vertices: [
    { id: 'v0', x: 0, z: 0 }, { id: 'v1', x: 2.2, z: 0 }, { id: 'v2', x: 2.6, z: 0.8 },
    { id: 'v3', x: 5.2, z: 0.8 }, { id: 'v4', x: 5.2, z: 3.8 }, { id: 'v5', x: 0, z: 3.8 }
  ] };
  for (const type of ['door', 'window']) {
    const opening = { id: 'unsafe', type, variant: type === 'door' ? 'single-door' : 'single-window',
      wallId: 'wall-v1-v2', offset: 0.4, width: 0.9, height: 2.08, sillHeight: 0, wrapAround: true };
    assert.equal(openingFitsBoundary(room, [], opening), false);
    const safe = fitOpening(room, [], opening, []);
    assert.ok(safe); assert.equal(safe.width, opening.width);
    assert.equal(openingFitsBoundary(room, [], safe), true);
    assert.notEqual(safe.wallId, opening.wallId);
    assert.equal(openingFitsBoundary(room, [], { ...opening, type: 'opening', variant: 'wall-opening' }), true);
  }
});

test('double doors and enlarged windows retain their requested size, move to fit, and reject impossible changes atomically', () => {
  fresh();
  const walls = geometry.getRoomWalls(store.getState().room);
  const door = { id: 'grow-door', type: 'door', variant: 'single-door', wallId: walls[0].id,
    offset: 0.52, width: 0.9, height: 2.08, sillHeight: 0 };
  const window = { id: 'grow-window', type: 'window', variant: 'single-window', wallId: walls[1].id,
    offset: 1.9, width: 1.2, height: 1.2, sillHeight: 0.75 };
  store.setState({ openings: [door, window] });
  const before = getSnapshot();
  assert.equal(store.getState().updateOpening(door.id, { variant: 'double-door' }), true);
  const largerDoor = store.getState().openings.find((opening) => opening.id === door.id);
  assert.equal(largerDoor.width, 1.6);
  assert.ok(largerDoor.offset >= 0.85 - 1e-6);
  assert.equal(openingFitsBoundary(store.getState().room, [], largerDoor), true);
  store.getState().undo(); assert.deepEqual(getSnapshot(), before);
  store.getState().redo();
  assert.equal(store.getState().updateOpening(window.id, { width: 4.5 }), true);
  const largerWindow = store.getState().openings.find((opening) => opening.id === window.id);
  assert.equal(largerWindow.width, 4.5);
  assert.notEqual(largerWindow.wallId, window.wallId);
  assert.equal(openingFitsBoundary(store.getState().room, [], largerWindow), true);
  const valid = getSnapshot();
  assert.equal(store.getState().updateOpening(window.id, { width: 25 }), false);
  assert.deepEqual(getSnapshot(), valid);
});

test('moves and size changes avoid other apertures, including pieces that wrap a corner', () => {
  fresh();
  const room = store.getState().room, walls = geometry.getRoomWalls(room);
  const corner = { id: 'corner', type: 'opening', variant: 'wall-opening', wallId: walls[0].id,
    offset: walls[0].length - 0.1, width: 1.6, height: 2, sillHeight: 0 };
  const door = { id: 'door', type: 'door', variant: 'single-door', wallId: walls[1].id,
    offset: 1.5, width: 0.9, height: 2.08, sillHeight: 0 };
  assert.equal(openingPlacementValid(room, [], { ...door, offset: 0.5 }, [corner]), false);
  store.setState({ openings: [corner, door] });
  assert.equal(store.getState().updateOpening(door.id, { offset: 0.5 }), true);
  const moved = store.getState().openings.find((opening) => opening.id === door.id);
  assert.equal(openingPlacementValid(room, [], moved, [corner]), true);
  assert.equal(moved.width, door.width);
  const trimmedDoor = { ...door, wallId: walls[0].id, offset: 1.3 };
  const window = { id: 'trimmed-window', type: 'window', variant: 'single-window', wallId: walls[0].id,
    offset: 2.4, width: 1.2, height: 1.2, sillHeight: 0.75 };
  assert.equal(openingPlacementValid(room, [], window, [trimmedDoor]), false, 'Separate holes can still have overlapping casings');
  const fittedWindow = fitOpening(room, [], window, [trimmedDoor]);
  assert.ok(fittedWindow.offset - fittedWindow.width / 2 - (trimmedDoor.offset + trimmedDoor.width / 2) >= 0.12 - 1e-6);
});

test('room resizing rejects a layout that cannot retain every frame without overlap', () => {
  fresh();
  const walls = geometry.getRoomWalls(store.getState().room);
  const common = { type: 'window', variant: 'double-window', width: 3.4, height: 1.2, sillHeight: 0.75 };
  store.setState({ openings: [
    { ...common, id: 'first', wallId: walls[0].id, offset: 2.6 },
    { ...common, id: 'second', wallId: walls[2].id, offset: 2.6 },
    { ...common, id: 'third', wallId: walls[1].id, offset: 1.9 }
  ] });
  const before = getSnapshot();
  assert.equal(store.getState().updateRoom({ width: 2.2 }), false);
  assert.deepEqual(getSnapshot(), before);
});

test('doors and windows can span straight split sections without shrinking their frames', () => {
  fresh();
  store.setState({ openings: [{ id: 'window', type: 'window', variant: 'double-window', wallId: 'wall-v0-v1',
    offset: 2.6, width: 2.4, height: 1.2, sillHeight: 0.75 }] });
  assert.equal(store.getState().splitWallById('wall-v0-v1'), true);
  const state = getSnapshot(), opening = state.openings[0];
  assert.equal(opening.width, 2.4);
  assert.equal(openingFitsBoundary(state.room, [], opening), true);
  const pieces = geometry.getRoomWalls(state.room).flatMap((wall) => geometry.openingsOnWall(state.room, [opening], wall.id));
  assert.equal(pieces.length, 2);
  assert.ok(Math.abs(pieces.reduce((sum, piece) => sum + piece.width, 0) - 2.4) < 1e-8);
});

test('corner radius changes adapt the section count and keep all sections usable', () => {
  fresh('rounded-rectangle');
  assert.equal(store.getState().updateRoom({ width: 6, depth: 6 }), true);
  store.setState({ openings: [] });
  const before = getSnapshot(), counts = [];
  for (const cornerRadius of [0, 0.05, 0.15, 0.3, 0.5, 1, 1.5, 2, 2.9]) {
    assert.equal(store.getState().updateRoom({ cornerRadius }, false), true);
    const room = store.getState().room;
    assert.equal(geometry.isValidRoom(room.vertices), true);
    assert.equal(room.shapeKind, 'rounded-rectangle');
    assert.ok(Math.abs(room.width - 6) < 1e-8); assert.ok(Math.abs(room.depth - 6) < 1e-8);
    counts.push(room.vertices.length);
    const walls = geometry.getRoomWalls(room);
    assert.ok(walls.every((wall) => wall.length >= geometry.MIN_WALL_LENGTH - 1e-8));
    if (room.cornerRadius >= 0.5) {
      assert.ok(walls.filter((wall) => Math.abs(wall.tangent.x * wall.tangent.z) > 1e-6).every((wall) => wall.length >= 0.35));
    }
    assert.deepEqual(parseProjectSnapshot(JSON.parse(JSON.stringify(getSnapshot()))), getSnapshot());
  }
  assert.equal(counts[0], 4); assert.equal(counts[1], 4);
  assert.ok(counts.at(-1) > counts[4]);
  store.getState().commitSnapshot(before);
  const final = getSnapshot(); store.getState().undo(); assert.deepEqual(getSnapshot(), before);
  store.getState().redo(); assert.deepEqual(getSnapshot(), final);
});

test('rounding remaps apertures and attached divisions, preserves their sizes, and rejects loss of a rigid frame', () => {
  fresh('rounded-rectangle');
  store.getState().updateRoom({ width: 6, depth: 6 });
  const walls = geometry.getRoomWalls(store.getState().room);
  const bounds = geometry.roomBounds(store.getState().room.vertices);
  const top = walls.find((wall) => Math.abs(wall.start.z - bounds.minZ) < 1e-8 && Math.abs(wall.end.z - bounds.minZ) < 1e-8);
  const bottom = walls.find((wall) => Math.abs(wall.start.z - bounds.maxZ) < 1e-8 && Math.abs(wall.end.z - bounds.maxZ) < 1e-8);
  assert.equal(store.getState().addDivider('wall', { kind: 'perimeter', id: top.id, t: 0.5 }, { kind: 'perimeter', id: bottom.id, t: 0.5 }), true);
  const before = getSnapshot(), sizes = before.openings.map((opening) => opening.width);
  assert.equal(store.getState().updateRoom({ cornerRadius: 1.5 }), true);
  assert.deepEqual(store.getState().openings.map((opening) => opening.width), sizes);
  const divider = resolveDividers(store.getState().room, store.getState().dividers)[0];
  const centreX = (bounds.minX + bounds.maxX) / 2;
  assert.ok(Math.abs(divider.a.x - centreX) < 1e-8); assert.ok(Math.abs(divider.b.x - centreX) < 1e-8);
  store.getState().undo(); assert.deepEqual(getSnapshot(), before);
  store.getState().redo();
  store.setState({ openings: [{ id: 'wide', type: 'window', variant: 'double-window', wallId: top.id,
    offset: 1.5, width: 2.8, height: 1.2, sillHeight: 0.75 }], dividers: [] });
  // Re-anchor to a current straight side before testing the impossible radius.
  const currentTop = geometry.getRoomWalls(store.getState().room).find((wall) => Math.abs(wall.start.z - bounds.minZ) < 1e-8 && Math.abs(wall.end.z - bounds.minZ) < 1e-8);
  store.setState({ openings: [{ ...store.getState().openings[0], wallId: currentTop.id }] });
  const stable = getSnapshot();
  assert.equal(store.getState().updateRoom({ cornerRadius: 2.9 }), false);
  assert.deepEqual(getSnapshot(), stable);
});

test('2D projections preserve the grab offset, transfer between walls, and exclude interior walls for windows', () => {
  fresh();
  const snapshot = getSnapshot(), opening = snapshot.openings[0];
  store.setState({ openings: [opening] });
  const target = openingPositionAtPoint(snapshot.room, [], opening, { x: 2.4, z: 0.08 }, 0.2);
  assert.ok(Math.abs(target.distance - 2.6) < 1e-8);
  store.getState().updateOpening(opening.id, geometry.perimeterLocation(snapshot.room, target.distance), false);
  assert.ok(Math.abs(store.getState().openings[0].offset - 2.6) < 1e-8);
  store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 }, { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 });
  const projected = openingPositionAtPoint(store.getState().room, store.getState().dividers, opening, { x: 2.6, z: 1.8 }, 0);
  assert.ok(!projected.wall.id.startsWith('divider-'));
  const before = getSnapshot();
  for (const point of [{ x: 5.2, z: 1.3 }, { x: 5.2, z: 1.5 }, { x: 5.2, z: 1.8 }]) {
    const location = openingPositionAtPoint(store.getState().room, store.getState().dividers, opening, point, 0.2);
    store.getState().updateOpening(opening.id, geometry.perimeterLocation(store.getState().room, location.distance), false);
  }
  store.getState().commitSnapshot(before);
  const afterDrag = getSnapshot();
  assert.equal(afterDrag.openings[0].wallId, 'wall-v1-v2');
  assert.ok(Math.abs(afterDrag.openings[0].offset - 2) < 1e-8);
  store.getState().undo(); assert.deepEqual(getSnapshot(), before);
});

test('Build Room uses two Item Spacing gap rows outside the selected aperture', () => {
  fresh();
  const template = { type: 'opening', variant: 'wall-opening', wallId: 'wall-v0-v1', height: 1.2, sillHeight: 0.75 };
  const snapshot = { ...getSnapshot(), openings: [
    { ...template, id: 'left', offset: 0.6, width: 0.8 },
    { ...template, id: 'active', offset: 2.5, width: 1 },
    { ...template, id: 'right', offset: 4.5, width: 1 }
  ] };
  const measures = architectureSpacingMeasurements(snapshot, 'active');
  const byId = Object.fromEntries(measures.map((measurement) => [measurement.id, measurement]));
  assert.equal(measures.length, 4);
  assert.equal(byId.wall, undefined); assert.equal(byId.width, undefined);
  assert.equal(byId['left-wall'].row, 1);
  assert.equal(byId['left-wall'].distance, 2); assert.ok(Math.abs(byId['right-wall'].distance - 2.2) < 1e-8);
  assert.equal(byId['left-item'].distance, 1); assert.equal(byId['right-item'].distance, 1);
  assert.equal(byId['left-item'].row, 0);
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { options: { interactiveArchitecture: true, showFurniture: false },
    helperGroup: new THREE.Group(), camera: new THREE.PerspectiveCamera(), container: { clientWidth: 1200, clientHeight: 800 },
    createDynamicSpacingLabel: (text) => {
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
      label.userData.dynamicSpacingText = text;
      label.userData.targetPixelHeight = themeMetric('spacing-dimension-label-screen-px');
      return label;
    }, updateDynamicSpacingLabel: (label, text) => { label.userData.dynamicSpacingText = text; } });
  const state = { ...snapshot, selectedOpeningId: 'active', showSpacingDimensions: false };
  scene.syncArchitectureSpacing(state);
  assert.equal(scene.architectureSpacingGroup.visible, true, 'Build guides ignore the optional furniture toggle');
  assert.equal(scene.architectureSpacingLabels.size, 4);
  const yByRow = new Map([...scene.architectureSpacingLabels.values()].map((label) => [label.userData.architectureMeasurementRow, label.position.y]));
  assert.ok(yByRow.get(1) < yByRow.get(0));
  scene.spacingDimensionLabels = new Map();
  scene.ensureSpacingHelpers();
  for (const property of ['linewidth', 'color', 'opacity', 'transparent', 'dashed', 'depthTest', 'depthWrite', 'worldUnits']) {
    const item = scene.spacingDimensionLines.material[property], architecture = scene.architectureSpacingLines.material[property];
    if (item instanceof THREE.Color) assert.equal(architecture.getHex(), item.getHex());
    else assert.equal(architecture, item);
  }
  for (const label of scene.architectureSpacingLabels.values()) {
    assert.equal(label.userData.targetPixelHeight, themeMetric('spacing-dimension-label-screen-px'));
    assert.equal(label.userData.spacingGapPaddingPx, 10);
  }
  const originalLabels = [...scene.architectureSpacingLabels.values()];
  scene.syncArchitectureSpacing({ ...state, openings: snapshot.openings.map((opening) => opening.id === 'active' ? { ...opening, offset: 2.7 } : opening) });
  assert.deepEqual([...scene.architectureSpacingLabels.values()], originalLabels, 'Live guides reuse their meshes');
  for (const position of [[12, 12, 12], [2.5, 12, 0.001], [12, 1.4, 12]]) {
    scene.camera.position.set(...position); scene.camera.lookAt(2.5, 0, 0);
    scene.layoutArchitectureSpacing();
    for (const label of scene.architectureSpacingLabels.values()) {
      if (!label.visible) continue;
      const base = label.userData.architectureMeasurementStart.clone().add(label.userData.architectureMeasurementEnd).multiplyScalar(0.5);
      const offset = label.position.clone().sub(base);
      assert.ok(offset.y <= 1e-8, 'No row is raised above the item centre');
      assert.ok(Math.abs(offset.dot(scene.architectureSpacingGroup.userData.wallTangent)) < 1e-8, 'Row separation cannot shift into the item width');
      if (label.userData.architectureMeasurementRow === 0) assert.ok(offset.length() < 1e-8);
      const start = label.userData.measurementStart.x, end = label.userData.measurementEnd.x;
      assert.ok(Math.max(start, end) <= 2.2 + 1e-8 || Math.min(start, end) >= 3.2 - 1e-8, 'Each guide stays outside the selected 1 m aperture');
    }
  }
  scene.syncArchitectureSpacing({ ...state, selectedOpeningId: null });
  assert.equal(scene.architectureSpacingGroup.visible, false);
  scene.disposeGroup(scene.helperGroup);
});

test('corner gap measurements include every collinear section in a densely split wall', () => {
  fresh();
  const original = getSnapshot(), width = original.room.width;
  const vertices = [{ id: 'v0', x: 0, z: 0 },
    ...Array.from({ length: 20 }, (_, index) => ({ id: `split-${index}`, x: width * (index + 1) / 21, z: 0 })),
    ...original.room.vertices.slice(1)];
  const room = { ...original.room, vertices, shapeKind: 'custom' };
  const position = geometry.perimeterLocation(room, 2.5);
  const opening = { id: 'active', type: 'window', variant: 'single-window', ...position, width: 1, height: 1.2, sillHeight: 0.75 };
  const measures = architectureSpacingMeasurements({ ...original, room, openings: [opening] }, opening.id);
  const left = measures.find((measurement) => measurement.id === 'left-wall');
  const right = measures.find((measurement) => measurement.id === 'right-wall');
  assert.ok(Math.abs(left.distance + opening.width + openingFrameOverhang(opening) * 2 + right.distance - width) < 1e-8);
  assert.equal(left.start.x, 0); assert.equal(right.end.x, width);
});

test('architectural spacing follows ceiling and wall visibility and centres its item row on each aperture', () => {
  fresh();
  let snapshot = { ...getSnapshot(), selectedOpeningId: 'active', showSpacingDimensions: false, showRoomDimensions: false,
    openings: [{ id: 'active', type: 'door', variant: 'single-door', wallId: 'wall-v0-v1',
      offset: 2.5, width: 0.9, height: 2.08, sillHeight: 0 }] };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { bridge: { getSnapshot: () => snapshot }, options: { interactiveArchitecture: true, showFurniture: false },
    currentCameraView: 'free', ceilingVisible: false, wallHiddenState: new Map(),
    camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(2.6, 1.3, 1.9) },
    container: { clientWidth: 1200, clientHeight: 800 }, helperGroup: new THREE.Group(), ceilingGroup: new THREE.Group(),
    wallsGroup: new THREE.Group(), floorGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(),
    updateInteriorWallView: () => {}, updateLightFixtureVisibility: () => {},
    createDynamicSpacingLabel: (text) => {
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
      label.userData.dynamicSpacingText = text; return label;
    }, updateDynamicSpacingLabel: (label, text) => { label.userData.dynamicSpacingText = text; } });
  const roomDimensions = new THREE.Group(); roomDimensions.userData.helperRole = 'roomDimensions';
  scene.helperGroup.add(roomDimensions);
  const setCamera = (x, y, z) => {
    scene.camera.position.set(x, y, z); scene.camera.lookAt(scene.controls.target);
    scene.updateCeilingVisibility(true); scene.updateCutawayWalls(true);
  };
  setCamera(12, 12, 12); scene.syncArchitectureSpacing(snapshot);
  assert.equal(scene.architectureSpacingGroup.visible, true);
  assert.equal(roomDimensions.visible, true);
  for (const [type, height, sillHeight] of [['door', 2.08, 0], ['window', 1.2, 0.8], ['opening', 0.75, 1]]) {
    snapshot = { ...snapshot, openings: [{ ...snapshot.openings[0], type, height, sillHeight }] };
    scene.syncArchitectureSpacing(snapshot);
    const label = scene.architectureSpacingLabels.get('left-item');
    assert.ok(Math.abs(label.position.y - sillHeight - height / 2) < 1e-8);
    assert.ok(label.userData.architectureMeasurementStart.y < snapshot.room.height);
  }
  setCamera(12, 1.4, 12);
  assert.equal(scene.ceilingVisible, true);
  assert.equal(roomDimensions.visible, false);
  assert.equal(scene.architectureSpacingGroup.visible, false);
  scene.syncArchitectureSpacing(snapshot);
  assert.equal(scene.architectureSpacingGroup.visible, false, 'An unchanged snapshot cannot reveal guides behind a closed ceiling');
  setCamera(12, 12, 12);
  assert.equal(roomDimensions.visible, true);
  assert.equal(scene.architectureSpacingGroup.visible, true, 'Orbiting back restores the same guide meshes');
  setCamera(2.5, 9, -8);
  assert.equal(scene.wallHiddenState.get('wall-v0-v1'), true);
  assert.equal(scene.architectureSpacingGroup.visible, false, 'Cutaway apertures cannot leave floating measurements');
  setCamera(12, 12, 12);
  assert.equal(scene.architectureSpacingGroup.visible, true);
  const divider = { id: 'divider-visibility', kind: 'wall', start: { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 },
    end: { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 } };
  snapshot = { ...snapshot, dividers: [divider], interiorWallView: 'up',
    openings: [{ ...snapshot.openings[0], wallId: divider.id, offset: 1.9, type: 'door', height: 2.08, sillHeight: 0 }] };
  scene.syncArchitectureSpacing(snapshot); assert.equal(scene.architectureSpacingGroup.visible, true);
  snapshot = { ...snapshot, interiorWallView: 'down' };
  scene.syncArchitectureSpacing(snapshot); assert.equal(scene.architectureSpacingGroup.visible, false);
  snapshot = { ...snapshot, interiorWallView: 'up' };
  scene.syncArchitectureSpacing(snapshot); assert.equal(scene.architectureSpacingGroup.visible, true);
  scene.syncArchitectureSpacing({ ...snapshot, selectedOpeningId: null });
  setCamera(12, 12, 12); assert.equal(scene.architectureSpacingGroup.visible, false);
  scene.disposeGroup(scene.helperGroup);
});

test('the nearest-target row falls back to a wall when no neighboring item exists', () => {
  fresh();
  const opening = { id: 'only', type: 'door', variant: 'single-door', wallId: 'wall-v0-v1',
    offset: 2, width: 0.9, height: 2.08, sillHeight: 0 };
  const measures = architectureSpacingMeasurements({ ...getSnapshot(), openings: [opening] }, opening.id);
  const byId = Object.fromEntries(measures.map((measurement) => [measurement.id, measurement]));
  assert.equal(measures.length, 4);
  for (const side of ['left', 'right']) {
    assert.equal(byId[`${side}-item`].kind, 'wall-gap');
    assert.equal(byId[`${side}-item`].distance, byId[`${side}-wall`].distance);
    assert.deepEqual(byId[`${side}-item`].start, byId[`${side}-wall`].start);
    assert.deepEqual(byId[`${side}-item`].end, byId[`${side}-wall`].end);
  }
});

test('sun height accepts five degrees, clamps lower values, and survives save and undo', () => {
  fresh();
  assert.equal(SUN_ELEVATION_MIN, 5);
  const before = getSnapshot();
  store.getState().setRoomLighting({ sunElevation: 5 });
  assert.equal(store.getState().room.lighting.sunElevation, 5);
  assert.equal(parseProjectSnapshot(JSON.parse(JSON.stringify(getSnapshot()))).room.lighting.sunElevation, 5);
  store.getState().undo(); assert.deepEqual(getSnapshot(), before);
  store.getState().redo(); assert.equal(store.getState().room.lighting.sunElevation, 5);
  store.getState().setRoomLighting({ sunElevation: 0 });
  assert.equal(store.getState().room.lighting.sunElevation, 5);
  store.getState().setRoomLighting({ sunElevation: 7 });
  assert.equal(store.getState().room.lighting.sunElevation, 7);
});

test('gap endpoints exclude the outer door cornice and window sill', () => {
  fresh();
  const door = { id: 'door', type: 'door', variant: 'double-door', wallId: 'wall-v0-v1',
    offset: 1.4, width: 1.6, height: 2.08, sillHeight: 0 };
  const window = { id: 'window', type: 'window', variant: 'double-window', wallId: door.wallId,
    offset: 3.8, width: 1.2, height: 1.2, sillHeight: 0.75 };
  const measures = architectureSpacingMeasurements({ ...getSnapshot(), openings: [door, window] }, door.id);
  const gap = measures.find((measurement) => measurement.id === 'right-item');
  assert.ok(Math.abs(gap.start.x - (door.offset + door.width / 2 + openingFrameOverhang(door))) < 1e-8);
  assert.ok(Math.abs(gap.end.x - (window.offset - window.width / 2 - openingFrameOverhang(window))) < 1e-8);
  assert.equal(gap.kind, 'item-gap');
});

test('circular and corner-wrapped gaps start at the full aperture edges, including across the seam', () => {
  for (const shape of ['circle', 'rectangle']) {
    fresh(shape);
    const snapshot = getSnapshot(), walls = geometry.getRoomWalls(snapshot.room);
    const opening = { id: 'wrapped', type: 'opening', variant: 'wall-opening', wallId: walls[0].id,
      offset: shape === 'circle' ? 0.2 : 0.1, width: 1.6, height: 1.2, sillHeight: 0.75 };
    const measures = architectureSpacingMeasurements({ ...snapshot, openings: [opening] }, opening.id);
    assert.equal(measures.length, 4, `${shape} keeps both rows when the anchor section is covered`);
    const startDistance = opening.offset - opening.width / 2, endDistance = opening.offset + opening.width / 2;
    const startLocation = geometry.perimeterLocation(snapshot.room, startDistance);
    const endLocation = geometry.perimeterLocation(snapshot.room, endDistance);
    const startWall = walls.find((wall) => wall.id === startLocation.wallId);
    const endWall = walls.find((wall) => wall.id === endLocation.wallId);
    const start = geometry.wallPoint(startWall, startLocation.offset), end = geometry.wallPoint(endWall, endLocation.offset);
    for (const measure of measures) {
      const left = measure.id.startsWith('left');
      const edge = left ? measure.end : measure.start, expected = left ? start : end;
      assert.ok(Math.hypot(edge.x - expected.x, edge.z - expected.z) < 1e-8);
      assert.ok(Math.abs(Math.hypot(measure.end.x - measure.start.x, measure.end.z - measure.start.z) - measure.distance) < 1e-8,
        'Every gap stays on its own wall outside the aperture');
    }
  }
});
