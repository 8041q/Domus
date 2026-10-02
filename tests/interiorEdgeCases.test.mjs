import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(async () => vite.close());
const spaces = await vite.ssrLoadModule('/src/core/spaces.ts');
const roomGeometry = await vite.ssrLoadModule('/src/core/roomGeometry.ts');
const placement = await vite.ssrLoadModule('/src/core/placement.ts');
const { usePlannerStore: store, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const saved = new Map();
globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
beforeEach(() => { saved.clear(); store.getState().resetProject(); });

const anchor = (id, t, kind = 'perimeter') => ({ kind, id, t });
const divider = (id, start, end, kind = 'wall') => ({ id: `divider-${id}`, kind, start, end });
const area = (polygon) => Math.abs(roomGeometry.polygonArea(polygon));
const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
function snapshotFor(room, dividers = [], openings = []) {
  return { ...getSnapshot(), room: { ...getSnapshot().room, ...room }, dividers, openings, spaces: [], objects: [] };
}
function assignSpaces(snapshot) {
  snapshot.spaces = spaces.deriveSpaces(snapshot).map((space, index) => ({ ...space, id: `space-${index}`,
    name: `Room ${index}`, floorFinish: index % 2 ? 'wood-floor-057' : 'carpet-011', wallColor: index % 2 ? '#224466' : '#ddaa33' }));
  return snapshot;
}
function assertFaces(snapshot, count) {
  const derived = spaces.deriveSpaces(snapshot);
  if (count != null) assert.equal(derived.length, count);
  near(derived.reduce((sum, space) => sum + space.area, 0), area(snapshot.room.vertices));
  assert.equal(new Set(derived.map((space) => space.boundaryKey)).size, derived.length);
  for (const space of derived) {
    assert.ok(space.area > 0);
    assert.ok(roomGeometry.pointInRoom(space.seed, { vertices: space.polygon }, false));
    assert.ok(space.polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)));
  }
  return derived;
}
function addMainWall(kind = 'wall') {
  assert.equal(store.getState().addDivider(kind, anchor('wall-v0-v1', 0.5), anchor('wall-v2-v3', 0.5)), true);
  return getSnapshot().dividers[0];
}

for (const shape of ['rectangle', 'angled-corner', 'l-shape', 'recess']) {
  test(`${shape}: valid chords retain area and interior seeds under rotation, translation and reversed winding`, () => {
    const base = roomGeometry.roomTemplate(shape, 6, 5);
    let checked = 0;
    for (const transform of [
      (vertices) => vertices,
      (vertices) => vertices.map((v) => ({ ...v, x: v.x * Math.cos(0.61) - v.z * Math.sin(0.61) + 7, z: v.x * Math.sin(0.61) + v.z * Math.cos(0.61) - 9 })),
      (vertices) => [...vertices].reverse()
    ]) {
      const room = { vertices: transform(base) };
      const walls = roomGeometry.getRoomWalls(room);
      assertFaces(snapshotFor(room), 1);
      for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) {
        const dividers = [divider('chord', anchor(walls[i].id, 0.37), anchor(walls[j].id, 0.63), (i + j) % 2 ? 'wall' : 'open')];
        if (!spaces.validateDividers(room, dividers)) continue;
        assertFaces(snapshotFor(room, dividers), 2);
        checked++;
      }
    }
    assert.ok(checked > 5, `Insufficient valid chords for ${shape}`);
  });
}

