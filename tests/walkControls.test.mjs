import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { createTestServer as createServer } from './helpers/vite.mjs';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { WalkControls } = await vite.ssrLoadModule('/src/renderer/WalkControls.ts');

function emit(target, type, fields = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

function fixture() {
  const document = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const window = new EventTarget();
  document.defaultView = window;
  const captures = new Set();
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: document, style: { cursor: 'default' }, clientHeight: 600,
    focus() { document.activeElement = canvas; },
    setPointerCapture(id) { captures.add(id); },
    hasPointerCapture(id) { return captures.has(id); },
    releasePointerCapture(id) { captures.delete(id); }
  });
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(3, 1.6, 3);
  const moves = [];
  let changes = 0, exits = 0;
  const controls = new WalkControls(camera, canvas, { move: (x, z) => moves.push({ x, z }), change: () => changes++, exit: () => exits++ });
  return { document, window, canvas, camera, moves, captures, controls, get changes() { return changes; }, get exits() { return exits; } };
}

const key = (f, code, fields) => emit(f.canvas, 'keydown', { code, key: code === 'Escape' ? 'Escape' : code, ...fields });
const pointer = (f, type, fields = {}) => {
  const button = fields.button ?? (type === 'pointerdown' ? 0 : f.pointerButton ?? 0);
  const x = fields.clientX ?? (type === 'pointerdown' ? 0 : f.pointerX ?? 0);
  const y = fields.clientY ?? (type === 'pointerdown' ? 0 : f.pointerY ?? 0);
  f.pointerButton = button; f.pointerX = x; f.pointerY = y;
  return emit(type === 'pointerdown' ? f.canvas : f.window, type, { pointerId: 1, button,
    pointerType: 'mouse', buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : button === 1 ? 4 : button === 2 ? 2 : 1,
    clientX: x, clientY: y, ...fields });
};
const distance = (f) => f.moves.reduce((sum, move) => sum + Math.hypot(move.x, move.z), 0);
function advance(f, from, duration, fps = 60) {
  f.controls.update(from);
  const frames = Math.round(duration * fps / 1000);
  for (let frame = 1; frame <= frames; frame++) f.controls.update(from + frame * duration / frames);
}

test('walk acceleration and distance are equal at 30, 60 and 144 Hz without a phantom first step', () => {
  const distances = [];
  for (const fps of [30, 60, 144]) {
    const f = fixture(); f.controls.setEnabled(true);
    assert.equal(key(f, 'KeyW').defaultPrevented, true);
    assert.equal(f.controls.update(0), true); assert.equal(f.moves.length, 0);
    const changes = f.changes;
    advance(f, 0, 1000, fps);
    assert.equal(f.changes, changes, 'update relies on the renderer for follow-up frames');
    assert.ok(f.moves.every(move => Math.abs(move.x) < 1e-8 && move.z < 0));
    assert.ok(distance(f) > 1.35 && distance(f) < 1.5, 'brief acceleration reaches normal walking speed');
    distances.push(distance(f)); f.controls.dispose();
  }
  assert.ok(Math.max(...distances) - Math.min(...distances) < 1e-9);
});

test('diagonal movement has the same speed as straight movement and braking settles promptly', () => {
  const straight = fixture(), diagonal = fixture();
  for (const f of [straight, diagonal]) { f.controls.setEnabled(true); key(f, 'KeyW'); }
  key(diagonal, 'KeyD');
  for (const f of [straight, diagonal]) advance(f, 0, 1000);
  assert.ok(Math.abs(distance(straight) - distance(diagonal)) < 1e-9);
  assert.ok(diagonal.moves.every(move => move.x > 0 && move.z < 0));
  emit(diagonal.window, 'keyup', { code: 'KeyW' }); emit(diagonal.window, 'keyup', { code: 'KeyD' });
  const before = distance(diagonal);
  assert.equal(diagonal.controls.update(1016), true, 'release briefly brakes instead of snapping');
  advance(diagonal, 1016, 500);
  assert.equal(diagonal.controls.update(1532), false);
  assert.ok(distance(diagonal) - before < 0.065, 'braking cannot drift far across the floor');
  for (const f of [straight, diagonal]) f.controls.dispose();
});

