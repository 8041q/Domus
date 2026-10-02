import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(async () => { await vite.close(); });
const geometry = await vite.ssrLoadModule('/src/core/spaces.ts');
const placement = await vite.ssrLoadModule('/src/core/placement.ts');
const { usePlannerStore, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const wallViews = await vite.ssrLoadModule('/src/core/interiorWallView.ts');
const { cutWallGeometry } = await vite.ssrLoadModule('/src/renderer/interiorWallGeometry.ts');
const { createFloorSurfaceGeometry } = await vite.ssrLoadModule('/src/renderer/floorGeometry.ts');
const roomGeometry = await vite.ssrLoadModule('/src/core/roomGeometry.ts');

const room = {
  vertices: [
    { id: 'a', x: 0, z: 0 }, { id: 'b', x: 5, z: 0 },
    { id: 'c', x: 5, z: 4 }, { id: 'd', x: 0, z: 4 }
  ]
};
const wall = {
  id: 'divider-1', kind: 'wall',
  start: { kind: 'perimeter', id: 'wall-a-b', t: 0.5 },
  end: { kind: 'perimeter', id: 'wall-c-d', t: 0.5 }
};
const open = {
  id: 'divider-2', kind: 'open',
  start: { kind: 'perimeter', id: 'wall-d-a', t: 0.5 },
  end: { kind: 'divider', id: 'divider-1', t: 0.5 }
};
const crossing = {
  id: 'divider-3', kind: 'wall',
  start: { kind: 'perimeter', id: 'wall-d-a', t: 0.5 },
  end: { kind: 'perimeter', id: 'wall-b-c', t: 0.5 }
};

test('Walls up and down use flat heights for short, reversed and angled dividers', () => {
  const physical = geometry.getPhysicalWalls(room, [wall, crossing]).filter((w) => w.id.startsWith('divider-'));
  for (const w of [...physical, { ...physical[0], length: 0.1 }, { ...physical[0], tangent: { x: 0.6, z: 0.8 } }]) {
    assert.ok(wallViews.interiorWallProfile(w, 2.6, 'up').every((p) => p.height === 2.6));
    assert.ok(wallViews.interiorWallProfile(w, 2.6, 'down').every((p) => p.height === 0.22));
  }
});

for (const preset of ['front', 'back', 'left', 'right', 'top']) {
  test(`orbit from ${preset} enters Free cam; zoom and pan retain the preset and wall mode`, () => {
    const events = [];
    usePlannerStore.getState().setInteriorWallView('down');
    usePlannerStore.getState().setPlanView(preset);
    const scene = Object.create(PlannerScene.prototype);
    Object.assign(scene, { currentCameraView: preset, controlsInteracting: false,
      controlsInteractionStartDirection: new THREE.Vector3(), camera: new THREE.PerspectiveCamera(32),
      controls: { target: new THREE.Vector3(2, 1, 2), maxDistance: 20 },
      bridge: { cameraViewChanged: (view) => { events.push(view); usePlannerStore.getState().setPlanView(view); } },
      updateCeilingVisibility: () => {}, updateCutawayWalls: () => {}, requestRender: () => {} });
    const offsets = { front: [0, 0, -7], back: [0, 0, 7], left: [-7, 0, 0], right: [7, 0, 0], top: [0, 7, 0.01] };
    scene.camera.position.copy(scene.controls.target).add(new THREE.Vector3(...offsets[preset]));
    scene.controlsInteracting = true;
    scene.controlsInteractionStartDirection.copy(scene.camera.position).sub(scene.controls.target).normalize();
    scene.camera.position.copy(scene.controls.target).addScaledVector(scene.controlsInteractionStartDirection, 9);
    scene.handleControlsChange();
    assert.equal(scene.currentCameraView, preset, 'Wheel zoom should preserve the preset');
    scene.camera.position.x += 1; scene.controls.target.x += 1;
    scene.handleControlsChange();
    assert.equal(scene.currentCameraView, preset, 'Pan should preserve the preset');
    const offset = scene.camera.position.clone().sub(scene.controls.target).applyAxisAngle(new THREE.Vector3(1, 1, 0).normalize(), 0.1);
    scene.camera.position.copy(scene.controls.target).add(offset);
    const direction = scene.camera.position.clone().sub(scene.controls.target).normalize();
    const framedSize = scene.camera.position.distanceTo(scene.controls.target) * Math.tan(scene.camera.fov * Math.PI / 360);
    scene.handleControlsChange();
    assert.equal(scene.currentCameraView, 'free');
    assert.deepEqual(events, ['free']);
    assert.equal(usePlannerStore.getState().interiorWallView, 'down');
    assert.equal(usePlannerStore.getState().planView, 'free');
    assert.ok(scene.camera.position.clone().sub(scene.controls.target).normalize().distanceTo(direction) < 1e-8);
    assert.ok(Math.abs(scene.camera.position.distanceTo(scene.controls.target) * Math.tan(scene.camera.fov * Math.PI / 360) - framedSize) < 1e-8);
    scene.handleControlsChange();
    assert.equal(events.length, 1);
  });
}

test('wall reveal geometry closes flat cross-sections and removes lowered doorway lintels', () => {
  const profile = [{ x: 0, height: 0.22 }, { x: 4, height: 0.22 }];
  const mesh = cutWallGeometry(0, 4, 0, 2.6, 0.05, profile);
  const edges = new Map();
  const pos = mesh.getAttribute('position');
  const key = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)].map((v) => v.toFixed(5)).join(',');
  for (let i = 0; i < pos.count; i += 3) {
    const corners = [key(i), key(i + 1), key(i + 2)];
    for (let j = 0; j < 3; j++) {
      const pair = [corners[j], corners[(j + 1) % 3]].sort().join('|');
      edges.set(pair, (edges.get(pair) ?? 0) + 1);
    }
  }
  assert.ok([...edges.values()].every((count) => count === 2));
  assert.ok(mesh.groups.some((group) => group.materialIndex === 0));
  const lintel = cutWallGeometry(1.2, 2.8, 2.08, 2.6, 0.05, profile);
  assert.equal(lintel.getAttribute('position').count, 0);
  mesh.dispose(); lintel.dispose();
});

