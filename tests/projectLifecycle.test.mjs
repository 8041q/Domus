import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { RoomProjects, ROOM_LIBRARY_KEY, ROOM_DRAFT_KEY } = await vite.ssrLoadModule('/src/core/roomProjects.ts');
const { emptyRoomSnapshot, parseProjectSnapshot, usePlannerStore: store, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { FEATURES } = await vite.ssrLoadModule('/src/config/features.ts');
const { PlanRoom } = await vite.ssrLoadModule('/src/PlanRoom.tsx');
const { AIExperimentPanel } = await vite.ssrLoadModule('/src/ai/AIExperimentPanel.tsx');
const client = await vite.ssrLoadModule('/src/ai/client.ts');
const { experimentalAiGateway } = await vite.ssrLoadModule('/server/aiGateway.ts');
function harness(values = new Map()) {
  let snapshot = emptyRoomSnapshot();
  let blocked = false;
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { if (blocked) throw new Error('Storage full'); values.set(key, value); } };
  const adapter = { snapshot: () => structuredClone(snapshot), open: (value) => { snapshot = structuredClone(value); return true; }, empty: emptyRoomSnapshot, decode: parseProjectSnapshot };
  const session = new RoomProjects(() => storage, adapter);
  session.initialize();
  return { session, values, storage, get: () => snapshot, edit: (height = 2.9) => { snapshot.room.height = height; session.changed(); }, block: () => { blocked = true; } };
}

test('new rooms start empty in every supported shape', () => {
  for (const shape of ['rectangle', 'angled-corner', 'l-shape', 'recess']) {
    const h = harness(); h.session.newRoom('  Office  ', shape);
    assert.equal(h.session.getState().name, 'Office');
    assert.equal(h.session.getState().dirty, true);
    assert.equal(h.get().room.shapeKind, shape);
    for (const key of ['objects', 'openings', 'dividers', 'unplacedObjects']) assert.equal(h.get()[key].length, 0);
    assert.ok(parseProjectSnapshot(h.get()));
  }
});

test('named rooms save independently, updates reuse IDs, and Save as makes a copy', () => {
  const h = harness();
  h.session.newRoom('Office', 'rectangle'); const original = h.session.save();
  h.edit(); const update = h.session.save();
  assert.equal(update.id, original.id);
  assert.notEqual(update.revision, original.revision);
  h.session.save('Office copy', true);
  h.session.newRoom('Kitchen', 'l-shape'); h.session.save();
  assert.equal(h.session.getState().rooms.length, 3);
  h.session.open(original.id);
  assert.equal(h.get().room.height, 2.9);
  assert.equal(h.session.getState().name, 'Office');
  assert.equal(h.session.getState().dirty, false);
});

test('dirty state returns to clean when the saved semantic snapshot is restored', () => {
  const h = harness(); h.session.save('Room');
  h.edit(3); assert.equal(h.session.getState().dirty, true);
  h.edit(2.6); assert.equal(h.session.getState().dirty, false);
});

test('recovery restores unsaved edits and keeps the saved baseline for dirty tracking', () => {
  const h = harness(); const saved = h.session.save('Office');
  h.edit(3); h.session.persistDraft();
  const recovered = harness(h.values);
  assert.equal(recovered.get().room.height, 3);
  assert.equal(recovered.session.getState().activeId, saved.id);
  assert.equal(recovered.session.getState().dirty, true);
  recovered.edit(2.6); assert.equal(recovered.session.getState().dirty, false);
  recovered.session.newRoom('Not saved yet', 'recess');
  const newRecovery = harness(h.values);
  assert.equal(newRecovery.session.getState().name, 'Not saved yet');
  assert.equal(newRecovery.session.getState().activeId, null);
  assert.equal(newRecovery.session.getState().dirty, true);
});

test('quota failures leave the last save, active identity and dirty work intact', () => {
  const h = harness(); const record = h.session.save('Office');
  const lastSave = h.values.get(ROOM_LIBRARY_KEY);
  h.edit(3); h.block();
  assert.throws(() => h.session.save(), /Storage full/);
  assert.equal(h.values.get(ROOM_LIBRARY_KEY), lastSave);
  assert.equal(h.session.getState().activeId, record.id);
  assert.equal(h.session.getState().dirty, true);
  assert.equal(h.get().room.height, 3);
  h.session.persistDraft(); assert.match(h.session.getState().warning, /Recovery/);
});

test('a changed record in another tab is protected and can be recovered with Save as', () => {
  const first = harness(); const record = first.session.save('Office');
  const second = harness(first.values); second.session.open(record.id);
  first.edit(3); first.session.save();
  second.edit(2.8); assert.throws(() => second.session.save(), /another tab/);
  second.session.save('Office alternative', true);
  assert.equal(second.session.getState().rooms.length, 2);
  second.session.open(record.id); assert.equal(second.get().room.height, 3);
});

test('duplicate and blank names cannot overwrite saved rooms', () => {
  const h = harness(); h.session.save('Office');
  assert.throws(() => h.session.save(' office ', true), /already exists/);
  assert.throws(() => h.session.save('   ', true), /room name/);
  assert.equal(h.session.getState().rooms.length, 1);
});