test('seeded crossing networks obey Euler face counts and conserve area', () => {
  let randomState = 20261002;
  const random = () => { randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0; return randomState / 2 ** 32; };
  const room = { vertices: roomGeometry.roomTemplate('rectangle', 8, 6) };
  for (let scenario = 0; scenario < 80; scenario++) {
    const lines = Array.from({ length: 1 + scenario % 8 }, (_, index) => ({ index, top: 0.05 + 0.9 * random(), bottom: 0.05 + 0.9 * random() }));
    const dividers = lines.map(({ index, top, bottom }) => divider(`random-${index}`, anchor('wall-v0-v1', top), anchor('wall-v2-v3', 1 - bottom), index % 2 ? 'open' : 'wall'));
    assert.equal(spaces.validateDividers(room, dividers), true, `Seeded scenario ${scenario}`);
    let crossings = 0;
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      if ((lines[i].top - lines[j].top) * (lines[i].bottom - lines[j].bottom) < 0) crossings++;
    }
    const snapshot = assignSpaces(snapshotFor(room, dividers));
    const derived = assertFaces(snapshot, 1 + lines.length + crossings);
    const reversed = spaces.deriveSpaces({ ...snapshot, dividers: [...dividers].reverse() });
    assert.deepEqual(new Map(reversed.map((space) => [space.boundaryKey, space.id])), new Map(derived.map((space) => [space.boundaryKey, space.id])));
  }
});

test('three walls at one junction produce six spaces; corner-to-corner walls produce two', () => {
  const room = { vertices: roomGeometry.roomTemplate('rectangle', 6, 6) };
  const dividers = [
    divider('vertical', anchor('wall-v0-v1', 0.5), anchor('wall-v2-v3', 0.5)),
    divider('horizontal', anchor('wall-v3-v0', 0.5), anchor('wall-v1-v2', 0.5)),
    divider('diagonal', anchor('wall-v0-v1', 0), anchor('wall-v2-v3', 0))
  ];
  assert.equal(spaces.validateDividers(room, dividers), true);
  assertFaces(snapshotFor(room, dividers), 6);
  assertFaces(snapshotFor(room, [dividers[2]]), 2);
});

test('a chord across a concave room notch is rejected', () => {
  const room = { vertices: roomGeometry.roomTemplate('recess', 6, 5) };
  assert.equal(spaces.validateDividers(room, [divider('outside', anchor('wall-v2-v3', 0.4), anchor('wall-v6-v7', 0.6))]), false);
});

test('partially overlapping collinear dividers are rejected even for overlaps under one centimetre', () => {
  const room = { vertices: roomGeometry.roomTemplate('rectangle', 6, 5) };
  const support = divider('support', anchor('wall-v0-v1', 0.5), anchor('wall-v2-v3', 0.5), 'open');
  const first = divider('first', anchor('wall-v3-v0', 0.5), anchor('divider-support', 0.5, 'divider'));
  // Both walls are about 3 m long, but the second overlaps the first by 6 mm.
  const second = divider('second', anchor('divider-first', 0.998, 'divider'), anchor('wall-v1-v2', 0.5));
  assert.equal(spaces.validateDividers(room, [first, support, second]), false);
  assert.equal(spaces.validateDividers(room, [first, support, { ...second, start: anchor('divider-first', 1, 'divider') }]), true);
});

test('perimeter splits preserve attached endpoints and nested connections through undo and redo', () => {
  const main = addMainWall();
  store.getState().addDivider('open', anchor('wall-v3-v0', 0.5), anchor(main.id, 0.5, 'divider'));
  const before = getSnapshot();
  const positions = spaces.resolveDividers(before.room, before.dividers).map(({ a, b }) => ({ a, b }));
  assert.equal(store.getState().splitWallById('wall-v0-v1'), true);
  assert.deepEqual(spaces.resolveDividers(getSnapshot().room, getSnapshot().dividers).map(({ a, b }) => ({ a, b })), positions);
  store.getState().undo();
  assert.deepEqual(getSnapshot(), before);
  store.getState().redo();
  assert.deepEqual(spaces.resolveDividers(getSnapshot().room, getSnapshot().dividers).map(({ a, b }) => ({ a, b })), positions);
});

