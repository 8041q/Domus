import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { PRODUCTS } from '../core/products';
import { clearanceRegions, resolvePlacement, spacingMeasurements } from '../core/placement';
import { getRoomWalls, roomBounds, wallPoint, wallProjectionDistance } from '../core/roomGeometry';
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
  'light-oak': 0xd7cfbf,
  'warm-oak': 0xa98766,
  stone: 0xb9bab8,
  concrete: 0x858992
};

const DIMENSION_COLOR = 0x4a4a4a;
const SELECTION_COLOR = 0xffd800;
const DIMENSION_WHITE = 0xffffff;
const CLEARANCE_COLOR = 0xc28c3d;
const TRIM_COLOR = 0xffffff;
const JUNCTION_COLOR = 0xffffff;
const WALL_THICKNESS = 0.05;
const FLOOR_THICKNESS = WALL_THICKNESS;
const CEILING_THICKNESS = WALL_THICKNESS;

export class PlannerScene {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(43, 1, 0.08, 100);
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private outlinePass: OutlinePass;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private floorGroup = new THREE.Group();
  private wallsGroup = new THREE.Group();
  private ceilingGroup = new THREE.Group();
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
  private lastHelperKey = '';
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
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.container.appendChild(this.renderer.domElement);

    // IKEA Kreativ uses a neutral studio field around the cutaway room. Keeping this
    // noticeably darker than the shell is important: white chamfers and selection
    // annotations should remain readable without making the room itself look greyed out.
    this.scene.background = new THREE.Color(0xd2d2d2);
    this.scene.add(this.floorGroup, this.wallsGroup, this.ceilingGroup, this.objectGroup, this.helperGroup);

