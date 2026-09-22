import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { PRODUCTS } from '../core/products';
import { clearanceRegions, resolvePlacement, spacingMeasurements } from '../core/placement';
import { distanceToWall, getRoomWalls, roomBounds, wallPoint, wallProjectionDistance } from '../core/roomGeometry';
import { formatLength } from '../core/units';
import type { FurnishCameraView, MeasurementSystem, PlannerSnapshot, PlacedObject, RoomOpening, SnapFeedback, Vec2 } from '../core/types';

export interface SceneSnapshot extends PlannerSnapshot {
  selectedId?: string | null;
  selectedOpeningId?: string | null;
  activeSnap?: SnapFeedback;
  showClearance?: boolean;
  showRoomDimensions?: boolean;
  showProductDimensions?: boolean;
  showSpacingDimensions?: boolean;
  measurementSystem?: MeasurementSystem;
}

export interface SceneBridge {
  getSnapshot: () => SceneSnapshot;
  select: (id: string | null) => void;
  selectOpening: (id: string | null) => void;
  updateObject: (id: string, patch: Partial<PlacedObject>) => void;
  updateOpening: (id: string, patch: Partial<RoomOpening>, recordHistory?: boolean) => void;
  commitDrag: (before: PlannerSnapshot) => void;
  feedback: (snap: SnapFeedback, collisionId: string | null, collisionPush: boolean) => void;
}

interface SceneOptions {
  showFurniture: boolean;
  interactiveFurniture: boolean;
  interactiveArchitecture: boolean;
}

const FLOOR_COLORS: Record<string, number> = {
  'light-oak': 0xd9c3a1,
  'warm-oak': 0xa9825c,
  stone: 0xc7c5bf,
  concrete: 0xa9aba8
};

const DIMENSION_COLOR = 0x575e5a;
const SELECTION_COLOR = 0x1769aa;
const CLEARANCE_COLOR = 0xc28c3d;
const TRIM_COLOR = 0xf8f8f5;

export class PlannerScene {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(43, 1, 0.08, 100);
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private floorGroup = new THREE.Group();
  private wallsGroup = new THREE.Group();
  private objectGroup = new THREE.Group();
  private helperGroup = new THREE.Group();
  private objectModels = new Map<string, THREE.Group>();
  private dragging: { id: string; before: PlannerSnapshot; snap: SnapFeedback; grabOffset: Vec2 } | null = null;
  private openingDragging: { id: string; before: PlannerSnapshot } | null = null;
  private hoverOpeningId: string | null = null;
  private resizeObserver: ResizeObserver;
  private animationFrame = 0;
  private lastRoomKey = '';
  private lastOpeningsKey = '';
  private currentCameraView: FurnishCameraView = 'perspective';
  private environmentTexture: THREE.Texture | null = null;
  private mainLight: THREE.DirectionalLight;
  private wallHiddenState = new Map<string, boolean>();

  constructor(private container: HTMLElement, private bridge: SceneBridge, private options: SceneOptions) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.shadowMap.enabled = true;
    // A firmer PCF shadow reads better for furniture and avoids the over-blurred Phase 5 result.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.appendChild(this.renderer.domElement);

    // Neutral mid-grey: enough separation from pale walls without the heavy dark-stage feel.
    this.scene.background = new THREE.Color(0xd6d7d4);
    this.scene.add(this.floorGroup, this.wallsGroup, this.objectGroup, this.helperGroup);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environmentTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.environmentTexture;
    pmrem.dispose();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minPolarAngle = 0.01;
    this.controls.minDistance = 1.8;
    this.controls.maxDistance = 20;
    this.controls.screenSpacePanning = false;