test('Walls down preserves exterior visibility, doorway thresholds, lighting and full export geometry', () => {
  const snapshot = { ...getSnapshot(), room: { ...getSnapshot().room, ...room }, dividers: [wall], spaces: [], objects: [],
    openings: [{ id: 'inner-door', type: 'door', variant: 'single-door', wallId: wall.id, width: 0.9, offset: 2, height: 2.08, sillHeight: 0 }],
    interiorWallView: 'down' };
  snapshot.spaces = geometry.deriveSpaces(snapshot).map((space, index) => ({ ...space, floorFinish: index ? 'carpet-011' : 'wood-floor-057' }));
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { bridge: { getSnapshot: () => snapshot }, camera: new THREE.PerspectiveCamera(),
    controls: { target: new THREE.Vector3(1, 1, 2) }, currentCameraView: 'free', wallHiddenState: new Map(),
    interiorProfiles: new Map(), interiorViewKey: '', wallsGroup: new THREE.Group(), interiorViewGroup: new THREE.Group(),
    daylightGroup: new THREE.Group(), floorGroup: new THREE.Group(), ceilingGroup: new THREE.Group(), objectGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(),
    floorMapResults: new Map(), requestRender: () => {} });
  scene.camera.position.set(8, 8, 8);
  scene.rebuildWalls(snapshot);
  scene.rebuildWindowDaylighting(snapshot);
  for (let i = 0; i < 30; i++) scene.updateCutawayWalls();
  const exterior = scene.wallsGroup.children.filter((mesh) => !mesh.userData.cutawayWallId?.startsWith('divider-')).map((mesh) => mesh.visible);
  assert.ok(scene.interiorViewGroup.children.some((mesh) => mesh.name === 'Dropped doorway edge inner-door'));
  assert.ok(scene.wallsGroup.children.filter((mesh) => mesh.userData.openingId === 'inner-door').every((mesh) => !mesh.visible));
  assert.equal(scene.wallsGroup.children.find((mesh) => mesh.name === 'Threshold inner-door').visible, true);
  assert.equal(scene.daylightGroup.children[0].castShadow, true);
  const full = scene.wallsGroup.children.find((mesh) => mesh.userData.interiorSection?.top === 2.6);
  assert.equal(full.geometry.parameters.height, 2.6);
  const exported = scene.collectExportItems().find((item) => item.id === wall.id);
  assert.ok(exported);
  const exportNode = scene.buildExportItem(exported);
  exportNode.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(exportNode);
  assert.ok(Math.abs(bounds.max.y - bounds.min.y - 2.6) < 1e-5);
  assert.ok(!scene.collectExportItems().some((item) => item.name.startsWith('Wall reveal')));
  scene.disposeGroup(exportNode);
  snapshot.interiorWallView = 'up';
  snapshot.selectedSpaceId = snapshot.spaces.find((space) => space.seed.x > 2.5).id;
  for (let i = 0; i < 35; i++) scene.updateCutawayWalls();
  assert.deepEqual(scene.wallsGroup.children.filter((mesh) => !mesh.userData.cutawayWallId?.startsWith('divider-')).map((mesh) => mesh.visible), exterior);
  assert.equal(full.visible, true);
  assert.ok(scene.wallsGroup.children.filter((mesh) => mesh.userData.openingId === 'inner-door').every((mesh) => mesh.visible));
  for (const group of [scene.wallsGroup, scene.interiorViewGroup, scene.architecturalShadeGroup]) scene.disposeGroup(group);
  scene.disposeDaylightRig();
});