test('width and depth edits preserve all space finishes without a review', () => {
  addMainWall();
  const before = getSnapshot();
  before.spaces.forEach((space, index) => store.getState().updateSpace(space.id, { name: `Office ${index}`, floorFinish: index ? 'wood-floor-057' : 'terrazzo-007' }));
  store.getState().updateRoom({ width: 8, depth: 6 });
  assertFaces(getSnapshot(), 2);
  assert.deepEqual(getSnapshot().spaces.map(({ id, name, floorFinish }) => ({ id, name, floorFinish })), before.spaces.map((space, index) => ({ id: space.id, name: `Office ${index}`, floorFinish: index ? 'wood-floor-057' : 'terrazzo-007' })));
});

test('removing a parent division includes descendants and doors; undo restores them', () => {
  const main = addMainWall();
  store.getState().addDivider('wall', anchor('wall-v3-v0', 0.5), anchor(main.id, 0.5, 'divider'));
  store.getState().addOpening('door');
  const before = getSnapshot();
  store.getState().removeDivider(main.id);
  assert.equal(getSnapshot().dividers.length, 0);
  assert.equal(getSnapshot().openings.filter((opening) => opening.wallId.startsWith('divider-')).length, 0);
  store.getState().undo();
  assert.deepEqual(getSnapshot(), before);
});

test('new divisions commit immediately and undo/redo restore their spaces', () => {
  const main = addMainWall();
  const before = getSnapshot();
  store.getState().addDivider('open', anchor('wall-v3-v0', 0.5), anchor(main.id, 0.5, 'divider'));
  const after = getSnapshot();
  assertFaces(after, 3);
  store.getState().undo();
  assert.deepEqual(getSnapshot(), before);
  store.getState().redo();
  assert.deepEqual(getSnapshot(), after);
});

test('saving a new division includes its automatically assigned spaces', () => {
  const main = addMainWall();
  store.getState().addDivider('open', anchor('wall-v3-v0', 0.5), anchor(main.id, 0.5, 'divider'));
  store.getState().saveLocal();
  assert.deepEqual(JSON.parse(saved.get('room-planner-project-v4')), getSnapshot());
  assert.equal(JSON.parse(saved.get('room-planner-project-v4')).spaces.length, 3);
});

test('workflow steps remain available immediately after a division or merge', () => {
  addMainWall();
  store.getState().removeDivider(getSnapshot().dividers[0].id);
  store.getState().setMode('plan');
  assert.equal(store.getState().mode, 'plan');
  assert.equal(getSnapshot().spaces.length, 1);
});

test('legacy cardinal-wall openings survive migration', () => {
  const legacy = getSnapshot();
  delete legacy.dividers;
  delete legacy.spaces;
  legacy.openings = [{ id: 'legacy-door', type: 'door', wall: 'east', offset: 1.8, width: 0.9, height: 2.08, sillHeight: 0 }];
  saved.set('room-planner-project-v2', JSON.stringify(legacy));
  assert.equal(store.getState().loadLocal(), true);
  assert.equal(getSnapshot().openings.length, 1);
  assert.equal(getSnapshot().openings[0].wallId, 'wall-v1-v2');
});

test('malformed interior saves are rejected atomically', () => {
  addMainWall();
  const before = getSnapshot();
  for (const corrupt of [
    (snapshot) => { snapshot.dividers[0].start = null; },
    (snapshot) => { snapshot.dividers[0].kind = 'invalid'; },
    (snapshot) => { snapshot.spaces.push({ ...snapshot.spaces[0] }); },
    (snapshot) => { snapshot.spaces[0].seed = { x: null, z: 3 }; },
    (snapshot) => { snapshot.openings.push({ id: 'bad-door', type: 'door', variant: 'single-door', wallId: snapshot.dividers[0].id, width: null, offset: 1, height: 2, sillHeight: 0 }); }
  ]) {
    const invalid = structuredClone(before);
    corrupt(invalid);
    saved.set('room-planner-project-v4', JSON.stringify(invalid));
    assert.equal(store.getState().loadLocal(), false);
    assert.deepEqual(getSnapshot(), before);
  }
});

