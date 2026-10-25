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
const WHEEL_TIME = 0.055;
const MAX_WHEEL_TRAVEL = 0.8;
const MAX_WHEEL_SPEED = 3;
const MAX_PAN_TRAVEL = 2;
const STOP_SPEED = 0.003;
const MIN_TRAVEL = 0.0001;
const MOVEMENT_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);

/** Eye-level navigation. Every translation goes through the shared collision callback. */
export class WalkControls {
  private enabled = false;
  private keys = new Set<string>();
  private rotation = new THREE.Euler(0, 0, 0, 'YXZ');
  private lastUpdate: number | null = null;
  private velocity = new THREE.Vector2();
  private pan = new THREE.Vector2();
  private wheel = new THREE.Vector2();
  private lookPending = false;
  private drag: { id: number; button: number; x: number; y: number } | null = null;
  private document: Document;
  private window: Window;
  private previousCursor = '';

  constructor(private camera: THREE.PerspectiveCamera, private element: HTMLCanvasElement, private callbacks: WalkControlCallbacks) {
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
    let dx = this.pan.x + travelRight * cos - travelForward * sin;
    let dz = this.pan.y - travelRight * sin - travelForward * cos;
    this.pan.set(0, 0);
    const wheelLength = this.wheel.length();
    if (wheelLength && dt) {
      const distance = Math.min(wheelLength * (1 - Math.exp(-dt / WHEEL_TIME)), MAX_WHEEL_SPEED * dt);
      const fraction = distance / wheelLength;
      dx += this.wheel.x * fraction; dz += this.wheel.y * fraction;
      this.wheel.multiplyScalar(1 - fraction);
      if (this.wheel.length() < MIN_TRAVEL) {
        dx += this.wheel.x; dz += this.wheel.y;
        this.wheel.set(0, 0);
      }
    }
    if (Math.hypot(dx, dz) > 1e-10) {
      this.callbacks.move(dx, dz);
      changed = true;
    }
    const active = !!length || this.velocity.lengthSq() > 0 || this.wheel.lengthSq() > 0;
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
    this.wheel.set(0, 0);
    this.lookPending = false;
    this.rotation.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.releaseDrag();
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
    if (this.drag.button === 0) {
      this.rotation.y = THREE.MathUtils.euclideanModulo(this.rotation.y - dx * LOOK_SPEED + Math.PI, Math.PI * 2) - Math.PI;
      this.rotation.x = THREE.MathUtils.clamp(this.rotation.x - dy * LOOK_SPEED, -MAX_PITCH, MAX_PITCH);
      this.lookPending = true;
    } else {
      // Drag the floor beneath the viewer, keeping both axes on the floor plane.
      this.queueTravel(this.pan, -dx * DRAG_SPEED, -dy * DRAG_SPEED);
      if (this.pan.length() > MAX_PAN_TRAVEL) this.pan.setLength(MAX_PAN_TRAVEL);
    }
    this.callbacks.change();
  }

  private onPointerUp = (event: PointerEvent) => {
    if (this.drag?.id !== event.pointerId) return;
    this.samplePointer(event);
    this.releaseDrag();
  };

  private onLostPointerCapture = (event: PointerEvent) => {
    if (this.drag?.id === event.pointerId) this.cancelDrag();
  };

  private cancelDrag() {
    this.pan.set(0, 0);
    this.lookPending = false;
    this.rotation.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.releaseDrag();
  }

  private onPointerCancel = (event: PointerEvent) => {
    if (this.drag?.id === event.pointerId) this.cancelDrag();
  };

  private onWheel = (event: WheelEvent) => {
    if (!this.enabled || this.document.hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!Number.isFinite(event.deltaY) || (event.deltaX != null && !Number.isFinite(event.deltaX))) return;
    event.preventDefault(); event.stopPropagation();
    this.element.focus({ preventScroll: true });
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, this.element.clientHeight) : 1;
    const forward = THREE.MathUtils.clamp(-event.deltaY * unit * 0.0025, -MAX_WHEEL_TRAVEL, MAX_WHEEL_TRAVEL);
    const right = THREE.MathUtils.clamp((event.deltaX ?? 0) * unit * 0.0025, -MAX_WHEEL_TRAVEL, MAX_WHEEL_TRAVEL);
    if (!forward && !right) return;
    const sin = Math.sin(this.rotation.y), cos = Math.cos(this.rotation.y);
    const dx = right * cos - forward * sin, dz = -right * sin - forward * cos;
    // A direction reversal cancels the old backlog instead of fighting it.
    if (this.wheel.x * dx + this.wheel.y * dz < 0) this.wheel.set(0, 0);
    this.wheel.x += dx; this.wheel.y += dz;
    if (this.wheel.length() > MAX_WHEEL_TRAVEL) this.wheel.setLength(MAX_WHEEL_TRAVEL);
    this.callbacks.change();
  };

  private onContextMenu = (event: Event) => {
    if (this.enabled) event.preventDefault();
  };

  private onBlur = () => {
    const changed = this.keys.size || this.velocity.lengthSq() || this.pan.lengthSq() || this.wheel.lengthSq() || this.lookPending;
    this.resetInput();
    if (this.enabled && changed) this.callbacks.change();
  };
  private onVisibilityChange = () => { if (this.document.hidden) this.onBlur(); };
}