test('interior daylight blockers respect solid doors, glass and passages independently of cutaway walls', () => {
  const scene = Object.create(PlannerScene.prototype);
  scene.daylightGroup = new THREE.Group();
  const base = { ...getSnapshot(), room: { ...getSnapshot().room, ...room }, dividers: [wall], objects: [], openings: [] };
  const door = { id: 'door', type: 'door', variant: 'single-door', wallId: wall.id,
    offset: 2, width: 0.9, height: 2.08, sillHeight: 0 };
  const blocked = (height = 1, z = 2) => {
    scene.daylightGroup.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(1, height, z), new THREE.Vector3(1, 0, 0));
    return ray.intersectObjects(scene.daylightGroup.children).some((hit) => hit.object.isMesh);
  };
  for (const [opening, expected] of [[null, true], [door, true], [{ ...door, variant: 'glass-door' }, false],
    [{ ...door, variant: 'door-frame' }, false], [{ ...door, type: 'opening' }, false]]) {
    scene.rebuildWindowDaylighting({ ...base, openings: opening ? [opening] : [] });
    const blocker = scene.daylightGroup.children.find((child) => child.isMesh);
    assert.equal(blocker.castShadow, true);
    assert.equal(blocker.visible, true);
    assert.equal(blocker.userData.cutawayWallId, undefined);
    assert.equal(blocker.material.colorWrite, false);
    assert.equal(blocker.material.depthWrite, false);
    assert.equal(blocked(), expected);
    assert.equal(blocked(2.4), true);
    assert.equal(blocked(1, 0.5), true);
  }
  scene.rebuildWindowDaylighting({ ...base, dividers: [{ ...wall, kind: 'open' }] });
  assert.equal(blocked(), false);
  scene.disposeDaylightRig();
});

test('window fill lights cast shadows with physical interior walls and dispose their shadow maps', () => {
  const scene = Object.create(PlannerScene.prototype);
  scene.daylightGroup = new THREE.Group();
  const window = { id: 'window', type: 'window', variant: 'double-window', wallId: 'wall-a-b',
    offset: 2, width: 1.2, height: 1.1, sillHeight: 0.9 };
  const base = { ...getSnapshot(), room: { ...getSnapshot().room, ...room }, dividers: [wall], openings: [window] };
  scene.rebuildWindowDaylighting(base);
  const light = scene.daylightGroup.children.find((child) => child.isSpotLight);
  assert.equal(light.castShadow, true);
  assert.equal(light.shadow.mapSize.width, 512);
  let disposed = false;
  light.shadow.dispose = () => { disposed = true; };
  scene.rebuildWindowDaylighting({ ...base, openings: [{ ...window, offset: 2.2 }] });
  assert.equal(scene.daylightGroup.children.find((child) => child.isSpotLight), light);
  assert.equal(disposed, false);
  assert.equal(light.position.x, 2.2);
  scene.rebuildWindowDaylighting({ ...base, dividers: [{ ...wall, kind: 'open' }] });
  assert.equal(disposed, true);
  assert.equal(scene.daylightGroup.children.find((child) => child.isSpotLight).castShadow, false);
  assert.equal(scene.daylightGroup.children.some((child) => child.isMesh), false);
  scene.disposeDaylightRig();
});

test('physical and open boundaries create connected spaces with conserved area', () => {
  for (const [dividers, count] of [[[], 1], [[wall], 2], [[wall, open], 3], [[wall, crossing], 4]]) {
    assert.equal(geometry.validateDividers(room, dividers), true);
    const faces = geometry.deriveSpacePolygons(room, dividers);
    assert.equal(faces.length, count);
    const total = faces.reduce((sum, polygon) => sum + Math.abs(polygon.reduce((area, a, index) => {
      const b = polygon[(index + 1) % polygon.length];
      return area + a.x * b.z - b.x * a.z;
    }, 0) / 2), 0);
    assert.ok(Math.abs(total - 20) < 1e-6);
  }
});

