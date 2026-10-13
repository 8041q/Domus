import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { FEATURES } = await vite.ssrLoadModule('/src/config/features.ts');
FEATURES.interiorWalls = true;
const { createFrameQueue } = await vite.ssrLoadModule('/src/core/frameQueue.ts');
const { usePlannerStore, getSnapshot, parseProjectSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { getPhysicalWalls } = await vite.ssrLoadModule('/src/core/spaces.ts');
const { getRoomWalls, roomBounds, isValidRoom, openingsOnWall } = await vite.ssrLoadModule('/src/core/roomGeometry.ts');
const { buildRoomPdf, ROOM_PDF_VIEWS } = await vite.ssrLoadModule('/src/core/roomPdf.ts');
const { wallCornerShading } = await vite.ssrLoadModule('/src/core/wallShading.ts');
const { roomReportData } = await vite.ssrLoadModule('/src/core/roomReport.ts');
const { PRODUCTS } = await vite.ssrLoadModule('/src/core/products.ts');

test('circular rooms reject windows and migrate old windows without losing their size or position', () => {
  usePlannerStore.getState().resetProject(); usePlannerStore.getState().setRoomTemplate('circle');
  assert.equal(usePlannerStore.getState().addOpening('window'), false);
  const opening = getSnapshot().openings.find((item) => item.type === 'opening');
  usePlannerStore.getState().updateOpening(opening.id, { type: 'window', variant: 'single-window' });
  assert.deepEqual(getSnapshot().openings.find((item) => item.id === opening.id), opening);
  const legacy = getSnapshot(); legacy.openings.find((item) => item.id === opening.id).type = 'window';
  legacy.openings.find((item) => item.id === opening.id).variant = 'single-window';
  assert.deepEqual(parseProjectSnapshot(legacy).openings.find((item) => item.id === opening.id), opening);
  usePlannerStore.getState().resetProject(); assert.equal(usePlannerStore.getState().addOpening('window'), true);
});

test('corner shades preserve long rectangular corners and suppress short, circular and straight split seams', () => {
  usePlannerStore.getState().resetProject();
  const room = getSnapshot().room;
  for (const wall of getRoomWalls(room)) assert.deepEqual(wallCornerShading(room, wall), { start: 1, end: 1 });
  const split = structuredClone(room), a = split.vertices[0], b = split.vertices[1];
  split.vertices.splice(1, 0, { id: 'split', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  const walls = getRoomWalls(split);
  assert.deepEqual(wallCornerShading(split, walls[0]), { start: 1, end: 0 });
  assert.deepEqual(wallCornerShading(split, walls[1]), { start: 0, end: 1 });
  split.vertices[1] = { id: 'split', x: a.x + (b.x - a.x) * 0.1, z: a.z + (b.z - a.z) * 0.1 };
  assert.deepEqual(wallCornerShading(split, getRoomWalls(split)[0]), { start: 0, end: 0 });
  usePlannerStore.getState().setRoomTemplate('circle');
  for (const diameter of [2.2, 6, 20]) {
    usePlannerStore.getState().updateRoom({ width: diameter });
    const circular = getSnapshot().room;
    for (const wall of getRoomWalls(circular)) assert.deepEqual(wallCornerShading(circular, wall), { start: 0, end: 0 });
  }
});

test('report groups quantities and separates unplaced furniture using measured model dimensions', () => {
  usePlannerStore.getState().resetProject(); const snapshot = getSnapshot();
  snapshot.objects = [{ id: 'a', productId: 'chair', x: 1, z: 1, rotationY: 0 }, { id: 'b', productId: 'chair', x: 2, z: 2, rotationY: 0 }];
  snapshot.unplacedObjects = [{ id: 'c', productId: 'chair' }];
  const data = roomReportData(snapshot, PRODUCTS);
  assert.deepEqual(data.furniture.map((row) => [row.quantity, row.status]), [[2, 'In room'], [1, 'Not placed']]);
  assert.equal(data.furniture[0].dimensions, '0.50 × 0.56 × 0.83');
  assert.equal(data.area, snapshot.room.width * snapshot.room.depth);
  const jpeg = { jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), width: 10, height: 10 };
  const pdf = buildRoomPdf(Array(5).fill(jpeg), Array(3).fill(jpeg));
  assert.match(new TextDecoder().decode(pdf), /\/Count 8 /);
});

test('project details update and undo even when furniture overlaps, and survive shape changes', () => {
  usePlannerStore.getState().resetProject();
  const objects = ['a', 'b'].map((id) => ({ id, productId: 'sofa', x: 1.7, z: 1.7, rotationY: 0 }));
  usePlannerStore.setState({ objects });
  const details = { company: 'Example Medical', companyContact: '', client: 'Sample Client', clientContact: '', reference: '', preparedBy: '', notes: '' };
  usePlannerStore.getState().updateProjectDetails(details);
  assert.deepEqual(getSnapshot().room.projectDetails, details);
  assert.deepEqual(getSnapshot().objects, objects);
  usePlannerStore.getState().undo(); assert.equal(getSnapshot().room.projectDetails, undefined);
  usePlannerStore.getState().redo(); assert.deepEqual(getSnapshot().room.projectDetails, details);
  usePlannerStore.getState().setRoomTemplate('circle'); assert.deepEqual(getSnapshot().room.projectDetails, details);
});

function fakeFrames(apply) {
  const callbacks = new Map();
  let id = 0;
  const queue = createFrameQueue(apply, (callback) => { callbacks.set(++id, callback); return id; }, (id) => callbacks.delete(id));
  return { queue, callbacks, tick: () => { const batch = [...callbacks.values()]; callbacks.clear(); batch.forEach((callback) => callback(0)); } };
}

test('circle presets resize uniformly, retain real-size apertures across short sections and undo a size gesture once', () => {
  const store = usePlannerStore;
  store.getState().resetProject();
  store.getState().setRoomTemplate('circle');
  const before = getSnapshot();
  const sizes = before.openings.map((opening) => opening.width);
  for (const diameter of [2.2, 3, 8, 20]) {
    store.getState().updateRoom({ width: diameter }, false);
    const snapshot = getSnapshot();
    assert.ok(Math.abs(snapshot.room.width - diameter) < 1e-8);
    assert.ok(Math.abs(snapshot.room.depth - diameter) < 1e-8);
    assert.equal(snapshot.room.shapeKind, 'circle');
    assert.equal(isValidRoom(snapshot.room.vertices), true);
    const bounds = roomBounds(snapshot.room.vertices);
    for (const vertex of snapshot.room.vertices) assert.ok(Math.abs(Math.hypot(vertex.x - (bounds.minX + bounds.maxX) / 2,
      vertex.z - (bounds.minZ + bounds.maxZ) / 2) - diameter / 2) < 1e-7);
    assert.deepEqual(snapshot.openings.map((opening) => opening.width), sizes);
    for (const opening of snapshot.openings) {
      const pieces = getRoomWalls(snapshot.room).flatMap((wall) => openingsOnWall(snapshot.room, [opening], wall.id));
      assert.ok(Math.abs(pieces.reduce((sum, piece) => sum + piece.width, 0) - opening.width) < 1e-7);
    }
  }
  store.getState().commitSnapshot(before);
  store.getState().undo(); assert.deepEqual(JSON.parse(JSON.stringify(getSnapshot())), JSON.parse(JSON.stringify(before)));
  store.getState().redo(); assert.ok(Math.abs(store.getState().room.width - 20) < 1e-7);
});

test('dragging an aperture across either end transfers it to the adjacent wall with a single undo', () => {
  for (const direction of [-1, 1]) {
    usePlannerStore.getState().resetProject();
    const before = getSnapshot(), opening = before.openings[0];
    const walls = getRoomWalls(before.room), wall = walls.find((wall) => wall.id === opening.wallId);
    const along = direction > 0 ? wall.length + 0.5 : -0.5;
    const point = { x: wall.start.x + wall.tangent.x * along, z: wall.start.z + wall.tangent.z * along };
    const scene = Object.create(PlannerScene.prototype);
    Object.assign(scene, { bridge: { getSnapshot: () => getSnapshot(), updateOpening: (id, patch) => usePlannerStore.getState().updateOpening(id, patch, false),
      commitDrag: (saved) => usePlannerStore.getState().commitSnapshot(saved) },
      openingDragging: { id: opening.id, before, grabOffset: 0, pointerId: 7 }, controls: { enabled: false },
      renderer: { domElement: { style: {}, hasPointerCapture: () => false } },
      raycaster: new THREE.Raycaster(new THREE.Vector3(point.x + wall.inward.x, 1.2, point.z + wall.inward.z),
        new THREE.Vector3(-wall.inward.x, 0, -wall.inward.z)), setPointer: () => {}, renderFromState: () => {} });
    scene.openingMoves = fakeFrames((event) => scene.moveOpening(event)).queue;
    scene.moveOpening({ pointerId: 7 }); scene.finishOpeningDrag();
    const moved = getSnapshot().openings.find((candidate) => candidate.id === opening.id);
    assert.equal(moved.wallId, walls[(wall.index + direction + walls.length) % walls.length].id);
    for (const field of ['width', 'height', 'sillHeight', 'variant']) assert.equal(moved[field], opening[field]);
    usePlannerStore.getState().undo(); assert.deepEqual(JSON.parse(JSON.stringify(getSnapshot())), JSON.parse(JSON.stringify(before)));
  }
});

test('PDF embeds five pages with byte-accurate cross references and rejects incomplete exports', () => {
  assert.deepEqual(ROOM_PDF_VIEWS, ['top', 'front', 'right', 'back', 'left']);
  const images = ROOM_PDF_VIEWS.map(() => ({ jpeg: new Uint8Array([255, 216, 255, 217]), width: 1800, height: 1273 }));
  const pdf = buildRoomPdf(images), text = Buffer.from(pdf).toString('latin1');
  assert.equal((text.match(/\/Type \/Page\b/g) ?? []).length, 5);
  const start = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(start, start + 4), 'xref');
  const entries = text.slice(start).split('\n').slice(3, 20);
  entries.forEach((entry, index) => assert.ok(text.slice(Number(entry.slice(0, 10))).startsWith(`${index + 1} 0 obj`)));
  assert.throws(() => buildRoomPdf(images.slice(1)), /five/);
});

test('a door can continue from an interior-wall endpoint onto its joined interior wall', () => {
  const store = usePlannerStore;
  store.getState().resetProject();
  assert.equal(store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 },
    { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 }), true);
  const first = store.getState().dividers[0];
  assert.equal(store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v3-v0', t: 0.5 },
    { kind: 'divider', id: first.id, t: 0.5 }), true);
  const second = store.getState().dividers[1];
  store.getState().selectDivider(second.id); assert.equal(store.getState().addOpening('door'), true);
  const opening = store.getState().openings.find((opening) => opening.id === store.getState().selectedOpeningId);
  const snapshot = getSnapshot(), wall = getPhysicalWalls(snapshot.room, snapshot.dividers).find((wall) => wall.id === second.id);
  const point = { x: wall.end.x + wall.tangent.x * 0.6, z: wall.end.z + wall.tangent.z * 0.6 };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { bridge: { getSnapshot: () => getSnapshot(), updateOpening: (id, patch) => store.getState().updateOpening(id, patch, false) },
    openingDragging: { id: opening.id, before: snapshot, grabOffset: 0, pointerId: 7 },
    raycaster: new THREE.Raycaster(new THREE.Vector3(point.x + wall.inward.x, 1.2, point.z + wall.inward.z),
      new THREE.Vector3(-wall.inward.x, 0, -wall.inward.z)), setPointer: () => {}, renderFromState: () => {} });
  scene.moveOpening({ pointerId: 7 });
  const moved = store.getState().openings.find((candidate) => candidate.id === opening.id);
  assert.equal(moved.wallId, first.id);
  assert.equal(moved.width, opening.width);
});

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