test('legacy single-slot save migrates once, without removing the original backup', () => {
  const legacy = JSON.stringify({ room: { width: 6, depth: 4, height: 2.7 }, objects: [] });
  const values = new Map([['room-planner-project-v3', legacy]]);
  const h = harness(values);
  assert.equal(h.session.getState().rooms.length, 1);
  assert.equal(h.session.getState().rooms[0].name, 'Recovered room');
  h.session.open('legacy-room'); assert.equal(h.get().room.width, 6);
  h.session.save();
  assert.equal(harness(values).session.getState().rooms.length, 1);
  assert.equal(values.get('room-planner-project-v3'), legacy);
});

test('malformed library, imported file and polygon never replace current work or saved data', () => {
  const values = new Map([[ROOM_LIBRARY_KEY, '{invalid']]);
  const h = harness(values);
  const before = structuredClone(h.get());
  assert.throws(() => h.session.save('Office'));
  assert.equal(values.get(ROOM_LIBRARY_KEY), '{invalid');
  assert.throws(() => h.session.readFile('{bad', 'Room'));
  const invalid = emptyRoomSnapshot(); invalid.room.vertices[2] = { id: 'v2', x: 0, z: 0 };
  assert.throws(() => h.session.readFile(JSON.stringify(invalid), 'Room'), /valid Domus/);
  assert.equal(parseProjectSnapshot(invalid), null);
  assert.deepEqual(h.get(), before);
});

test('project files preserve disabled interior data and omit session/credential state', () => {
  const previous = FEATURES.interiorWalls; FEATURES.interiorWalls = true;
  try {
    store.getState().resetProject();
    assert.equal(store.getState().addDivider('wall', { kind: 'perimeter', id: 'wall-v0-v1', t: 0.5 }, { kind: 'perimeter', id: 'wall-v2-v3', t: 0.5 }), true);
    store.getState().updateSpace(store.getState().spaces[0].id, { name: 'Reception', wallColor: '#aaccee' });
    const h = harness(); h.session.importRoom({ name: 'Divided room', snapshot: getSnapshot() });
    FEATURES.interiorWalls = false;
    const exported = h.session.exportFile(); const envelope = JSON.parse(exported);
    assert.deepEqual(Object.keys(envelope).sort(), ['format', 'name', 'snapshot', 'version']);
    const imported = h.session.readFile(exported, 'Fallback');
    assert.equal(imported.name, 'Divided room'); assert.equal(imported.snapshot.dividers.length, 1);
    assert.equal(imported.snapshot.spaces[0].name, 'Reception');
    assert.deepEqual(imported.snapshot, h.get());
    assert.throws(() => h.session.readFile(JSON.stringify({ ...envelope, version: 9 }), 'Room'), /version/);
  } finally { FEATURES.interiorWalls = previous; }
});

test('opening a room resets view, selection and undo history; failed opening is atomic', () => {
  store.getState().resetProject(); store.getState().updateRoom({ height: 3 });
  const before = getSnapshot();
  assert.equal(store.getState().openProject({}), false);
  assert.deepEqual(getSnapshot(), before);
  store.getState().undo(); assert.equal(store.getState().room.height, 2.6);
  store.getState().setMode('plan'); store.getState().setBuildView('3d');
  assert.equal(store.getState().openProject(emptyRoomSnapshot('recess')), true);
  assert.equal(store.getState().mode, 'build'); assert.equal(store.getState().buildView, 'plan');
  assert.equal(store.getState().selectedId, null);
  const opened = getSnapshot(); store.getState().undo(); assert.deepEqual(getSnapshot(), opened);
  store.getState().updateRoom({ height: 2.8 }); store.getState().undo(); assert.deepEqual(getSnapshot(), opened);
});

test('disabled AI hides all entry points and refuses client, gateway and proposal calls', async () => {
  const previous = FEATURES.aiExperiment; const previousFetch = globalThis.fetch;
  const before = getSnapshot(); let fetches = 0;
  FEATURES.aiExperiment = false;
  globalThis.fetch = () => { fetches++; throw new Error('Unexpected provider call'); };
  try {
    assert.doesNotMatch(renderToString(createElement(PlanRoom)), /Experimental AI room assistant/);
    assert.equal(renderToString(createElement(AIExperimentPanel, { onClose() {} })), '');
    await assert.rejects(client.getAiGatewayConfig(), /disabled/);
    await assert.rejects(client.listAiModels({ provider: 'openai' }), /disabled/);
    await assert.rejects(client.sendAiTurn({}), /disabled/);
    assert.equal(fetches, 0);
    assert.deepEqual(store.getState().applyAiProposal({}), { ok: false, error: 'The AI experiment is disabled.' });
    assert.deepEqual(getSnapshot(), before);
    let middleware; experimentalAiGateway().configureServer({ middlewares: { use(fn) { middleware = fn; } } });
    for (const route of ['config', 'models', 'turn']) {
      let body; const response = { setHeader() {}, end(text) { body = JSON.parse(text); } };
      await middleware({ url: `/api/ai/${route}`, method: 'POST' }, response, () => assert.fail('AI route bypassed disabled gate'));
      assert.equal(response.statusCode, 503); assert.match(body.error, /disabled/);
    }
  } finally { FEATURES.aiExperiment = previous; globalThis.fetch = previousFetch; }
  assert.match(renderToString(createElement(PlanRoom)), /Experimental AI room assistant/);
});