    // Screen-space silhouette outlining matches the reference planner: the selected
    // product gets one crisp yellow contour, independent of its component meshes.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.outlinePass = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera);
    this.outlinePass.visibleEdgeColor.setHex(SELECTION_COLOR);
    this.outlinePass.hiddenEdgeColor.setHex(SELECTION_COLOR);
    this.outlinePass.edgeStrength = 20.0;
    this.outlinePass.edgeThickness = 3.8;
    this.outlinePass.edgeGlow = 0;
    this.outlinePass.pulsePeriod = 0;
    this.composer.addPass(this.outlinePass);
    this.composer.addPass(new OutputPass());

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
    const hemi = new THREE.HemisphereLight(0xffffff, 0x777b80, 0.78);
    const ambient = new THREE.AmbientLight(0xffffff, 0.18);
    this.mainLight = new THREE.DirectionalLight(0xfffdf8, 1.72);
    this.mainLight.position.set(4.2, 7.2, 4.8);
    this.mainLight.castShadow = true;
    this.mainLight.shadow.mapSize.set(2048, 2048);
    this.mainLight.shadow.camera.near = 0.25;
    this.mainLight.shadow.camera.far = 34;
    this.mainLight.shadow.bias = -0.00012;
    this.mainLight.shadow.normalBias = 0.012;
    const fill = new THREE.DirectionalLight(0xe5e9ed, 0.34);
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
    this.disposeGroup(this.ceilingGroup);
    this.disposeGroup(this.objectGroup);
    this.disposeGroup(this.helperGroup);
    this.outlinePass.dispose();
    this.composer.dispose();
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
    this.camera.fov = isDollhouse ? 39 : 32;
    this.camera.updateProjectionMatrix();
    const distance = Math.max(4.2, size * (isDollhouse ? 1.72 : 2.2));
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
        this.camera.position.set(bounds.maxX + size * 0.76, Math.max(3.8, size * 0.84), bounds.maxZ + size * 0.96);
        break;
    }
    this.controls.update();
    this.updateCeilingVisibility();
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
    this.syncHelperTransforms(snapshot);
    const helperKey = this.helperStateKey(snapshot);
    if (helperKey !== this.lastHelperKey) {
      this.rebuildHelpers(snapshot);
      this.lastHelperKey = helperKey;
    }
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
      const renderable = obj as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      renderable.geometry?.dispose();
      const material = renderable.material;
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

  /**
   * Offset the room polygon along each wall's inward normal. Positive values move
   * toward the room interior; negative values move outward. Intersections of the
   * shifted wall lines give exact miter corners, including non-orthogonal rooms.
   */
  private insetRoomVertices(snapshot: PlannerSnapshot, offset: number): Vec2[] {
    const walls = getRoomWalls(snapshot.room);
    if (walls.length < 3 || Math.abs(offset) <= 1e-9) return snapshot.room.vertices.map((v) => ({ x: v.x, z: v.z }));

    const cross = (a: Vec2, b: Vec2) => a.x * b.z - a.z * b.x;
    return walls.map((wall, index) => {
      const previous = walls[(index - 1 + walls.length) % walls.length];
      const p = {
        x: previous.start.x + previous.inward.x * offset,
        z: previous.start.z + previous.inward.z * offset
      };
      const q = {
        x: wall.start.x + wall.inward.x * offset,
        z: wall.start.z + wall.inward.z * offset
      };
      const denom = cross(previous.tangent, wall.tangent);
      if (Math.abs(denom) > 1e-6) {
        const delta = { x: q.x - p.x, z: q.z - p.z };
        const t = cross(delta, wall.tangent) / denom;
        return {
          x: p.x + previous.tangent.x * t,
          z: p.z + previous.tangent.z * t
        };
      }

      // Degenerate / almost-collinear corner. A normalized bisector gives a safe
      // visual fallback and keeps malformed custom rooms from producing NaNs.
      const bx = previous.inward.x + wall.inward.x;
      const bz = previous.inward.z + wall.inward.z;
      const bl = Math.hypot(bx, bz) || 1;
      const vertex = snapshot.room.vertices[index];
      return { x: vertex.x + bx / bl * offset, z: vertex.z + bz / bl * offset };
    });
  }

  private createMiteredSlabGeometry(
    topVertices: Vec2[],
    bottomVertices: Vec2[],
    topY: number,
    bottomY: number,
    topMaterialIndex = 0,
    bottomMaterialIndex = 0,
    sideMaterialIndex = 0
  ) {
    const count = Math.min(topVertices.length, bottomVertices.length);
    const positions: number[] = [];
    for (let i = 0; i < count; i += 1) positions.push(topVertices[i].x, topY, topVertices[i].z);
    for (let i = 0; i < count; i += 1) positions.push(bottomVertices[i].x, bottomY, bottomVertices[i].z);

    const indices: number[] = [];
    const topContour = topVertices.slice(0, count).map((v) => new THREE.Vector2(v.x, v.z));
    const bottomContour = bottomVertices.slice(0, count).map((v) => new THREE.Vector2(v.x, v.z));

    const topStart = indices.length;
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(topContour, [])) indices.push(a, b, c);
    const topCount = indices.length - topStart;

    const bottomStart = indices.length;
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(bottomContour, [])) indices.push(count + c, count + b, count + a);
    const bottomCount = indices.length - bottomStart;

    const sideStart = indices.length;
    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;
      indices.push(i, j, count + j, i, count + j, count + i);
    }
    const sideCount = indices.length - sideStart;

    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    indexed.setIndex(indices);
    indexed.addGroup(topStart, topCount, topMaterialIndex);
    indexed.addGroup(bottomStart, bottomCount, bottomMaterialIndex);
    indexed.addGroup(sideStart, sideCount, sideMaterialIndex);

    // Mitered architectural panels need hard normals. Sharing the perimeter vertices
    // makes Three.js average the face normals, which visually creates a second soft
    // edge beside the real cut. Splitting the vertices gives the same crisp edge as
    // BoxGeometry / the door casing, with no fake seam.
    const geometry = indexed.toNonIndexed();
    indexed.dispose();
    geometry.computeVertexNormals();
    return geometry;
  }

  private makeQuadGeometry(points: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((point) => [point.x, point.y, point.z]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    return geometry;
  }

  private rebuildRoom(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.floorGroup);
    this.disposeGroup(this.wallsGroup);
    this.disposeGroup(this.ceilingGroup);
    this.wallHiddenState.clear();
    const { floorFinish } = snapshot.room;
    const halfWall = WALL_THICKNESS / 2;

    // The floor is one physical mitered panel. The finish is now the top material
    // of that same geometry rather than a second coplanar mesh; this removes the
    // thin doubled/split line that could appear around the perimeter.
    const floorTopVertices = this.insetRoomVertices(snapshot, halfWall);
    const floorBottomVertices = this.insetRoomVertices(snapshot, halfWall - FLOOR_THICKNESS);
    const slab = new THREE.Mesh(
      this.createMiteredSlabGeometry(
        floorTopVertices,
        floorBottomVertices,
        0,
        -FLOOR_THICKNESS,
        1,
        0,
        2
      ),
      [
        new THREE.MeshStandardMaterial({ color: TRIM_COLOR, roughness: 0.82, side: THREE.DoubleSide }),
        new THREE.MeshStandardMaterial({
          color: FLOOR_COLORS[floorFinish] ?? FLOOR_COLORS['light-oak'],
          roughness: 0.84,
          metalness: 0,
          side: THREE.DoubleSide
        }),
        // The miter reveal is an architectural graphic edge, not a lit finish.
        // Keep it pure white regardless of environment lighting or shadows.
        new THREE.MeshBasicMaterial({ color: JUNCTION_COLOR, side: THREE.DoubleSide, toneMapped: false })
      ]
    );
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.floorGroup.add(slab);

    this.rebuildWalls(snapshot);
    this.rebuildCeiling(snapshot);
  }

  private rebuildCeiling(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.ceilingGroup);
    const halfWall = WALL_THICKNESS / 2;

    // The ceiling uses the complementary full-thickness miter to the wall top.
    // Its room-facing underside is inset to the inner wall face, while the upper
    // perimeter reaches the outer wall face. It is only exposed in side presets.
    const bottomVertices = this.insetRoomVertices(snapshot, halfWall);
    const topVertices = this.insetRoomVertices(snapshot, halfWall - CEILING_THICKNESS);
    const ceiling = new THREE.Mesh(
      this.createMiteredSlabGeometry(
        topVertices,
        bottomVertices,
        snapshot.room.height,
        snapshot.room.height - CEILING_THICKNESS,
        0,
        0,
        1
      ),
      [
        new THREE.MeshStandardMaterial({
          color: TRIM_COLOR,
          roughness: 0.78,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -0.6,
          polygonOffsetUnits: -0.6
        }),
        new THREE.MeshBasicMaterial({ color: JUNCTION_COLOR, side: THREE.DoubleSide, toneMapped: false })
      ]
    );
    ceiling.castShadow = true;
    ceiling.receiveShadow = true;
    this.ceilingGroup.add(ceiling);
    this.updateCeilingVisibility();
  }

  private updateCeilingVisibility() {
    this.ceilingGroup.visible = this.currentCameraView === 'front'
      || this.currentCameraView === 'back'
      || this.currentCameraView === 'left'
      || this.currentCameraView === 'right';
  }

  private rebuildWalls(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.wallsGroup);
    const { height, wallColor } = snapshot.room;
    const thickness = WALL_THICKNESS;

    for (const wall of getRoomWalls(snapshot.room)) {
      const wallOpenings = snapshot.openings.filter((o) => o.wallId === wall.id).sort((a, b) => a.offset - b.offset);
      let cursor = 0;
      for (const opening of wallOpenings) {
        const start = Math.max(cursor, opening.offset - opening.width / 2);
        const end = Math.min(wall.length, opening.offset + opening.width / 2);
        if (start > cursor) this.addWallSegmentBox(wall, cursor, start, 0, height, thickness, wallColor, height, snapshot);
        if (opening.sillHeight > 0.01) this.addWallSegmentBox(wall, start, end, 0, opening.sillHeight, thickness, wallColor, height, snapshot);
        const openingTop = Math.min(height, opening.sillHeight + opening.height);
        if (openingTop < height - 0.01) this.addWallSegmentBox(wall, start, end, openingTop, height, thickness, wallColor, height, snapshot);
        this.addOpeningFrame(opening, snapshot, thickness);
        cursor = Math.max(cursor, end);
      }
      if (cursor < wall.length) this.addWallSegmentBox(wall, cursor, wall.length, 0, height, thickness, wallColor, height, snapshot);

      // Keep the normal footer requested earlier, but give the footer itself a
      // proper miter at room corners so it never sticks through a cutaway wall.
      this.addBaseboardRuns(wall, snapshot);
    }
  }

  private wallOffsetPoint(wall: ReturnType<typeof getRoomWalls>[number], distance: number, offset: number): Vec2 {
    const point = wallPoint(wall, distance);
    return { x: point.x + wall.inward.x * offset, z: point.z + wall.inward.z * offset };
  }

  private wallSegmentEdgePoints(
    wall: ReturnType<typeof getRoomWalls>[number],
    start: number,
    end: number,
    offset: number,
    snapshot: PlannerSnapshot
  ) {
    const corners = this.insetRoomVertices(snapshot, offset);
    const startTouchesCorner = start <= 0.0001;
    const endTouchesCorner = end >= wall.length - 0.0001;
    return {
      start: startTouchesCorner ? corners[wall.index] : this.wallOffsetPoint(wall, start, offset),
      end: endTouchesCorner ? corners[(wall.index + 1) % corners.length] : this.wallOffsetPoint(wall, end, offset)
    };
  }

  private addBaseboardRuns(wall: ReturnType<typeof getRoomWalls>[number], snapshot: PlannerSnapshot) {
    const openingFrameWidth = 0.05;
    const blocked = snapshot.openings
      .filter((opening) => opening.wallId === wall.id && opening.sillHeight <= 0.025)
      .map((opening) => ({
        // Stop at the outside of the casing, not the raw opening. The old run
        // continued underneath half of the door frame, producing the little split
        // at the jamb. This makes baseboard and casing meet edge-to-edge.
        start: Math.max(0, opening.offset - opening.width / 2 - openingFrameWidth / 2),
        end: Math.min(wall.length, opening.offset + opening.width / 2 + openingFrameWidth / 2)
      }))
      .sort((a, b) => a.start - b.start);

    let cursor = 0;
    for (const range of blocked) {
      if (range.start > cursor) this.addBaseboard(wall, cursor, range.start, snapshot);
      cursor = Math.max(cursor, range.end);
    }
    if (cursor < wall.length) this.addBaseboard(wall, cursor, wall.length, snapshot);
  }

  private addWallSegmentBox(
    wall: ReturnType<typeof getRoomWalls>[number],
    start: number,
    end: number,
    bottom: number,
    top: number,
    thickness: number,
    wallColor: THREE.ColorRepresentation,
    roomHeight: number,
    snapshot: PlannerSnapshot
  ) {
    if (end - start < 0.005 || top - bottom < 0.005) return;
    const halfT = thickness / 2;
    const outer = this.wallSegmentEdgePoints(wall, start, end, -halfT, snapshot);
    const inner = this.wallSegmentEdgePoints(wall, start, end, halfT, snapshot);

    // A miter consumes the full panel thickness. There is no remaining square top
    // ledge: the wall's outer top edge connects directly to the recessed inner edge.
    const cutTop = top >= roomHeight - 0.0001;
    const topCut = cutTop ? Math.min(thickness, Math.max(0, (top - bottom) * 0.45)) : 0;
    const innerTop = top - topCut;

    // The lower edge is mitered as well, but below floor level. That preserves the
    // requested normal skirting/footer and avoids lifting the visible wall finish.
    const outerBottom = bottom <= 0.0001 ? bottom - thickness : bottom;
    const innerBottom = bottom;

    const points = [
      new THREE.Vector3(outer.start.x, outerBottom, outer.start.z),
      new THREE.Vector3(outer.end.x, outerBottom, outer.end.z),
      new THREE.Vector3(outer.end.x, top, outer.end.z),
      new THREE.Vector3(outer.start.x, top, outer.start.z),
      new THREE.Vector3(inner.start.x, innerBottom, inner.start.z),
      new THREE.Vector3(inner.end.x, innerBottom, inner.end.z),
      new THREE.Vector3(inner.end.x, innerTop, inner.end.z),
      new THREE.Vector3(inner.start.x, innerTop, inner.start.z)
    ];
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((point) => [point.x, point.y, point.z]), 3));
    indexed.setIndex([
      0, 1, 2, 0, 2, 3, // outer face
      4, 7, 6, 4, 6, 5, // inner face
      0, 3, 7, 0, 7, 4, // start miter
      1, 5, 6, 1, 6, 2, // end miter
      3, 2, 6, 3, 6, 7, // top miter
      0, 4, 5, 0, 5, 1  // bottom miter
    ]);
    indexed.addGroup(0, 6, 0);   // outer structural face
    indexed.addGroup(6, 6, 1);   // room-facing wall finish
    indexed.addGroup(12, 24, 2); // all four miter cuts: constant unlit white

    // Keep every miter edge genuinely sharp. The previous shared vertex normals
    // blended the wall face into the cut and read as a second edge / split.
    const geometry = indexed.toNonIndexed();
    indexed.dispose();
    geometry.computeVertexNormals();

    const body = new THREE.Mesh(
      geometry,
      [
        new THREE.MeshStandardMaterial({ color: TRIM_COLOR, roughness: 0.8, side: THREE.DoubleSide }),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(wallColor), roughness: 0.94, side: THREE.DoubleSide }),
        // Miter faces deliberately ignore scene lighting and shadowing so the
        // architectural cut stays the exact same white from every camera angle.
        new THREE.MeshBasicMaterial({ color: JUNCTION_COLOR, side: THREE.DoubleSide, toneMapped: false })
      ]
    );
    body.receiveShadow = true;
    body.castShadow = true;
    this.tagCutawaySurface(body, wall);
    this.wallsGroup.add(body);
  }

  private addBaseboard(
    wall: ReturnType<typeof getRoomWalls>[number],
    start: number,
    end: number,
    snapshot: PlannerSnapshot
  ) {
    if (end - start < 0.03) return;
    const height = 0.07;
    // Match the door casing projection exactly: frameDepth is wall thickness +
    // 12 mm, so its room-side face sits 6 mm proud of the finished wall. A flush
    // skirting/casing junction reads as one trim system instead of two stacked rails.
    const casingProjection = 0.012 / 2;
    const backOffset = WALL_THICKNESS / 2;
    const frontOffset = backOffset + casingProjection;
    const back = this.wallSegmentEdgePoints(wall, start, end, backOffset, snapshot);
    const front = this.wallSegmentEdgePoints(wall, start, end, frontOffset, snapshot);
    const geometry = new THREE.BufferGeometry();
    const points = [
      new THREE.Vector3(back.start.x, 0, back.start.z),
      new THREE.Vector3(back.end.x, 0, back.end.z),
      new THREE.Vector3(front.end.x, 0, front.end.z),
      new THREE.Vector3(front.start.x, 0, front.start.z),
      new THREE.Vector3(back.start.x, height, back.start.z),
      new THREE.Vector3(back.end.x, height, back.end.z),
      new THREE.Vector3(front.end.x, height, front.end.z),
      new THREE.Vector3(front.start.x, height, front.start.z)
    ];
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((point) => [point.x, point.y, point.z]), 3));
    geometry.setIndex([
      0, 1, 2, 0, 2, 3,
      4, 7, 6, 4, 6, 5,
      0, 4, 5, 0, 5, 1,
      1, 5, 6, 1, 6, 2,
      2, 6, 7, 2, 7, 3,
      3, 7, 4, 3, 4, 0
    ]);
    const flatGeometry = geometry.toNonIndexed();
    geometry.dispose();
    flatGeometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      flatGeometry,
      new THREE.MeshStandardMaterial({ color: TRIM_COLOR, roughness: 0.72, side: THREE.DoubleSide })
    );
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
    const tag = <T extends THREE.Object3D>(mesh: T): T => {
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
        const edge = alignedBox(along, panelHeight / 2, width, panelHeight, 0.028, interiorOffset, 0xf4f4f1) as THREE.Mesh;
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
      // crosses its structural core, preventing both wall-colour fill and collision jitter.
      const transitionLimit = previousHidden ? 0.16 : 0.075;
      const crossingWall = this.camera.position.y > -0.12
        && this.camera.position.y < snapshot.room.height + 0.22
        && along > -0.12
        && along < wall.length + 0.12
        && Math.abs(signed) < transitionLimit;
      const dollhouseCutaway = previousHidden ? facing > 0.045 : facing > 0.18;
      nextState.set(wall.id, crossingWall || dollhouseCutaway);
    }

    const cutawayChanged = [...nextState.entries()].some(([id, hidden]) => this.wallHiddenState.get(id) !== hidden)
      || this.wallHiddenState.size !== nextState.size;
    this.wallHiddenState = nextState;
    for (const group of [this.wallsGroup, this.floorGroup]) group.traverse((object) => {
      const wallId = typeof object.userData.cutawayWallId === 'string' ? object.userData.cutawayWallId : null;
      const wallIds = Array.isArray(object.userData.cutawayWallIds)
        ? object.userData.cutawayWallIds.filter((id: unknown): id is string => typeof id === 'string')
        : wallId ? [wallId] : [];
      if (!wallIds.length) return;
      // A junction belongs to every adjoining wall; hide it whenever one of those
      // walls is cut away so no white seam is left floating in the dollhouse opening.
      const hidden = wallIds.some((id) => nextState.get(id) ?? false);
      if (force || object.visible === hidden) object.visible = !hidden;
    });
    if (cutawayChanged && snapshot.showRoomDimensions) {
      this.rebuildHelpers(snapshot);
      this.lastHelperKey = this.helperStateKey(snapshot);
    }
  }

  private syncObjects(snapshot: SceneSnapshot) {
    if (!this.options.showFurniture) {
      this.outlinePass.selectedObjects = [];
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

    let outlined: THREE.Group | null = null;
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
      if (object.id === snapshot.selectedId) outlined = group;
    }
    this.outlinePass.selectedObjects = outlined ? [outlined] : [];
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

  private lineResolution(material: LineMaterial) {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    material.resolution.set(width, height);
  }

  private makeLine(
    points: THREE.Vector3[],
    color = DIMENSION_COLOR,
    opacity = 0.82,
    dashed = false,
    overlay = false,
    widthPx = 2.0
  ) {
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap((point) => [point.x, point.y, point.z]));
    const material = new LineMaterial({
      color,
      linewidth: widthPx,
      transparent: opacity < 1,
      opacity,
      dashed,
      dashSize: dashed ? 0.07 : 1,
      gapSize: dashed ? 0.045 : 0,
      depthTest: !overlay,
      depthWrite: !overlay,
      worldUnits: false
    });
    this.lineResolution(material);
    const line = new Line2(geometry, material);
    if (dashed) line.computeLineDistances();
    if (overlay) line.renderOrder = 24;
    this.helperGroup.add(line);
    return line;
  }

  private makeLocalLine(
    parent: THREE.Group,
    points: THREE.Vector3[],
    color = DIMENSION_COLOR,
    opacity = 0.82,
    dashed = false,
    overlay = false,
    widthPx = 2.0
  ) {
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap((point) => [point.x, point.y, point.z]));
    const material = new LineMaterial({
      color,
      linewidth: widthPx,
      transparent: opacity < 1,
      opacity,
      dashed,
      dashSize: dashed ? 0.055 : 1,
      gapSize: dashed ? 0.035 : 0,
      depthTest: !overlay,
      depthWrite: !overlay,
      worldUnits: false
    });
    this.lineResolution(material);
    const line = new Line2(geometry, material);
    if (dashed) line.computeLineDistances();
    if (overlay) line.renderOrder = 24;
    parent.add(line);
    return line;
  }

  private makeLocalMeasurementLine(parent: THREE.Group, points: THREE.Vector3[], widthPx = 2.0) {
    // Product measurements should read as clean screen-space drafting strokes.
    // A single antialiased white stroke avoids the chunky/pixelated double-line
    // effect caused by the old black under-stroke.
    const line = this.makeLocalLine(parent, points, DIMENSION_WHITE, 0.98, false, true, widthPx);
    line.renderOrder = 25;
    return line;
  }

  private createTextSprite(text: string, scale = 0.42, tone: 'neutral' | 'blue' | 'amber' = 'neutral') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 112;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fg = tone === 'blue' ? '#245f8e' : tone === 'amber' ? '#7a5727' : '#55595b';
    ctx.font = '600 40px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(242,242,240,0.92)';
    ctx.lineWidth = 8;
    ctx.strokeText(text, 256, 56);
    ctx.fillStyle = fg;
    ctx.fillText(text, 256, 56);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    sprite.scale.set(scale * 2.0, scale * 0.44, 1);
    sprite.renderOrder = 28;
    return sprite;
  }

  private createArchitecturalDimensionText(text: string, scale = 0.34) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 112;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '600 40px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(245,245,243,0.98)';
    ctx.lineWidth = 9;
    ctx.strokeText(text, 256, 56);
    ctx.fillStyle = '#3f4142';
    ctx.fillText(text, 256, 56);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    sprite.scale.set(scale * 2.0, scale * 0.44, 1);
    sprite.renderOrder = 30;
    return sprite;
  }

  private createDimensionBadge(text: string, height = 0.215) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '800 37px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const boxWidth = Math.min(294, Math.max(120, Math.ceil(ctx.measureText(text).width + 46)));
    const boxHeight = 66;
    const x = (canvas.width - boxWidth) / 2;
    const y = (canvas.height - boxHeight) / 2;
    const r = 12;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + boxWidth - r, y);
    ctx.quadraticCurveTo(x + boxWidth, y, x + boxWidth, y + r);
    ctx.lineTo(x + boxWidth, y + boxHeight - r);
    ctx.quadraticCurveTo(x + boxWidth, y + boxHeight, x + boxWidth - r, y + boxHeight);
    ctx.lineTo(x + r, y + boxHeight);
    ctx.quadraticCurveTo(x, y + boxHeight, x, y + boxHeight - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(28,29,28,0.98)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    const visibleAspect = boxWidth / boxHeight;
    sprite.scale.set(height * visibleAspect, height, 1);
    sprite.renderOrder = 30;
    return sprite;
  }

  private annotationLength(metres: number, system: MeasurementSystem) {
    return system === 'metric' ? `${Math.round(metres * 100)} cm` : formatLength(metres, system);
  }


  private helperStateKey(snapshot: SceneSnapshot) {
    const selected = snapshot.selectedId ? snapshot.objects.find((object) => object.id === snapshot.selectedId) : undefined;
    const spacingState = snapshot.showSpacingDimensions && selected
      ? snapshot.objects.map((object) => [object.id, object.x, object.z, object.rotationY])
      : null;
    return JSON.stringify({
      selectedId: snapshot.selectedId ?? null,
      selectedProduct: selected?.productId ?? null,
      showClearance: !!snapshot.showClearance,
      showRoomDimensions: !!snapshot.showRoomDimensions,
      showProductDimensions: !!snapshot.showProductDimensions,
      showSpacingDimensions: !!snapshot.showSpacingDimensions,
      measurementSystem: snapshot.measurementSystem ?? 'metric',
      activeSnap: snapshot.activeSnap ?? null,
      spacingState,
      roomDimensionState: snapshot.showRoomDimensions || snapshot.showSpacingDimensions ? {
        height: snapshot.room.height,
        vertices: snapshot.room.vertices.map((vertex) => [vertex.x, vertex.z]),
        hidden: snapshot.showRoomDimensions ? [...this.wallHiddenState.entries()] : null
      } : null
    });
  }

  private syncHelperTransforms(snapshot: SceneSnapshot) {
    const selected = snapshot.selectedId ? snapshot.objects.find((object) => object.id === snapshot.selectedId) : undefined;
    if (!selected) return;
    this.helperGroup.children.forEach((object) => {
      if (object.userData.objectId !== selected.id) return;
      if (object.userData.helperRole === 'productDimensions') {
        object.position.set(selected.x, 0, selected.z);
        object.rotation.y = selected.rotationY;
      } else if (object.userData.helperRole === 'clearance') {
        object.position.set(selected.x, 0.014, selected.z);
        object.rotation.y = selected.rotationY;
      }
    });
  }

  private rebuildHelpers(snapshot: SceneSnapshot) {
    this.disposeGroup(this.helperGroup);
    const system = snapshot.measurementSystem ?? 'metric';

    if (snapshot.showRoomDimensions) this.addRoomDimensions(snapshot, system);

    if (!snapshot.selectedId || !this.options.showFurniture) return;
    const selected = snapshot.objects.find((o) => o.id === snapshot.selectedId);
    if (!selected) return;

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
        ], SELECTION_COLOR, 0.72, true, true);
      }
      if (snap.z) {
        this.makeLine([
          new THREE.Vector3(bounds.minX, 0.025, snap.z.value),
          new THREE.Vector3(bounds.maxX, 0.025, snap.z.value)
        ], SELECTION_COLOR, 0.72, true, true);
      }
    }
  }

  private addClearanceGuide(selected: PlacedObject) {
    const parent = new THREE.Group();
    parent.userData.helperRole = 'clearance';
    parent.userData.objectId = selected.id;
    parent.position.set(selected.x, 0.014, selected.z);
    parent.rotation.y = selected.rotationY;

    for (const region of clearanceRegions({ ...selected, x: 0, z: 0, rotationY: 0 })) {
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
    for (const wall of getRoomWalls(snapshot.room)) {
      const hidden = this.wallHiddenState.get(wall.id) ?? false;
      const outward = new THREE.Vector3(-wall.inward.x, 0, -wall.inward.z);
      const tangent = new THREE.Vector3(wall.tangent.x, 0, wall.tangent.z);
      const offset = hidden ? 0.34 : 0.32;
      // IKEA's dollhouse dimensions read like a clean architectural annotation:
      // one offset string, short witness marks and 45° slash ticks. Keeping the
      // witness marks local to the string avoids the long perspective diagonals
      // that made the previous version look skewed away from the wall.
      const dimensionY = hidden ? 0.052 : snapshot.room.height + 0.045;
      const start = new THREE.Vector3(wall.start.x + outward.x * offset, dimensionY, wall.start.z + outward.z * offset);
      const end = new THREE.Vector3(wall.end.x + outward.x * offset, dimensionY, wall.end.z + outward.z * offset);

      this.makeLine([start, end], DIMENSION_COLOR, 1, false, true, 2.65);
      const witness = outward.clone().multiplyScalar(0.082);
      this.makeLine([start.clone().sub(witness), start.clone().add(witness)], DIMENSION_COLOR, 0.98, false, true, 2.2);
      this.makeLine([end.clone().sub(witness), end.clone().add(witness)], DIMENSION_COLOR, 0.98, false, true, 2.2);

      const tickDirection = tangent.clone().add(outward).normalize().multiplyScalar(0.064);
      this.makeLine([start.clone().sub(tickDirection), start.clone().add(tickDirection)], DIMENSION_COLOR, 1, false, true, 2.8);
      this.makeLine([end.clone().sub(tickDirection), end.clone().add(tickDirection)], DIMENSION_COLOR, 1, false, true, 2.8);

      const centre = start.clone().add(end).multiplyScalar(0.5).add(outward.clone().multiplyScalar(0.038));
      centre.y += hidden ? 0.052 : 0.062;
      const label = this.createArchitecturalDimensionText(this.annotationLength(wall.length, system), 0.62);
      label.position.copy(centre);
      label.userData.alignToDimensionLine = { start: start.clone(), end: end.clone() };
      this.helperGroup.add(label);
    }
  }

  private addProductDimensions(selected: PlacedObject, system: MeasurementSystem) {
    const p = PRODUCTS[selected.productId];
    const parent = new THREE.Group();
    parent.userData.helperRole = 'productDimensions';
    parent.userData.objectId = selected.id;
    parent.position.set(selected.x, 0, selected.z);
    parent.rotation.y = selected.rotationY;
    const x0 = -p.width / 2;
    const x1 = p.width / 2;
    const z0 = -p.depth / 2;
    const z1 = p.depth / 2;
    const floorY = 0.028;
    const widthZ = z1 + 0.16;
    const depthX = x0 - 0.16;
    const heightX = x0 - 0.16;
    const heightZ = z0 - 0.04;

    // White dashed measurement volume, while the selected product keeps the yellow
    // screen-space silhouette from OutlinePass.
    const boxMaterial = new LineMaterial({
      color: DIMENSION_WHITE,
      linewidth: 1.9,
      transparent: true,
      opacity: 0.98,
      dashed: true,
      dashSize: 0.082,
      gapSize: 0.050,
      depthTest: false,
      depthWrite: false,
      worldUnits: false
    });
    this.lineResolution(boxMaterial);
    const sourceEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(p.width, p.height, p.depth));
    const boxGeometry = new LineSegmentsGeometry().fromEdgesGeometry(sourceEdges);
    sourceEdges.dispose();

    const box = new LineSegments2(boxGeometry, boxMaterial);
    box.computeLineDistances();
    box.position.y = p.height / 2;
    box.renderOrder = 25;
    parent.add(box);

    const widthA = new THREE.Vector3(x0, floorY, widthZ);
    const widthB = new THREE.Vector3(x1, floorY, widthZ);
    const depthA = new THREE.Vector3(depthX, floorY, z0);
    const depthB = new THREE.Vector3(depthX, floorY, z1);
    const heightA = new THREE.Vector3(heightX, 0, heightZ);
    const heightB = new THREE.Vector3(heightX, p.height, heightZ);

    this.makeLocalMeasurementLine(parent, [widthA, widthB], 2.35);
    this.makeLocalMeasurementLine(parent, [new THREE.Vector3(x0, floorY, z1), widthA], 1.8);
    this.makeLocalMeasurementLine(parent, [new THREE.Vector3(x1, floorY, z1), widthB], 1.8);
    this.makeLocalMeasurementLine(parent, [depthA, depthB], 2.35);
    this.makeLocalMeasurementLine(parent, [new THREE.Vector3(x0, floorY, z0), depthA], 1.8);
    this.makeLocalMeasurementLine(parent, [new THREE.Vector3(x0, floorY, z1), depthB], 1.8);
    this.makeLocalMeasurementLine(parent, [heightA, heightB], 2.35);
    this.makeLocalMeasurementLine(parent, [new THREE.Vector3(x0, 0, z0), heightA], 1.8);
    this.makeLocalMeasurementLine(parent, [new THREE.Vector3(x0, p.height, z0), heightB], 1.8);

    const widthLabel = this.createDimensionBadge(this.annotationLength(p.width, system), 0.18);
    widthLabel.position.set(0, 0.16, widthZ + 0.015);
    parent.add(widthLabel);
    const depthLabel = this.createDimensionBadge(this.annotationLength(p.depth, system), 0.18);
    depthLabel.position.set(depthX - 0.015, 0.16, 0);
    parent.add(depthLabel);
    const heightLabel = this.createDimensionBadge(this.annotationLength(p.height, system), 0.18);
    heightLabel.position.set(heightX - 0.02, p.height / 2, heightZ);
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

  private orientDimensionLabels() {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    this.helperGroup.traverse((object) => {
      if (!(object instanceof THREE.Sprite)) return;
      const alignment = object.userData.alignToDimensionLine as { start?: THREE.Vector3; end?: THREE.Vector3 } | undefined;
      if (!alignment?.start || !alignment.end || !(object.material instanceof THREE.SpriteMaterial)) return;
      a.copy(alignment.start).project(this.camera);
      b.copy(alignment.end).project(this.camera);
      let angle = Math.atan2(b.y - a.y, b.x - a.x);
      // Keep drafting text upright even when the camera crosses to the opposite side.
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      object.material.rotation = angle;
    });
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
    this.renderer.domElement.style.cursor = 'grabbing';
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
      // Apply the visual transform immediately. Store/React synchronisation still happens
      // below, but the mesh no longer waits for another animation frame while dragging.
      const model = this.objectModels.get(moving.id);
      if (model) {
        model.position.set(resolved.x, 0, resolved.z);
        model.rotation.y = resolved.rotationY ?? moving.rotationY;
      }
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
      return;
    }

    if (this.options.interactiveFurniture) {
      const furnitureHits = this.raycaster.intersectObjects([...this.objectModels.values()], true);
      const furnitureId = this.findObjectId(furnitureHits[0]?.object ?? null);
      this.renderer.domElement.style.cursor = furnitureId ? 'move' : '';
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
    this.renderer.domElement.style.cursor = '';
    this.bridge.feedback({ kind: 'none' }, null, false);
  };

  private resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.helperGroup.traverse((object) => {
      const material = (object as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
      const materials = Array.isArray(material) ? material : material ? [material] : [];
      materials.forEach((item) => {
        if (item instanceof LineMaterial) item.resolution.set(width, height);
      });
    });
  }

  private animate = () => {
    this.controls.update();
    this.updateCutawayWalls();
    this.orientDimensionLabels();
    this.composer.render();
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