test('long delayed frames and repeat keys cannot create a movement jump or extra scheduling', () => {
  const f = fixture(); f.controls.setEnabled(true); key(f, 'KeyW'); advance(f, 0, 500);
  const changes = f.changes; key(f, 'KeyW', { repeat: true }); assert.equal(f.changes, changes);
  f.moves.length = 0; f.controls.update(50_000);
  assert.ok(distance(f) <= 0.075 + 1e-9, 'background stalls contribute at most one short step');
  f.controls.dispose();
});

test('look drag turns in place and keyboard movement follows horizontal heading', () => {
  const f = fixture(); f.controls.setEnabled(true);
  const position = f.camera.position.clone();
  pointer(f, 'pointerdown');
  pointer(f, 'pointermove', { clientX: -Math.PI / 2 / 0.003, clientY: 20_000 });
  pointer(f, 'pointerup');
  f.controls.update(0);
  assert.ok(f.camera.position.equals(position));
  const direction = new THREE.Vector3(); f.camera.getWorldDirection(direction);
  assert.ok(direction.y < 0 && direction.y > -1, 'Pitch stops before the upside-down singularity');
  key(f, 'KeyW'); f.controls.update(0); f.controls.update(20);
  assert.ok(f.moves[0].x < 0);
  assert.ok(Math.abs(f.moves[0].z) < 1e-8);
  f.controls.dispose();
});

test('mouse pan and wheel share horizontal collision movement without changing FOV', () => {
  const f = fixture(); f.controls.setEnabled(true);
  const originalFov = f.camera.fov, originalQuaternion = f.camera.quaternion.clone();
  pointer(f, 'pointerdown', { button: 2 });
  pointer(f, 'pointermove', { clientX: 40, clientY: 30 });
  pointer(f, 'pointerup', { button: 2 });
  assert.equal(f.moves.length, 0, 'pointer bursts wait for the next rendered frame');
  f.controls.update(0);
  assert.deepEqual(f.moves[0], { x: -0.24, z: 0.18 });
  f.moves.length = 0;
  const wheel = emit(f.canvas, 'wheel', { deltaY: -1e6, deltaMode: 1 });
  assert.equal(wheel.defaultPrevented, true);
  assert.equal(f.moves.length, 0, 'wheel input eases across future frames');
  advance(f, 0, 1000);
  assert.ok(Math.abs(distance(f) - 0.8) < 1e-8);
  assert.ok(f.moves.every(move => move.x === 0 && move.z < 0 && Math.abs(move.z) <= 0.05 + 1e-6));
  assert.equal(f.camera.fov, originalFov);
  assert.ok(f.camera.quaternion.equals(originalQuaternion));
  f.controls.dispose();
});

test('pointer bursts use one collision translation per frame and include the final pointerup sample', () => {
  const f = fixture(); f.controls.setEnabled(true);
  pointer(f, 'pointerdown', { button: 2 });
  for (let sample = 1; sample <= 100; sample++) pointer(f, 'pointermove', { clientX: sample / 2, clientY: sample / 4 });
  pointer(f, 'pointerup', { button: 2, clientX: 60, clientY: 30 });
  assert.equal(f.moves.length, 0);
  assert.equal(f.controls.update(0), true);
  assert.equal(f.moves.length, 1);
  assert.ok(Math.abs(f.moves[0].x + 0.36) < 1e-10);
  assert.ok(Math.abs(f.moves[0].z - 0.18) < 1e-10);
  assert.equal(f.controls.update(16), false, 'the final pointer frame is followed by one idle frame');
  pointer(f, 'pointerdown', { button: 2 });
  pointer(f, 'pointermove', { clientX: 1e6 });
  f.controls.update(32);
  assert.ok(Math.hypot(f.moves[1].x, f.moves[1].z) <= 2, 'an anomalous pointer burst has bounded travel');
  f.controls.dispose();
});