test('divider endpoints follow their supporting wall and nested junction', () => {
  const moved = { ...room, vertices: room.vertices.map((vertex) => vertex.id === 'a' || vertex.id === 'b'
    ? { ...vertex, z: -1 } : vertex) };
  const [first, second] = geometry.resolveDividers(moved, [wall, open]);
  assert.equal(first.a.z, -1);
  assert.equal(first.b.z, 4);
  assert.equal(second.b.z, 1.5);
});

test('furniture can overlap interior sections, door gaps and invisible boundaries', () => {
  const chair = { id: 'test-chair', productId: 'chair', x: 2.5, z: 1, rotationY: 0 };
  const closed = { ...room, dividers: [wall], openings: [] };
  assert.equal(placement.isPlacementValid(chair, closed, []), true);
  const doorway = { ...closed, openings: [{ id: 'door', type: 'door', variant: 'single-door', wallId: wall.id,
    offset: 1, width: 0.9, height: 2.08, sillHeight: 0 }] };
  assert.equal(placement.isPlacementValid(chair, doorway, []), true);
  assert.equal(placement.isPlacementValid(chair, { ...room, dividers: [{ ...wall, kind: 'open' }], openings: [] }, []), true);
});

test('interior wall snapping uses a 12 cm entry and 20 cm exit gap on either face', () => {
  const closed = { ...room, dividers: [wall], openings: [] };
  for (const rotationY of [0, Math.PI / 4, Math.PI / 2]) for (const side of [-1, 1]) {
    const moving = { id: 'chair', productId: 'chair', x: 2.5 + side, z: 1, rotationY };
    const footprint = placement.objectFootprintCorners({ ...moving, x: 0, z: 0 });
    const support = Math.max(...footprint.map((p) => -side * p.x));
    const face = 2.5 + side * (support + 0.0255);
    const outside = placement.resolvePlacement(moving, face + side * 0.1201, 1, closed, []);
    assert.equal(outside.snap.x, undefined);
    const first = placement.resolvePlacement(moving, face + side * 0.1199, 1, closed, []);
    assert.equal(first.snap.x?.targetId, wall.id);
    assert.ok(Math.abs(first.x - face) < 1e-8);
    const held = placement.resolvePlacement({ ...moving, x: first.x }, face - side * 0.1999, 1, closed, [], { previousSnap: first.snap });
    assert.ok(Math.abs(held.x - face) < 1e-8);
    const released = placement.resolvePlacement({ ...moving, x: held.x }, face - side * 0.2001, 1, closed, [], { previousSnap: held.snap });
    assert.equal(released.snap.x, undefined);
    assert.ok(Math.abs(released.x - (face - side * 0.2001)) < 1e-8);
    const crossed = placement.resolvePlacement({ ...moving, x: released.x }, 2.5 - side, 1, closed, [], { previousSnap: released.snap });
    assert.equal(crossed.x, 2.5 - side);
  }
});

test('exterior wall snapping retains its 18 mm entry and 21 mm exit gap', () => {
  const moving = { id: 'chair', productId: 'chair', x: 1, z: 1, rotationY: 0 };
  const face = 0.205 + 0.0255;
  const first = placement.resolvePlacement(moving, face + 0.0179, 1, room, []);
  assert.equal(first.snap.x?.targetId, 'wall-d-a');
  assert.ok(Math.abs(first.x - face) < 1e-8);
  const held = placement.resolvePlacement({ ...moving, x: first.x }, face + 0.0209, 1, room, [], { previousSnap: first.snap });
  assert.ok(Math.abs(held.x - face) < 1e-8);
  const released = placement.resolvePlacement({ ...moving, x: held.x }, face + 0.0211, 1, room, [], { previousSnap: held.snap });
  assert.equal(released.snap.x, undefined);
  assert.ok(Math.abs(released.x - (face + 0.0211)) < 1e-8);
});

