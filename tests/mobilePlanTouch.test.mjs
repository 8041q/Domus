import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTestServer } from './helpers/vite.mjs';

const vite = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { PlanTouchController, pinchPlanView, resizedPlanView } = await vite.ssrLoadModule('/src/core/planTouch.ts');
const { usePlannerStore: store, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const point = (id, x, y) => ({ id, x, y });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);

function editingFixture(selectedInitially = true) {
  store.getState().resetProject();
  let selected = selectedInitially;
  let view = { scale: 40, ox: 20, oz: 30 };
  const released = [], pending = [];
  let commits = 0, cancellations = 0;
  const controller = new PlanTouchController({
    begin(start) {
      if (!selected) { selected = true; return null; }
      const before = getSnapshot();
      return {
        move(sample) { pending.push(() => store.getState().updateRoom({ height: before.room.height + (sample.y - start.y) / 100 }, false)); },
        finish() { for (const apply of pending.splice(0)) apply(); store.getState().commitSnapshot(before); commits++; },
        cancel() { pending.length = 0; store.getState().cancelInteraction(before); cancellations++; }
      };
    },
    view: () => view,
    navigate(next) { view = next; },
    release(id) { released.push(id); }
  });
  return { controller, released, pending, flush() { for (const apply of pending.splice(0)) apply(); },
    get view() { return view; }, get commits() { return commits; }, get cancellations() { return cancellations; } };
}

test('pinch zoom keeps the original world point beneath the moving centroid', () => {
  const start = { x: 100, y: 200, distance: 50 }, current = { x: 150, y: 220, distance: 75 };
  const view = { scale: 40, ox: 20, oz: 60 };
  const next = pinchPlanView(view, start, current);
  near(next.scale, 60);
  near((start.x - view.ox) / view.scale, (current.x - next.ox) / next.scale);
  near((start.y - view.oz) / view.scale, (current.y - next.oz) / next.scale);
  assert.equal(pinchPlanView(view, start, { ...current, distance: 1e5 }).scale, 180);
  assert.equal(pinchPlanView(view, start, { ...current, distance: 0 }).scale, 6);
});

test('orientation and viewport resizing preserve zoom and the world point at the canvas centre', () => {
  const before = { scale: 52, ox: -80, oz: 70, width: 390, height: 650 };
  const after = resizedPlanView(before, 820, 280);
  assert.equal(after.scale, before.scale);
  near((before.width / 2 - before.ox) / before.scale, (after.width / 2 - after.ox) / after.scale);
  near((before.height / 2 - before.oz) / before.scale, (after.height / 2 - after.oz) / after.scale);
});

test('first touch selects without editing and only a subsequent drag creates one undo step', () => {
  const fixture = editingFixture(false), before = getSnapshot();
  fixture.controller.down(point(1, 100, 100));
  fixture.controller.move(point(1, 110, 150)); fixture.controller.up(point(1, 110, 150));
  assert.deepEqual(getSnapshot(), before); assert.equal(fixture.commits, 0);
  fixture.controller.down(point(1, 100, 100));
  fixture.controller.move(point(1, 100, 150)); fixture.controller.up(point(1, 100, 150));
  near(getSnapshot().room.height, 3.1); assert.equal(fixture.commits, 1);
  store.getState().undo(); assert.deepEqual(JSON.parse(JSON.stringify(getSnapshot())), JSON.parse(JSON.stringify(before)));
  store.getState().redo(); near(getSnapshot().room.height, 3.1);
});

test('a stationary selected tap does not snap, preview, or enter undo history', () => {
  const fixture = editingFixture(), before = getSnapshot();
  fixture.controller.down(point(1, 100, 100));
  fixture.controller.move(point(1, 103, 104)); fixture.controller.up(point(1, 103, 104));
  assert.equal(fixture.commits, 0); assert.equal(fixture.pending.length, 0);
  assert.deepEqual(getSnapshot(), before); assert.equal(fixture.controller.active, false);
});

test('second-finger takeover rolls back an applied preview, clears queued changes, and preserves existing undo', () => {
  const fixture = editingFixture();
  store.getState().updateRoom({ height: 2.9 });
  const before = getSnapshot();
  fixture.controller.down(point(1, 100, 100));
  fixture.controller.move(point(1, 100, 140)); fixture.flush();
  near(getSnapshot().room.height, 3.3);
  fixture.controller.move(point(1, 100, 150)); assert.equal(fixture.pending.length, 1);
  fixture.controller.down(point(2, 200, 150));
  assert.equal(fixture.pending.length, 0); assert.deepEqual(getSnapshot(), before);
  fixture.controller.move(point(1, 90, 150)); fixture.controller.move(point(2, 230, 150));
  assert.ok(fixture.view.scale > 40); assert.deepEqual(getSnapshot(), before);
  fixture.controller.up(point(1, 90, 150));
  fixture.controller.move(point(2, 240, 170)); fixture.controller.up(point(2, 240, 170));
  assert.equal(fixture.commits, 0); assert.equal(fixture.controller.active, false);
  store.getState().undo(); near(getSnapshot().room.height, 2.6);
  store.getState().redo(); assert.deepEqual(getSnapshot(), before);
});

test('cancelling touch restores preview state and releases every pointer without committing', () => {
  const fixture = editingFixture(), before = getSnapshot();
  fixture.controller.down(point(1, 100, 100)); fixture.controller.move(point(1, 100, 140)); fixture.flush();
  fixture.controller.cancel();
  assert.deepEqual(getSnapshot(), before); assert.deepEqual(fixture.released, [1]);
  assert.equal(fixture.commits, 0); assert.equal(fixture.controller.active, false);
  fixture.controller.down(point(1, 100, 100)); fixture.controller.down(point(2, 200, 100));
  assert.equal(fixture.controller.down(point(3, 300, 100)), false);
  fixture.controller.cancel();
  assert.deepEqual(fixture.released, [1, 1, 2]); assert.equal(fixture.controller.active, false);
});

test('tap-only drawing actions wait for release and never fire during two-finger navigation', () => {
  let drawn = 0;
  const controller = new PlanTouchController({
    begin: () => ({ move() {}, finish() {}, cancel() {}, tap() { drawn++; } }),
    view: () => ({ scale: 40, ox: 0, oz: 0 }), navigate() {}, release() {}
  });
  controller.down(point(1, 100, 100)); assert.equal(drawn, 0);
  controller.down(point(2, 200, 100)); controller.up(point(1, 100, 100)); controller.up(point(2, 200, 100));
  assert.equal(drawn, 0);
  controller.down(point(1, 100, 100)); controller.up(point(1, 100, 100)); assert.equal(drawn, 1);
});