test('an unreadable recovery draft is retained until an explicit replacement or save', () => {
  const values = new Map([[ROOM_DRAFT_KEY, '{invalid']]);
  const h = harness(values); h.edit(3); h.session.persistDraft();
  assert.equal(values.get(ROOM_DRAFT_KEY), '{invalid');
  assert.match(h.session.getState().warning, /draft could not be read/);
  h.session.save('Office');
  assert.equal(JSON.parse(values.get(ROOM_DRAFT_KEY)).snapshot.room.height, 3);
});

test('a valid recovery draft restores work even if the saved library is unreadable', () => {
  const h = harness(); h.session.newRoom('Unsaved work', 'l-shape'); h.edit(3); h.session.persistDraft();
  h.values.set(ROOM_LIBRARY_KEY, '{invalid');
  const recovered = harness(h.values);
  assert.equal(recovered.get().room.height, 3);
  assert.equal(recovered.session.getState().name, 'Unsaved work');
  assert.equal(recovered.session.getState().dirty, true);
  assert.equal(h.values.get(ROOM_LIBRARY_KEY), '{invalid');
});

test('starting project handling around an already edited store marks the existing work dirty', () => {
  const initial = emptyRoomSnapshot();
  const current = structuredClone(initial); current.room.height = 3;
  const values = new Map();
  const session = new RoomProjects(() => ({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }),
    { initial: () => initial, snapshot: () => current, open: () => true, empty: emptyRoomSnapshot, decode: parseProjectSnapshot });
  session.initialize();
  assert.equal(session.getState().dirty, true);
});

test('deleting another saved room leaves the active layout and save identity unchanged', () => {
  const h = harness(); const first = h.session.save('Office');
  const active = h.session.save('Office copy', true); h.edit(3);
  const layout = structuredClone(h.get()); const draft = h.values.get(ROOM_DRAFT_KEY);
  h.session.remove(first.id, first.revision);
  assert.deepEqual(h.session.getState().rooms.map((room) => room.id), [active.id]);
  assert.equal(h.session.getState().activeId, active.id);
  assert.equal(h.session.getState().dirty, true);
  assert.deepEqual(h.get(), layout);
  assert.equal(h.values.get(ROOM_DRAFT_KEY), draft);
});

test('deleting the active save preserves edits as an unsaved recoverable room', () => {
  const h = harness(); const saved = h.session.save('Office'); h.edit(3);
  h.session.remove(saved.id, saved.revision);
  assert.equal(h.session.getState().activeId, null);
  assert.equal(h.session.getState().savedAt, null);
  assert.equal(h.session.getState().dirty, true);
  assert.equal(h.get().room.height, 3);
  const recovered = harness(h.values);
  assert.equal(recovered.session.getState().activeId, null);
  assert.equal(recovered.session.getState().dirty, true);
  assert.equal(recovered.get().room.height, 3);
  const replacement = recovered.session.save();
  assert.notEqual(replacement.id, saved.id);
  assert.equal(replacement.name, 'Office');
});

test('failed deletion does not remove saved data or change active metadata', () => {
  const h = harness(); const saved = h.session.save('Office');
  const before = h.values.get(ROOM_LIBRARY_KEY); const metadata = h.session.getState();
  h.block(); assert.throws(() => h.session.remove(saved.id, saved.revision), /Storage full/);
  assert.equal(h.values.get(ROOM_LIBRARY_KEY), before);
  assert.deepEqual(h.session.getState(), metadata);
});

test('deletion refuses a stale revision and a deleted save recovers as an unsaved copy in another tab', () => {
  const h = harness(); const saved = h.session.save('Office');
  const other = harness(h.values);
  h.edit(3); const updated = h.session.save();
  assert.throws(() => other.session.remove(saved.id, saved.revision), /another tab/);
  assert.equal(JSON.parse(h.values.get(ROOM_LIBRARY_KEY)).rooms.length, 1);
  // The other tab can delete the fresh listed record without replacing its working layout.
  other.session.remove(updated.id, updated.revision);
  // Simulate the original tab's leave-page recovery flush after the deletion.
  h.session.persistDraft();
  const recovered = harness(h.values);
  assert.equal(recovered.session.getState().activeId, null);
  assert.equal(recovered.session.getState().dirty, true);
  assert.equal(recovered.get().room.height, 3);
});

test('deleting the last migrated room does not resurrect the legacy save', () => {
  const values = new Map([['room-planner-project-v3', JSON.stringify(emptyRoomSnapshot())]]);
  const h = harness(values); h.session.remove('legacy-room', 'legacy');
  assert.equal(harness(values).session.getState().rooms.length, 0);
  assert.ok(values.get('room-planner-project-v3'));
  assert.deepEqual(JSON.parse(values.get(ROOM_LIBRARY_KEY)).rooms, []);
});