for (const rotationY of [0, Math.PI / 4, Math.PI / 2]) {
  test(`interior boundaries permit rotated furniture at ${Math.round(rotationY * 180 / Math.PI)} degrees`, () => {
    const main = addMainWall();
    const chair = { id: 'chair', productId: 'chair', x: 2.6, z: 1.9, rotationY };
    const opening = { id: 'door', type: 'door', variant: 'single-door', wallId: main.id, width: 0.9, offset: 1.9, height: 2.08, sillHeight: 0 };
    const room = spaces.architectureRoom({ ...getSnapshot(), openings: [opening] });
    assert.equal(placement.isPlacementValid(chair, room, []), true);
    assert.equal(placement.isPlacementValid(chair, { ...room, openings: [{ ...opening, width: 0.3 }] }, []), true);
  });
}

test('short floor-level openings remain soft targets for taller furniture', () => {
  const main = addMainWall();
  const opening = { id: 'gap', type: 'opening', variant: 'wall-opening', wallId: main.id, width: 1.4, offset: 1.9, height: 0.5, sillHeight: 0 };
  const room = spaces.architectureRoom({ ...getSnapshot(), openings: [opening] });
  assert.equal(placement.isPlacementValid({ id: 'tall', productId: 'chair', x: 2.6, z: 1.9, rotationY: 0 }, room, []), true);
  assert.equal(placement.isPlacementValid({ id: 'low', productId: 'coffee-table', x: 2.6, z: 1.9, rotationY: 0 }, room, []), true);
});

test('spacing rays stop at solid divisions but continue through open boundaries and door gaps', () => {
  const main = addMainWall();
  const chair = { id: 'chair', productId: 'chair', x: 1, z: 1.9, rotationY: 0 };
  const measure = (snapshot) => placement.spacingMeasurements(chair, spaces.architectureRoom(snapshot), []).find((measurement) => measurement.direction.x > 0.9);
  const closed = measure(getSnapshot());
  assert.ok(closed.end.x < 2.61);
  const door = { id: 'door', type: 'door', variant: 'single-door', wallId: main.id, width: 0.9, offset: 1.9, height: 2.08, sillHeight: 0 };
  assert.ok(measure({ ...getSnapshot(), openings: [door] }).end.x > 5);
  assert.ok(measure({ ...getSnapshot(), dividers: [{ ...main, kind: 'open' }] }).end.x > 5);
});

test('threshold detection uses the immediately adjacent spaces in a narrow strip', () => {
  const room = { vertices: roomGeometry.roomTemplate('rectangle', 6, 5) };
  const main = divider('one', anchor('wall-v0-v1', 0.4), anchor('wall-v2-v3', 0.6));
  const parallel = divider('two', anchor('wall-v0-v1', 0.41), anchor('wall-v2-v3', 0.59));
  const snapshot = assignSpaces(snapshotFor(room, [main, parallel]));
  const door = { id: 'door', type: 'door', variant: 'single-door', wallId: main.id, width: 0.9, offset: 2.5, height: 2.08, sillHeight: 0 };
  assert.equal(spaces.interiorDoorHasThreshold(snapshot, door), true);
});

test('a dense grid of physical and invisible boundaries forms 64 distinct spaces', () => {
  const room = { vertices: roomGeometry.roomTemplate('rectangle', 8, 8) };
  const dividers = Array.from({ length: 7 }, (_, index) => {
    const t = (index + 1) / 8;
    return [divider(`vertical-${index}`, anchor('wall-v0-v1', t), anchor('wall-v2-v3', 1 - t)),
      divider(`horizontal-${index}`, anchor('wall-v3-v0', t), anchor('wall-v1-v2', 1 - t), 'open')];
  }).flat();
  assert.equal(spaces.validateDividers(room, dividers), true);
  for (const space of assertFaces(snapshotFor(room, dividers), 64)) near(space.area, 1);
});