test('Shift still bypasses the larger interior snap band and door gaps do not attract furniture', () => {
  const moving = { id: 'chair', productId: 'chair', x: 1, z: 1, rotationY: 0 };
  const closed = { ...room, dividers: [wall], openings: [] };
  const face = 2.5 - 0.205 - 0.0255;
  const snapped = placement.resolvePlacement(moving, face - 0.05, 1, closed, []);
  assert.equal(snapped.snap.x?.targetId, wall.id);
  const free = placement.resolvePlacement({ ...moving, x: snapped.x }, face + 0.05, 1, closed, [], {
    enterSnapDistance: 0, exitSnapDistance: 0, spatialWallSnap: false, previousSnap: snapped.snap, allowOverlap: true
  });
  assert.equal(free.snap.x, undefined);
  assert.ok(Math.abs(free.x - (face + 0.05)) < 1e-8);
  const doorway = { ...closed, openings: [{ id: 'door', type: 'door', variant: 'single-door', wallId: wall.id,
    offset: 1, width: 0.9, height: 2.08, sillHeight: 0 }] };
  assert.equal(placement.resolvePlacement(moving, face - 0.05, 1, doorway, []).snap.x, undefined);
});

test('wall-affinity furniture releases contact rotation beyond the interior snap gap', () => {
  const closed = { ...room, dividers: [wall], openings: [] };
  const sofa = { id: 'sofa', productId: 'sofa', x: 1.4145, z: 1, rotationY: 0 };
  const crossed = placement.resolvePlacement(sofa, 3.8, 1, closed, [], { spatialWallSnap: true });
  assert.equal(crossed.x, 3.8);
  assert.equal(crossed.rotationY, 0);
  const through = placement.resolvePlacement({ ...sofa, x: 2.4 }, 3.8, 1, closed, [], { spatialWallSnap: true });
  assert.equal(through.x, 3.8);
  assert.equal(through.rotationY, 0);
});

test('automatic spaces, undo, redo, save and legacy load retain expected state', () => {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  usePlannerStore.getState().resetProject();
  assert.equal(usePlannerStore.getState().addDivider('wall',
    { kind: 'perimeter', id: 'wall-v0-v1', t: 0.25 },
    { kind: 'perimeter', id: 'wall-v2-v3', t: 0.75 }), true);
  const newId = getSnapshot().spaces[1].id;
  assert.equal(getSnapshot().spaces.length, 2);
  usePlannerStore.getState().undo();
  assert.equal(getSnapshot().dividers.length, 0);
  usePlannerStore.getState().redo();
  assert.equal(getSnapshot().spaces[1].id, newId);
  usePlannerStore.getState().updateSpace(newId, { name: 'Corridor', floorFinish: 'wood-floor-057' });
  usePlannerStore.getState().saveLocal();
  usePlannerStore.getState().resetProject();
  assert.equal(usePlannerStore.getState().loadLocal(), true);
  assert.equal(getSnapshot().dividers.length, 1);
  values.delete('room-planner-project-v4');
  const legacy = getSnapshot();
  delete legacy.dividers;
  delete legacy.spaces;
  values.set('room-planner-project-v3', JSON.stringify(legacy));
  assert.equal(usePlannerStore.getState().loadLocal(), true);
  assert.equal(getSnapshot().dividers.length, 0);
  assert.equal(getSnapshot().spaces.length, 1);
});

test('ordinary divider resizing preserves identities even when the old seed changes sides', () => {
  usePlannerStore.getState().resetProject();
  usePlannerStore.getState().addDivider('wall',
    { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 },
    { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 });
  const before = getSnapshot();
  const id = before.dividers[0].id;
  usePlannerStore.getState().updateSpace(before.spaces[0].id, { name: 'Reception', wallColor: '#cc8844' });
  assert.equal(usePlannerStore.getState().updateDivider(id, {
    start: { kind: 'perimeter', id: 'wall-v0-v1', t: 0.1 },
    end: { kind: 'perimeter', id: 'wall-v2-v3', t: 0.9 }
  }), true);
  assert.equal(getSnapshot().spaces.find((space) => space.id === before.spaces[0].id).name, 'Reception');
  assert.deepEqual(geometry.deriveSpaces(getSnapshot()).map((space) => space.id), before.spaces.map((space) => space.id));
  const prior = getSnapshot();
  usePlannerStore.getState().removeDivider(id);
  usePlannerStore.getState().undo();
  assert.deepEqual(getSnapshot(), prior);
  usePlannerStore.getState().setRoomTemplate('l-shape');
  usePlannerStore.getState().undo();
  assert.deepEqual(getSnapshot(), prior);
});