test('look bursts preserve total rotation while applying the quaternion only on the rendered frame', () => {
  const f = fixture(); f.controls.setEnabled(true);
  const before = f.camera.quaternion.clone();
  pointer(f, 'pointerdown');
  for (let sample = 1; sample <= 100; sample++) pointer(f, 'pointermove', { clientX: sample, clientY: sample / 2 });
  pointer(f, 'pointerup');
  assert.ok(f.camera.quaternion.equals(before), 'events update intent without repeated camera work');
  assert.equal(f.controls.update(0), true);
  const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.15, -0.3, 0, 'YXZ'));
  assert.ok(f.camera.quaternion.angleTo(expected) < 1e-7);
  assert.equal(f.moves.length, 0);
  assert.equal(f.controls.update(16), false);
  f.controls.dispose();
});

test('wheel units have equal travel, trackpad sideways movement works, and bursts cannot build a long backlog', () => {
  for (const [deltaY, deltaMode] of [[120, 0], [7.5, 1], [0.2, 2]]) {
    const f = fixture(); f.controls.setEnabled(true);
    emit(f.canvas, 'wheel', { deltaY, deltaMode }); advance(f, 0, 1000);
    assert.ok(Math.abs(distance(f) - 0.3) < 1e-8);
    assert.equal(f.controls.update(1016), false); f.controls.dispose();
  }
  const f = fixture(); f.controls.setEnabled(true);
  for (let sample = 0; sample < 1000; sample++) emit(f.canvas, 'wheel', { deltaX: 100, deltaY: 0, deltaMode: 0 });
  advance(f, 0, 1000);
  assert.ok(Math.abs(distance(f) - 0.8) < 1e-8);
  assert.ok(f.moves.every(move => move.x > 0 && Math.abs(move.z) < 1e-9));
  assert.equal(f.controls.update(1016), false); f.controls.dispose();
});

test('wheel reversal promptly cancels the old direction and pinch zoom stays a browser gesture', () => {
  const f = fixture(); f.controls.setEnabled(true);
  emit(f.canvas, 'wheel', { deltaY: -120, deltaMode: 0 });
  emit(f.canvas, 'wheel', { deltaY: 40, deltaMode: 0 });
  advance(f, 0, 1000);
  assert.ok(Math.abs(distance(f) - 0.1) < 1e-8);
  assert.ok(f.moves.every(move => move.z > 0));
  assert.equal(emit(f.canvas, 'wheel', { deltaY: 120, deltaMode: 0, ctrlKey: true }).defaultPrevented, false);
  assert.equal(emit(f.canvas, 'wheel', { deltaY: NaN, deltaMode: 0 }).defaultPrevented, false);
  assert.equal(f.controls.update(1016), false); f.controls.dispose();
});

test('cancelled pointers and missed button releases cannot keep dragging or apply a cancelled sample', () => {
  const f = fixture(); f.controls.setEnabled(true);
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    pointer(f, 'pointerdown', { button: 2 }); pointer(f, 'pointermove', { clientX: 40 });
    if (ending === 'lostpointercapture') emit(f.canvas, ending, { pointerId: 1 });
    else pointer(f, ending);
    assert.equal(f.captures.size, 0); assert.equal(f.controls.update(0), false);
    assert.equal(f.moves.length, 0);
  }
  pointer(f, 'pointerdown');
  pointer(f, 'pointermove', { clientX: 200, buttons: 0 });
  assert.equal(f.captures.size, 0); assert.equal(f.controls.update(16), false);
  assert.ok(f.camera.quaternion.equals(new THREE.Quaternion()));
  f.controls.dispose();
});