test('same-count T junction reassignment commits automatically and remains undoable', () => {
  const main = addMainWall();
  assert.equal(store.getState().addDivider('open', anchor('wall-v3-v0', 0.5), anchor(main.id, 0.5, 'divider')), true);
  const before = getSnapshot(), branch = before.dividers[1];
  assert.equal(store.getState().updateDivider(branch.id, { start: anchor('wall-v1-v2', 0.5) }), true);
  const after = getSnapshot();
  assertFaces(after, 3);
  store.getState().undo();
  assert.deepEqual(getSnapshot(), before);
  store.getState().redo();
  assert.deepEqual(getSnapshot(), after);
});

test('multiple doors avoid each other and solid junctions; an overfilled wall stays unchanged', () => {
  const main = addMainWall();
  store.getState().addDivider('wall', anchor('wall-v3-v0', 0.5), anchor(main.id, 0.5, 'divider'));
  store.getState().selectDivider(main.id);
  store.getState().addOpening('door');
  store.getState().addOpening('door');
  const before = getSnapshot();
  const doors = before.openings.filter((opening) => opening.wallId === main.id);
  assert.equal(doors.length, 2);
  assert.ok(doors.every((door) => Math.abs(door.offset - 1.9) > door.width / 2));
  assert.equal(spaces.validateInteriorOpenings(before.room, before.dividers, before.openings), true);
  store.getState().addOpening('door');
  assert.deepEqual(getSnapshot(), before);
});

test('a fully decorated multi-space project round trips through save and load', () => {
  const main = addMainWall();
  store.getState().addDivider('open', anchor('wall-v3-v0', 0.5), anchor(main.id, 0.5, 'divider'));
  getSnapshot().spaces.forEach((space, index) => store.getState().updateSpace(space.id, {
    name: ['Reception', 'Corridor', 'Office'][index], floorFinish: ['carpet-011', 'wood-floor-057', 'terrazzo-007'][index], wallColor: ['#123456', '#654321', '#aabbcc'][index]
  }));
  store.getState().selectDivider(main.id);
  store.getState().addOpening('door');
  const before = getSnapshot();
  store.getState().saveLocal();
  store.getState().resetProject();
  assert.equal(store.getState().loadLocal(), true);
  assert.deepEqual(getSnapshot(), before);
});

test('adding furniture to a divided room always finds a valid position or leaves it unplaced', () => {
  addMainWall();
  for (const productId of ['chair', 'sofa', 'cabinet']) {
    store.getState().addObject(productId);
    const snapshot = getSnapshot();
    const object = snapshot.objects.at(-1);
    if (object?.productId === productId) assert.equal(placement.isPlacementValid(object, spaces.architectureRoom(snapshot), snapshot.objects.filter((other) => other.id !== object.id)), true);
    else assert.ok(snapshot.unplacedObjects.some((item) => item.productId === productId));
  }
});

test('furniture too wide for the exterior shell is kept unplaced', () => {
  const snapshot = assignSpaces(snapshotFor({ width: 1.5, vertices: roomGeometry.roomTemplate('rectangle', 3, 3.8).map((v) => ({ ...v, x: v.x / 2 })) }, [
    divider('narrow-left', anchor('wall-v0-v1', 1 / 3), anchor('wall-v2-v3', 2 / 3)),
    divider('narrow-right', anchor('wall-v0-v1', 2 / 3), anchor('wall-v2-v3', 1 / 3))
  ]));
  snapshot.spaces = snapshot.spaces.map(({ polygon, area, ...space }) => space);
  store.setState(snapshot);
  store.getState().addObject('sofa');
  assert.equal(getSnapshot().objects.length, 0);
  assert.equal(getSnapshot().unplacedObjects.at(-1)?.productId, 'sofa');
  const before = getSnapshot();
  store.getState().placeUnplacedObject(before.unplacedObjects[0].id);
  assert.deepEqual(getSnapshot(), before);
  store.getState().undo();
  assert.equal(getSnapshot().unplacedObjects.length, 0);
  store.getState().redo();
  assert.deepEqual(getSnapshot(), before);
});