test('exterior insertions find separate apertures, select the result, and stop when the wall is full', () => {
  const store = usePlannerStore;
  for (const type of ['door', 'window', 'opening']) {
    store.getState().resetProject();
    store.getState().selectWall('wall-v0-v1');
    const before = getSnapshot();
    assert.equal(store.getState().addOpening(type), true);
    const state = store.getState();
    const inserted = state.openings.find((opening) => opening.id === state.selectedOpeningId);
    assert.equal(inserted.type, type);
    assert.equal(inserted.wallId, 'wall-v0-v1');
    assert.ok(before.openings.filter((opening) => opening.wallId === inserted.wallId).every((opening) =>
      Math.abs(opening.offset - inserted.offset) >= (opening.width + inserted.width) / 2 + 0.05 - 1e-6));
    store.getState().undo();
    assert.deepEqual(JSON.parse(JSON.stringify(getSnapshot())), JSON.parse(JSON.stringify(before)));
    store.getState().redo();
    assert.equal(store.getState().openings.length, before.openings.length + 1);
  }
  let additions = 0;
  while (store.getState().addOpening('window')) assert.ok(++additions < 20);
  const before = getSnapshot();
  assert.equal(store.getState().addOpening('window'), false);
  assert.deepEqual(getSnapshot(), before);
});