test('blur and composition immediately cancel velocity, wheel backlog and queued gestures', () => {
  for (const interrupt of ['blur', 'compositionstart', 'composing-key', 'modified-key']) {
    const f = fixture(); f.controls.setEnabled(true); key(f, 'KeyW'); advance(f, 0, 200);
    emit(f.canvas, 'wheel', { deltaY: -500, deltaMode: 0 });
    pointer(f, 'pointerdown', { button: 2 }); pointer(f, 'pointermove', { clientX: 40 });
    const moved = f.moves.length;
    if (interrupt === 'composing-key') assert.equal(key(f, 'KeyW', { isComposing: true }).defaultPrevented, false);
    else if (interrupt === 'modified-key') assert.equal(key(f, 'KeyW', { metaKey: true }).defaultPrevented, false);
    else emit(f.canvas, interrupt);
    assert.equal(f.controls.update(220), false, `${interrupt} stops all queued motion`);
    assert.equal(f.moves.length, moved); assert.equal(f.captures.size, 0);
    f.controls.dispose();
  }
});

test('focus loss, hidden page and pointer cancellation release held movement and capture', () => {
  const f = fixture(); f.controls.setEnabled(true);
  key(f, 'KeyW'); pointer(f, 'pointerdown');
  assert.equal(f.captures.size, 1);
  emit(f.canvas, 'blur');
  assert.equal(f.controls.update(0), false); assert.equal(f.captures.size, 0);
  key(f, 'ArrowUp'); f.document.hidden = true; emit(f.document, 'visibilitychange');
  f.document.hidden = false;
  assert.equal(f.controls.update(20), false);
  pointer(f, 'pointerdown'); pointer(f, 'pointercancel');
  assert.equal(f.captures.size, 0);
  key(f, 'KeyD'); f.document.activeElement = {};
  assert.equal(f.controls.update(50), false);
  f.controls.dispose();
});

test('disabled controls and modified or unfocused keys leave ordinary browser actions intact', () => {
  const f = fixture();
  assert.equal(key(f, 'KeyW').defaultPrevented, false);
  assert.equal(emit(f.canvas, 'wheel', { deltaY: 5, deltaMode: 0 }).defaultPrevented, false);
  f.controls.setEnabled(true);
  assert.equal(key(f, 'KeyW', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(f.controls.update(0), false);
  f.document.activeElement = {};
  assert.equal(key(f, 'KeyW').defaultPrevented, false);
  assert.equal(f.controls.update(30), false);
  f.controls.dispose();
});

test('focused walk prevents deletion keys from triggering browser navigation without moving or exiting', () => {
  const f = fixture();
  assert.equal(key(f, 'Backspace').defaultPrevented, false);
  f.controls.setEnabled(true);
  for (const code of ['Backspace', 'Delete']) assert.equal(key(f, code).defaultPrevented, true);
  assert.equal(f.controls.update(0), false);
  assert.deepEqual(f.moves, []); assert.equal(f.exits, 0);
  assert.equal(key(f, 'Backspace', { metaKey: true }).defaultPrevented, false);
  f.document.activeElement = {};
  assert.equal(key(f, 'Backspace').defaultPrevented, false);
  f.controls.dispose();
});

test('Escape exits and disabling/disposal releases capture, clears keys and restores the cursor', () => {
  const f = fixture(); f.controls.setEnabled(true);
  key(f, 'KeyW'); pointer(f, 'pointerdown');
  assert.equal(key(f, 'Escape').defaultPrevented, true);
  assert.equal(f.exits, 1); assert.equal(f.captures.size, 0);
  f.controls.setEnabled(false);
  assert.equal(f.canvas.style.cursor, 'default');
  assert.equal(f.controls.update(20), false);
  f.controls.setEnabled(true); pointer(f, 'pointerdown'); f.controls.dispose();
  assert.equal(f.canvas.style.cursor, 'default'); assert.equal(f.captures.size, 0);
  assert.equal(emit(f.canvas, 'wheel', { deltaY: -100, deltaMode: 0 }).defaultPrevented, false);
});