test('furniture wider than every divided space can still be inserted and moved across the layout', () => {
  const snapshot = assignSpaces(snapshotFor({ width: 3, vertices: roomGeometry.roomTemplate('rectangle', 3, 3.8) }, [
    divider('left', anchor('wall-v0-v1', 1 / 3), anchor('wall-v2-v3', 2 / 3)),
    divider('right', anchor('wall-v0-v1', 2 / 3), anchor('wall-v2-v3', 1 / 3))
  ]));
  snapshot.spaces = snapshot.spaces.map(({ polygon, area, ...space }) => space);
  store.setState(snapshot);
  store.getState().addObject('sofa');
  const object = getSnapshot().objects[0];
  assert.ok(object);
  assert.equal(getSnapshot().unplacedObjects.length, 0);
  assert.equal(placement.overlapsInteriorWall(object, spaces.architectureRoom(getSnapshot())), true);
  assert.equal(placement.isPlacementValid(object, spaces.architectureRoom(getSnapshot()), []), true);
});

test('a threshold detects different finishes anywhere along a door crossed by an invisible boundary', () => {
  const room = { vertices: roomGeometry.roomTemplate('rectangle', 6, 5) };
  const main = divider('main', anchor('wall-v0-v1', 0.4), anchor('wall-v2-v3', 0.6));
  const branch = divider('branch', anchor('wall-v3-v0', 0.5), anchor(main.id, 0.5, 'divider'), 'open');
  const snapshot = assignSpaces(snapshotFor(room, [main, branch]));
  snapshot.spaces = snapshot.spaces.map((space) => ({ ...space, floorFinish: space.seed.x < 2.4 && space.seed.z < 2.5 ? 'wood-floor-057' : 'carpet-011' }));
  const door = { id: 'door', type: 'door', variant: 'single-door', wallId: main.id, width: 0.9, offset: 2.6, height: 2.08, sillHeight: 0 };
  assert.equal(spaces.validateInteriorOpenings(snapshot.room, snapshot.dividers, [door]), true);
  assert.equal(spaces.interiorDoorHasThreshold(snapshot, door), true);
});

test('free furniture overlap crosses physical dividers', () => {
  addMainWall();
  const chair = { id: 'chair', productId: 'chair', x: 1, z: 1, rotationY: 0 };
  assert.ok(placement.resolvePlacement(chair, 4, 1, spaces.architectureRoom(getSnapshot()), [], { allowOverlap: true }).x === 4);
});

test('splits inherit the containing space finishes, including a second split beside differently decorated spaces', () => {
  const original = getSnapshot().spaces[0];
  store.getState().updateSpace(original.id, { floorFinish: 'terrazzo-007', wallColor: '#884422' });
  const main = addMainWall();
  assert.ok(getSnapshot().spaces.every((space) => space.floorFinish === 'terrazzo-007' && space.wallColor === '#884422'));
  const left = spaces.spaceAtPoint(getSnapshot(), { x: 1, z: 1 });
  const right = spaces.spaceAtPoint(getSnapshot(), { x: 4, z: 1 });
  store.getState().updateSpace(left.id, { floorFinish: 'wood-floor-057', wallColor: '#223344' });
  store.getState().addDivider('open', anchor('wall-v3-v0', 0.5), anchor(main.id, 0.5, 'divider'));
  const derived = spaces.deriveSpaces(getSnapshot());
  assert.equal(derived.length, 3);
  assert.ok(derived.filter((space) => space.seed.x < 2.6).every((space) => space.floorFinish === 'wood-floor-057' && space.wallColor === '#223344'));
  assert.equal(derived.find((space) => space.id === right.id).floorFinish, 'terrazzo-007');
  assert.equal(new Set(derived.map((space) => space.name)).size, 3);
});

