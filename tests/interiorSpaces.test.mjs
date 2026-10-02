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

test('furniture is blocked by wall sections, passes a door gap, and crosses an open divider', () => {
  const chair = { id: 'test-chair', productId: 'chair', x: 2.5, z: 1, rotationY: 0 };
  const closed = { ...room, dividers: [wall], openings: [] };
  assert.equal(placement.isPlacementValid(chair, closed, []), false);
  const doorway = { ...closed, openings: [{ id: 'door', type: 'door', variant: 'single-door', wallId: wall.id,
    offset: 1, width: 0.9, height: 2.08, sillHeight: 0 }] };
  assert.equal(placement.isPlacementValid(chair, doorway, []), true);
  assert.equal(placement.isPlacementValid(chair, { ...room, dividers: [{ ...wall, kind: 'open' }], openings: [] }, []), true);
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

test('solid-wall collision prevents fast dragging across a wall but allows a wide doorway', () => {
  const chair = { id: 'test-chair', productId: 'chair', x: 1, z: 1, rotationY: 0 };
  const closed = { ...room, dividers: [wall], openings: [] };
  assert.ok(placement.resolvePlacement(chair, 4, 1, closed, [], { enterSnapDistance: 0 }).x < 2.5);
  const doorway = { ...closed, openings: [{ id: 'door', type: 'door', variant: 'single-door', wallId: wall.id,
    offset: 1, width: 0.9, height: 2.08, sillHeight: 0 }] };
  assert.ok(placement.resolvePlacement(chair, 4, 1, doorway, [], { enterSnapDistance: 0 }).x > 3.9);
  assert.ok(placement.resolvePlacement(chair, 4, 1, { ...closed, dividers: [{ ...wall, kind: 'open' }] }, [], { enterSnapDistance: 0 }).x > 3.9);
});

test('closing an occupied interior door is rejected', () => {
  usePlannerStore.getState().resetProject();
  usePlannerStore.getState().addDivider('wall',
    { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 },
    { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 });
  usePlannerStore.getState().addOpening('door');
  const door = getSnapshot().openings.find((opening) => opening.wallId.startsWith('divider-'));
  assert.ok(door);
  usePlannerStore.setState({ objects: [{ id: 'test-chair', productId: 'chair', x: 2.6, z: door.offset, rotationY: 0 }] });
  usePlannerStore.getState().removeOpening(door.id);
  assert.ok(getSnapshot().openings.some((opening) => opening.id === door.id));
  usePlannerStore.getState().updateOpening(door.id, { offset: 0.7 });
  assert.equal(getSnapshot().openings.find((opening) => opening.id === door.id).offset, door.offset);
});

test('3D wall faces change colour at junctions and thresholds only join different door finishes', () => {
  usePlannerStore.getState().resetProject();
  const snapshot = { ...getSnapshot(), room: { ...getSnapshot().room, vertices: room.vertices }, dividers: [wall, open], openings: [], spaces: [] };
  snapshot.spaces = geometry.deriveSpaces(snapshot).map((space, index) => ({ ...space, id: `space-${index}`,
    wallColor: ['#cc0000', '#00cc00', '#0000cc'][index], floorFinish: index === 0 ? 'wood-floor-057' : 'carpet-011' }));
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { wallsGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(), floorMapResults: new Map() });
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
    offset: 1, width: 0.9, height: 2.08, sillHeight: 0 }];
  const scene = Object.create(PlannerScene.prototype);
  const emptyMaps = { color: null, normal: null, height: null, roughness: null };
  Object.assign(scene, {
    wallsGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(), floorGroup: new THREE.Group(),
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
    const edge = new Set();
    let area = 0;
    for (let i = 0; i < normals.count; i++) {
      assert.ok(normals.getY(i) > 0.99);
      if (Math.abs(positions.getX(i) - 2.5) < 1e-6) edge.add(positions.getZ(i).toFixed(5));
    }
    for (let i = 0; i < positions.count; i += 3) {
      area += Math.abs((positions.getX(i + 1) - positions.getX(i)) * (positions.getZ(i + 2) - positions.getZ(i))
        - (positions.getZ(i + 1) - positions.getZ(i)) * (positions.getX(i + 2) - positions.getX(i))) / 2;
    }
    assert.ok(Math.abs(area - 10) < 1e-5);
    seam.push([...edge].sort());
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
  } finally {
    globalThis.FileReader = priorReader;
    for (const group of [scene.floorGroup, scene.wallsGroup, scene.architecturalShadeGroup, root]) scene.disposeGroup(group);
  }
});