test('invalid connections, exterior-overlapping dividers and doorway junctions are rejected', () => {
  assert.equal(geometry.validateDividers(room, [{ ...wall, end: { kind: 'divider', id: wall.id, t: 0.5 } }]), false);
  assert.equal(geometry.validateDividers(room, [wall, { ...wall, id: 'duplicate' }]), false);
  assert.equal(geometry.validateDividers(room, [{ ...wall,
    start: { kind: 'perimeter', id: 'wall-a-b', t: 0.1 },
    end: { kind: 'perimeter', id: 'wall-a-b', t: 0.9 } }]), false);
  const opening = { id: 'door', type: 'door', variant: 'single-door', wallId: wall.id, offset: 2,
    width: 0.9, height: 2.08, sillHeight: 0 };
  assert.equal(geometry.validateInteriorOpenings(room, [wall, crossing], [opening]), false);
  assert.equal(geometry.validateInteriorOpenings(room, [wall, open], [opening]), true);
  assert.equal(geometry.validateInteriorOpenings(room, [wall], [{ ...opening, type: 'window' }]), false);
});

test('fast drags cross solid divisions and doorways while respecting the exterior shell', () => {
  const chair = { id: 'test-chair', productId: 'chair', x: 1, z: 1, rotationY: 0 };
  const closed = { ...room, dividers: [wall], openings: [] };
  assert.equal(placement.resolvePlacement(chair, 4, 1, closed, []).x, 4);
  assert.ok(placement.resolvePlacement(chair, 9, 1, closed, []).x < 5);
  assert.ok(placement.resolvePlacement(chair, 4, 1, closed, [{ ...chair, id: 'obstacle', x: 3 }]).x < 3);
  const doorway = { ...closed, openings: [{ id: 'door', type: 'door', variant: 'single-door', wallId: wall.id,
    offset: 1, width: 0.9, height: 2.08, sillHeight: 0 }] };
  assert.ok(placement.resolvePlacement(chair, 4, 1, doorway, [], { enterSnapDistance: 0 }).x > 3.9);
  assert.ok(placement.resolvePlacement(chair, 4, 1, { ...closed, dividers: [{ ...wall, kind: 'open' }] }, [], { enterSnapDistance: 0 }).x > 3.9);
});

test('doors can be moved or removed while furniture overlaps their divider', () => {
  usePlannerStore.getState().resetProject();
  usePlannerStore.getState().addDivider('wall',
    { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 },
    { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 });
  usePlannerStore.getState().addOpening('door');
  const door = getSnapshot().openings.find((opening) => opening.wallId.startsWith('divider-'));
  assert.ok(door);
  usePlannerStore.setState({ objects: [{ id: 'test-chair', productId: 'chair', x: 2.6, z: door.offset, rotationY: 0 }] });
  usePlannerStore.getState().updateOpening(door.id, { offset: 0.7 });
  assert.equal(getSnapshot().openings.find((opening) => opening.id === door.id).offset, 0.7);
  usePlannerStore.getState().removeOpening(door.id);
  assert.ok(!getSnapshot().openings.some((opening) => opening.id === door.id));
});

test('3D wall faces change colour at junctions and thresholds only join different door finishes', () => {
  usePlannerStore.getState().resetProject();
  const snapshot = { ...getSnapshot(), room: { ...getSnapshot().room, vertices: room.vertices }, dividers: [wall, open], openings: [], spaces: [] };
  snapshot.spaces = geometry.deriveSpaces(snapshot).map((space, index) => ({ ...space, id: `space-${index}`,
    wallColor: ['#cc0000', '#00cc00', '#0000cc'][index], floorFinish: index === 0 ? 'wood-floor-057' : 'carpet-011' }));
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { wallsGroup: new THREE.Group(), interiorViewGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(), floorMapResults: new Map() });
  scene.rebuildWalls(snapshot);
  const walls = scene.wallsGroup.children.filter((mesh) => mesh.name === `Interior wall ${wall.id}`);
  assert.equal(walls.length, 2);
  for (const mesh of walls) {
    const inward = geometry.getPhysicalWalls(snapshot.room, snapshot.dividers).find((item) => item.id === wall.id).inward;
    const left = geometry.spaceAtPoint(snapshot, { x: mesh.position.x + inward.x * 0.06, z: mesh.position.z + inward.z * 0.06 });
    const right = geometry.spaceAtPoint(snapshot, { x: mesh.position.x - inward.x * 0.06, z: mesh.position.z - inward.z * 0.06 });
    assert.equal(`#${mesh.material[4].color.getHexString()}`, left.wallColor);
    assert.equal(`#${mesh.material[5].color.getHexString()}`, right.wallColor);
  }
  snapshot.openings = [{ id: 'interior-door', type: 'door', variant: 'single-door', wallId: wall.id,
    offset: 1, width: 0.9, height: 2.08, sillHeight: 0 }];
  scene.rebuildWalls(snapshot);
  const thresholds = () => scene.wallsGroup.children.filter((mesh) => mesh.name.startsWith('Threshold'));
  assert.equal(thresholds().length, 1);
  const threshold = thresholds()[0];
  assert.ok(scene.wallsGroup.children.some((mesh) => mesh.userData.openingId === 'interior-door'
    && mesh.material.color?.equals(threshold.material.color)));
  snapshot.openings[0].variant = 'door-frame';
  scene.rebuildWalls(snapshot);
  assert.equal(thresholds().length, 0);
  snapshot.openings[0].type = 'opening';
  scene.rebuildWalls(snapshot);
  assert.equal(thresholds().length, 0);
  snapshot.openings[0].type = 'door';
  snapshot.openings[0].variant = 'single-door';
  snapshot.spaces = snapshot.spaces.map((space) => ({ ...space, floorFinish: 'carpet-011' }));
  scene.rebuildWalls(snapshot);
  assert.equal(thresholds().length, 0);
  scene.disposeGroup(scene.wallsGroup);
});