test('selection and finish edits remain independent for each space', () => {
  addMainWall();
  const [first, second] = getSnapshot().spaces;
  store.getState().selectSpace(first.id);
  store.getState().updateSpace(store.getState().selectedSpaceId, { floorFinish: 'wood-floor-057', wallColor: '#223344' });
  store.getState().selectSpace(second.id);
  store.getState().updateSpace(store.getState().selectedSpaceId, { floorFinish: 'terrazzo-007', wallColor: '#aa8866' });
  assert.equal(getSnapshot().spaces.find((space) => space.id === first.id).floorFinish, 'wood-floor-057');
  assert.equal(getSnapshot().spaces.find((space) => space.id === second.id).floorFinish, 'terrazzo-007');
  store.getState().undo();
  assert.equal(getSnapshot().spaces.find((space) => space.id === first.id).wallColor, '#223344');
  assert.equal(getSnapshot().spaces.find((space) => space.id === second.id).wallColor, second.wallColor);
});

test('editing spaces control finishes while furniture searches the whole shell without changing the camera', () => {
  addMainWall();
  store.getState().setMode('plan');
  store.getState().setPlanView('top');
  const right = spaces.spaceAtPoint(getSnapshot(), { x: 4, z: 1 });
  store.getState().selectSpace(right.id);
  store.getState().addObject('chair');
  const object = getSnapshot().objects.at(-1);
  assert.equal(placement.isPlacementValid(object, spaces.architectureRoom(getSnapshot()), []), true);
  assert.equal(placement.overlapsInteriorWall(object, spaces.architectureRoom(getSnapshot())), false);
  assert.equal(store.getState().planView, 'top');
  store.getState().select(object.id);
  assert.equal(store.getState().selectedSpaceId, spaces.spaceAtPoint(getSnapshot(), object).id);
  const before = getSnapshot();
  store.getState().updateObject(object.id, { x: 4, z: 1 });
  store.getState().commitSnapshot(before);
  assert.equal(store.getState().selectedSpaceId, right.id);
  store.getState().undo();
  near(getSnapshot().objects[0].x, object.x);
  store.getState().redo();
  near(getSnapshot().objects[0].x, 4);
  store.getState().saveLocal();
  store.getState().resetProject();
  assert.equal(store.getState().loadLocal(), true);
  near(getSnapshot().objects[0].x, 4);
});

test('a narrow editing space does not prevent adding furniture elsewhere in the shell', () => {
  store.getState().addDivider('wall', anchor('wall-v0-v1', 0.12), anchor('wall-v2-v3', 0.88));
  const narrow = spaces.spaceAtPoint(getSnapshot(), { x: 0.3, z: 1 });
  const wide = spaces.spaceAtPoint(getSnapshot(), { x: 3, z: 1 });
  store.getState().selectSpace(narrow.id);
  store.getState().addObject('sofa');
  assert.equal(getSnapshot().objects.length, 1);
  assert.equal(getSnapshot().unplacedObjects.length, 0);
  assert.equal(spaces.spaceAtPoint(getSnapshot(), getSnapshot().objects[0]).id, wide.id);
});

test('furniture straddling a divider survives save, load and rotation', () => {
  addMainWall();
  store.getState().addObject('chair');
  const object = getSnapshot().objects[0];
  store.getState().updateObject(object.id, { x: 2.6, z: 1.9 });
  store.getState().rotateSelected(Math.PI / 4);
  const snapshot = getSnapshot();
  assert.equal(placement.isPlacementValid(snapshot.objects[0], spaces.architectureRoom(snapshot), []), true);
  store.getState().saveLocal();
  store.getState().resetProject();
  assert.equal(store.getState().loadLocal(), true);
  assert.deepEqual(getSnapshot().objects, snapshot.objects);
});
