import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTestServer } from './helpers/vite.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(async () => { await vite.close(); });
const { createWalkNavigation, isWalkPositionValid, findWalkSpawn, moveWalkPosition } = await vite.ssrLoadModule('/src/core/walkNavigation.ts');
const { roomTemplate, pointInRoom, getRoomWalls } = await vite.ssrLoadModule('/src/core/roomGeometry.ts');
const { deriveSpaces } = await vite.ssrLoadModule('/src/core/spaces.ts');

function snapshot(shape = 'rectangle', dividers = [], openings = []) {
  return { room: { vertices: roomTemplate(shape, 6, 5), height: 2.6, floorFinish: 'carpet-011', wallColor: '#fff' },
    dividers, openings, spaces: [], objects: [], unplacedObjects: [] };
}
const divider = (kind = 'wall') => ({ id: 'divider-middle', kind,
  start: { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 }, end: { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 } });
const aperture = (patch = {}) => ({ id: 'passage', wallId: 'divider-middle', type: 'opening', variant: 'wall-opening',
  offset: 2.5, width: 1, height: 2.1, sillHeight: 0, ...patch });
const near = (actual, expected, tolerance = 0.001) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('walking stays at a safe distance from the perimeter even for a very large displacement', () => {
  const navigation = createWalkNavigation(snapshot());
  const result = moveWalkPosition(navigation, { x: 2, z: 2 }, { x: -100, z: 0 });
  near(result.x, navigation.clearance);
  near(result.z, 2);
  assert.equal(isWalkPositionValid(navigation, result), true);
  assert.equal(isWalkPositionValid(navigation, { x: 0.1, z: 2 }), false);
});

test('diagonal movement slides along walls and stops in corners', () => {
  const navigation = createWalkNavigation(snapshot());
  const result = moveWalkPosition(navigation, { x: 1, z: 1 }, { x: -2, z: 2 });
  near(result.x, navigation.clearance);
  near(result.z, 3);
  const corner = moveWalkPosition(navigation, { x: 1, z: 1 }, { x: -20, z: -20 });
  near(corner.x, navigation.clearance);
  near(corner.z, navigation.clearance);
});

test('sweeps cannot tunnel through an angled interior wall and can slide along it', () => {
  const angled = { id: 'divider-angled', kind: 'wall', start: { kind: 'perimeter', id: 'wall-v0-v1', t: 0.25 }, end: { kind: 'perimeter', id: 'wall-v2-v3', t: 0.25 } };
  const navigation = createWalkNavigation(snapshot('rectangle', [angled]));
  const result = moveWalkPosition(navigation, { x: 1, z: 2 }, { x: 4, z: 0 });
  assert.ok(result.x < 3.5);
  assert.ok(result.z > 2, 'the wall tangent carries the remaining movement');
  assert.equal(isWalkPositionValid(navigation, result), true);
});

test('bare passages and door frames allow passage, while closed doors and windows stay solid', () => {
  for (const opening of [aperture(), aperture({ type: 'door', variant: 'door-frame' })]) {
    const navigation = createWalkNavigation(snapshot('rectangle', [divider()], [opening]));
    const result = moveWalkPosition(navigation, { x: 2, z: 2.5 }, { x: 2, z: 0 });
    near(result.x, 4);
  }
  for (const opening of [aperture({ type: 'door', variant: 'single-door' }), aperture({ type: 'window', variant: 'full-height-window' })]) {
    const navigation = createWalkNavigation(snapshot('rectangle', [divider()], [opening]));
    const result = moveWalkPosition(navigation, { x: 2, z: 2.5 }, { x: 2, z: 0 });
    near(result.x, 3 - navigation.clearance);
  }
});

test('low, raised and narrow openings do not admit the walking body', () => {
  for (const opening of [aperture({ height: 1.5 }), aperture({ sillHeight: 0.2 }), aperture({ width: 0.4 })]) {
    const navigation = createWalkNavigation(snapshot('rectangle', [divider()], [opening]));
    const result = moveWalkPosition(navigation, { x: 2, z: 2.5 }, { x: 2, z: 0 });
    assert.ok(result.x < 3);
    assert.equal(isWalkPositionValid(navigation, result), true);
  }
});