    // Fast, artifact-free studio lighting. Contact depth now comes from real shadows instead of SSAO.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x7f817e, 0.92);
    const ambient = new THREE.AmbientLight(0xffffff, 0.13);
    this.mainLight = new THREE.DirectionalLight(0xfffcf5, 2.35);
    this.mainLight.position.set(4.2, 7.2, 4.8);
    this.mainLight.castShadow = true;
    this.mainLight.shadow.mapSize.set(2048, 2048);
    this.mainLight.shadow.camera.near = 0.25;
    this.mainLight.shadow.camera.far = 34;
    this.mainLight.shadow.bias = -0.00012;
    this.mainLight.shadow.normalBias = 0.012;
    const fill = new THREE.DirectionalLight(0xe8edf0, 0.25);
    fill.position.set(-4.5, 5.2, -4.2);
    this.scene.add(hemi, ambient, this.mainLight, this.mainLight.target, fill);

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.resetCamera();
    this.renderFromState();
    this.animate();
  }

  dispose() {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.disposeGroup(this.floorGroup);
    this.disposeGroup(this.wallsGroup);
    this.disposeGroup(this.objectGroup);
    this.disposeGroup(this.helperGroup);
    this.environmentTexture?.dispose();
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }

  resetCamera() {
    this.setCameraView('perspective');
  }

  setCameraView(view: FurnishCameraView) {
    this.currentCameraView = view;
    const room = this.bridge.getSnapshot().room;
    const bounds = roomBounds(room.vertices);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, 2);
    const targetY = Math.min(0.95, room.height * 0.38);
    const isDollhouse = view === 'perspective';
    this.camera.fov = isDollhouse ? 43 : 32;
    this.camera.updateProjectionMatrix();
    const distance = Math.max(4.2, size * (isDollhouse ? 1.65 : 2.2));
    this.controls.maxDistance = Math.max(20, size * 4.5);
    this.controls.target.set(cx, targetY, cz);

    switch (view) {
      case 'top':
        this.camera.position.set(cx + 0.01, Math.max(room.height + 4, size * 2.2), cz + 0.01);
        this.controls.target.set(cx, 0, cz);
        break;
      case 'front':
        this.camera.position.set(cx, targetY, bounds.minZ - distance);
        break;
      case 'back':
        this.camera.position.set(cx, targetY, bounds.maxZ + distance);
        break;
      case 'left':
        this.camera.position.set(bounds.minX - distance, targetY, cz);
        break;
      case 'right':
        this.camera.position.set(bounds.maxX + distance, targetY, cz);
        break;
      default:
        this.camera.position.set(bounds.maxX + size * 0.7, Math.max(3.8, size * 0.8), bounds.maxZ + size * 0.9);
        break;
    }
    this.controls.update();
    this.updateCutawayWalls(true);
  }

  renderFromState() {
    const snapshot = this.bridge.getSnapshot();
    const roomKey = JSON.stringify(snapshot.room);
    const openingsKey = JSON.stringify(snapshot.openings);
    if (roomKey !== this.lastRoomKey) {
      this.rebuildRoom(snapshot);
      this.lastRoomKey = roomKey;
      this.lastOpeningsKey = openingsKey;
      const bounds = roomBounds(snapshot.room.vertices);
      this.controls.target.set((bounds.minX + bounds.maxX) / 2, Math.min(0.95, snapshot.room.height * 0.38), (bounds.minZ + bounds.maxZ) / 2);
      this.updateShadowBounds(snapshot);
    } else if (openingsKey !== this.lastOpeningsKey) {
      this.rebuildWalls(snapshot);
      this.lastOpeningsKey = openingsKey;
    }
    this.syncObjects(snapshot);
    this.syncOpeningHighlight(snapshot);
    this.rebuildHelpers(snapshot);
    this.updateCutawayWalls(true);
  }

  private updateShadowBounds(snapshot: PlannerSnapshot) {
    const bounds = roomBounds(snapshot.room.vertices);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const span = Math.max(bounds.width, bounds.depth, 4);
    const radius = span * 0.72 + 1.1;
    this.mainLight.target.position.set(cx, 0.4, cz);
    this.mainLight.position.set(cx + span * 0.55, Math.max(6.5, span * 0.72), cz + span * 0.48);
    const shadow = this.mainLight.shadow.camera as THREE.OrthographicCamera;
    shadow.left = -radius;
    shadow.right = radius;
    shadow.top = radius;
    shadow.bottom = -radius;
    shadow.near = 0.25;
    shadow.far = Math.max(24, span * 4);
    shadow.updateProjectionMatrix();
    this.mainLight.shadow.needsUpdate = true;
  }

  private disposeGroup(group: THREE.Group) {
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments || obj instanceof THREE.Line || obj instanceof THREE.Sprite)) return;
      if ('geometry' in obj && obj.geometry) obj.geometry.dispose();
      const material = obj.material;
      if (Array.isArray(material)) material.forEach((m) => {
        if (m instanceof THREE.SpriteMaterial) m.map?.dispose();
        m.dispose();
      });
      else if (material) {
        if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
        material.dispose();
      }
    });
    group.clear();
  }

  private wallYaw(wall: ReturnType<typeof getRoomWalls>[number]) {
    return Math.atan2(wall.inward.x, wall.inward.z);
  }

  private rebuildRoom(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.floorGroup);
    this.disposeGroup(this.wallsGroup);
    this.wallHiddenState.clear();
    const { floorFinish, vertices } = snapshot.room;
    const wallThickness = 0.10;

    const shape = new THREE.Shape();
    vertices.forEach((vertex, index) => {
      if (index === 0) shape.moveTo(vertex.x, -vertex.z);
      else shape.lineTo(vertex.x, -vertex.z);
    });
    shape.closePath();

    // The central slab supports the walkable room area.
    const slabGeometry = new THREE.ExtrudeGeometry(shape, { depth: 0.055, bevelEnabled: false, steps: 1 });
    slabGeometry.rotateX(-Math.PI / 2);
    const slab = new THREE.Mesh(slabGeometry, new THREE.MeshStandardMaterial({ color: TRIM_COLOR, roughness: 0.82 }));
    slab.position.y = -0.055;
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.floorGroup.add(slab);

    const floorGeometry = new THREE.ShapeGeometry(shape);
    floorGeometry.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(
      floorGeometry,
      new THREE.MeshStandardMaterial({
        color: FLOOR_COLORS[floorFinish] ?? FLOOR_COLORS['light-oak'],
        roughness: 0.84,
        metalness: 0,
        side: THREE.DoubleSide
      })
    );
    floor.position.y = 0.001;
    floor.receiveShadow = true;
    this.floorGroup.add(floor);

    // Extend the white slab underneath every wall. The floor and wall now overlap structurally
    // instead of merely touching at a zero-thickness perimeter edge.
    for (const wall of getRoomWalls(snapshot.room)) {
      const centre = wallPoint(wall, wall.length / 2);
      const yaw = this.wallYaw(wall);
      const footing = new THREE.Mesh(
        new THREE.BoxGeometry(wall.length + wallThickness * 0.9, 0.055, wallThickness),
        new THREE.MeshStandardMaterial({ color: TRIM_COLOR, roughness: 0.82 })
      );
      footing.rotation.y = yaw;
      footing.position.set(
        centre.x,
        -0.0275,
        centre.z
      );
      footing.receiveShadow = true;
      footing.castShadow = true;
      this.floorGroup.add(footing);

    }

    this.rebuildWalls(snapshot);
  }

  private rebuildWalls(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.wallsGroup);
    const { height, wallColor } = snapshot.room;
    const thickness = 0.10;

    for (const wall of getRoomWalls(snapshot.room)) {
      const wallOpenings = snapshot.openings.filter((o) => o.wallId === wall.id).sort((a, b) => a.offset - b.offset);
      let cursor = 0;
      for (const opening of wallOpenings) {
        const start = Math.max(cursor, opening.offset - opening.width / 2);
        const end = Math.min(wall.length, opening.offset + opening.width / 2);
        if (start > cursor) this.addWallSegmentBox(wall, cursor, start, 0, height, thickness, wallColor);
        if (opening.sillHeight > 0.01) this.addWallSegmentBox(wall, start, end, 0, opening.sillHeight, thickness, wallColor);
        const openingTop = Math.min(height, opening.sillHeight + opening.height);
        if (openingTop < height - 0.01) this.addWallSegmentBox(wall, start, end, openingTop, height, thickness, wallColor);
        this.addOpeningFrame(opening, snapshot, thickness);
        cursor = Math.max(cursor, end);
      }
      if (cursor < wall.length) this.addWallSegmentBox(wall, cursor, wall.length, 0, height, thickness, wallColor);

      // White skirting follows the actual wall material. Any opening that reaches
      // into the 7 cm footer interrupts it, even if its bottom is slightly above floor level.
      let trimCursor = 0;
      const footerOpenings = wallOpenings.filter((o) => o.sillHeight < 0.075);
      for (const opening of footerOpenings) {
        const start = Math.max(trimCursor, opening.offset - opening.width / 2);
        const end = Math.min(wall.length, opening.offset + opening.width / 2);
        if (start > trimCursor) this.addBaseboard(wall, trimCursor, start);
        trimCursor = Math.max(trimCursor, end);
      }
      if (trimCursor < wall.length) this.addBaseboard(wall, trimCursor, wall.length);
      this.addFloorJunction(wall, snapshot, thickness);
    }
  }

  private addFloorJunction(wall: ReturnType<typeof getRoomWalls>[number], snapshot: PlannerSnapshot, wallThickness: number) {
    const yaw = this.wallYaw(wall);
    const floorColor = FLOOR_COLORS[snapshot.room.floorFinish] ?? FLOOR_COLORS['light-oak'];
    const floorOpenings = snapshot.openings
      .filter((opening) => opening.wallId === wall.id && opening.sillHeight <= 0.025)
      .sort((a, b) => a.offset - b.offset);

    const addTrim = (start: number, end: number) => {
      if (end - start < 0.025) return;
      const centre = wallPoint(wall, (start + end) / 2);
      const trim = new THREE.Mesh(
        new THREE.BoxGeometry(end - start, 0.012, 0.026),
        new THREE.MeshStandardMaterial({ color: TRIM_COLOR, roughness: 0.74 })
      );
      trim.rotation.y = yaw;
      trim.position.set(centre.x + wall.inward.x * (wallThickness / 2 + 0.013), 0.007, centre.z + wall.inward.z * (wallThickness / 2 + 0.013));
      trim.receiveShadow = true;
      this.tagCutawaySurface(trim, wall);
      this.wallsGroup.add(trim);
    };

    let cursor = 0;
    for (const opening of floorOpenings) {
      const start = Math.max(cursor, opening.offset - opening.width / 2);
      const end = Math.min(wall.length, opening.offset + opening.width / 2);
      addTrim(cursor, start);
      const thresholdPoint = wallPoint(wall, opening.offset);
      const threshold = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.05, opening.width), 0.012, wallThickness + 0.05),
        new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.84 })
      );
      threshold.rotation.y = yaw;
      threshold.position.set(thresholdPoint.x, 0.007, thresholdPoint.z);
      threshold.receiveShadow = true;
      this.wallsGroup.add(threshold);
      cursor = Math.max(cursor, end);
    }
    addTrim(cursor, wall.length);
  }

  private addWallSegmentBox(
    wall: ReturnType<typeof getRoomWalls>[number],
    start: number,
    end: number,
    bottom: number,
    top: number,
    thickness: number,
    wallColor: THREE.ColorRepresentation
  ) {
    if (end - start < 0.005 || top - bottom < 0.005) return;
    const len = end - start;
    const h = top - bottom;
    const centre = wallPoint(wall, (start + end) / 2);
    const yaw = this.wallYaw(wall);

    // The wall core is always white. This makes exposed thickness/cut edges read as a clean border.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(len, h, thickness),
      new THREE.MeshStandardMaterial({ color: TRIM_COLOR, roughness: 0.8 })
    );
    body.rotation.y = yaw;
    body.position.set(
      centre.x,
      (bottom + top) / 2,
      centre.z
    );
    body.receiveShadow = true;
    body.castShadow = true;
    this.tagCutawaySurface(body, wall);
    this.wallsGroup.add(body);

    // A thin coloured interior finish sits on the room-facing plane only.
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(len, h),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(wallColor), roughness: 0.9, side: THREE.FrontSide })
    );
    face.rotation.y = yaw;
    face.position.set(
      centre.x + wall.inward.x * (thickness / 2 + 0.0015),
      (bottom + top) / 2,
      centre.z + wall.inward.z * (thickness / 2 + 0.0015)
    );
    face.receiveShadow = true;
    this.tagCutawaySurface(face, wall);
    this.wallsGroup.add(face);
  }

  private addBaseboard(wall: ReturnType<typeof getRoomWalls>[number], start: number, end: number) {
    if (end - start < 0.03) return;
    const length = end - start;
    const centre = wallPoint(wall, (start + end) / 2);
    const depth = 0.026;
    const height = 0.07;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(length, height, depth),
      new THREE.MeshStandardMaterial({ color: TRIM_COLOR, roughness: 0.72 })
    );
    mesh.rotation.y = this.wallYaw(wall);
    mesh.position.set(centre.x + wall.inward.x * (0.05 + depth / 2), height / 2, centre.z + wall.inward.z * (0.05 + depth / 2));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.tagCutawaySurface(mesh, wall);
    this.wallsGroup.add(mesh);
  }

  private addOpeningFrame(opening: PlannerSnapshot['openings'][number], snapshot: PlannerSnapshot, wallThickness: number) {
    const wall = getRoomWalls(snapshot.room).find((candidate) => candidate.id === opening.wallId);
    if (!wall) return;
    const frame = 0.05;
    const frameDepth = wallThickness + 0.012;
    const bottom = opening.sillHeight;
    const top = Math.min(snapshot.room.height, bottom + opening.height);
    const yaw = this.wallYaw(wall);
    const centre = wallPoint(wall, opening.offset);

    const material = (color: THREE.ColorRepresentation, roughness = 0.66) => new THREE.MeshStandardMaterial({ color, roughness });
    const tag = (mesh: THREE.Object3D) => {
      this.tagCutawaySurface(mesh, wall);
      mesh.userData.openingId = opening.id;
      this.wallsGroup.add(mesh);
      return mesh;
    };
    const alignedBox = (along: number, y: number, alongSize: number, boxHeight: number, depth: number, normalOffset = 0, color: THREE.ColorRepresentation = TRIM_COLOR) => {
      const point = wallPoint(wall, along);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(alongSize, boxHeight, depth), material(color));
      mesh.rotation.y = yaw;
      mesh.position.set(point.x + wall.inward.x * normalOffset, y, point.z + wall.inward.z * normalOffset);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return tag(mesh);
    };
    const glassPanel = (along: number, panelWidth: number, panelBottom = bottom, panelTop = top, normalOffset = wallThickness / 2 + 0.004) => {
      const point = wallPoint(wall, along);
      const glass = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.max(0.08, panelWidth), Math.max(0.05, panelTop - panelBottom)),
        new THREE.MeshPhysicalMaterial({
          color: 0xb7d7e1,
          transparent: true,
          opacity: 0.30,
          roughness: 0.12,
          transmission: 0.12,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      );
      glass.rotation.y = yaw;
      glass.position.set(point.x + wall.inward.x * normalOffset, (panelTop + panelBottom) / 2, point.z + wall.inward.z * normalOffset);
      return tag(glass);
    };

    // A wall opening intentionally has no decorative insert. A fully transparent pick plane
    // keeps the empty hole draggable in the 3D builder without changing its appearance.
    if (opening.type === 'opening') {
      const pick = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.max(0.12, opening.width), Math.max(0.12, top - bottom)),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
      );
      pick.userData.invisiblePick = true;
      pick.rotation.y = yaw;
      pick.position.set(centre.x + wall.inward.x * (wallThickness / 2 + 0.006), (top + bottom) / 2, centre.z + wall.inward.z * (wallThickness / 2 + 0.006));
      tag(pick);
      return;
    }

    // White reveal/frame around every architectural opening.
    alignedBox(opening.offset - opening.width / 2, (top + bottom) / 2, frame, top - bottom, frameDepth);
    alignedBox(opening.offset + opening.width / 2, (top + bottom) / 2, frame, top - bottom, frameDepth);
    alignedBox(opening.offset, top, opening.width, frame, frameDepth);
    if (opening.type === 'window') alignedBox(opening.offset, bottom, opening.width, frame, frameDepth);

    if (opening.type === 'window') {
      const innerWidth = Math.max(0.08, opening.width - 0.08);
      if (opening.variant === 'double-window') {
        glassPanel(opening.offset - innerWidth * 0.25, innerWidth / 2 - 0.022);
        glassPanel(opening.offset + innerWidth * 0.25, innerWidth / 2 - 0.022);
        alignedBox(opening.offset, (top + bottom) / 2, 0.035, top - bottom, 0.04, wallThickness / 2 + 0.006);
      } else if (opening.variant === 'sliding-window') {
        glassPanel(opening.offset - innerWidth * 0.23, innerWidth * 0.56, bottom, top, wallThickness / 2 + 0.001);
        glassPanel(opening.offset + innerWidth * 0.23, innerWidth * 0.56, bottom, top, wallThickness / 2 + 0.012);
        alignedBox(opening.offset, (top + bottom) / 2, 0.032, top - bottom, 0.035, wallThickness / 2 + 0.016);
      } else {
        glassPanel(opening.offset, innerWidth);
      }
      return;
    }

    if (opening.variant === 'door-frame') return;

    const innerWidth = Math.max(0.1, opening.width - 0.08);
    const panelHeight = Math.max(0.1, opening.height - 0.055);
    const interiorOffset = wallThickness / 2 + 0.022;
    const makeDoorPanel = (along: number, width: number, glass = false) => {
      if (glass) {
        glassPanel(along, Math.max(0.08, width - 0.025), 0.045, Math.max(0.12, panelHeight - 0.015), interiorOffset + 0.002);
        const edge = alignedBox(along, panelHeight / 2, width, panelHeight, 0.028, interiorOffset, 0xf4f4f1);
        if (edge.material instanceof THREE.MeshStandardMaterial) {
          edge.material.transparent = true;
          edge.material.opacity = 0.22;
          edge.material.depthWrite = false;
        }
      } else {
        alignedBox(along, panelHeight / 2, width, panelHeight, 0.035, interiorOffset, 0xcbbca7);
      }
    };

    if (opening.variant === 'double-door' || opening.variant === 'glass-double-door') {
      const half = innerWidth / 2;
      makeDoorPanel(opening.offset - half / 2, half - 0.012, opening.variant === 'glass-double-door');
      makeDoorPanel(opening.offset + half / 2, half - 0.012, opening.variant === 'glass-double-door');
      alignedBox(opening.offset, panelHeight / 2, 0.025, panelHeight, 0.04, interiorOffset, TRIM_COLOR);
    } else {
      makeDoorPanel(opening.offset, innerWidth, opening.variant === 'glass-door');
    }
  }

  private syncOpeningHighlight(snapshot: SceneSnapshot) {
    const selected = snapshot.selectedOpeningId ?? null;
    this.wallsGroup.traverse((object) => {
      const openingId = typeof object.userData.openingId === 'string' ? object.userData.openingId : null;
      if (!openingId || !(object instanceof THREE.Mesh)) return;
      const active = openingId === selected || openingId === this.hoverOpeningId;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of materials) {
        if (mat instanceof THREE.MeshBasicMaterial) {
          // Custom wall openings use a transparent pick plane only. Never tint/fill it:
          // a selected empty opening must remain a true void, not look like glass.
          if (object.userData.invisiblePick) {
            mat.opacity = 0;
            mat.transparent = true;
            mat.depthWrite = false;
          } else {
            mat.color.setHex(active ? 0x00e5ff : 0xffffff);
            mat.opacity = active ? 0.16 : 0;
            mat.transparent = true;
          }
        } else if (mat instanceof THREE.MeshPhysicalMaterial) {
          mat.emissive.setHex(active ? 0x00a9bd : 0x000000);
          mat.emissiveIntensity = active ? 0.12 : 0;
        } else if (mat instanceof THREE.MeshStandardMaterial) {
          mat.emissive.setHex(active ? 0x00a9bd : 0x000000);
          mat.emissiveIntensity = active ? 0.16 : 0;
        }
      }
    });
  }

  private tagCutawaySurface(object: THREE.Object3D, wall: ReturnType<typeof getRoomWalls>[number]) {
    object.userData.cutawayWallId = wall.id;
    object.userData.cutawayOutwardX = -wall.inward.x;
    object.userData.cutawayOutwardZ = -wall.inward.z;
  }

  private updateCutawayWalls(force = false) {
    const snapshot = this.bridge.getSnapshot();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const nearTopDown = this.currentCameraView === 'top' || Math.abs(offset.y) > Math.hypot(offset.x, offset.z) * 2.55;
    const nextState = new Map<string, boolean>();

    for (const wall of getRoomWalls(snapshot.room)) {
      if (nearTopDown) {
        nextState.set(wall.id, false);
        continue;
      }
      const centre = wallPoint(wall, wall.length / 2);
      const dx = this.camera.position.x - centre.x;
      const dz = this.camera.position.z - centre.z;
      const radialLength = Math.hypot(dx, dz) || 1;
      const outwardX = -wall.inward.x;
      const outwardZ = -wall.inward.z;
      const facing = outwardX * (dx / radialLength) + outwardZ * (dz / radialLength);
      const signed = (this.camera.position.x - wall.start.x) * wall.inward.x + (this.camera.position.z - wall.start.z) * wall.inward.z;
      const along = wallProjectionDistance(wall, { x: this.camera.position.x, z: this.camera.position.z });
      const previousHidden = this.wallHiddenState.get(wall.id) ?? false;

      // Camera/wall transitions are handled visually rather than by moving the camera.
      // This narrow hysteresis zone hides the complete wall assembly while the camera
      // crosses its 10 cm core, preventing both wall-colour fill and collision jitter.
      const transitionLimit = previousHidden ? 0.16 : 0.075;
      const crossingWall = this.camera.position.y > -0.12
        && this.camera.position.y < snapshot.room.height + 0.22
        && along > -0.12
        && along < wall.length + 0.12
        && Math.abs(signed) < transitionLimit;
      const dollhouseCutaway = previousHidden ? facing > 0.045 : facing > 0.18;
      nextState.set(wall.id, crossingWall || dollhouseCutaway);
    }

    this.wallHiddenState = nextState;
    this.wallsGroup.traverse((object) => {
      const wallId = typeof object.userData.cutawayWallId === 'string' ? object.userData.cutawayWallId : null;
      if (!wallId) return;
      const hidden = nextState.get(wallId) ?? false;
      if (force || object.visible === hidden) object.visible = !hidden;
    });
  }

  private syncObjects(snapshot: SceneSnapshot) {
    if (!this.options.showFurniture) {
      if (this.objectModels.size) {
        this.disposeGroup(this.objectGroup);
        this.objectModels.clear();
      }
      return;
    }

    const live = new Set(snapshot.objects.map((o) => o.id));
    for (const [id, group] of this.objectModels) {
      if (live.has(id)) continue;
      this.disposeObject(group);
      this.objectGroup.remove(group);
      this.objectModels.delete(id);
    }

    for (const object of snapshot.objects) {
      let group = this.objectModels.get(object.id);
      if (!group) {
        group = this.createPlaceholderModel(object.productId);
        group.userData.objectId = object.id;
        group.traverse((node) => { node.userData.objectId = object.id; });
        this.objectModels.set(object.id, group);
        this.objectGroup.add(group);
      }
      group.position.set(object.x, 0, object.z);
      group.rotation.y = object.rotationY;
      const selected = object.id === snapshot.selectedId;
      group.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const mat = node.material;
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.emissive.setHex(selected ? 0x10263a : 0x000000);
          mat.emissiveIntensity = selected ? 0.09 : 0;
        }
      });
    }
  }

  private disposeObject(group: THREE.Group) {
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => m.dispose());
    });
  }

  private createPlaceholderModel(id: keyof typeof PRODUCTS) {
    const p = PRODUCTS[id];
    const group = new THREE.Group();
    const baseMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.swatch), roughness: 0.7 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x4d4c48, roughness: 0.7 });
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xe4dfd4, roughness: 0.76 });
    const greenMat = new THREE.MeshStandardMaterial({ color: 0x54765a, roughness: 0.72 });

    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material = baseMat) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };

    if (id === 'sofa' || id === 'armchair') {
      box(p.width * 0.82, 0.24, p.depth * 0.68, 0, 0.34, 0.05);
      box(p.width * 0.84, 0.52, 0.18, 0, 0.56, -p.depth * 0.34);
      box(p.width * 0.09, 0.48, p.depth * 0.7, -p.width * 0.455, 0.38, 0.03);
      box(p.width * 0.09, 0.48, p.depth * 0.7, p.width * 0.455, 0.38, 0.03);
      for (const x of [-p.width * 0.38, p.width * 0.38]) for (const z of [-p.depth * 0.28, p.depth * 0.28]) box(0.055, 0.12, 0.055, x, 0.06, z, darkMat);
    } else if (id === 'dining-table' || id === 'coffee-table') {
      const top = id === 'dining-table' ? 0.075 : 0.065;
      box(p.width, top, p.depth, 0, p.height - top / 2, 0);
      const legH = p.height - top;
      const insetX = p.width * 0.39;
      const insetZ = p.depth * 0.36;
      for (const x of [-insetX, insetX]) for (const z of [-insetZ, insetZ]) box(0.065, legH, 0.065, x, legH / 2, z, darkMat);
    } else if (id === 'chair') {
      box(p.width * 0.82, 0.07, p.depth * 0.74, 0, 0.46, 0.02);
      box(p.width * 0.78, 0.37, 0.055, 0, 0.68, -p.depth * 0.34);
      for (const x of [-p.width * 0.32, p.width * 0.32]) for (const z of [-p.depth * 0.28, p.depth * 0.28]) box(0.045, 0.46, 0.045, x, 0.23, z, darkMat);
    } else if (id === 'cabinet') {
      box(p.width, p.height, p.depth, 0, p.height / 2, 0, lightMat);
      box(0.012, p.height * 0.78, p.depth + 0.008, 0, p.height * 0.52, p.depth * 0.51, darkMat);
      box(0.025, 0.025, 0.04, -0.11, p.height * 0.53, p.depth * 0.56, darkMat);
      box(0.025, 0.025, 0.04, 0.11, p.height * 0.53, p.depth * 0.56, darkMat);
    } else if (id === 'bookcase') {
      box(0.055, p.height, p.depth, -p.width / 2 + 0.03, p.height / 2, 0, lightMat);
      box(0.055, p.height, p.depth, p.width / 2 - 0.03, p.height / 2, 0, lightMat);
      for (let i = 0; i < 5; i += 1) box(p.width, 0.045, p.depth, 0, 0.04 + i * (p.height - 0.08) / 4, 0, lightMat);
    } else if (id === 'rug') {
      const rug = new THREE.Mesh(new THREE.BoxGeometry(p.width, p.height, p.depth), baseMat);
      rug.position.y = p.height / 2 + 0.004;
      rug.receiveShadow = true;
      group.add(rug);
    } else if (id === 'plant') {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.32, 18), baseMat);
      pot.position.y = 0.16;
      pot.castShadow = true;
      pot.receiveShadow = true;
      group.add(pot);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.72, 10), darkMat);
      stem.position.y = 0.65;
      stem.castShadow = true;
      group.add(stem);
      for (let i = 0; i < 7; i += 1) {
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 8), greenMat);
        const a = (i / 7) * Math.PI * 2;
        leaf.scale.set(1.25, 0.5, 0.75);
        leaf.position.set(Math.cos(a) * 0.13, 0.83 + (i % 3) * 0.12, Math.sin(a) * 0.13);
        leaf.castShadow = true;
        group.add(leaf);
      }
    }

    return group;
  }

  private makeLine(points: THREE.Vector3[], color = DIMENSION_COLOR, opacity = 0.82, dashed = false) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: opacity < 1, opacity, dashSize: 0.07, gapSize: 0.045 })
      : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
    const line = new THREE.Line(geometry, material);
    if (dashed) line.computeLineDistances();
    this.helperGroup.add(line);
    return line;
  }

  private makeLocalLine(parent: THREE.Group, points: THREE.Vector3[], color = DIMENSION_COLOR, opacity = 0.82, dashed = false) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: opacity < 1, opacity, dashSize: 0.055, gapSize: 0.035 })
      : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
    const line = new THREE.Line(geometry, material);
    if (dashed) line.computeLineDistances();
    parent.add(line);
    return line;
  }

  private createTextSprite(text: string, scale = 0.42, tone: 'neutral' | 'blue' | 'amber' = 'neutral') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 112;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fg = tone === 'blue' ? '#245f8e' : tone === 'amber' ? '#7a5727' : '#4e5551';
    ctx.font = '600 40px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Thin light halo gives drafting text contrast without a pill/badge container.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(250,250,248,0.92)';
    ctx.lineWidth = 10;
    ctx.strokeText(text, 256, 56);
    ctx.fillStyle = fg;
    ctx.fillText(text, 256, 56);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    sprite.scale.set(scale * 2.0, scale * 0.44, 1);
    sprite.renderOrder = 20;
    return sprite;
  }

  private rebuildHelpers(snapshot: SceneSnapshot) {
    this.disposeGroup(this.helperGroup);
    const system = snapshot.measurementSystem ?? 'metric';

    if (snapshot.showRoomDimensions) this.addRoomDimensions(snapshot, system);

    if (!snapshot.selectedId || !this.options.showFurniture) return;
    const selected = snapshot.objects.find((o) => o.id === snapshot.selectedId);
    if (!selected) return;
    const p = PRODUCTS[selected.productId];

    // Keep selection feedback distinct from the product dimension wireframe.
    if (!snapshot.showProductDimensions) {
      const selection = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(p.width + 0.03, Math.max(0.05, p.height + 0.03), p.depth + 0.03)),
        new THREE.LineBasicMaterial({ color: SELECTION_COLOR, transparent: true, opacity: 0.72 })
      );
      selection.position.set(selected.x, Math.max(0.05, p.height + 0.03) / 2, selected.z);
      selection.rotation.y = selected.rotationY;
      this.helperGroup.add(selection);
    }

    if (snapshot.showClearance) this.addClearanceGuide(selected);
    if (snapshot.showProductDimensions) this.addProductDimensions(selected, system);
    if (snapshot.showSpacingDimensions) this.addSpacingDimensions(selected, snapshot, system);

    const snap = snapshot.activeSnap;
    if (snap && snap.kind !== 'none') {
      const bounds = roomBounds(snapshot.room.vertices);
      if (snap.x) {
        this.makeLine([
          new THREE.Vector3(snap.x.value, 0.025, bounds.minZ),
          new THREE.Vector3(snap.x.value, 0.025, bounds.maxZ)
        ], SELECTION_COLOR, 0.75, true);
      }
      if (snap.z) {
        this.makeLine([
          new THREE.Vector3(bounds.minX, 0.025, snap.z.value),
          new THREE.Vector3(bounds.maxX, 0.025, snap.z.value)
        ], SELECTION_COLOR, 0.75, true);
      }
    }
  }

  private addClearanceGuide(selected: PlacedObject) {
    const parent = new THREE.Group();
    parent.position.set(selected.x, 0.014, selected.z);
    parent.rotation.y = selected.rotationY;

    for (const region of clearanceRegions({ ...selected, x: 0, z: 0, rotationY: 0 })) {
      // Regions are generated in local orientation here; the parent applies the product rotation once.
      const localCx = region.centre.x;
      const localCz = region.centre.z;
      const geo = new THREE.PlaneGeometry(region.width, region.depth);
      const mat = new THREE.MeshBasicMaterial({
        color: CLEARANCE_COLOR,
        transparent: true,
        opacity: region.side === 'front' ? 0.105 : 0.07,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const plane = new THREE.Mesh(geo, mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(localCx, 0, localCz);
      parent.add(plane);

      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(region.width, region.depth)),
        new THREE.LineDashedMaterial({ color: CLEARANCE_COLOR, transparent: true, opacity: 0.78, dashSize: 0.055, gapSize: 0.035 })
      );
      edge.computeLineDistances();
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(localCx, 0.002, localCz);
      parent.add(edge);
    }
    this.helperGroup.add(parent);
  }

  private addRoomDimensions(snapshot: SceneSnapshot, system: MeasurementSystem) {
    const y = snapshot.room.height + 0.18;
    for (const wall of getRoomWalls(snapshot.room)) {
      const outward = { x: -wall.inward.x, z: -wall.inward.z };
      const offset = 0.10;
      const start = new THREE.Vector3(wall.start.x + outward.x * offset, y, wall.start.z + outward.z * offset);
      const end = new THREE.Vector3(wall.end.x + outward.x * offset, y, wall.end.z + outward.z * offset);
      const centre = start.clone().add(end).multiplyScalar(0.5);
      const tangent = new THREE.Vector3(wall.tangent.x, 0, wall.tangent.z);
      const gap = Math.min(0.48, wall.length * 0.3);
      const leftEnd = centre.clone().addScaledVector(tangent, -gap / 2);
      const rightStart = centre.clone().addScaledVector(tangent, gap / 2);
      this.makeLine([start, leftEnd], DIMENSION_COLOR, 0.8);
      this.makeLine([rightStart, end], DIMENSION_COLOR, 0.8);
      // Extension lines rise from the wall top so the dimensions read above the architecture.
      this.makeLine([
        new THREE.Vector3(wall.start.x, snapshot.room.height + 0.025, wall.start.z),
        start
      ], DIMENSION_COLOR, 0.54);
      this.makeLine([
        new THREE.Vector3(wall.end.x, snapshot.room.height + 0.025, wall.end.z),
        end
      ], DIMENSION_COLOR, 0.54);
      const label = this.createTextSprite(formatLength(wall.length, system), 0.34);
      label.position.copy(centre).add(new THREE.Vector3(0, 0.075, 0));
      this.helperGroup.add(label);
    }
  }

  private addProductDimensions(selected: PlacedObject, system: MeasurementSystem) {
    const p = PRODUCTS[selected.productId];
    const parent = new THREE.Group();
    parent.position.set(selected.x, 0, selected.z);
    parent.rotation.y = selected.rotationY;
    const lineColor = 0x2f6f9f;
    const x0 = -p.width / 2;
    const x1 = p.width / 2;
    const z0 = -p.depth / 2;
    const z1 = p.depth / 2;
    const y = Math.max(0.08, p.height + 0.11);

    // Dashed wireframe volume annotation; this replaces (rather than stacks on) the selection box.
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(p.width, p.height, p.depth)),
      new THREE.LineDashedMaterial({ color: lineColor, transparent: true, opacity: 0.66, dashSize: 0.055, gapSize: 0.035 })
    );
    box.computeLineDistances();
    box.position.y = p.height / 2;
    parent.add(box);

    this.makeLocalLine(parent, [new THREE.Vector3(x0, y, z1 + 0.12), new THREE.Vector3(x1, y, z1 + 0.12)], lineColor, 0.88, true);
    this.makeLocalLine(parent, [new THREE.Vector3(x1 + 0.12, y, z0), new THREE.Vector3(x1 + 0.12, y, z1)], lineColor, 0.88, true);
    this.makeLocalLine(parent, [new THREE.Vector3(x1 + 0.16, 0, z0), new THREE.Vector3(x1 + 0.16, p.height, z0)], lineColor, 0.88, true);

    const widthLabel = this.createTextSprite(`W ${formatLength(p.width, system)}`, 0.31, 'blue');
    widthLabel.position.set(0, y + 0.10, z1 + 0.12);
    parent.add(widthLabel);
    const depthLabel = this.createTextSprite(`D ${formatLength(p.depth, system)}`, 0.31, 'blue');
    depthLabel.position.set(x1 + 0.12, y + 0.10, 0);
    parent.add(depthLabel);
    const heightLabel = this.createTextSprite(`H ${formatLength(p.height, system)}`, 0.31, 'blue');
    heightLabel.position.set(x1 + 0.16, p.height / 2, z0);
    parent.add(heightLabel);

    this.helperGroup.add(parent);
  }

  private addSpacingDimensions(selected: PlacedObject, snapshot: SceneSnapshot, system: MeasurementSystem) {
    const others = snapshot.objects.filter((object) => object.id !== selected.id);
    for (const measurement of spacingMeasurements(selected, snapshot.room, others)) {
      const origin = new THREE.Vector3(measurement.origin.x, 0.075, measurement.origin.z);
      const end = new THREE.Vector3(measurement.end.x, 0.075, measurement.end.z);
      this.makeLine([origin, end], CLEARANCE_COLOR, 0.82);
      const perpendicular = new THREE.Vector3(-measurement.direction.z, 0, measurement.direction.x).multiplyScalar(0.055);
      this.makeLine([origin.clone().sub(perpendicular), origin.clone().add(perpendicular)], CLEARANCE_COLOR, 0.72);
      this.makeLine([end.clone().sub(perpendicular), end.clone().add(perpendicular)], CLEARANCE_COLOR, 0.72);
      const label = this.createTextSprite(formatLength(measurement.distance, system), 0.32, 'amber');
      label.position.copy(origin).add(end).multiplyScalar(0.5);
      label.position.y = 0.2;
      this.helperGroup.add(label);
    }
  }

  private findObjectId(object: THREE.Object3D | null): string | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (typeof current.userData.objectId === 'string') return current.userData.objectId;
      current = current.parent;
    }
    return null;
  }

  private findOpeningId(object: THREE.Object3D | null): string | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (typeof current.userData.openingId === 'string') return current.userData.openingId;
      current = current.parent;
    }
    return null;
  }

  private setPointer(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private visibleWallUnderRay(snapshot: SceneSnapshot) {
    const walls = getRoomWalls(snapshot.room);
    let best: { wall: ReturnType<typeof getRoomWalls>[number]; point: THREE.Vector3; distance: number } | null = null;
    for (const wall of walls) {
      const centre = wallPoint(wall, wall.length / 2);
      const outwardX = -wall.inward.x;
      const outwardZ = -wall.inward.z;
      const camDx = this.camera.position.x - centre.x;
      const camDz = this.camera.position.z - centre.z;
      const camLen = Math.hypot(camDx, camDz) || 1;
      const facing = outwardX * (camDx / camLen) + outwardZ * (camDz / camLen);
      // The dollhouse system hides these foreground walls; don't let their invisible planes steal dragging.
      if (facing > 0.18 && this.currentCameraView !== 'top') continue;
      const normal = new THREE.Vector3(wall.inward.x, 0, wall.inward.z);
      const plane = new THREE.Plane(normal, -(normal.x * wall.start.x + normal.z * wall.start.z));
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(plane, point)) continue;
      const along = wallProjectionDistance(wall, { x: point.x, z: point.z });
      if (along < -0.25 || along > wall.length + 0.25 || point.y < -0.25 || point.y > snapshot.room.height + 0.35) continue;
      const distance = point.distanceTo(this.camera.position);
      if (!best || distance < best.distance) best = { wall, point, distance };
    }
    return best;
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.setPointer(event);

    if (this.options.interactiveArchitecture) {
      const openingHits = this.raycaster.intersectObjects(this.wallsGroup.children, true);
      const openingId = openingHits.map((hit) => this.findOpeningId(hit.object)).find(Boolean) ?? null;
      if (openingId) {
        const before = structuredClone(this.bridge.getSnapshot()) as PlannerSnapshot;
        this.bridge.selectOpening(openingId);
        this.openingDragging = { id: openingId, before };
        this.controls.enabled = false;
        this.renderer.domElement.style.cursor = 'grabbing';
        this.renderer.domElement.setPointerCapture?.(event.pointerId);
        return;
      }
    }

    if (!this.options.interactiveFurniture) return;
    const hits = this.raycaster.intersectObjects([...this.objectModels.values()], true);
    const id = this.findObjectId(hits[0]?.object ?? null);
    if (!id) {
      this.bridge.select(null);
      return;
    }
    const before = structuredClone(this.bridge.getSnapshot()) as PlannerSnapshot;
    this.bridge.select(id);
    const selected = this.bridge.getSnapshot().objects.find((object) => object.id === id);
    const hitPoint = hits[0]?.point;
    const grabOffset = selected && hitPoint
      ? { x: hitPoint.x - selected.x, z: hitPoint.z - selected.z }
      : { x: 0, z: 0 };
    this.dragging = { id, before, snap: { kind: 'none' }, grabOffset };
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture?.(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    this.setPointer(event);

    if (this.openingDragging) {
      const snapshot = this.bridge.getSnapshot();
      const opening = snapshot.openings.find((candidate) => candidate.id === this.openingDragging!.id);
      if (!opening) return;
      const hit = this.visibleWallUnderRay(snapshot);
      if (!hit) return;
      const half = opening.width / 2 + 0.05;
      const along = Math.max(half, Math.min(hit.wall.length - half, wallProjectionDistance(hit.wall, { x: hit.point.x, z: hit.point.z })));
      this.bridge.updateOpening(opening.id, { wallId: hit.wall.id, offset: along }, false);
      return;
    }

    if (this.dragging) {
      const point = new THREE.Vector3();
      const snapshot = this.bridge.getSnapshot();
      const moving = snapshot.objects.find((o) => o.id === this.dragging!.id);
      if (!moving) return;

      let rawX = moving.x;
      let rawZ = moving.z;
      const viewVector = this.controls.target.clone().sub(this.camera.position).normalize();
      const isTopLike = Math.abs(viewVector.y) > 0.12;
      if (isTopLike) {
        if (!this.raycaster.ray.intersectPlane(this.floorPlane, point)) return;
        rawX = point.x - this.dragging.grabOffset.x;
        rawZ = point.z - this.dragging.grabOffset.z;
      } else if (Math.abs(viewVector.z) >= Math.abs(viewVector.x)) {
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -moving.z);
        if (!this.raycaster.ray.intersectPlane(plane, point)) return;
        rawX = point.x - this.dragging.grabOffset.x;
      } else {
        const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -moving.x);
        if (!this.raycaster.ray.intersectPlane(plane, point)) return;
        rawZ = point.z - this.dragging.grabOffset.z;
      }

      const others = snapshot.objects.filter((o) => o.id !== moving.id);
      const freeMove = event.shiftKey;
      if (freeMove) this.dragging.snap = { kind: 'none' };
      const resolved = resolvePlacement(moving, rawX, rawZ, snapshot.room, others, {
        previousSnap: freeMove ? undefined : this.dragging.snap,
        enterSnapDistance: freeMove ? 0 : undefined,
        exitSnapDistance: freeMove ? 0 : undefined,
        spatialWallSnap: !freeMove,
        allowOverlap: freeMove
      });
      this.dragging.snap = freeMove ? { kind: 'none' } : resolved.snap;
      const patch: Partial<PlacedObject> = { x: resolved.x, z: resolved.z };
      if (resolved.rotationY != null && Math.abs(resolved.rotationY - moving.rotationY) > 1e-6) patch.rotationY = resolved.rotationY;
      this.bridge.updateObject(moving.id, patch);
      this.bridge.feedback(
        freeMove ? { kind: 'none', label: 'Free move' } : resolved.snap,
        freeMove ? null : resolved.colliding ? moving.id : null,
        freeMove ? false : resolved.pushedByCollision
      );
      return;
    }

    if (this.options.interactiveArchitecture) {
      const hits = this.raycaster.intersectObjects(this.wallsGroup.children, true);
      const openingId = hits.map((hit) => this.findOpeningId(hit.object)).find(Boolean) ?? null;
      if (openingId !== this.hoverOpeningId) {
        this.hoverOpeningId = openingId;
        this.renderer.domElement.style.cursor = openingId ? 'pointer' : '';
        this.syncOpeningHighlight(this.bridge.getSnapshot());
      }
    }
  };

  private onPointerUp = () => {
    if (this.openingDragging) {
      this.bridge.commitDrag(this.openingDragging.before);
      this.openingDragging = null;
      this.controls.enabled = true;
      this.renderer.domElement.style.cursor = this.hoverOpeningId ? 'pointer' : '';
      return;
    }
    if (!this.dragging) return;
    this.bridge.commitDrag(this.dragging.before);
    this.dragging = null;
    this.controls.enabled = true;
    this.bridge.feedback({ kind: 'none' }, null, false);
  };

  private resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private animate = () => {
    this.controls.update();
    this.updateCutawayWalls();
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
