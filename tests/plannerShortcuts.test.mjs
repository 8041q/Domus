import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTestServer as createServer } from './helpers/vite.mjs';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { handlePlannerShortcut } = await vite.ssrLoadModule('/src/core/plannerShortcuts.ts');
const { usePlannerStore: store, getSnapshot } = await vite.ssrLoadModule('/src/store.ts');

function press(patch = {}, docPatch = {}) {
  const calls = [];
  const event = { key: 'x', composedPath: () => [], preventDefault: () => calls.push('prevent'), ...patch };
  const doc = { activeElement: null, querySelector: () => null, ...docPatch };
  handlePlannerShortcut(event, { mode: 'build', rotate: () => calls.push('rotate'), remove: () => calls.push('remove'),
    undo: () => calls.push('undo'), redo: () => calls.push('redo') }, doc);
  return calls;
}

test('X deletes once and leaves modifier shortcuts, composition and handled events alone', () => {
  assert.deepEqual(press(), ['prevent', 'remove']);
  assert.deepEqual(press({ key: 'X', shiftKey: true }), ['prevent', 'remove']);
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'isComposing', 'defaultPrevented']) {
    assert.deepEqual(press({ [flag]: true }), [], flag);
  }
  assert.deepEqual(press({}, { querySelector: () => ({ open: true }) }), []);
});

test('X never deletes while a form control or editable field has focus', () => {
  for (const selector of ['input', 'textarea', 'select', '[role="textbox"]', '[role="combobox"]']) {
    const target = { closest: (selectors) => selectors.includes(selector) ? {} : null };
    assert.deepEqual(press({ composedPath: () => [target] }), [], selector);
    assert.deepEqual(press({}, { activeElement: target }), [], selector);
  }
  const editable = { isContentEditable: true };
  assert.deepEqual(press({ composedPath: () => [editable] }), []);
  assert.deepEqual(press({}, { activeElement: editable }), []);
});

test('X removes selected doors, windows, openings and furniture in both modes, with undo', () => {
  for (const mode of ['build', 'plan']) {
    for (const type of ['door', 'window', 'opening', 'furniture']) {
      store.getState().resetProject();
      store.getState().setMode(mode);
      if (type === 'furniture') {
        store.setState({ objects: [{ id: 'model', productId: 'chair', x: 1, z: 1, rotationY: 0 }], selectedId: 'model', selectedOpeningId: null });
      } else {
        assert.equal(store.getState().addOpening(type), true);
      }
      const before = getSnapshot();
      const id = type === 'furniture' ? store.getState().selectedId : store.getState().selectedOpeningId;
      handlePlannerShortcut({ key: 'x', composedPath: () => [], preventDefault() {} }, {
        mode, remove: store.getState().removeSelected, rotate() {}, undo() {}, redo() {}
      }, { activeElement: null, querySelector: () => null });
      const collection = type === 'furniture' ? 'objects' : 'openings';
      assert.equal(store.getState()[collection].some((item) => item.id === id), false, `${mode}: ${type}`);
      store.getState().undo();
      assert.deepEqual(JSON.parse(JSON.stringify(getSnapshot())), JSON.parse(JSON.stringify(before)));
    }
  }
  store.getState().resetProject();
});