test('door-frame lintels reduce head clearance while bare openings use the full aperture', () => {
  const lowFrame = createWalkNavigation(snapshot('rectangle', [divider()], [aperture({ type: 'door', variant: 'door-frame', height: 1.77 })]));
  assert.ok(moveWalkPosition(lowFrame, { x: 2, z: 2.5 }, { x: 2, z: 0 }).x < 3);
  const clearFrame = createWalkNavigation(snapshot('rectangle', [divider()], [aperture({ type: 'door', variant: 'door-frame', height: 1.80 })]));
  near(moveWalkPosition(clearFrame, { x: 2, z: 2.5 }, { x: 2, z: 0 }).x, 4);
  const bare = createWalkNavigation(snapshot('rectangle', [divider()], [aperture({ height: 1.77 })]));
  near(moveWalkPosition(bare, { x: 2, z: 2.5 }, { x: 2, z: 0 }).x, 4);
});

test('exterior doors remain bounded and open dividers allow free movement', () => {
  const navigation = createWalkNavigation(snapshot('rectangle', [divider('open')], [aperture({ wallId: 'wall-v0-v1', type: 'door', variant: 'door-frame', offset: 3 })]));
  near(moveWalkPosition(navigation, { x: 2, z: 2.5 }, { x: 2, z: 0 }).x, 4);
  near(moveWalkPosition(navigation, { x: 3, z: 2 }, { x: 0, z: -10 }).z, navigation.clearance);
});

test('concave outlines block a path crossing the recess even if its destination is inside', () => {
  const navigation = createWalkNavigation(snapshot('recess'));
  const result = moveWalkPosition(navigation, { x: 1, z: 4.5 }, { x: 4, z: 0 });
  assert.ok(result.x < 6 * 0.38);
  assert.equal(isWalkPositionValid(navigation, result), true);
  const reversed = snapshot('recess');
  reversed.room.vertices.reverse();
  const other = createWalkNavigation(reversed);
  near(moveWalkPosition(other, { x: 1, z: 4.5 }, { x: 4, z: 0 }).x, result.x);
});

test('spawn finds clear floor in a concave room and honors the selected space', () => {
  const concave = createWalkNavigation(snapshot('recess'));
  const spawn = findWalkSpawn(concave, { x: 3, z: 4.8 });
  assert.ok(spawn);
  assert.equal(isWalkPositionValid(concave, spawn), true);
  const split = snapshot('rectangle', [divider()]);
  split.spaces = deriveSpaces(split).map((space, index) => ({ ...space, id: `space-${index}` }));
  const right = split.spaces.find((space) => space.seed.x > 3);
  const navigation = createWalkNavigation(split);
  const selectedSpawn = findWalkSpawn(navigation, { x: 1, z: 1 }, right.id);
  assert.ok(selectedSpawn.x > 3 + navigation.clearance);
  assert.equal(isWalkPositionValid(navigation, selectedSpawn), true);
});

test('eye height adapts to a low ceiling; invalid movement and stale camera positions are handled', () => {
  const low = snapshot(); low.room.height = 1.4;
  const navigation = createWalkNavigation(low);
  assert.ok(navigation.eyeHeight < low.room.height - 0.1);
  const from = { x: 2, z: 2 };
  assert.deepEqual(moveWalkPosition(navigation, from, { x: NaN, z: 1 }), from);
  const repaired = moveWalkPosition(navigation, { x: -2, z: 2 }, { x: 1, z: 0 });
  assert.equal(isWalkPositionValid(navigation, repaired), true);
});

test('a selected space too narrow for a person falls back to clear floor elsewhere', () => {
  const narrow = { ...divider(), start: { kind: 'perimeter', id: 'wall-v0-v1', t: 0.04 },
    end: { kind: 'perimeter', id: 'wall-v2-v3', t: 0.96 } };
  const split = snapshot('rectangle', [narrow]);
  split.spaces = deriveSpaces(split).map((space, index) => ({ ...space, id: `space-${index}` }));
  const selected = split.spaces.find((space) => space.seed.x < 0.24);
  assert.ok(selected);
  const navigation = createWalkNavigation(split);
  const spawn = findWalkSpawn(navigation, { x: 0.12, z: 2 }, selected.id);
  assert.ok(spawn && spawn.x > 0.24 + navigation.clearance);
  assert.equal(isWalkPositionValid(navigation, spawn), true);
});

