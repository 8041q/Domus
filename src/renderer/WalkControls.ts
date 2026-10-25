import * as THREE from 'three';

interface WalkControlCallbacks {
  /** Resolve horizontal movement against the room before moving the camera. */
  move: (dx: number, dz: number) => void;
  change: () => void;
  exit: () => void;
}

const WALK_SPEED = 1.5;
const LOOK_SPEED = 0.003;
const DRAG_SPEED = 0.006;
const MAX_PITCH = Math.PI * 85 / 180;
const ACCELERATION_TIME = 0.065;
const BRAKING_TIME = 0.04;
const ZOOM_TIME = 0.055;
const MIN_FOV = 30;
const MAX_FOV = 85;
const MAX_PAN_TRAVEL = 2;
const STOP_SPEED = 0.003;
const MOVEMENT_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);
export type WalkPointerMode = 'look' | 'pan';
type TouchPoint = { x: number; y: number };

/** Eye-level navigation. Every translation goes through the shared collision callback. */
export class WalkControls {
  private enabled = false;
  private keys = new Set<string>();
  private rotation = new THREE.Euler(0, 0, 0, 'YXZ');
  private lastUpdate: number | null = null;
  private velocity = new THREE.Vector2();
  private pan = new THREE.Vector2();
  private targetFov: number;
  private pointerMode: WalkPointerMode = 'look';
  private touches = new Map<number, TouchPoint>();
  private touchGesture: 'single' | 'pending' | 'pan' | 'pinch' = 'single';
  private touchOrigin: { x: number; y: number; distance: number } | null = null;
  private touchPairPending = false;
  private lookPending = false;
  private drag: { id: number; button: number; x: number; y: number } | null = null;
  private document: Document;
  private window: Window;
  private previousCursor = '';

