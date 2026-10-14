import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { createLoadingCoordinator } = await vite.ssrLoadModule('/src/core/loadingCoordinator.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');

function fixture() {
  let time = 0, id = 0;
  const jobs = new Map();
  const coordinator = createLoadingCoordinator({
    now: () => time,
    schedule(callback, delay) { jobs.set(++id, { at: time + delay, callback }); return id; },
    cancel(timer) { jobs.delete(timer); }
  });
  const advance = duration => {
    const until = time + duration;
    while (true) {
      const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      time = next[1].at; jobs.delete(next[0]); next[1].callback();
    }
    time = until;
  };
  return { coordinator, advance, jobs, state: coordinator.getSnapshot };
}
const view = { phase: 'view', label: 'Opening view', blocking: true };
const models = { phase: 'models', label: 'Loading furniture', progress: { completed: 1, total: 4, unit: 'models' } };

test('short loading completes immediately but the single presentation lasts at least two seconds', () => {
  const { coordinator, state, advance } = fixture();
  const task = coordinator.start(view);
  assert.equal(state().blocking, true);
  advance(50); task.finish();
  assert.equal(state().pending, 0); assert.equal(state().blocking, false);
  advance(1949);
  assert.equal(state().visible, true); assert.equal(state().leaving, false);
  advance(1); assert.equal(state().leaving, true);
  advance(160); assert.equal(state().visible, false);
});

test('view, materials and furniture share a lifetime, and phase handoffs do not restart minimum timing', () => {
  const { coordinator, state, advance } = fixture();
  const opening = coordinator.start(view);
  advance(100);
  const textures = coordinator.start({ phase: 'textures', label: 'Loading materials' });
  const furniture = coordinator.start(models);
  assert.equal(state().pending, 3);
  opening.finish();
  assert.equal(state().message.phase, 'models'); assert.equal(state().blocking, false);
  advance(600); furniture.finish();
  assert.equal(state().message.phase, 'textures'); assert.equal(state().pending, 1);
  advance(300); textures.finish();
  assert.equal(state().pending, 0);
  advance(999); assert.equal(state().leaving, false);
  advance(1); assert.equal(state().leaving, true, 'Two seconds applies to the whole flow, not each individual phase');
});

test('completed startup never hides still-pending work, including work lasting beyond two seconds', () => {
  const { coordinator, state, advance } = fixture();
  const opening = coordinator.start(view);
  const furniture = coordinator.start(models);
  opening.finish(); advance(5000);
  assert.equal(state().visible, true); assert.equal(state().leaving, false);
  assert.equal(state().pending, 1); assert.equal(state().message.phase, 'models');
  furniture.finish(); advance(0); assert.equal(state().leaving, true);
  advance(160); assert.equal(state().visible, false);
});

test('export dependencies stay registered and advance to actual export preparation when assets finish', () => {
  const { coordinator, state } = fixture();
  const furniture = coordinator.start(models);
  const textures = coordinator.start({ phase: 'textures', label: 'Loading materials' });
  const exporting = coordinator.start({ phase: 'export', label: 'Preparing report', detail: 'Capturing views', blocking: true });
  assert.equal(state().pending, 3); assert.equal(state().blocking, true);
  assert.equal(state().message.phase, 'export');
  assert.equal(state().message.detail, 'Loading furniture for the export');
  furniture.update({ ...models, progress: { completed: 3, total: 4, unit: 'models' } });
  assert.equal(state().message.progress.completed, 3);
  furniture.finish();
  assert.equal(state().message.detail, 'Loading room materials for the export');
  textures.finish(); assert.equal(state().message.detail, 'Capturing views');
  exporting.finish(); assert.equal(state().pending, 0); assert.equal(state().blocking, false);
});

test('errors remain recoverable without replacing other pending work, and retry is a real pending operation', () => {
  const { coordinator, state, advance } = fixture();
  const failed = coordinator.start({ ...models, label: 'Model failed', error: true, action: 'retry' });
  const textures = coordinator.start({ phase: 'textures', label: 'Loading materials' });
  assert.equal(state().message.phase, 'textures');
  textures.finish(); advance(5000);
  assert.equal(state().message.error, true); assert.equal(state().pending, 0);
  assert.equal(state().message.action, 'retry'); assert.equal(state().visible, true);
  failed.update(models); assert.equal(state().pending, 1); assert.equal(state().message.error, undefined);
  failed.finish(); advance(160); assert.equal(state().visible, false);
});

test('navigation and recovery discard old work and timers; late callbacks cannot affect a new flow', () => {
  const { coordinator, state, advance, jobs } = fixture();
  const stale = coordinator.start(view);
  stale.finish(); assert.ok(jobs.size);
  coordinator.dispose(); assert.equal(jobs.size, 0);
  const current = coordinator.start(models);
  stale.update(view); stale.finish();
  assert.equal(state().pending, 1); assert.equal(state().message.phase, 'models');
  coordinator.clear(); assert.equal(state().visible, false); assert.equal(jobs.size, 0);
  current.update(models); advance(5000);
  assert.equal(state().visible, false);
});

test('material loading reports actual pending promises, deduplicates a finish, and ends after the last finish resolves', async () => {
  const statuses = [], resolve = [];
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { options: { onTextureStatus: loading => statuses.push(loading) },
    floorMapCache: new Map(), floorMapResults: new Map(), disposed: false,
    loadFloorMap: () => new Promise(done => resolve.push(done)) });
  const definition = { id: 'first', name: 'First', maps: { color: '/first.jpg' }, textureWidthMetres: 1,
    useNormalMap: false, useHeightMap: false, useRoughnessMap: false };
  const first = scene.loadFloorFinishMaps(definition);
  assert.equal(scene.loadFloorFinishMaps(definition), first);
  const second = scene.loadFloorFinishMaps({ ...definition, id: 'second' });
  assert.equal(resolve.length, 2, 'Sharing a finish must not create another request');
  resolve[0](null); await first;
  assert.equal(statuses.at(-1), true, 'A remaining material must keep loading active');
  resolve[1](null); await second;
  assert.equal(statuses.at(-1), false);
  const before = statuses.length;
  await scene.loadFloorFinishMaps(definition);
  assert.equal(statuses.length, before, 'Cached material reuse does not create a loading phase');
});