test('repairing an invalid camera position searches nearby floor before the room centre', () => {
  const newWall = { ...divider(), start: { kind: 'perimeter', id: 'wall-v0-v1', t: 0.75 },
    end: { kind: 'perimeter', id: 'wall-v2-v3', t: 0.25 } };
  const navigation = createWalkNavigation(snapshot('rectangle', [newWall]));
  const preferred = { x: 4.5, z: 2.5 };
  assert.equal(isWalkPositionValid(navigation, preferred), false);
  const spawn = findWalkSpawn(navigation, preferred);
  assert.ok(spawn && isWalkPositionValid(navigation, spawn));
  assert.ok(Math.hypot(spawn.x - preferred.x, spawn.z - preferred.z) < 0.3, 'recovery stays close to the viewer');
  assert.ok(spawn.x > 4, 'the room centre does not take precedence over nearby floor');
});

test('wall contact slides through collinear seams and allows moving away without sticking', () => {
  const state = snapshot();
  const corners = state.room.vertices;
  state.room.vertices = corners.flatMap((start, i) => {
    const end = corners[(i + 1) % corners.length];
    return Array.from({ length: 40 }, (_, j) => ({ id: `edge-${i}-${j}`, x: start.x + (end.x - start.x) * j / 40, z: start.z + (end.z - start.z) * j / 40 }));
  });
  const navigation = createWalkNavigation(state);
  let point = { x: navigation.clearance, z: 1 };
  for (let i = 0; i < 120; i++) point = moveWalkPosition(navigation, point, { x: -0.01, z: 0.017 });
  near(point.x, navigation.clearance); near(point.z, 3.04);
  const away = moveWalkPosition(navigation, point, { x: 0.01, z: 0 });
  near(away.x, point.x + 0.01, 1e-7);
});

test('exact-fit passage centre remains traversable and undersized passages block repeated small steps', () => {
  for (const [width, permitted] of [[0.45, true], [0.449, false]]) {
    const navigation = createWalkNavigation(snapshot('rectangle', [divider()], [aperture({ width })]));
    let point = { x: 2, z: 2.5 };
    for (let i = 0; i < 100; i++) point = moveWalkPosition(navigation, point, { x: 0.02, z: 0 });
    assert.equal(point.x > 3, permitted, `width ${width}`);
    assert.equal(isWalkPositionValid(navigation, point), true);
  }
});

test('deterministic curved and concave motion stays inside translated, rotated and reversed rooms', () => {
  let seed = 0x12ba991;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (const shape of ['rectangle', 'circle', 'l-shape', 'recess']) {
    for (const reversed of [false, true]) {
      const state = snapshot(shape);
      const angle = 0.71, cos = Math.cos(angle), sin = Math.sin(angle);
      state.room.vertices = state.room.vertices.map((vertex) => ({ ...vertex,
        x: vertex.x * cos - vertex.z * sin - 13.7, z: vertex.x * sin + vertex.z * cos - 8.1 }));
      if (reversed) state.room.vertices.reverse();
      const navigation = createWalkNavigation(state), walls = getRoomWalls(state.room);
      let point = findWalkSpawn(navigation);
      assert.ok(point);
      for (let i = 0; i < 500; i++) {
        const scale = i % 37 === 0 ? 100 : 0.08;
        point = moveWalkPosition(navigation, point, { x: (random() - 0.5) * scale, z: (random() - 0.5) * scale });
        assert.equal(pointInRoom(point, state.room, false), true, `${shape} step ${i}`);
        for (const wall of walls) {
          const along = Math.max(0, Math.min(wall.length, (point.x - wall.start.x) * wall.tangent.x + (point.z - wall.start.z) * wall.tangent.z));
          const distance = Math.hypot(point.x - wall.start.x - along * wall.tangent.x, point.z - wall.start.z - along * wall.tangent.z);
          assert.ok(distance >= navigation.clearance - 1e-6, `${shape} crossed wall at step ${i}`);
        }
      }
    }
  }
});

test('a closed divider cannot be crossed by many large or tiny direction changes', () => {
  const navigation = createWalkNavigation(snapshot('rectangle', [divider()]));
  let point = { x: 2, z: 2 };
  for (let i = 0; i < 1000; i++) {
    point = moveWalkPosition(navigation, point, { x: i % 7 === 0 ? 100 : 0.025, z: Math.sin(i * 0.037) * 0.05 });
    assert.ok(point.x <= 3 - navigation.clearance + 1e-6);
  }
});

test('nonfinite preferences and spawn points cannot produce an unusable navigation state', () => {
  const navigation = createWalkNavigation(snapshot(), { radius: NaN, eyeHeight: Infinity });
  assert.equal(navigation.radius, 0.20); assert.equal(navigation.eyeHeight, 1.60);
  const spawn = findWalkSpawn(navigation, { x: Infinity, z: NaN });
  assert.ok(spawn && isWalkPositionValid(navigation, spawn));
});