  constructor(private camera: THREE.PerspectiveCamera, private element: HTMLCanvasElement, private callbacks: WalkControlCallbacks) {
    this.targetFov = camera.fov;
    this.document = element.ownerDocument;
    this.window = this.document.defaultView!;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('lostpointercapture', this.onLostPointerCapture);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
    element.addEventListener('keydown', this.onKeyDown);
    element.addEventListener('compositionstart', this.onBlur);
    element.addEventListener('blur', this.onBlur);
    this.window.addEventListener('pointermove', this.onPointerMove);
    this.window.addEventListener('pointerup', this.onPointerUp);
    this.window.addEventListener('pointercancel', this.onPointerCancel);
    this.window.addEventListener('keyup', this.onKeyUp);
    this.window.addEventListener('blur', this.onBlur);
    this.document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  setPointerMode(mode: WalkPointerMode) {
    if (this.pointerMode !== mode) {
      this.resetInput();
      this.pointerMode = mode;
    }
    if (this.enabled) {
      this.element.focus({ preventScroll: true });
      this.callbacks.change();
    }
  }

  /** Optical zoom changes the lens, never the viewer's position. */
  zoomBy(factor: number) {
    if (!this.enabled || !Number.isFinite(factor) || factor <= 0) return;
    this.element.focus({ preventScroll: true });
    this.queueZoom(factor);
    this.callbacks.change();
  }

  private queueZoom(factor: number) {
    const halfFov = THREE.MathUtils.degToRad(this.targetFov / 2);
    this.targetFov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfFov) / factor)), MIN_FOV, MAX_FOV);
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.resetInput();
    if (enabled) {
      this.rotation.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.rotation.x = THREE.MathUtils.clamp(this.rotation.x, -MAX_PITCH, MAX_PITCH);
      this.rotation.z = 0;
      this.camera.quaternion.setFromEuler(this.rotation);
      this.previousCursor = this.element.style.cursor;
      this.element.style.cursor = 'grab';
      this.element.focus({ preventScroll: true });
    } else {
      this.element.style.cursor = this.previousCursor;
    }
  }

  /** Apply one input sample per frame; true includes the final moving frame. */
  update(nowMs = performance.now()): boolean {
    if (!this.enabled) return false;
    if (this.document.activeElement !== this.element || this.document.hidden) {
      this.resetInput();
      return false;
    }
    this.flushTouchPair(false);
    let right = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
    let forward = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
    const length = Math.hypot(right, forward);
    if (length) { right *= WALK_SPEED / length; forward *= WALK_SPEED / length; }
    const dt = this.lastUpdate == null || !Number.isFinite(nowMs) ? 0 : THREE.MathUtils.clamp((nowMs - this.lastUpdate) / 1000, 0, 0.05);
    this.lastUpdate = Number.isFinite(nowMs) ? nowMs : null;
    const time = length ? ACCELERATION_TIME : BRAKING_TIME;
    const decay = Math.exp(-dt / time);
    // Integrating the exponential exactly keeps acceleration and travel equal at
    // 30, 60 and 144 Hz. A fresh input establishes time without a fake 1/60 step.
    const travelRight = right * dt + (this.velocity.x - right) * time * (1 - decay);
    const travelForward = forward * dt + (this.velocity.y - forward) * time * (1 - decay);
    this.velocity.set(right + (this.velocity.x - right) * decay, forward + (this.velocity.y - forward) * decay);
    if (!length && this.velocity.length() < STOP_SPEED) this.velocity.set(0, 0);

    let changed = this.lookPending;
    if (this.lookPending) {
      this.camera.quaternion.setFromEuler(this.rotation);
      this.lookPending = false;
    }
    const sin = Math.sin(this.rotation.y), cos = Math.cos(this.rotation.y);
    const dx = this.pan.x + travelRight * cos - travelForward * sin;
    const dz = this.pan.y - travelRight * sin - travelForward * cos;
    this.pan.set(0, 0);
    const zoomPending = Math.abs(this.targetFov - this.camera.fov) > 0.001;
    if (zoomPending && dt) {
      this.camera.fov += (this.targetFov - this.camera.fov) * (1 - Math.exp(-dt / ZOOM_TIME));
      if (Math.abs(this.targetFov - this.camera.fov) < 0.01) this.camera.fov = this.targetFov;
      this.camera.updateProjectionMatrix();
      changed = true;
    }
    if (Math.hypot(dx, dz) > 1e-10) {
      this.callbacks.move(dx, dz);
      changed = true;
    }
    const active = !!length || this.velocity.lengthSq() > 0 || Math.abs(this.targetFov - this.camera.fov) > 0.001;
    if (!active) this.lastUpdate = null;
    // Events schedule the first frame; the caller schedules follow-up frames.
    // Scheduling from here as well would keep a second unnecessary RAF alive.
    return changed || active;
  }

  dispose() {
    this.setEnabled(false);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    this.element.removeEventListener('keydown', this.onKeyDown);
    this.element.removeEventListener('compositionstart', this.onBlur);
    this.element.removeEventListener('blur', this.onBlur);
    this.window.removeEventListener('pointermove', this.onPointerMove);
    this.window.removeEventListener('pointerup', this.onPointerUp);
    this.window.removeEventListener('pointercancel', this.onPointerCancel);
    this.window.removeEventListener('keyup', this.onKeyUp);
    this.window.removeEventListener('blur', this.onBlur);
    this.document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  private queueTravel(target: THREE.Vector2, right: number, forward: number) {
    const sin = Math.sin(this.rotation.y), cos = Math.cos(this.rotation.y);
    target.x += right * cos - forward * sin;
    target.y += -right * sin - forward * cos;
  }

  private resetInput() {
    this.keys.clear();
    this.lastUpdate = null;
    this.velocity.set(0, 0);
    this.pan.set(0, 0);
    this.targetFov = this.camera.fov;
    this.lookPending = false;
    this.rotation.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.releaseDrag();
    const ids = [...this.touches.keys()];
    this.touches.clear();
    this.touchOrigin = null;
    this.touchPairPending = false;
    this.touchGesture = 'single';
    for (const id of ids) if (this.element.hasPointerCapture?.(id)) this.element.releasePointerCapture(id);
  }

  private releaseDrag() {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.element.hasPointerCapture?.(drag.id)) this.element.releasePointerCapture(drag.id);
    if (drag && this.enabled) this.element.style.cursor = 'grab';
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.enabled || this.document.activeElement !== this.element) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) {
      this.onBlur();
      return;
    }
    if (event.defaultPrevented) return;
    if (event.key === 'Backspace' || event.key === 'Delete') {
      // WebKit uses Backspace for history navigation outside editable fields.
      // Walk suppresses furniture deletion and keeps these keys inside the room.
      event.preventDefault(); event.stopPropagation();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      this.resetInput();
      this.callbacks.exit();
      return;
    }
    if (!MOVEMENT_CODES.has(event.code)) return;
    event.preventDefault(); event.stopPropagation();
    if (!this.keys.has(event.code)) {
      this.keys.add(event.code);
      this.callbacks.change();
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    if (!this.keys.delete(event.code)) return;
    event.preventDefault();
    this.callbacks.change();
  };

  private onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      this.startTouch(event);
      return;
    }
    if (!this.enabled || this.drag || event.button < 0 || event.button > 2) return;
    if (event.isPrimary === false) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    event.preventDefault(); event.stopPropagation();
    this.element.focus({ preventScroll: true });
    this.drag = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY };
    this.element.setPointerCapture?.(event.pointerId);
    this.element.style.cursor = 'grabbing';
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.touches.has(event.pointerId)) {
      this.moveTouch(event);
      return;
    }
    if (!this.enabled || this.drag?.id !== event.pointerId) return;
    const mask = this.drag.button === 1 ? 4 : this.drag.button === 2 ? 2 : 1;
    if (event.pointerType !== 'touch' && Number.isFinite(event.buttons) && !(event.buttons & mask)) {
      this.releaseDrag();
      return;
    }
    this.samplePointer(event);
  };

  private samplePointer(event: PointerEvent) {
    if (!this.drag || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
    this.drag.x = event.clientX; this.drag.y = event.clientY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (!dx && !dy) return;
    event.preventDefault(); event.stopPropagation();
    this.queueDrag(dx, dy, this.drag.button === 0 ? this.pointerMode : 'pan');
  }

  private queueDrag(dx: number, dy: number, mode: WalkPointerMode, notify = true) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const scale = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / Math.tan(THREE.MathUtils.degToRad(65 / 2));
    if (mode === 'look') {
      // Grab the panorama: the room follows the drag, just as it does in Pan.
      this.rotation.y = THREE.MathUtils.euclideanModulo(this.rotation.y + dx * LOOK_SPEED * scale + Math.PI, Math.PI * 2) - Math.PI;
      this.rotation.x = THREE.MathUtils.clamp(this.rotation.x + dy * LOOK_SPEED * scale, -MAX_PITCH, MAX_PITCH);
      this.lookPending = true;
    } else {
      // Pan remains on the floor plane so the viewer never floats or sinks.
      this.queueTravel(this.pan, -dx * DRAG_SPEED * scale, -dy * DRAG_SPEED * scale);
      if (this.pan.length() > MAX_PAN_TRAVEL) this.pan.setLength(MAX_PAN_TRAVEL);
    }
    if (notify) this.callbacks.change();
  }

  private touchPair() {
    const [first, second] = [...this.touches.values()];
    if (!first || !second) return null;
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2,
      distance: Math.hypot(first.x - second.x, first.y - second.y) };
  }

  private startTouch(event: PointerEvent) {
    if (!this.enabled || this.document.hidden || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    event.preventDefault(); event.stopPropagation();
    if (this.touches.size >= 2 || this.touches.has(event.pointerId)) return;
    this.element.focus({ preventScroll: true });
    this.releaseDrag();
    this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.touchPairPending = false;
    this.element.setPointerCapture?.(event.pointerId);
    if (this.touches.size === 2) {
      // A second finger starts a new gesture, without carrying a queued look
      // into the two-finger pan/pinch interaction.
      this.pan.set(0, 0);
      this.lookPending = false;
      this.rotation.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.touchGesture = 'pending';
      this.touchOrigin = this.touchPair();
    } else {
      this.touchGesture = 'single';
      this.touchOrigin = null;
    }
  }

  private moveTouch(event: PointerEvent) {
    const previous = this.touches.get(event.pointerId);
    if (!this.enabled || !previous || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    event.preventDefault(); event.stopPropagation();
    const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
    this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.touches.size === 1) {
      if (dx || dy) this.queueDrag(dx, dy, this.pointerMode);
      return;
    }
    // Both pointer positions are consumed together on the next frame. Evaluating
    // the first moving finger alone can mistake a fast two-finger pan for pinch.
    this.touchPairPending = true;
    this.callbacks.change();
  }

  private flushTouchPair(notify: boolean) {
    if (!this.touchPairPending) return;
    this.touchPairPending = false;
    const pair = this.touchPair();
    if (!pair || !this.touchOrigin || !Number.isFinite(pair.distance)) return;
    const origin = this.touchOrigin;
    if (this.touchGesture === 'pending') {
      const pan = Math.hypot(pair.x - this.touchOrigin.x, pair.y - this.touchOrigin.y);
      const pinch = Math.abs(pair.distance - this.touchOrigin.distance) / 2;
      if (Math.max(pan, pinch) < 6) return;
      // Lock the gesture until fingers lift: pinch must not also slide the
      // viewer sideways as the fingers arrive in separate pointer samples.
      this.touchGesture = pinch >= pan ? 'pinch' : 'pan';
    }
    if (this.touchGesture === 'pan') {
      this.queueDrag(pair.x - origin.x, pair.y - origin.y, 'pan', notify);
    } else if (origin.distance > 1 && pair.distance > 1) {
      this.queueZoom(pair.distance / origin.distance);
      if (notify) this.callbacks.change();
    }
    this.touchOrigin = pair;
  }

  private endTouch(event: PointerEvent, cancelled: boolean) {
    if (cancelled) {
      this.onBlur();
      return;
    }
    this.moveTouch(event);
    this.flushTouchPair(true);
    this.touches.delete(event.pointerId);
    this.touchGesture = 'single';
    this.touchOrigin = null;
    this.touchPairPending = false;
    if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
  }

  private onPointerUp = (event: PointerEvent) => {
    if (this.touches.has(event.pointerId)) {
      this.endTouch(event, false);
      return;
    }
    if (this.drag?.id !== event.pointerId) return;
    this.samplePointer(event);
    this.releaseDrag();
  };

  private onLostPointerCapture = (event: PointerEvent) => {
    if (this.touches.has(event.pointerId)) {
      this.endTouch(event, true);
      return;
    }
    if (this.drag?.id === event.pointerId) this.cancelDrag();
  };

  private cancelDrag() {
    this.pan.set(0, 0);
    this.lookPending = false;
    this.rotation.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.releaseDrag();
  }

  private onPointerCancel = (event: PointerEvent) => {
    if (this.touches.has(event.pointerId)) {
      this.endTouch(event, true);
      return;
    }
    if (this.drag?.id === event.pointerId) this.cancelDrag();
  };

  private onWheel = (event: WheelEvent) => {
    if (!this.enabled || this.document.hidden || event.metaKey || event.altKey) return;
    if (!Number.isFinite(event.deltaY) || (event.deltaX != null && !Number.isFinite(event.deltaX))) return;
    event.preventDefault(); event.stopPropagation();
    this.element.focus({ preventScroll: true });
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, this.element.clientHeight) : 1;
    // Trackpad pinch arrives as Ctrl+wheel; ordinary wheel uses the same zoom.
    const amount = THREE.MathUtils.clamp(-event.deltaY * unit * 0.0015, -0.5, 0.5);
    if (!amount) return;
    if ((this.targetFov - this.camera.fov) * amount > 0) this.targetFov = this.camera.fov;
    this.queueZoom(Math.exp(amount));
    this.callbacks.change();
  };

  private onContextMenu = (event: Event) => {
    if (this.enabled) event.preventDefault();
  };

  private onBlur = () => {
    const changed = this.keys.size || this.velocity.lengthSq() || this.pan.lengthSq() || Math.abs(this.targetFov - this.camera.fov) > 0.001 || this.lookPending;
    this.resetInput();
    if (this.enabled && changed) this.callbacks.change();
  };
  private onVisibilityChange = () => { if (this.document.hidden) this.onBlur(); };
}
