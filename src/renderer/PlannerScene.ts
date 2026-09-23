import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
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
import { floorFinishDefinition, type FloorFinishDefinition } from '../core/roomFinishes';
import { clearanceRegions, resolvePlacement, spacingMeasurements } from '../core/placement';
import { getRoomWalls, roomBounds, wallPoint, wallProjectionDistance } from '../core/roomGeometry';
import { formatLength } from '../core/units';
import type { FloorFinish, PlanCameraView, MeasurementSystem, PlannerSnapshot, PlacedObject, RoomOpening, SnapFeedback, Vec2 } from '../core/types';
import { themeHex, themeMetric } from '../theme';

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

const DIMENSION_COLOR = themeHex('dimension-line');
const SELECTION_COLOR = themeHex('interaction');
const INTERACTION_STRONG_COLOR = themeHex('interaction-strong');
const PRODUCT_DIMENSION_COLOR = themeHex('product-dimension-line');
const CLEARANCE_COLOR = themeHex('clearance-fill');
const CLEARANCE_EDGE_COLOR = themeHex('clearance-edge');
const SPACING_COLOR = themeHex('spacing-line');
const DIMENSION_TEXT_COLOR = themeHex('dimension-text');
const DIMENSION_CARD_BACKGROUND = themeHex('dimension-card-background');
const DIMENSION_CARD_BORDER = themeHex('dimension-card-border');
const TRIM_COLOR = 0xffffff;
const JUNCTION_COLOR = 0xffffff;
const WALL_THICKNESS = 0.05;
const FLOOR_THICKNESS = WALL_THICKNESS;
const CEILING_THICKNESS = WALL_THICKNESS;

type DomusExportCategory = 'Walls' | 'Floors' | 'Frames' | 'Ceiling' | 'Furniture';

interface DomusExportSource {
  object: THREE.Object3D;
  logicalRoot: boolean;
}

interface LoadedFloorMaps {
  color: THREE.Texture | null;
  normal: THREE.Texture | null;
  roughness: THREE.Texture | null;
}