test('named floors form upward surfaces with a shared seam and survive binary GLB export', async () => {
  usePlannerStore.getState().resetProject();
  const snapshot = { ...getSnapshot(), room: { ...getSnapshot().room, vertices: room.vertices }, dividers: [wall], openings: [], spaces: [] };
  snapshot.spaces = geometry.deriveSpaces(snapshot).map((space, index) => ({ ...space, id: `space-${index}`,
    name: index === 0 ? 'Reception' : 'Corridor', floorFinish: index === 0 ? 'wood-floor-057' : 'carpet-011' }));
  snapshot.openings = [{ id: 'door', type: 'door', variant: 'single-door', wallId: wall.id,
    offset: 1, width: 0.9, height: 2.08, sillHeight: 0, doorFlipped: true }];
  const scene = Object.create(PlannerScene.prototype);
  const emptyMaps = { color: null, normal: null, height: null, roughness: null };
  Object.assign(scene, {
    wallsGroup: new THREE.Group(), interiorViewGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(), floorGroup: new THREE.Group(),
    ceilingGroup: new THREE.Group(), objectGroup: new THREE.Group(),
    spaceFloorMaterials: new Set(), wallHiddenState: new Map(),
    floorMapResults: new Map([['carpet-011', emptyMaps], ['wood-floor-057', emptyMaps]])
  });
  for (const method of ['rebuildCeiling', 'rebuildCeilingLighting', 'rebuildWindowDaylighting', 'rebuildSunset', 'applyRoomLighting']) scene[method] = () => {};
  scene.rebuildRoom(snapshot);
  const floors = scene.floorGroup.children.filter((mesh) => mesh.userData.domusSpaceName);
  assert.equal(floors.length, 2);
  const seam = [];
  for (const floor of floors) {
    const positions = floor.geometry.getAttribute('position'), normals = floor.geometry.getAttribute('normal');
    const edge = [];
    let area = 0;
    for (let i = 0; i < normals.count; i++) {
      assert.ok(normals.getY(i) > 0.99);
      assert.ok(positions.getX(i) >= 0.025 - 1e-6 && positions.getX(i) <= 4.975 + 1e-6);
      assert.ok(positions.getZ(i) >= 0.025 - 1e-6 && positions.getZ(i) <= 3.975 + 1e-6);
      const uv = floor.geometry.getAttribute('uv');
      assert.ok(Math.abs(uv.getX(i) - positions.getX(i)) < 1e-6 && Math.abs(uv.getY(i) - positions.getZ(i)) < 1e-6);
    }
    for (let i = 0; i < positions.count; i += 3) {
      area += Math.abs((positions.getX(i + 1) - positions.getX(i)) * (positions.getZ(i + 2) - positions.getZ(i))
        - (positions.getZ(i + 1) - positions.getZ(i)) * (positions.getX(i + 2) - positions.getX(i))) / 2;
      const points = [i, i + 1, i + 2].filter((j) => Math.abs(positions.getX(j) - 2.5) < 1e-6).map((j) => positions.getZ(j));
      if (points.length === 2) edge.push([Math.min(...points), Math.max(...points)]);
    }
    assert.ok(Math.abs(area - 2.475 * 3.95) < 1e-5);
    // Both tessellated surfaces must cover the complete shared seam without gaps.
    edge.sort((a, b) => a[0] - b[0]);
    let end = 0.025;
    for (const interval of edge) { assert.ok(interval[0] <= end + 1e-6); end = Math.max(end, interval[1]); }
    assert.ok(Math.abs(end - 3.975) < 1e-6);
    seam.push([edge[0][0].toFixed(5), end.toFixed(5)]);
  }
  assert.deepEqual(seam[0], seam[1]);
  const slab = scene.floorGroup.children.find((mesh) => mesh.name === 'Floor');
  assert.ok(!slab.geometry.groups.some((group) => group.materialIndex === 1));
  const root = new THREE.Group();
  for (const item of scene.collectExportItems()) {
    const node = scene.buildExportItem(item);
    if (node) root.add(node);
  }
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const priorReader = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      void blob.arrayBuffer().then((result) => { this.result = result; this.onloadend?.(); });
    }
  };
  try {
    const binary = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false, trs: true });
    const view = new DataView(binary);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, view.getUint32(12, true))));
    for (const name of ['Floor - Reception', 'Floor - Corridor', `Interior wall ${wall.id}`, 'Threshold door']) {
      assert.ok(gltf.nodes.some((node) => node.name === name), `Missing export item: ${name}`);
    }
    assert.ok(gltf.nodes.some((node) => node.extras?.domusFloorFinish === 'wood-floor-057'));
    assert.ok(gltf.nodes.some((node) => node.extras?.domusDoorFlipped === true));
    for (const name of ['Floor - Reception', 'Floor - Corridor']) {
      const node = gltf.nodes.find((node) => node.name === name);
      const meshNode = node.mesh != null ? node : gltf.nodes[node.children[0]];
      const accessor = gltf.accessors[gltf.meshes[meshNode.mesh].primitives[0].attributes.POSITION];
      const offset = (axis) => (node.translation?.[axis] ?? 0) + (meshNode === node ? 0 : meshNode.translation?.[axis] ?? 0);
      assert.ok(accessor.min[0] + offset(0) >= 0.025 - 1e-6 && accessor.max[0] + offset(0) <= 4.975 + 1e-6);
      assert.ok(accessor.min[2] + offset(2) >= 0.025 - 1e-6 && accessor.max[2] + offset(2) <= 3.975 + 1e-6);
    }
  } finally {
    globalThis.FileReader = priorReader;
    for (const group of [scene.floorGroup, scene.wallsGroup, scene.architecturalShadeGroup, root]) scene.disposeGroup(group);
  }
});