test('adding openings and furniture still works without secure-context randomUUID', () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const store = usePlannerStore;
    store.getState().resetProject();
    assert.equal(store.getState().addOpening('door'), true);
    store.getState().addObject('chair');
    assert.equal(store.getState().objects.length, 1);
    assert.equal(store.getState().selectedId, store.getState().objects[0].id);
    store.getState().duplicateSelected();
    assert.equal(store.getState().objects.length, 2);
    assert.notEqual(store.getState().objects[0].id, store.getState().objects[1].id);
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else delete crypto.randomUUID;
  }
});

test('moving the selected opening to another wall keeps that wall active for the next insertion', () => {
  const store = usePlannerStore;
  store.getState().resetProject();
  const door = store.getState().openings.find((opening) => opening.type === 'door');
  store.getState().selectOpening(door.id);
  store.getState().updateOpening(door.id, { wallId: 'wall-v3-v0' });
  assert.equal(store.getState().selectedWallId, 'wall-v3-v0');
  assert.equal(store.getState().addOpening('window'), true);
  assert.equal(store.getState().openings.find((opening) => opening.id === store.getState().selectedOpeningId).wallId, 'wall-v3-v0');
});

test('a selected door is revealed on a cutaway wall in Build Room and the normal cutaway returns afterward', () => {
  const store = usePlannerStore;
  store.getState().resetProject();
  const opening = store.getState().openings.find((opening) => opening.type === 'door');
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { bridge: { getSnapshot: () => store.getState() },
    options: { interactiveArchitecture: true }, currentCameraView: 'free',
    camera: { position: new THREE.Vector3(12, 12, 12) }, wallHiddenState: new Map(),
    wallsGroup: new THREE.Group(), floorGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(),
    updateInteriorWallView: () => {}, rebuildRoomDimensionHelpers: () => {} });
  const door = new THREE.Object3D();
  door.userData.cutawayWallId = opening.wallId;
  scene.wallsGroup.add(door);
  scene.updateCutawayWalls(true);
  assert.equal(door.visible, false);
  store.getState().selectOpening(opening.id);
  scene.updateCutawayWalls(true);
  assert.equal(door.visible, true);
  scene.options.interactiveArchitecture = false;
  scene.updateCutawayWalls(true);
  assert.equal(door.visible, false, 'Plan Room keeps its normal cutaway');
  scene.options.interactiveArchitecture = true;
  store.getState().selectOpening(null);
  scene.updateCutawayWalls(true);
  assert.equal(door.visible, false);
});