interface DomusExportItem {
  category: DomusExportCategory;
  id: string;
  name: string;
  rotationY: number;
  sources: DomusExportSource[];
}

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
  private currentCameraView: PlanCameraView = 'perspective';
  private environmentTexture: THREE.Texture | null = null;
  private mainLight: THREE.DirectionalLight;
  private wallHiddenState = new Map<string, boolean>();
  private floorTextureReady: Promise<void> = Promise.resolve();
  private floorMaterial: THREE.MeshStandardMaterial | null = null;
  private floorFinishRequest = 0;
  private lastFloorFinish: FloorFinish | null = null;
  private floorMapCache = new Map<FloorFinish, Promise<LoadedFloorMaps>>();
  private floorMapResults = new Map<FloorFinish, LoadedFloorMaps>();
  private floorMapAssets = new Set<THREE.Texture>();

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
    for (const texture of this.floorMapAssets) texture.dispose();
    this.floorMapAssets.clear();
    this.floorMapCache.clear();
    this.floorMapResults.clear();
    this.outlinePass.dispose();
    this.composer.dispose();
    this.environmentTexture?.dispose();
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }

  resetCamera() {
    this.setCameraView('perspective');
  }

  /**
   * Attach semantic export metadata to one complete logical item. The object's
   * hierarchy is preserved (important for sofas/models made from many parts).
   */
  private tagExportRoot<T extends THREE.Object3D>(
    object: T,
    category: DomusExportCategory,
    itemId: string,
    itemName: string
  ): T {
    object.userData.domusExportCategory = category;
    object.userData.domusExportItemId = itemId;
    object.userData.domusExportItemName = itemName;
    object.userData.domusExportRoot = true;
    return object;
  }

  /**
   * Attach one piece of a logical export item. Multiple meshes carrying the same
   * category + item id are gathered below one centred parent in the GLB.
   */
  private tagExportPart<T extends THREE.Object3D>(
    object: T,
    category: DomusExportCategory,
    itemId: string,
    itemName: string,
    rotationY = 0
  ): T {
    object.userData.domusExportCategory = category;
    object.userData.domusExportItemId = itemId;
    object.userData.domusExportItemName = itemName;
    object.userData.domusExportRotationY = rotationY;
    object.userData.domusExportRoot = false;
    return object;
  }

  private collectExportItems(): DomusExportItem[] {
    const items = new Map<string, DomusExportItem>();
    const registrations: Array<{ root: THREE.Group; fallbackCategory: DomusExportCategory }> = [
      { root: this.floorGroup, fallbackCategory: 'Floors' },
      { root: this.wallsGroup, fallbackCategory: 'Walls' },
      { root: this.ceilingGroup, fallbackCategory: 'Ceiling' },
      { root: this.objectGroup, fallbackCategory: 'Furniture' }
    ];

    const add = (
      object: THREE.Object3D,
      category: DomusExportCategory,
      id: string,
      name: string,
      logicalRoot: boolean,
      rotationY = 0
    ) => {
      const key = `${category}:${id}`;
      let item = items.get(key);
      if (!item) {
        item = { category, id, name, rotationY, sources: [] };
        items.set(key, item);
      }
      item.sources.push({ object, logicalRoot });
    };

    for (const { root, fallbackCategory } of registrations) {
      root.updateMatrixWorld(true);
      for (const child of root.children) {
        const category = child.userData.domusExportCategory as DomusExportCategory | undefined;
        const itemId = typeof child.userData.domusExportItemId === 'string' ? child.userData.domusExportItemId : undefined;
        const itemName = typeof child.userData.domusExportItemName === 'string' ? child.userData.domusExportItemName : undefined;
        if (category && itemId) {
          add(
            child,
            category,
            itemId,
            itemName || child.name || itemId,
            child.userData.domusExportRoot === true,
            typeof child.userData.domusExportRotationY === 'number' ? child.userData.domusExportRotationY : 0
          );
          continue;
        }

        // Future-proof default: any new logical direct child added to one of the
        // physical scene groups is exported automatically. For example, a future
        // LightFixture group added to ceilingGroup appears under Ceiling without
        // changing exportGLB(). Explicit metadata is only needed when several
        // separate scene meshes must be gathered as one logical item.
        add(
          child,
          fallbackCategory,
          child.uuid,
          child.name || `${fallbackCategory} Item`,
          true,
          0
        );
      }
    }

    return [...items.values()];
  }

  private exportableWorldBounds(sources: DomusExportSource[]) {
    const bounds = new THREE.Box3();
    const temp = new THREE.Box3();
    let hasGeometry = false;

    for (const { object } of sources) {
      object.updateWorldMatrix(true, true);
      object.traverse((node) => {
        if (node.userData.invisiblePick || !(node instanceof THREE.Mesh)) return;
        const geometry = node.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.boundingBox) return;
        temp.copy(geometry.boundingBox).applyMatrix4(node.matrixWorld);
        if (temp.isEmpty()) return;
        bounds.union(temp);
        hasGeometry = true;
      });
    }

    if (hasGeometry) return bounds;

    // A future punctual light can be a valid glTF node without fixture geometry.
    // In that case its own world position is the most useful pivot.
    const centre = new THREE.Vector3();
    const point = new THREE.Vector3();
    for (const { object } of sources) centre.add(object.getWorldPosition(point));
    if (sources.length) centre.multiplyScalar(1 / sources.length);
    bounds.set(centre, centre);
    return bounds;
  }

  private prepareExportClone(root: THREE.Object3D) {
    const remove: THREE.Object3D[] = [];
    root.traverse((object) => {
      if (object.userData.invisiblePick) {
        remove.push(object);
        return;
      }

      // Keep useful semantic ids, but strip viewport/export implementation details
      // from glTF extras.
      delete object.userData.cutawayWallId;
      delete object.userData.cutawayOutwardX;
      delete object.userData.cutawayOutwardZ;
      delete object.userData.domusExportCategory;
      delete object.userData.domusExportItemId;
      delete object.userData.domusExportItemName;
      delete object.userData.domusExportRotationY;
      delete object.userData.domusExportRoot;
      delete object.userData.invisiblePick;

      if (!(object instanceof THREE.Mesh)) return;

      // Object3D.clone() shares geometries/materials. Export clones get independent
      // copies because we re-centre their origins and clear UI highlight materials.
      object.geometry = object.geometry.clone();
      object.material = Array.isArray(object.material)
        ? object.material.map((material) => material.clone())
        : object.material.clone();

      if (typeof object.userData.openingId === 'string') {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) {
            material.emissive.setHex(0x000000);
            material.emissiveIntensity = 0;
          }
        }
      }
    });

    for (const object of remove) object.parent?.remove(object);
  }

  /**
   * Re-centre leaf mesh geometry around each mesh node's own origin without moving
   * it in world space. Logical item parents are centred separately below.
   */
  private centreExportMeshOrigins(root: THREE.Object3D) {
    const offset = new THREE.Vector3();
    const translation = new THREE.Matrix4();
    const adjusted = new THREE.Matrix4();

    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh || object.children.length) return;
      if (Object.keys(object.geometry.morphAttributes).length) return;
      object.geometry.computeBoundingBox();
      const bounds = object.geometry.boundingBox;
      if (!bounds || bounds.isEmpty()) return;
      bounds.getCenter(offset);
      if (offset.lengthSq() < 1e-12) return;

      object.geometry.translate(-offset.x, -offset.y, -offset.z);
      object.updateMatrix();
      translation.makeTranslation(offset.x, offset.y, offset.z);
      adjusted.copy(object.matrix).multiply(translation);
      adjusted.decompose(object.position, object.quaternion, object.scale);
      object.matrixAutoUpdate = true;
    });
  }

  private buildExportItem(item: DomusExportItem) {
    const bounds = this.exportableWorldBounds(item.sources);
    const centre = bounds.getCenter(new THREE.Vector3());
    const itemRoot = new THREE.Group();
    itemRoot.name = item.name;
    itemRoot.userData.domusCategory = item.category;
    itemRoot.userData.domusItemId = item.id;

    // A single logical model (furniture / future light fixture) keeps its complete
    // world orientation at the new centred parent. Multi-piece architectural items
    // use the wall-aligned yaw stored by their builders.
    if (item.sources.length === 1 && item.sources[0].logicalRoot) {
      item.sources[0].object.getWorldQuaternion(itemRoot.quaternion);
    } else {
      itemRoot.rotation.y = item.rotationY;
    }
    itemRoot.position.copy(centre);
    itemRoot.updateMatrixWorld(true);
    const inverseItemMatrix = itemRoot.matrixWorld.clone().invert();

    let partIndex = 0;
    const addCloneAtWorldTransform = (source: THREE.Object3D, preferredName?: string) => {
      if (source.userData.invisiblePick) return;
      source.updateWorldMatrix(true, true);
      const clone = source.clone(true);
      this.prepareExportClone(clone);

      // Preserve the source's exact world-space appearance while changing its parent
      // to the item's new centred pivot.
      const localMatrix = inverseItemMatrix.clone().multiply(source.matrixWorld);
      localMatrix.decompose(clone.position, clone.quaternion, clone.scale);
      clone.matrixAutoUpdate = true;
      if (preferredName) clone.name = preferredName;
      else if (!clone.name) clone.name = `${item.name} Part ${++partIndex}`;
      itemRoot.add(clone);
    };

    for (const { object, logicalRoot } of item.sources) {
      if (object.userData.invisiblePick) continue;
      object.updateWorldMatrix(true, true);

      if (logicalRoot && object instanceof THREE.Group) {
        // The centred item parent replaces the source model's outer group. This gives
        // Blender the useful hierarchy Furniture > Sofa > cushion/legs rather than
        // Furniture > Sofa > Sofa > cushion/legs, while retaining every nested part.
        for (const child of object.children) addCloneAtWorldTransform(child);
        for (const key of ['objectId', 'productId']) {
          if (object.userData[key] !== undefined) itemRoot.userData[key] = object.userData[key];
        }
      } else {
        const preferredName = logicalRoot && object.name === item.name
          ? `${item.name} Geometry`
          : undefined;
        addCloneAtWorldTransform(object, preferredName);
      }
    }

    this.centreExportMeshOrigins(itemRoot);
    itemRoot.updateMatrixWorld(true);

    let hasContent = false;
    let unnamedMeshIndex = 0;
    itemRoot.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        hasContent = true;
        if (!object.name) object.name = `${item.name} Part ${++unnamedMeshIndex}`;
      } else if (object instanceof THREE.Light) {
        hasContent = true;
      }
    });
    return hasContent ? itemRoot : null;
  }

  async exportGLB(filename = 'domus-room.glb') {
    // Give the active finish maps a chance to arrive before GLTFExporter serialises
    // the floor material. Failed requests resolve too, so export never hangs offline.
    await this.floorTextureReady;
    // Export semantic data, not the current dollhouse view. Camera cutaways,
    // dimensions, selection outlines and other helper/UI state are never part of
    // this export tree.
    const exportRoot = new THREE.Group();
    exportRoot.name = 'DomusRoom';
    exportRoot.userData.domusFormatVersion = 2;
    exportRoot.userData.units = 'meters';

    const categories = new Map<DomusExportCategory, THREE.Group>();
    const categoryOrder: DomusExportCategory[] = ['Walls', 'Floors', 'Frames', 'Ceiling', 'Furniture'];
    for (const name of categoryOrder) {
      const group = new THREE.Group();
      group.name = name;
      group.userData.domusCategory = name;
      categories.set(name, group);
      exportRoot.add(group);
    }

    for (const item of this.collectExportItems()) {
      if (item.category === 'Furniture' && !this.options.showFurniture) continue;
      const node = this.buildExportItem(item);
      if (node) categories.get(item.category)?.add(node);
    }

    // Keep stable top-level categories, but do not clutter Blender with an empty
    // Furniture node in architecture-only views.
    for (const [name, group] of categories) {
      if (!group.children.length && name === 'Furniture') exportRoot.remove(group);
    }

    exportRoot.updateMatrixWorld(true);
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(exportRoot, {
      binary: true,
      onlyVisible: false,
      // Explicit TRS nodes make Blender's object origins/transforms easy to inspect.
      trs: true
    });
    if (!(result instanceof ArrayBuffer)) throw new Error('GLB export did not return binary data.');

    const blob = new Blob([result], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  setCameraView(view: PlanCameraView) {
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
    const { floorFinish, ...roomWithoutFloorFinish } = snapshot.room;
    const roomKey = JSON.stringify(roomWithoutFloorFinish);
    const openingsKey = JSON.stringify(snapshot.openings);
    if (roomKey !== this.lastRoomKey) {
      this.rebuildRoom(snapshot);
      this.lastRoomKey = roomKey;
      this.lastFloorFinish = floorFinish;
      this.lastOpeningsKey = openingsKey;
      const bounds = roomBounds(snapshot.room.vertices);
      this.controls.target.set((bounds.minX + bounds.maxX) / 2, Math.min(0.95, snapshot.room.height * 0.38), (bounds.minZ + bounds.maxZ) / 2);
      this.updateShadowBounds(snapshot);
    } else if (floorFinish !== this.lastFloorFinish) {
      // Finish changes are deliberately decoupled from geometry rebuilds. Keep the
      // current floor visible until every map for the requested finish has settled,
      // then replace the material channels atomically in one frame.
      this.requestFloorFinish(floorFinish);
      this.lastFloorFinish = floorFinish;
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
    const disposedTextures = new Set<THREE.Texture>();
    const disposeMaterial = (material: THREE.Material) => {
      // Floor finishes and annotation sprites own their textures. Dispose every
      // texture reference once so changing finishes repeatedly does not leak GPU memory.
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !disposedTextures.has(value)) {
          disposedTextures.add(value);
          value.dispose();
        }
      }
      material.dispose();
    };

    group.traverse((obj) => {
      const renderable = obj as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      renderable.geometry?.dispose();
      const material = renderable.material;
      if (Array.isArray(material)) material.forEach(disposeMaterial);
      else if (material) disposeMaterial(material);
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
    const uvs: number[] = [];
    // World-space planar UVs: one UV unit equals one metre. This keeps finish
    // scale stable across rooms and also makes the texture mapping portable in glTF.
    for (let i = 0; i < count; i += 1) {
      positions.push(topVertices[i].x, topY, topVertices[i].z);
      uvs.push(topVertices[i].x, topVertices[i].z);
    }
    for (let i = 0; i < count; i += 1) {
      positions.push(bottomVertices[i].x, bottomY, bottomVertices[i].z);
      uvs.push(bottomVertices[i].x, bottomVertices[i].z);
    }

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
    indexed.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
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

  /** Configure one loaded map at the material's documented physical tile size. */
  private configureFloorMap(texture: THREE.Texture, name: string, textureWidthMetres: number, srgb: boolean) {
    texture.name = name;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    const repeatsPerMetre = 1 / Math.max(0.1, textureWidthMetres);
    texture.repeat.set(repeatsPerMetre, repeatsPerMetre);
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Carpet011 has useful real fibre detail but its albedo is warm. This derives a
   * neutral charcoal base-colour from that CC0 photograph while preserving the
   * photographed pile variation. Normal and roughness maps remain untouched.
   */
  private makeDarkGreyCarpetTexture(source: THREE.Texture) {
    const image = source.image as CanvasImageSource & { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
    const width = image.naturalWidth || image.width || 0;
    const height = image.naturalHeight || image.height || 0;
    if (!width || !height) return source;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return source;
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const data = pixels.data;
      for (let index = 0; index < data.length; index += 4) {
        const luminance = data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
        // Keep a little range in the fibres, but move the whole material into a
        // dark neutral grey instead of multiplying the original beige/brown hue.
        const grey = Math.max(48, Math.min(116, 40 + luminance * 0.34));
        data[index] = grey * 0.94;
        data[index + 1] = grey * 0.98;
        data[index + 2] = grey;
      }
      context.putImageData(pixels, 0, 0);
      const graded = new THREE.CanvasTexture(canvas);
      source.dispose();
      return graded;
    } catch {
      // A texture host without canvas-readable CORS data still gets the original
      // CC0 colour map instead of breaking the finish load.
      return source;
    }
  }

  private async loadFloorMap(url: string, name: string, textureWidthMetres: number, srgb: boolean) {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    try {
      const texture = await loader.loadAsync(url);
      this.floorMapAssets.add(texture);
      return this.configureFloorMap(texture, name, textureWidthMetres, srgb);
    } catch {
      return null;
    }
  }

  /** Load each finish once; scene rebuilds clone the already-loaded images instantly. */
  private loadFloorFinishMaps(definition: FloorFinishDefinition) {
    const cached = this.floorMapCache.get(definition.id);
    if (cached) return cached;

    const load = Promise.all([
      this.loadFloorMap(definition.maps.color, `${definition.name} Base Color`, definition.textureWidthMetres, true),
      this.loadFloorMap(definition.maps.normal, `${definition.name} Normal`, definition.textureWidthMetres, false),
      this.loadFloorMap(definition.maps.roughness, `${definition.name} Roughness`, definition.textureWidthMetres, false)
    ]).then(([loadedColor, normal, roughness]) => {
      let color = loadedColor;
      if (color && definition.colorTreatment === 'dark-grey-carpet') {
        const treated = this.makeDarkGreyCarpetTexture(color);
        if (treated !== color) {
          this.floorMapAssets.delete(color);
          color = this.configureFloorMap(treated, `${definition.name} Base Color`, definition.textureWidthMetres, true);
          this.floorMapAssets.add(color);
        }
      }
      const maps = { color, normal, roughness };
      this.floorMapResults.set(definition.id, maps);
      return maps;
    });
    this.floorMapCache.set(definition.id, load);
    return load;
  }

  private cloneFloorMap(texture: THREE.Texture | null) {
    if (!texture) return null;
    const clone = texture.clone();
    clone.needsUpdate = true;
    return clone;
  }

  private disposeFloorMaterialMaps(material: THREE.MeshStandardMaterial) {
    const maps = [material.map, material.normalMap, material.roughnessMap];
    for (const texture of maps) texture?.dispose();
    material.map = null;
    material.normalMap = null;
    material.roughnessMap = null;
  }

  private applyFloorMaps(material: THREE.MeshStandardMaterial, definition: FloorFinishDefinition, maps: LoadedFloorMaps) {
    this.disposeFloorMaterialMaps(material);
    material.map = this.cloneFloorMap(maps.color);
    material.normalMap = this.cloneFloorMap(maps.normal);
    material.roughnessMap = this.cloneFloorMap(maps.roughness);
    material.color.set(maps.color ? 0xffffff : definition.fallbackColor);
    material.normalScale.set(definition.normalScale, definition.normalScale);
    material.roughness = maps.roughness ? 1 : definition.fallbackRoughness;
    material.metalness = 0;
    material.envMapIntensity = definition.envMapIntensity;
    material.name = `Floor - ${definition.name}`;
    material.needsUpdate = true;
  }

  private createFloorMaterial(definition: FloorFinishDefinition) {
    const material = new THREE.MeshStandardMaterial({
      color: definition.fallbackColor,
      roughness: definition.fallbackRoughness,
      metalness: 0,
      envMapIntensity: definition.envMapIntensity,
      side: THREE.DoubleSide
    });
    material.normalScale.set(definition.normalScale, definition.normalScale);
    material.name = `Floor - ${definition.name}`;
    this.floorMaterial = material;

    // If this finish has already loaded once, room edits can rebuild the slab with
    // its full PBR material synchronously—no colour/blank flash while dragging walls.
    const cached = this.floorMapResults.get(definition.id);
    if (cached) this.applyFloorMaps(material, definition, cached);
    else this.requestFloorFinish(definition.id, material);
    return material;
  }

  private requestFloorFinish(finish: FloorFinish, target = this.floorMaterial) {
    if (!target) return;
    const definition = floorFinishDefinition(finish);
    const request = ++this.floorFinishRequest;
    const cached = this.floorMapResults.get(finish);
    if (cached) {
      this.applyFloorMaps(target, definition, cached);
      this.floorTextureReady = Promise.resolve();
      return;
    }

    // Crucially, do not clear or replace the current material here. During a user
    // selection the old finish stays rendered until all three new channels settle.
    this.floorTextureReady = this.loadFloorFinishMaps(definition).then((maps) => {
      if (request !== this.floorFinishRequest || this.floorMaterial !== target) return;
      this.applyFloorMaps(target, definition, maps);
    });
  }

  private rebuildRoom(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.floorGroup);
    this.disposeGroup(this.wallsGroup);
    this.disposeGroup(this.ceilingGroup);
    this.wallHiddenState.clear();
    const { floorFinish } = snapshot.room;
    const halfWall = WALL_THICKNESS / 2;
    const floorDefinition = floorFinishDefinition(floorFinish);
    const floorMaterial = this.createFloorMaterial(floorDefinition);

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
        floorMaterial,
        // The miter reveal is an architectural graphic edge, not a lit finish.
        // Keep it pure white regardless of environment lighting or shadows.
        new THREE.MeshBasicMaterial({ color: JUNCTION_COLOR, side: THREE.DoubleSide, toneMapped: false })
      ]
    );
    slab.receiveShadow = true;
    slab.castShadow = true;
    slab.name = 'Floor';
    this.tagExportRoot(slab, 'Floors', 'floor', 'Floor');
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
    ceiling.name = 'Ceiling';
    this.tagExportRoot(ceiling, 'Ceiling', 'ceiling', 'Ceiling');
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
    body.name = `Wall ${wall.index + 1} Segment`;
    this.tagCutawaySurface(body, wall);
    this.tagExportPart(body, 'Walls', wall.id, `Wall ${wall.index + 1}`, this.wallYaw(wall));
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
    mesh.name = `Baseboard ${wall.index + 1} Segment`;
    this.tagCutawaySurface(mesh, wall);
    this.tagExportPart(mesh, 'Floors', `baseboard:${wall.id}`, `Baseboard ${wall.index + 1}`, this.wallYaw(wall));
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
    const typeLabel = opening.type === 'window' ? 'Window' : opening.type === 'door' ? 'Door' : 'Opening';
    const typeIndex = snapshot.openings.filter((candidate) => candidate.type === opening.type).findIndex((candidate) => candidate.id === opening.id) + 1;
    const exportName = `${typeLabel} ${Math.max(1, typeIndex)}`;

    const material = (color: THREE.ColorRepresentation, roughness = 0.66) => new THREE.MeshStandardMaterial({ color, roughness });
    const tag = <T extends THREE.Object3D>(mesh: T): T => {
      this.tagCutawaySurface(mesh, wall);
      mesh.userData.openingId = opening.id;
      mesh.name = mesh.name || `${exportName} Part`;
      this.tagExportPart(mesh, 'Frames', opening.id, exportName, yaw);
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
            mat.color.setHex(active ? SELECTION_COLOR : 0xffffff);
            mat.opacity = active ? 0.18 : 0;
            mat.transparent = true;
          }
        } else if (mat instanceof THREE.MeshPhysicalMaterial) {
          mat.emissive.setHex(active ? INTERACTION_STRONG_COLOR : 0x000000);
          mat.emissiveIntensity = active ? 0.16 : 0;
        } else if (mat instanceof THREE.MeshStandardMaterial) {
          mat.emissive.setHex(active ? INTERACTION_STRONG_COLOR : 0x000000);
          mat.emissiveIntensity = active ? 0.18 : 0;
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
        const product = PRODUCTS[object.productId];
        group.name = product.name;
        group.userData.objectId = object.id;
        group.userData.productId = object.productId;
        this.tagExportRoot(group, 'Furniture', object.id, product.name);
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

  private makeLocalMeasurementLine(parent: THREE.Group, points: THREE.Vector3[], widthPx = 2.0, dashed = false, color = PRODUCT_DIMENSION_COLOR) {
    const line = this.makeLocalLine(parent, points, color, 0.92, dashed, true, widthPx);
    line.renderOrder = 25;
    return line;
  }

  private addLabelledMeasurementLine({
    parent,
    start,
    end,
    text,
    color = DIMENSION_COLOR,
    widthPx = 1.5,
    dashed = false,
    overlay = true,
    labelHeight = themeMetric('dimension-label-height'),
    labelStyle = 'world',
    keepUpright = true,
    textOutlinePx = themeMetric('dimension-text-outline-px'),
    targetPixelHeight = themeMetric('dimension-label-screen-px')
  }: {
    parent?: THREE.Group;
    start: THREE.Vector3;
    end: THREE.Vector3;
    text: string;
    color?: number;
    widthPx?: number;
    dashed?: boolean;
    overlay?: boolean;
    labelHeight?: number;
    labelStyle?: 'world' | 'camera-card';
    keepUpright?: boolean;
    textOutlinePx?: number;
    targetPixelHeight?: number;
  }) {
    const label = labelStyle === 'camera-card'
      ? this.createProductDimensionBadge(text, labelHeight, textOutlinePx, targetPixelHeight)
      : this.createMeasurementTextPlane(text, labelHeight, textOutlinePx, targetPixelHeight);
    const worldWidth = typeof label.userData.labelWorldWidth === 'number' ? label.userData.labelWorldWidth : labelHeight * 1.4;
    const length = start.distanceTo(end);
    const gap = Math.min(Math.max(worldWidth + 0.055, 0.12), length * 0.7);
    const destination = parent ?? this.helperGroup;
    const draw = (points: THREE.Vector3[]) => {
      if (parent) this.makeLocalLine(parent, points, color, 0.92, dashed, overlay, widthPx);
      else this.makeLine(points, color, 0.92, dashed, overlay, widthPx);
    };

    if (length > gap + 0.04) {
      const direction = end.clone().sub(start).normalize();
      const mid = start.clone().add(end).multiplyScalar(0.5);
      const firstEnd = mid.clone().addScaledVector(direction, -gap / 2);
      const secondStart = mid.clone().addScaledVector(direction, gap / 2);
      draw([start, firstEnd]);
      draw([secondStart, end]);
    } else {
      draw([start, end]);
    }

    label.position.copy(start).add(end).multiplyScalar(0.5);
    if (labelStyle === 'world') {
      this.orientMeasurementLabel(label, start, end);
      if (keepUpright) {
        label.userData.keepMeasurementUpright = true;
        label.userData.measurementStart = start.clone();
        label.userData.measurementEnd = end.clone();
        label.userData.measurementBaseQuaternion = label.quaternion.clone();
        label.userData.measurementFlipped = false;
      }
    }
    destination.add(label);
    return label;
  }

  /**
   * World labels remain attached to the dimension direction. They never billboard;
   * the only camera-dependent change is a 180° baseline flip handled below so text
   * is not read upside-down when the orbit camera crosses to the opposite side.
   */
  private orientMeasurementLabel(label: THREE.Object3D, start: THREE.Vector3, end: THREE.Vector3) {
    const xAxis = end.clone().sub(start).normalize();
    if (xAxis.lengthSq() < 1e-8) return;

    // PlaneGeometry's local X is the text baseline and local Z is its face normal.
    // Horizontal room/spacing annotations face upward; near-vertical labels use a
    // fixed horizontal face. Neither orientation tracks the camera.
    let zAxis = Math.abs(xAxis.y) > 0.78
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);
    if (Math.abs(zAxis.dot(xAxis)) > 0.96) zAxis = new THREE.Vector3(1, 0, 0);

    const yAxis = zAxis.clone().cross(xAxis).normalize();
    zAxis = xAxis.clone().cross(yAxis).normalize();
    const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    label.quaternion.setFromRotationMatrix(basis);
  }

  private createMeasurementTextPlane(text: string, height: number, outlinePx: number = themeMetric('dimension-text-outline-px'), targetPixelHeight: number = themeMetric('dimension-label-screen-px')) {
    const fontPx = themeMetric('dimension-texture-font-px');
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `700 ${fontPx}px Inter, system-ui, sans-serif`;
    const measuredWidth = Math.ceil(probe.measureText(text).width);
    const paddingX = 14 + outlinePx * 2;
    const paddingY = 10 + outlinePx * 2;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(72, measuredWidth + paddingX * 2);
    canvas.height = Math.max(84, fontPx + paddingY * 2);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `700 ${fontPx}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const textHex = `#${DIMENSION_TEXT_COLOR.toString(16).padStart(6, '0')}`;
    ctx.strokeStyle = 'rgba(255,255,255,0.96)';
    ctx.lineWidth = outlinePx;
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2 + 1);
    ctx.fillStyle = textHex;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const aspect = canvas.width / canvas.height;
    const geometry = new THREE.PlaneGeometry(aspect, 1);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    const plane = new THREE.Mesh(geometry, material);
    plane.scale.set(height, height, 1);
    plane.userData.measurementLabel = true;
    plane.userData.labelAspect = aspect;
    plane.userData.labelWorldWidth = height * aspect;
    plane.userData.targetPixelHeight = targetPixelHeight;
    plane.renderOrder = 30;
    return plane;
  }

  /** Product dimensions intentionally use a Sprite: the compact card always faces
   * the camera while its measured line/bounding-box geometry remains world-aligned. */
  private createProductDimensionBadge(text: string, height: number, outlinePx: number = themeMetric('dimension-text-outline-px'), targetPixelHeight: number = themeMetric('product-dimension-label-screen-px')) {
    const fontPx = themeMetric('dimension-texture-font-px');
    const paddingX = themeMetric('product-dimension-card-padding-x-px');
    const paddingY = themeMetric('product-dimension-card-padding-y-px');
    const radius = themeMetric('product-dimension-card-radius-px');
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `700 ${fontPx}px Inter, system-ui, sans-serif`;
    const measuredWidth = Math.ceil(probe.measureText(text).width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(88, measuredWidth + paddingX * 2 + outlinePx * 2);
    canvas.height = Math.max(84, fontPx + paddingY * 2 + outlinePx * 2);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cardInset = 2;
    ctx.beginPath();
    ctx.roundRect(cardInset, cardInset, canvas.width - cardInset * 2, canvas.height - cardInset * 2, radius);
    ctx.fillStyle = `#${DIMENSION_CARD_BACKGROUND.toString(16).padStart(6, '0')}f2`;
    ctx.fill();
    ctx.strokeStyle = `#${DIMENSION_CARD_BORDER.toString(16).padStart(6, '0')}`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = `700 ${fontPx}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.96)';
    ctx.lineWidth = outlinePx;
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2 + 1);
    ctx.fillStyle = `#${DIMENSION_TEXT_COLOR.toString(16).padStart(6, '0')}`;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const aspect = canvas.width / canvas.height;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(height * aspect, height, 1);
    sprite.userData.measurementLabel = true;
    sprite.userData.labelAspect = aspect;
    sprite.userData.labelWorldWidth = height * aspect;
    sprite.userData.targetPixelHeight = targetPixelHeight;
    sprite.renderOrder = 31;
    return sprite;
  }

  /**
   * Keep world-oriented room/spacing text readable as the orbit camera crosses a
   * dimension line. This flips only the text baseline by 180°; it does not make
   * the plane face the camera, so the annotation remains geometrically static.
   */
  private updateMeasurementLabelOrientation() {
    const projectedStart = new THREE.Vector3();
    const projectedEnd = new THREE.Vector3();
    this.camera.updateMatrixWorld();

    this.helperGroup.traverse((object) => {
      if (!object.userData.keepMeasurementUpright) return;
      const start = object.userData.measurementStart as THREE.Vector3 | undefined;
      const end = object.userData.measurementEnd as THREE.Vector3 | undefined;
      const base = object.userData.measurementBaseQuaternion as THREE.Quaternion | undefined;
      if (!start || !end || !base) return;

      projectedStart.copy(start).project(this.camera);
      projectedEnd.copy(end).project(this.camera);
      const screenDx = projectedEnd.x - projectedStart.x;
      let flipped = Boolean(object.userData.measurementFlipped);
      // Small hysteresis prevents labels rapidly switching when their baseline is
      // almost perfectly vertical on screen.
      if (screenDx > 0.012) flipped = false;
      else if (screenDx < -0.012) flipped = true;

      object.quaternion.copy(base);
      if (flipped) object.rotateZ(Math.PI);
      object.userData.measurementFlipped = flipped;
    });
  }

  /**
   * Keep labels legible while dollying without changing the world orientation of
   * room/spacing planes. Camera-facing product Sprite cards use the same size rule.
   */
  private updateMeasurementLabelScale() {
    this.camera.updateMatrixWorld();
    const viewportHeight = Math.max(1, this.container.clientHeight);
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const cameraSpace = new THREE.Vector3();
    const worldPosition = new THREE.Vector3();
    const minHeight = themeMetric('dimension-label-min-world-height');
    const maxHeight = themeMetric('dimension-label-max-world-height');

    this.helperGroup.updateWorldMatrix(true, true);
    this.helperGroup.traverse((object) => {
      if (!object.userData.measurementLabel) return;
      object.getWorldPosition(worldPosition);
      cameraSpace.copy(worldPosition).applyMatrix4(this.camera.matrixWorldInverse);
      const depth = Math.max(0.12, -cameraSpace.z);
      const worldPerPixel = (2 * depth * Math.tan(halfFov)) / viewportHeight;
      const targetPixels = Number(object.userData.targetPixelHeight) || themeMetric('dimension-label-screen-px');
      const worldHeight = THREE.MathUtils.clamp(worldPerPixel * targetPixels, minHeight, maxHeight);
      const aspect = Number(object.userData.labelAspect) || 1;
      if (object instanceof THREE.Sprite) object.scale.set(worldHeight * aspect, worldHeight, 1);
      else object.scale.set(worldHeight, worldHeight, 1);
    });
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
        opacity: region.side === 'front' ? 0.18 : 0.13,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const plane = new THREE.Mesh(geo, mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(localCx, 0, localCz);
      parent.add(plane);

      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(region.width, region.depth)),
        new THREE.LineDashedMaterial({ color: CLEARANCE_EDGE_COLOR, transparent: true, opacity: 0.96, dashSize: 0.08, gapSize: 0.045 })
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
      const dimensionY = hidden ? 0.052 : snapshot.room.height + 0.045;
      const start = new THREE.Vector3(wall.start.x + outward.x * offset, dimensionY, wall.start.z + outward.z * offset);
      const end = new THREE.Vector3(wall.end.x + outward.x * offset, dimensionY, wall.end.z + outward.z * offset);

      this.addLabelledMeasurementLine({
        start,
        end,
        text: this.annotationLength(wall.length, system),
        color: DIMENSION_COLOR,
        widthPx: 1.55,
        dashed: false,
        overlay: true,
        labelHeight: themeMetric('dimension-label-height')
      });

      const witness = outward.clone().multiplyScalar(0.068);
      this.makeLine([start.clone().sub(witness), start.clone().add(witness)], DIMENSION_COLOR, 0.95, false, true, 1.3);
      this.makeLine([end.clone().sub(witness), end.clone().add(witness)], DIMENSION_COLOR, 0.95, false, true, 1.3);

      const tickDirection = tangent.clone().add(outward).normalize().multiplyScalar(0.052);
      this.makeLine([start.clone().sub(tickDirection), start.clone().add(tickDirection)], DIMENSION_COLOR, 0.95, false, true, 1.45);
      this.makeLine([end.clone().sub(tickDirection), end.clone().add(tickDirection)], DIMENSION_COLOR, 0.95, false, true, 1.45);
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
    const y0 = 0.028;
    const y1 = p.height;
    const lineWidth = 1.35;

    const bfl = new THREE.Vector3(x0, y0, z1);
    const bfr = new THREE.Vector3(x1, y0, z1);
    const bbl = new THREE.Vector3(x0, y0, z0);
    const bbr = new THREE.Vector3(x1, y0, z0);
    const tfl = new THREE.Vector3(x0, y1, z1);
    const tfr = new THREE.Vector3(x1, y1, z1);
    const tbl = new THREE.Vector3(x0, y1, z0);
    const tbr = new THREE.Vector3(x1, y1, z0);

    const edge = (a: THREE.Vector3, b: THREE.Vector3) => this.makeLocalMeasurementLine(parent, [a, b], lineWidth, true, PRODUCT_DIMENSION_COLOR);
    edge(bfr, bbr);
    edge(bbl, bbr);
    edge(tfl, tfr);
    edge(tfr, tbr);
    edge(tbr, tbl);
    edge(tbl, tfl);
    edge(bbr, tbr);
    edge(bbl, tbl);
    edge(bfr, tfr);

    this.addLabelledMeasurementLine({
      parent,
      start: bfl,
      end: bfr,
      text: this.annotationLength(p.width, system),
      color: PRODUCT_DIMENSION_COLOR,
      widthPx: lineWidth,
      dashed: true,
      overlay: true,
      labelHeight: themeMetric('product-dimension-label-height'),
      labelStyle: 'camera-card',
      targetPixelHeight: themeMetric('product-dimension-label-screen-px')
    });
    this.addLabelledMeasurementLine({
      parent,
      start: bbl,
      end: bfl,
      text: this.annotationLength(p.depth, system),
      color: PRODUCT_DIMENSION_COLOR,
      widthPx: lineWidth,
      dashed: true,
      overlay: true,
      labelHeight: themeMetric('product-dimension-label-height'),
      labelStyle: 'camera-card',
      targetPixelHeight: themeMetric('product-dimension-label-screen-px')
    });
    this.addLabelledMeasurementLine({
      parent,
      start: bfl,
      end: tfl,
      text: this.annotationLength(p.height, system),
      color: PRODUCT_DIMENSION_COLOR,
      widthPx: lineWidth,
      dashed: true,
      overlay: true,
      labelHeight: themeMetric('product-dimension-label-height'),
      labelStyle: 'camera-card',
      targetPixelHeight: themeMetric('product-dimension-label-screen-px')
    });

    this.helperGroup.add(parent);
  }

  private addSpacingDimensions(selected: PlacedObject, snapshot: SceneSnapshot, system: MeasurementSystem) {
    const others = snapshot.objects.filter((object) => object.id !== selected.id);
    for (const measurement of spacingMeasurements(selected, snapshot.room, others)) {
      const origin = new THREE.Vector3(measurement.origin.x, 0.075, measurement.origin.z);
      const end = new THREE.Vector3(measurement.end.x, 0.075, measurement.end.z);
      this.addLabelledMeasurementLine({
        start: origin,
        end,
        text: formatLength(measurement.distance, system),
        color: SPACING_COLOR,
        widthPx: 1.65,
        dashed: false,
        overlay: true,
        labelHeight: themeMetric('dimension-label-height'),
        textOutlinePx: themeMetric('spacing-dimension-text-outline-px')
      });
      const perpendicular = new THREE.Vector3(-measurement.direction.z, 0, measurement.direction.x).multiplyScalar(0.05);
      this.makeLine([origin.clone().sub(perpendicular), origin.clone().add(perpendicular)], SPACING_COLOR, 0.92, false, true, 1.35);
      this.makeLine([end.clone().sub(perpendicular), end.clone().add(perpendicular)], SPACING_COLOR, 0.92, false, true, 1.35);
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
    this.updateMeasurementLabelOrientation();
    this.updateMeasurementLabelScale();
    this.composer.render();
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