test('floor finishes match mitered slab edges in angled, concave, reversed and divided rooms', () => {
  const scene = Object.create(PlannerScene.prototype);
  for (const shape of ['rectangle', 'angled-corner', 'l-shape', 'recess']) for (const reversed of [false, true]) {
    let vertices = roomGeometry.roomTemplate(shape, 5, 4).map((p) => ({ ...p,
      x: 10 + p.x * Math.cos(0.37) - p.z * Math.sin(0.37),
      z: -7 + p.x * Math.sin(0.37) + p.z * Math.cos(0.37) }));
    if (reversed) vertices = vertices.reverse();
    const snapshot = { room: { ...getSnapshot().room, vertices }, dividers: [], spaces: [] };
    const inner = scene.insetRoomVertices(snapshot, 0.025);
    const floor = createFloorSurfaceGeometry(vertices, inner);
    const p = floor.getAttribute('position');
    let area = 0;
    for (let i = 0; i < p.count; i += 3) {
      const triangle = [i, i + 1, i + 2].map((j) => ({ x: p.getX(j), z: p.getZ(j) }));
      const centre = { x: triangle.reduce((n, v) => n + v.x, 0) / 3, z: triangle.reduce((n, v) => n + v.z, 0) / 3 };
      assert.equal(roomGeometry.pointInRoom(centre, { vertices: inner }), true, `${shape}: floor bridges recess`);
      for (const point of triangle) assert.equal(roomGeometry.pointInRoom(point, { vertices: inner }), true);
      area += Math.abs(roomGeometry.polygonArea(triangle));
    }
    assert.ok(Math.abs(area - Math.abs(roomGeometry.polygonArea(inner))) < 1e-5, `${shape}: floor leaves gaps or overlaps`);
    floor.dispose();
  }
  const inner = [{ x: 0.025, z: 0.025 }, { x: 4.975, z: 0.025 }, { x: 4.975, z: 3.975 }, { x: 0.025, z: 3.975 }];
  // A tiny space wholly under the wall must not invert and spill outside the slab.
  const strip = createFloorSurfaceGeometry([{ x: 0, z: 0 }, { x: 0.01, z: 0 }, { x: 0.01, z: 4 }, { x: 0, z: 4 }], inner);
  assert.equal(strip.getAttribute('position').count, 0);
  strip.dispose();
});
