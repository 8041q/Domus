import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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
import { clearanceRegions, resolvePlacement, spacingMeasurements, type SpacingMeasurement } from '../core/placement';
import { BASEBOARD_STYLES, glazingAreas, isSunGlazedOpening } from '../core/architecturalStyles';
import { getRoomWalls, pointInRoom, roomBounds, wallPoint, wallProjectionDistance } from '../core/roomGeometry';
import { effectiveSunAzimuth } from '../core/sun';
import { formatLength } from '../core/units';
import type { FloorFinish, PlanCameraView, MeasurementSystem, PlannerSnapshot, PlacedObject, RoomOpening, RoomWallSegment, SnapFeedback, Vec2 } from '../core/types';
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
  cameraViewChanged?: (view: PlanCameraView) => void;
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
const SCENE_LAYER = 0;
const ANNOTATION_TEXT_LAYER = 1;
const TRIM_COLOR = 0xffffff;
const JUNCTION_COLOR = 0xffffff;
const WALL_THICKNESS = 0.05;
const FLOOR_THICKNESS = WALL_THICKNESS;
const CEILING_THICKNESS = WALL_THICKNESS;

// Cutaway thresholds. `facing` is the horizontal dot product between a
// wall's outward normal and the direction from that wall to the camera. Smaller
// ENTER values make side walls disappear sooner at shallow viewing angles. EXIT
// stays lower than ENTER to prevent flicker while orbiting around the threshold.
const CUTAWAY_ENTER_FACING = 0.02;
const CUTAWAY_EXIT_FACING = 0.005;

// Automatic ceiling behavior for the free Cutaway view camera. When the camera is
// almost level with its target (small elevation angle), the room reads as an
// enclosed eye-level view, so show the ceiling. The threshold is intentionally
// tight: the camera must be nearly horizontal. EXIT stays slightly wider to avoid
// flicker around the boundary. Side presets force the ceiling on separately.
const CEILING_ENTER_ELEVATION = THREE.MathUtils.degToRad(4);
const CEILING_EXIT_ELEVATION = THREE.MathUtils.degToRad(5);

type DomusExportCategory = 'Walls' | 'Floors' | 'Frames' | 'Ceiling' | 'Furniture';

interface DomusExportSource {
  object: THREE.Object3D;
  logicalRoot: boolean;
}

interface LoadedFloorMaps {
  color: THREE.Texture | null;
  normal: THREE.Texture | null;
  height: THREE.Texture | null;
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
  private floorGroup = new THREE.Group();
  private wallsGroup = new THREE.Group();
  private ceilingGroup = new THREE.Group();
  private architecturalShadeGroup = new THREE.Group();
  private lightFixtureGroup = new THREE.Group();
  private interiorLightGroup = new THREE.Group();
  private daylightGroup = new THREE.Group();
  private sunsetGroup = new THREE.Group();
  private sunsetLights: [THREE.DirectionalLight, THREE.DirectionalLight] | null = null;
  private lastSunAnglesKey = '';
  private contactShadowGroup = new THREE.Group();
  private objectGroup = new THREE.Group();
  private helperGroup = new THREE.Group();
  private objectModels = new Map<string, THREE.Group>();
  private contactShadows = new Map<string, THREE.Group>();
  private dragging: {
    id: string;
    before: PlannerSnapshot;
    snap: SnapFeedback;
    startClientX: number;
    startClientY: number;
    startX: number;
    startZ: number;
    screenRight: Vec2;
    screenUp: Vec2;
    worldPerPixelX: number;
    worldPerPixelY: number;
  } | null = null;
  private openingDragging: { id: string; before: PlannerSnapshot } | null = null;
  private hoverOpeningId: string | null = null;
  private resizeObserver: ResizeObserver;
  private animationFrame = 0;
  private disposed = false;
  private controlsInteracting = false;
  private controlsInteractionStartDirection = new THREE.Vector3();
  private lastRoomKey = '';
  private lastOpeningsKey = '';
  private lastOpeningHighlightKey = '';
  private lastHelperKey = '';
  private lastSpacingHelperKey = '';
  private lastSnapHelperKey = '';
  private currentCameraView: PlanCameraView = 'perspective';
  private ceilingVisible = false;
  private hemiLight: THREE.HemisphereLight;
  private ambientLight: THREE.AmbientLight;
  private mainLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;
  private wallHiddenState = new Map<string, boolean>();
  private floorTextureReady: Promise<void> = Promise.resolve();
  private floorMaterial: THREE.MeshStandardMaterial | null = null;
  private floorFinishRequest = 0;
  private lastFloorFinish: FloorFinish | null = null;
  private floorMapCache = new Map<FloorFinish, Promise<LoadedFloorMaps>>();
  private floorMapResults = new Map<FloorFinish, LoadedFloorMaps>();
  private floorMapAssets = new Set<THREE.Texture>();
  private spacingDimensionGroup: THREE.Group | null = null;
  private spacingDimensionLines: LineSegments2 | null = null;
  private spacingDimensionLabels = new Map<SpacingMeasurement['side'], THREE.Mesh>();

  constructor(private container: HTMLElement, private bridge: SceneBridge, private options: SceneOptions) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    const pixelRatio = Math.min(window.devicePixelRatio, 1.6);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.container.appendChild(this.renderer.domElement);

    // IKEA Kreativ uses a neutral studio field around the cutaway room. Keeping this
    // noticeably darker than the shell is important: white chamfers and selection
    // annotations should remain readable without making the room itself look greyed out.
    this.scene.background = new THREE.Color(0xd2d2d2);
    // Start open by construction. The first camera evaluation may opt into the
    // ceiling, but there is never a one-frame closed-room flash while Plan Room mounts.
    this.ceilingGroup.visible = false;
    this.scene.add(this.floorGroup, this.wallsGroup, this.ceilingGroup, this.architecturalShadeGroup, this.lightFixtureGroup, this.interiorLightGroup, this.daylightGroup, this.sunsetGroup, this.contactShadowGroup, this.objectGroup, this.helperGroup);

    // Screen-space silhouette outlining matches the reference planner: the selected
    // product gets one crisp yellow contour, independent of its component meshes.
    // Only selected furniture needs the off-screen outline path. The ordinary
    // room uses the renderer's native MSAA, avoiding a fullscreen filter and its
    // softened texture detail on every camera movement.
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

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minPolarAngle = 0.01;
    this.controls.minDistance = 1.8;
    this.controls.maxDistance = 20;
    this.controls.screenSpacePanning = false;

    // OrbitControls swaps rotate/pan whenever Shift is held. Shift already has an
    // application-level meaning here (free furniture movement), so keep the normal
    // mouse mapping stable: LMB = orbit and RMB = pan even while Shift is down.
    // This only changes the mouse-action decision inside OrbitControls; furniture
    // pointer-downs still disable controls before OrbitControls sees the gesture.
    const controlsInternal = this.controls as OrbitControls & { _onMouseDown?: (event: PointerEvent) => void };
    const orbitMouseDown = controlsInternal._onMouseDown;
    if (orbitMouseDown) {
      controlsInternal._onMouseDown = (event: PointerEvent) => {
        if (!event.shiftKey) {
          orbitMouseDown(event);
          return;
        }
        const unmodifiedEvent = new Proxy(event, {
          get(target, property) {
            if (property === 'shiftKey') return false;
            return Reflect.get(target, property, target);
          }
        }) as PointerEvent;
        orbitMouseDown(unmodifiedEvent);
      };
    }

    this.controls.addEventListener('change', this.onControlsChange);
    this.controls.addEventListener('start', this.onControlsStart);
    this.controls.addEventListener('end', this.onControlsEnd);

    // Broad bounced light keeps the architectural shell legible. A single
    // directional shadow map supplies contact and furniture shadows; fixtures
    // remain visual accents instead of carrying the room's entire exposure.
    this.hemiLight = new THREE.HemisphereLight(0xf7f8fa, 0xb8b4ae, 1.1);
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    this.mainLight = new THREE.DirectionalLight(0xfff6eb, 0.9);
    this.mainLight.position.set(4.2, 7.2, 4.8);
    this.mainLight.castShadow = true;

    // Only controls darkness of projected shadow.Does NOT change room illumination.
    this.mainLight.shadow.intensity = 0.6;

    this.mainLight.shadow.mapSize.set(1024, 1024);
    this.mainLight.shadow.camera.near = 0.25;
    this.mainLight.shadow.camera.far = 34;
    this.mainLight.shadow.bias = -0.00012;
    this.mainLight.shadow.normalBias = 0.012;
    this.mainLight.shadow.radius = 6;
    this.fillLight = new THREE.DirectionalLight(0xe9edf0, 0.3);
    this.fillLight.position.set(-4.5, 5.2, -4.2);
    this.scene.add(this.hemiLight, this.ambientLight, this.mainLight, this.mainLight.target, this.fillLight);

    // Capture pointer-down before OrbitControls. Furniture drags disable controls
    // before they enter a camera gesture. Shift+empty-space is allowed through so
    // the user can orbit without clearing the active furniture selection.
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.resetCamera();
    this.renderFromState();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.floorFinishRequest += 1;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.controls.removeEventListener('change', this.onControlsChange);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.controls.removeEventListener('end', this.onControlsEnd);
    this.controls.dispose();
    this.disposeGroup(this.floorGroup);
    this.disposeGroup(this.wallsGroup);
    this.disposeGroup(this.ceilingGroup);
    this.disposeGroup(this.architecturalShadeGroup);
    this.disposeGroup(this.lightFixtureGroup);
    this.disposeGroup(this.interiorLightGroup);
    this.disposeGroup(this.daylightGroup);
    this.disposeSunsetRig();
    this.disposeGroup(this.contactShadowGroup);
    this.disposeGroup(this.objectGroup);
    this.disposeGroup(this.helperGroup);
    for (const texture of this.floorMapAssets) texture.dispose();
    this.floorMapAssets.clear();
    this.floorMapCache.clear();
    this.floorMapResults.clear();
    this.outlinePass.dispose();
    this.composer.dispose();
    this.scene.environment = null;
    this.floorMaterial = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    if (this.renderer.domElement.parentNode === this.container) this.container.removeChild(this.renderer.domElement);
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
      delete object.userData.stableTrimColor;

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
    // Export semantic data, not the current Cutaway view. Camera cutaways,
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
    // Export support is only loaded when requested, keeping the normal 3D path smaller.
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
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
    // Aim at the room volume centre rather than below it. This keeps the room
    // visually centered in both perspective and orthographic-like preset views.
    const targetY = room.height * 0.5;
    const isCutaway = view === 'perspective';
    this.camera.fov = isCutaway ? 15 : 32;
    this.camera.updateProjectionMatrix();
    const distance = Math.max(3.8, size * (isCutaway ? 4.0 : 1.3));
    this.controls.maxDistance = Math.max(20, size * 5.5);
    this.controls.target.set(cx, targetY, cz);

    switch (view) {
      case 'top':
        // Keep a tiny Z-only offset so lookAt/OrbitControls never hit the exact
        // pole singularity. Offsetting both X and Z rotated the plan diagonally.
        this.camera.position.set(cx, Math.max(room.height + 4, size * 2.0), cz + 0.01);
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
        this.camera.position.set(bounds.maxX + size * 2.6, Math.max(3.8, size * 2.8), bounds.maxZ + size * 2.6);
        break;
    }
    this.controls.update();
    this.updateCeilingVisibility();
    this.updateCutawayWalls(true);
    this.requestRender();
  }

  renderFromState() {
    if (this.disposed) return;
    const snapshot = this.bridge.getSnapshot();
    const { floorFinish, ...roomWithoutFloorFinish } = snapshot.room;
    const { sunAzimuth, sunElevation, ...lightingWithoutSunAngles } = roomWithoutFloorFinish.lighting;
    const roomKey = JSON.stringify({ ...roomWithoutFloorFinish, lighting: lightingWithoutSunAngles });
    const openingsKey = JSON.stringify(snapshot.openings);
    let architectureChanged = false;
    if (roomKey !== this.lastRoomKey) {
      this.rebuildRoom(snapshot);
      architectureChanged = true;
      this.lastRoomKey = roomKey;
      this.lastFloorFinish = floorFinish;
      this.lastOpeningsKey = openingsKey;
      const bounds = roomBounds(snapshot.room.vertices);
      this.controls.target.set((bounds.minX + bounds.maxX) / 2, snapshot.room.height * 0.5, (bounds.minZ + bounds.maxZ) / 2);
      this.updateShadowBounds(snapshot);
    } else if (floorFinish !== this.lastFloorFinish) {
      // Keep ordinary floor finish changes decoupled from geometry rebuilds. The
      // current floor remains visible until the requested maps have settled. When
      // the baseboard is set to Materials, however, its finish is intentionally
      // linked to the floor, so rebuild the wall group immediately with the new
      // floor definition as well. Cached maps apply synchronously and uncached maps
      // finish loading on the replacement baseboard material independently.
      this.requestFloorFinish(floorFinish);
      if (snapshot.room.baseboardMaterial === 'materials') {
        this.rebuildWalls(snapshot);
        architectureChanged = true;
      }
      this.lastFloorFinish = floorFinish;
    } else if (openingsKey !== this.lastOpeningsKey) {
      this.rebuildWalls(snapshot);
      this.rebuildWindowDaylighting(snapshot);
      this.rebuildSunset(snapshot);
      architectureChanged = true;
      this.lastOpeningsKey = openingsKey;
    }
    this.syncSunsetAngles(snapshot);
    this.syncObjects(snapshot);
    this.syncOpeningHighlight(snapshot);
    this.syncHelperTransforms(snapshot);
    const helperKey = this.helperStateKey(snapshot);
    if (helperKey !== this.lastHelperKey) {
      this.rebuildHelpers(snapshot);
      this.lastHelperKey = helperKey;
      this.lastSpacingHelperKey = this.spacingHelperStateKey(snapshot);
      this.lastSnapHelperKey = this.snapHelperStateKey(snapshot);
    } else {
      const snapKey = this.snapHelperStateKey(snapshot);
      if (snapKey !== this.lastSnapHelperKey) {
        this.rebuildSnapHelpers(snapshot);
        this.lastSnapHelperKey = snapKey;
      }

      const spacingKey = this.spacingHelperStateKey(snapshot);
      if (spacingKey !== this.lastSpacingHelperKey) {
        // Spacing helpers are persistent now: line buffers, materials and canvases
        // are reused while dragging. Updating them at the same cadence as furniture
        // keeps the guides visually attached without reintroducing allocation/texture
        // churn on every pointer move.
        this.syncSpacingHelpers(snapshot);
        this.lastSpacingHelperKey = spacingKey;
      }
    }
    // Room-lighting toggles are stored in the room state but may change without
    // requiring full geometry rebuilds. Keep the explicit lighting rig in sync here.
    this.applyRoomLighting(snapshot);
    this.updateShadowBounds(snapshot);
    this.updateLightFixtureVisibility(snapshot);
    // Cutaway visibility depends on architecture/camera, not furniture/selection state.
    if (architectureChanged) this.updateCutawayWalls(true);
    this.requestRender();
  }

  private updateShadowBounds(snapshot: PlannerSnapshot) {
    const bounds = roomBounds(snapshot.room.vertices);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const span = Math.max(bounds.width, bounds.depth, 4);
    const radius = span * 0.72 + 1.1;
    this.mainLight.target.position.set(cx, 0.45, cz);
    // Keep the shadow source below the ceiling in every lighting mode. Its
    // illumination is a stand-in for indoor bounce, not exterior sunlight.
    this.mainLight.position.set(cx, snapshot.room.height - 0.12, cz);
    this.fillLight.position.set(cx - span * 0.28, snapshot.room.height - 0.35, cz - span * 0.24);
    const shadow = this.mainLight.shadow.camera as THREE.OrthographicCamera;
    shadow.left = -radius;
    shadow.right = radius;
    shadow.top = radius;
    shadow.bottom = -radius;
    shadow.near = 0.25;
    shadow.far = Math.max(8, snapshot.room.height + span * 1.6);
    shadow.updateProjectionMatrix();
    this.mainLight.shadow.needsUpdate = true;
  }

  private disposeGroup(group: THREE.Group) {
    const disposedTextures = new Set<THREE.Texture>();
    const disposedMaterials = new Set<THREE.Material>();
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposeMaterial = (material: THREE.Material) => {
      if (disposedMaterials.has(material)) return;
      disposedMaterials.add(material);
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
      if (renderable.geometry && !disposedGeometries.has(renderable.geometry)) {
        disposedGeometries.add(renderable.geometry);
        renderable.geometry.dispose();
      }
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
    sideMaterialIndex = 0,
    topSubdivisionMetres = 0
  ) {
    const count = Math.min(topVertices.length, bottomVertices.length);
    const positions: number[] = [];
    const uvs: number[] = [];

    const pushVertex = (point: Vec2, y: number) => {
      positions.push(point.x, y, point.z);
      // World-space planar UVs: one UV unit equals one metre. Texture.repeat then
      // converts that into each material's documented physical tile size.
      uvs.push(point.x, point.z);
    };
    const pushTriangle = (a: Vec2, b: Vec2, c: Vec2, y: number) => {
      pushVertex(a, y);
      pushVertex(b, y);
      pushVertex(c, y);
    };
    const lerpTrianglePoint = (a: Vec2, b: Vec2, c: Vec2, i: number, j: number, segments: number): Vec2 => {
      const u = i / segments;
      const v = j / segments;
      return {
        x: a.x + (b.x - a.x) * u + (c.x - a.x) * v,
        z: a.z + (b.z - a.z) * u + (c.z - a.z) * v
      };
    };
    const pushSubdividedTopTriangle = (a: Vec2, b: Vec2, c: Vec2) => {
      const longestEdge = Math.max(
        Math.hypot(b.x - a.x, b.z - a.z),
        Math.hypot(c.x - b.x, c.z - b.z),
        Math.hypot(a.x - c.x, a.z - c.z)
      );
      const segments = topSubdivisionMetres > 0
        ? Math.max(1, Math.min(96, Math.ceil(longestEdge / topSubdivisionMetres)))
        : 1;

      for (let i = 0; i < segments; i += 1) {
        for (let j = 0; j < segments - i; j += 1) {
          const p00 = lerpTrianglePoint(a, b, c, i, j, segments);
          const p10 = lerpTrianglePoint(a, b, c, i + 1, j, segments);
          const p01 = lerpTrianglePoint(a, b, c, i, j + 1, segments);
          pushTriangle(p00, p10, p01, topY);

          if (i + j < segments - 1) {
            const p11 = lerpTrianglePoint(a, b, c, i + 1, j + 1, segments);
            pushTriangle(p10, p11, p01, topY);
          }
        }
      }
    };

    const topContour = topVertices.slice(0, count).map((v) => new THREE.Vector2(v.x, v.z));
    const bottomContour = bottomVertices.slice(0, count).map((v) => new THREE.Vector2(v.x, v.z));

    const topStart = positions.length / 3;
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(topContour, [])) {
      // Room contours are authored counter-clockwise in X/Z, which points
      // their raw triangle normals downward in Y-up space. Reverse the top winding
      // so normal mapping and vertex displacement operate on an upward floor normal.
      pushSubdividedTopTriangle(topVertices[a], topVertices[c], topVertices[b]);
    }
    const topCount = positions.length / 3 - topStart;

    const bottomStart = positions.length / 3;
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(bottomContour, [])) {
      pushTriangle(bottomVertices[a], bottomVertices[b], bottomVertices[c], bottomY);
    }
    const bottomCount = positions.length / 3 - bottomStart;

    const sideStart = positions.length / 3;
    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;
      pushVertex(topVertices[i], topY);
      pushVertex(topVertices[j], topY);
      pushVertex(bottomVertices[j], bottomY);
      pushVertex(topVertices[i], topY);
      pushVertex(bottomVertices[j], bottomY);
      pushVertex(bottomVertices[i], bottomY);
    }
    const sideCount = positions.length / 3 - sideStart;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.addGroup(topStart, topCount, topMaterialIndex);
    geometry.addGroup(bottomStart, bottomCount, bottomMaterialIndex);
    geometry.addGroup(sideStart, sideCount, sideMaterialIndex);
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
  private configureFloorMap(
    texture: THREE.Texture,
    name: string,
    textureWidthMetres: number,
    srgb: boolean,
    wrapMode: 'repeat' | 'mirror' = 'repeat',
    anisotropy = 8
  ) {
    texture.name = name;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;

    // Carpets mirror at their mismatched image edges. Directional wood and
    // terrazzo use ordinary repeat wrapping.
    const wrapping = wrapMode === 'mirror'
      ? THREE.MirroredRepeatWrapping
      : THREE.RepeatWrapping;
    texture.wrapS = wrapping;
    texture.wrapT = wrapping;

    const repeatsPerMetre = 1 / Math.max(0.1, textureWidthMetres);
    texture.repeat.set(repeatsPerMetre, repeatsPerMetre);

    // Explicit trilinear mip filtering is important for high-frequency carpet
    // fibres when the floor is viewed from normal planner camera distances.
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(anisotropy, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  }

  private async loadFloorMap(
    url: string,
    name: string,
    textureWidthMetres: number,
    srgb: boolean,
    wrapMode: 'repeat' | 'mirror' = 'repeat',
    anisotropy = 8
  ) {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    try {
      const texture = await loader.loadAsync(url);
      if (this.disposed) {
        texture.dispose();
        return null;
      }
      this.floorMapAssets.add(texture);
      return this.configureFloorMap(texture, name, textureWidthMetres, srgb, wrapMode, anisotropy);
    } catch {
      return null;
    }
  }

  /** Load each finish once; scene rebuilds clone the already-loaded images instantly. */
  private loadFloorFinishMaps(definition: FloorFinishDefinition) {
    const cached = this.floorMapCache.get(definition.id);
    if (cached) return cached;

    const wrapMode = definition.wrapMode ?? 'repeat';
    const anisotropy = definition.anisotropy ?? 8;
    const load = Promise.all([
      this.loadFloorMap(definition.maps.color, `${definition.name} Base Color`, definition.textureWidthMetres, true, wrapMode, anisotropy),
      definition.useNormalMap === false
        ? Promise.resolve(null)
        : this.loadFloorMap(definition.maps.normal, `${definition.name} Normal`, definition.textureWidthMetres, false, wrapMode, anisotropy),
      definition.useHeightMap === false
        ? Promise.resolve(null)
        : this.loadFloorMap(definition.maps.height, `${definition.name} Height`, definition.textureWidthMetres, false, wrapMode, anisotropy),
      definition.useRoughnessMap === false
        ? Promise.resolve(null)
        : this.loadFloorMap(definition.maps.roughness, `${definition.name} Roughness`, definition.textureWidthMetres, false, wrapMode, anisotropy)
    ]).then(([color, normal, height, roughness]) => {
      if (this.disposed) return { color: null, normal: null, height: null, roughness: null };
      const maps = { color, normal, height, roughness };
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
    const maps = [material.map, material.normalMap, material.displacementMap, material.roughnessMap];
    for (const texture of maps) texture?.dispose();
    material.map = null;
    material.normalMap = null;
    material.displacementMap = null;
    material.roughnessMap = null;
  }

  private applyFloorMaps(material: THREE.MeshStandardMaterial, definition: FloorFinishDefinition, maps: LoadedFloorMaps) {
    this.disposeFloorMaterialMaps(material);

    material.map = this.cloneFloorMap(maps.color);
    material.normalMap = definition.useNormalMap === false
      ? null
      : this.cloneFloorMap(maps.normal);

    const useHeightMap = definition.useHeightMap !== false && definition.heightScale > 0;
    material.displacementMap = useHeightMap
      ? this.cloneFloorMap(maps.height)
      : null;
    material.displacementScale = material.displacementMap ? definition.heightScale : 0;
    // Centre authored grayscale displacement around the architectural floor plane
    // instead of lifting the whole slab by the map's average value.
    material.displacementBias = material.displacementMap
      ? -definition.heightScale * 0.5
      : 0;

    material.roughnessMap = definition.useRoughnessMap === false
      ? null
      : this.cloneFloorMap(maps.roughness);
    material.color.set(maps.color ? 0xffffff : definition.fallbackColor);
    material.normalScale.set(
      material.normalMap ? definition.normalScale : 0,
      material.normalMap ? definition.normalScale : 0
    );
    material.roughness = material.roughnessMap ? 1 : definition.fallbackRoughness;
    material.metalness = 0;
    material.envMapIntensity = definition.envMapIntensity;
    material.name = `Floor - ${definition.name}`;

    // Finish changes reuse this same material instance, so shader customisation must
    // be switched here rather than only when the floor material is first created.
    this.configureFloorMaterialShader(material, definition);
    material.needsUpdate = true;
  }

  /** Remove the broad source-image shading and break terrazzo repetition. */
  private configureFloorMaterialShader(
    material: THREE.MeshStandardMaterial,
    definition: FloorFinishDefinition
  ) {
    if (!definition.antiTile) {
      material.onBeforeCompile = () => {};
      material.customProgramCacheKey = () => 'domus-floor-standard-v1';
      return;
    }

    if (definition.id === 'carpet-011' || definition.id === 'carpet-012') {
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `
#ifdef USE_MAP
  // The carpet source has broad photographed light/dark patches and mismatched
  // opposite edges. Mirrored wrapping closes the edges. A continuous UV warp
  // hides mirror symmetry, while coarse-mip removal preserves only fine pile.
  vec2 carpetUv = vMapUv;
  vec2 warpedUv = carpetUv + vec2(
    0.08 * sin(carpetUv.y * 2.7 + sin(carpetUv.x * 1.1))
      + 0.025 * sin(carpetUv.x * 4.5 + carpetUv.y * 1.8),
    0.08 * sin(carpetUv.x * 2.9 + sin(carpetUv.y * 1.3))
      + 0.025 * sin(carpetUv.y * 4.2 - carpetUv.x * 1.7)
  );
  vec4 carpetDetail = texture(map, warpedUv);
  vec4 carpetCoarse = textureLod(map, warpedUv, 5.0);
  vec4 carpetMean = textureLod(map, vec2(0.5), 10.0);
  vec4 sampledDiffuseColor = clamp(
    carpetDetail - 0.9 * (carpetCoarse - carpetMean),
    0.0, 1.0
  );
  diffuseColor *= sampledDiffuseColor;
#endif
`
        );
      };
      material.customProgramCacheKey = () => 'domus-carpet-warp-highpass-v2';
      return;
    }

    if (definition.id === 'terrazzo-005' || definition.id === 'terrazzo-007') {
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `
#ifdef USE_MAP
  // A gentle, continuous domain warp makes the 1 m chip pattern aperiodic
  // without blending regions of different texture density into visible patches.
  vec2 floorUv = vMapUv;
  vec2 warpedUv = floorUv + vec2(
    0.065 * sin(floorUv.y * 2.7 + sin(floorUv.x * 1.1))
      + 0.018 * sin(floorUv.x * 4.5 + floorUv.y * 1.8),
    0.065 * sin(floorUv.x * 2.9 + sin(floorUv.y * 1.3))
      + 0.018 * sin(floorUv.y * 4.2 - floorUv.x * 1.7)
  );
  vec4 terrazzoDetail = texture(map, warpedUv);
  vec4 terrazzoCoarse = textureLod(map, warpedUv, 6.0);
  vec4 terrazzoMean = textureLod(map, vec2(0.5), 10.0);
  vec4 sampledDiffuseColor = clamp(
    terrazzoDetail - 0.85 * (terrazzoCoarse - terrazzoMean),
    0.0, 1.0
  );
  diffuseColor *= sampledDiffuseColor;
#endif
`
        );
      };
      material.customProgramCacheKey = () => 'domus-terrazzo-warp-v1';
      return;
    }

    material.onBeforeCompile = () => {};
    material.customProgramCacheKey = () => 'domus-floor-standard-v1';
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
    this.configureFloorMaterialShader(material, definition);
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
      if (this.disposed || request !== this.floorFinishRequest || this.floorMaterial !== target) return;
      this.applyFloorMaps(target, definition, maps);
      this.requestRender();
    });
  }

  private rebuildRoom(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.floorGroup);
    this.disposeGroup(this.wallsGroup);
    this.disposeGroup(this.ceilingGroup);
    this.disposeGroup(this.architecturalShadeGroup);
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
        2,
        0.08
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
    slab.castShadow = false;
    slab.name = 'Floor';
    this.tagExportRoot(slab, 'Floors', 'floor', 'Floor');
    this.floorGroup.add(slab);
    this.addFloorPerimeterShade(snapshot);

    this.rebuildWalls(snapshot);
    this.rebuildCeiling(snapshot);
    this.rebuildCeilingLighting(snapshot);
    this.rebuildWindowDaylighting(snapshot);
    this.rebuildSunset(snapshot);
    this.applyRoomLighting(snapshot);
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
        // This underside receives no bounced light in a forward renderer. Give
        // it the reference's steady warm plaster tone instead of letting the
        // directional shadow map turn it almost black.
        new THREE.MeshBasicMaterial({ color: snapshot.room.ceilingColor, side: THREE.DoubleSide, toneMapped: false }),
        new THREE.MeshBasicMaterial({ color: JUNCTION_COLOR, side: THREE.DoubleSide, toneMapped: false })
      ]
    );
    // All direct lights stay below this slab, and broad fill stands in for
    // indoor bounce. Camera visibility therefore cannot open a skylight.
    ceiling.castShadow = false;
    ceiling.receiveShadow = true;
    ceiling.name = 'Ceiling';
    this.tagExportRoot(ceiling, 'Ceiling', 'ceiling', 'Ceiling');
    this.ceilingGroup.add(ceiling);
    this.addCeilingPerimeterShade(snapshot);
    this.updateCeilingVisibility();
  }

  private addCeilingPerimeterShade(snapshot: PlannerSnapshot) {
    const bounds = roomBounds(snapshot.room.vertices);
    const width = Math.min(0.65, Math.min(bounds.width, bounds.depth) * 0.16);
    const edge = this.insetRoomVertices(snapshot, WALL_THICKNESS / 2);
    const inner = this.insetRoomVertices(snapshot, WALL_THICKNESS / 2 + width);
    const underside = snapshot.room.height - CEILING_THICKNESS - 0.002;

    for (const wall of getRoomWalls(snapshot.room)) {
      const next = (wall.index + 1) % edge.length;
      const geometry = this.makeQuadGeometry([
        new THREE.Vector3(edge[wall.index].x, underside, edge[wall.index].z),
        new THREE.Vector3(edge[next].x, underside, edge[next].z),
        new THREE.Vector3(inner[next].x, underside, inner[next].z),
        new THREE.Vector3(inner[wall.index].x, underside, inner[wall.index].z)
      ]);
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
        0, 0, wall.length, 0, wall.length, 1, 0, 1
      ], 2));
      const material = new THREE.ShaderMaterial({
        uniforms: { wallLength: { value: wall.length } },
        vertexShader: `
          varying vec2 vCeilingPosition;
          void main() {
            vCeilingPosition = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float wallLength;
          varying vec2 vCeilingPosition;
          void main() {
            float fromWall = 1.0 - smoothstep(0.0, 1.0, vCeilingPosition.y);
            float nearCorner = max(
              1.0 - smoothstep(0.0, 0.7, vCeilingPosition.x),
              1.0 - smoothstep(0.0, 0.7, wallLength - vCeilingPosition.x)
            );
            float contact = 1.0 - smoothstep(0.0, 0.15, vCeilingPosition.y);
            float opacity = fromWall * (0.04 + 0.015 * nearCorner) + 0.015 * contact;
            gl_FragColor = vec4(0.16, 0.15, 0.14, opacity);
          }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const shade = new THREE.Mesh(geometry, material);
      shade.userData.ceilingShade = true;
      shade.visible = this.ceilingVisible;
      shade.renderOrder = 1;
      this.architecturalShadeGroup.add(shade);
    }
  }

  private updateLightFixtureVisibility(snapshot: PlannerSnapshot) {
    const lighting = snapshot.room.lighting;
    this.lightFixtureGroup.visible = lighting.enabled && (lighting.showWithoutCeiling || this.ceilingVisible);
  }

  private ceilingLightPositions(snapshot: PlannerSnapshot) {
    const bounds = roomBounds(snapshot.room.vertices);
    const width = Math.max(2.2, bounds.width);
    const depth = Math.max(2.2, bounds.depth);
    // A maximum 3 x 3 grid keeps one affordable light per visible fixture.
    // Quarter-room margins also keep the outside rows off the wall line.
    const cols = THREE.MathUtils.clamp(Math.round(width / 1.9), 2, 3);
    const rows = THREE.MathUtils.clamp(Math.round(depth / 1.9), 2, 3);
    const marginX = width * 0.25;
    const marginZ = depth * 0.25;
    const walls = getRoomWalls(snapshot.room);
    const minimumWallClearance = Math.min(0.8, Math.min(width, depth) * 0.2);
    const positions: THREE.Vector3[] = [];
    for (let r = 0; r < rows; r += 1) {
      const tz = rows === 1 ? 0.5 : r / (rows - 1);
      const z = THREE.MathUtils.lerp(bounds.minZ + marginZ, bounds.maxZ - marginZ, tz);
      for (let c = 0; c < cols; c += 1) {
        const tx = cols === 1 ? 0.5 : c / (cols - 1);
        const x = THREE.MathUtils.lerp(bounds.minX + marginX, bounds.maxX - marginX, tx);
        if (!pointInRoom({ x, z }, snapshot.room, true)) continue;
        // In a recess or L-shaped room, bounding-box margins do not describe
        // the distance to an inside wall. Check the actual segments as well.
        const wallDistance = Math.min(...walls.map((wall) => {
          const projection = THREE.MathUtils.clamp(
            ((x - wall.start.x) * wall.tangent.x + (z - wall.start.z) * wall.tangent.z) / Math.max(wall.length, 0.001),
            0, 1
          );
          const nearestX = wall.start.x + wall.tangent.x * wall.length * projection;
          const nearestZ = wall.start.z + wall.tangent.z * wall.length * projection;
          return Math.hypot(x - nearestX, z - nearestZ);
        }));
        if (wallDistance < minimumWallClearance) continue;
        positions.push(new THREE.Vector3(x, snapshot.room.height - CEILING_THICKNESS - 0.006, z));
      }
    }
    if (!positions.length) positions.push(new THREE.Vector3((bounds.minX + bounds.maxX) / 2, snapshot.room.height - CEILING_THICKNESS - 0.006, (bounds.minZ + bounds.maxZ) / 2));
    return positions;
  }

  private createSurfaceFixture() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 0.025, 26),
      new THREE.MeshStandardMaterial({ color: 0xf9f8f4, roughness: 0.78, metalness: 0.02 })
    );
    body.castShadow = false;
    body.receiveShadow = true;
    body.position.y = -0.012;
    group.add(body);

    const diffuser = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.008, 26),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
    );
    diffuser.position.y = -0.028;
    group.add(diffuser);
    return group;
  }

  private createRecessedFixture() {
    const group = new THREE.Group();
    const trim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.01, 26),
      new THREE.MeshStandardMaterial({ color: 0xfbfbfb, roughness: 0.72, metalness: 0.01 })
    );
    trim.position.y = -0.005;
    trim.castShadow = false;
    trim.receiveShadow = true;
    group.add(trim);

    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.085, 0.015, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
    );
    lens.position.y = -0.016;
    group.add(lens);
    return group;
  }

  private createFixtureHalo() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context) {
      const gradient = context.createRadialGradient(32, 32, 5, 32, 32, 32);
      gradient.addColorStop(0, 'rgba(255,255,255,0)');
      gradient.addColorStop(0.32, 'rgba(255,255,255,0.42)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 64, 64);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return {
      geometry: new THREE.PlaneGeometry(0.46, 0.46),
      material: new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    };
  }

  private rebuildCeilingLighting(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.lightFixtureGroup);
    this.disposeGroup(this.interiorLightGroup);
    const lighting = snapshot.room.lighting;
    if (!lighting.enabled) {
      this.updateLightFixtureVisibility(snapshot);
      return;
    }

    const positions = this.ceilingLightPositions(snapshot);
    const halo = this.createFixtureHalo();
    for (const position of positions) {
      const glow = new THREE.Mesh(halo.geometry, halo.material);
      glow.rotation.x = Math.PI / 2;
      glow.position.set(position.x, position.y - 0.003, position.z);
      glow.renderOrder = 1;
      this.lightFixtureGroup.add(glow);

      const fixture = lighting.fixtureType === 'recessed' ? this.createRecessedFixture() : this.createSurfaceFixture();
      fixture.position.copy(position);
      fixture.name = lighting.fixtureType === 'recessed' ? 'Recessed Downlight' : 'Surface Mounted Light';
      fixture.traverse((node) => { node.userData.roomLightFixture = true; });
      this.lightFixtureGroup.add(fixture);
    }

    // Every visible fixture has a matching light. None adds a shadow map;
    // scale intensity with the grid size to keep total exposure controlled.
    const intensity = 1.1 * Math.sqrt(4 / positions.length);
    for (const position of positions) {
      const light = new THREE.SpotLight(0xfff1e5, intensity, Math.max(3.4, snapshot.room.height * 1.4), THREE.MathUtils.degToRad(78), 0.8, 2);
      light.userData.baseIntensity = intensity;
      light.position.set(position.x, position.y - 0.07, position.z);
      light.target.position.set(position.x, 0.2, position.z);
      light.castShadow = false;
      this.interiorLightGroup.add(light, light.target);
    }

    this.updateLightFixtureVisibility(snapshot);
  }

  private rebuildWindowDaylighting(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.daylightGroup);

    const windows = snapshot.openings.filter((opening) => isSunGlazedOpening(opening) || opening.type === 'opening');
    for (const opening of windows) {
      const wall = getRoomWalls(snapshot.room).find((candidate) => candidate.id === opening.wallId);
      if (!wall) continue;
      const centre = wallPoint(wall, opening.offset);
      const outward = new THREE.Vector3(-wall.inward.x, 0, -wall.inward.z);
      const inward = new THREE.Vector3(wall.inward.x, 0, wall.inward.z);
      const verticalCenter = opening.sillHeight + opening.height * 0.62;
      const source = new THREE.Vector3(centre.x, verticalCenter, centre.z)
        .addScaledVector(outward, 0.38)
        .add(new THREE.Vector3(0, opening.height * 0.08, 0));
      const targetPosition = new THREE.Vector3(centre.x, Math.max(0.32, verticalCenter * 0.58), centre.z)
        .addScaledVector(inward, 1.45);

      const light = new THREE.SpotLight(0xf2f5ff, 0.12, 3.2, THREE.MathUtils.degToRad(52), 0.8, 2);
      light.position.copy(source);
      light.target.position.copy(targetPosition);
      light.castShadow = false;
      this.daylightGroup.add(light, light.target);
    }
  }

  private disposeSunsetRig() {
    for (const child of this.sunsetGroup.children) {
      if (child instanceof THREE.DirectionalLight) child.shadow.dispose();
    }
    this.disposeGroup(this.sunsetGroup);
    this.sunsetLights = null;
  }

  private sunDirection(snapshot: PlannerSnapshot) {
    const walls = getRoomWalls(snapshot.room);
    const windows = snapshot.openings.flatMap((opening) => {
      const wall = walls.find((candidate) => candidate.id === opening.wallId);
      return isSunGlazedOpening(opening) && wall ? [{ opening, wall }] : [];
    });
    if (!windows.length) return null;

    // Zero horizontal rotation faces the first valid window. The orbit is
    // shared by every opening, regardless of how many receive direct sun.
    const firstWall = windows[0].wall;
    const direction = new THREE.Vector3(-firstWall.inward.x, 0, -firstWall.inward.z)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(effectiveSunAzimuth(snapshot.room.lighting.sunAzimuth, windows.length)));
    return direction;
  }

  private positionSunsetLights(snapshot: PlannerSnapshot, direction: THREE.Vector3) {
    if (!this.sunsetLights) return;
    const bounds = roomBounds(snapshot.room.vertices);
    const centre = new THREE.Vector3(
      (bounds.minX + bounds.maxX) / 2,
      snapshot.room.height / 2,
      (bounds.minZ + bounds.maxZ) / 2
    );
    const elevation = THREE.MathUtils.degToRad(snapshot.room.lighting.sunElevation);
    const sideways = new THREE.Vector3(-direction.z, 0, direction.x);
    const vertical = new THREE.Vector3(
      -direction.x * Math.sin(elevation),
      Math.cos(elevation),
      -direction.z * Math.sin(elevation)
    );
    // Both sources orbit the room at a fixed radius. Their small offset in the
    // tangent plane keeps their separation and two shadow directions constant.
    const source = centre.clone()
      .addScaledVector(direction, 50 * Math.cos(elevation));
    source.y += 50 * Math.sin(elevation);
    this.sunsetLights.forEach((light, index) => {
      const side = index === 0 ? -1 : 1;
      light.position.copy(source)
        .addScaledVector(sideways, side)
        .addScaledVector(vertical, 0.45 * side);
      light.target.position.copy(centre);
      light.shadow.needsUpdate = true;
    });
  }

  private syncSunsetAngles(snapshot: PlannerSnapshot) {
    const key = `${snapshot.room.lighting.sunAzimuth}:${snapshot.room.lighting.sunElevation}`;
    if (key === this.lastSunAnglesKey) return;
    const direction = this.sunDirection(snapshot);
    if (direction) this.positionSunsetLights(snapshot, direction);
    this.lastSunAnglesKey = key;
  }

  /** A soft and a crisp sun share one orbit while the established room
   * rig and furniture contact shadows remain independent. */
  private rebuildSunset(snapshot: PlannerSnapshot) {
    this.disposeSunsetRig();
    const walls = getRoomWalls(snapshot.room);
    const direction = this.sunDirection(snapshot);
    this.lastSunAnglesKey = `${snapshot.room.lighting.sunAzimuth}:${snapshot.room.lighting.sunElevation}`;
    if (!direction) return;

    const bounds = roomBounds(snapshot.room.vertices);
    const shadowSpan = Math.hypot(bounds.width, bounds.depth) + snapshot.room.height * 2 + 4;
    const makeSun = (
      name: string,
      color: THREE.ColorRepresentation,
      intensity: number,
      mapSize: number,
      radius: number
    ) => {
      const light = new THREE.DirectionalLight(color, intensity);
      light.name = name;
      light.castShadow = true;
      light.shadow.mapSize.set(mapSize, mapSize);
      const camera = light.shadow.camera;
      camera.left = camera.bottom = -shadowSpan / 2;
      camera.right = camera.top = shadowSpan / 2;
      camera.near = 1;
      camera.far = 105;
      camera.updateProjectionMatrix();
      light.shadow.bias = -0.00012;
      light.shadow.normalBias = 0.01;
      light.shadow.radius = radius;
      this.sunsetGroup.add(light, light.target);
      return light;
    };
    const softSun = makeSun('Window sunset soft', 0xffc28a, 1.7, 512, 9);
    const sharpSun = makeSun('Window sunset sharp', 0xffe5c7, 1.4, 1024, 1.25);
    this.sunsetLights = [softSun, sharpSun];
    this.positionSunsetLights(snapshot, direction);
    const sunsetShadowCameras = new Set<THREE.Camera>([
      softSun.shadow.camera,
      sharpSun.shadow.camera
    ]);

    // Invisible walls and ceiling write only to the paired sun shadow maps.
    // Every window stays open; direction and surrounding geometry decide which
    // panes admit sunlight.
    const maskMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
    const beforeMaskShadow: THREE.Object3D['onBeforeShadow'] = (_renderer, _object, _camera, shadowCamera, _geometry, depthMaterial) => {
      const isSunset = sunsetShadowCameras.has(shadowCamera);
      depthMaterial.depthWrite = isSunset;
      depthMaterial.colorWrite = isSunset;
    };
    const afterMaskShadow: THREE.Object3D['onAfterShadow'] = (_renderer, _object, _camera, _shadowCamera, _geometry, depthMaterial) => {
      depthMaterial.depthWrite = true;
      depthMaterial.colorWrite = true;
    };
    const addMask = (maskWall: RoomWallSegment, along: number, bottom: number, width: number, height: number) => {
      if (width <= 0.001 || height <= 0.001) return;
      const point = wallPoint(maskWall, along);
      const mask = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.04), maskMaterial);
      mask.position.set(point.x, bottom + height / 2, point.z);
      mask.rotation.y = -Math.atan2(maskWall.tangent.z, maskWall.tangent.x);
      mask.castShadow = true;
      mask.onBeforeShadow = beforeMaskShadow;
      mask.onAfterShadow = afterMaskShadow;
      this.sunsetGroup.add(mask);
    };
    for (const wall of walls) {
      const panes = snapshot.openings.filter((opening) => opening.wallId === wall.id).flatMap(glazingAreas);
      const cuts = [0, wall.length, ...panes.flatMap((pane) => [
        Math.max(0, pane.left),
        Math.min(wall.length, pane.right)
      ])].sort((a, b) => a - b);
      for (let i = 1; i < cuts.length; i += 1) {
        const left = cuts[i - 1];
        const right = cuts[i];
        if (right - left <= 0.001) continue;
        const middle = (left + right) / 2;
        const apertures = panes
          .filter((pane) => middle > pane.left && middle < pane.right)
          .map((pane) => ({
            bottom: Math.max(0, pane.bottom),
            top: Math.min(snapshot.room.height, pane.top)
          }))
          .sort((a, b) => a.bottom - b.bottom);
        let cursor = 0;
        for (const aperture of apertures) {
          addMask(wall, middle, cursor, right - left, aperture.bottom - cursor);
          cursor = Math.max(cursor, aperture.top);
        }
        addMask(wall, middle, cursor, right - left, snapshot.room.height - cursor);
      }
    }
    const ceilingShape = new THREE.Shape(snapshot.room.vertices.map((vertex) => new THREE.Vector2(vertex.x, vertex.z)));
    const ceilingMask = new THREE.Mesh(new THREE.ShapeGeometry(ceilingShape), maskMaterial);
    ceilingMask.rotation.x = Math.PI / 2;
    ceilingMask.position.y = snapshot.room.height + 0.02;
    ceilingMask.castShadow = true;
    ceilingMask.onBeforeShadow = beforeMaskShadow;
    ceilingMask.onAfterShadow = afterMaskShadow;
    this.sunsetGroup.add(ceilingMask);
  }

  private applyRoomLighting(snapshot: PlannerSnapshot) {
    const enabled = snapshot.room.lighting.enabled;
    const hasDaylight = this.daylightGroup.children.length > 0;
    const hasSunset = snapshot.openings.some(isSunGlazedOpening);
    // The broad terms stand in for bounced indoor light. Fixtures supply a
    // visible ceiling cue; the original shadow caster still projects furniture
    // shadows onto the room, while contact AO sits beneath each model.
    this.hemiLight.intensity = hasSunset ? (enabled ? 0.72 : 0.62) : (enabled ? 1.15 : 0.95);
    this.ambientLight.intensity = hasSunset ? (enabled ? 0.16 : 0.12) : (enabled ? 0.38 : 0.28);
    this.mainLight.intensity = hasSunset ? (enabled ? 0.52 : 0.46) : (enabled ? 0.82 : (hasDaylight ? 0.78 : 0.88));
    this.fillLight.intensity = hasSunset ? (enabled ? 0.15 : 0.12) : (enabled ? 0.34 : 0.26);
    for (const child of this.interiorLightGroup.children) {
      if (child instanceof THREE.SpotLight) {
        child.intensity = child.userData.baseIntensity * (hasSunset ? 0.55 : 1);
      }
    }
    this.renderer.toneMappingExposure = hasSunset ? 0.91 : 0.98;
    this.scene.background = new THREE.Color(0xd4d5d6);
  }

  private updateCeilingVisibility(force = false) {
    const sidePreset = this.currentCameraView === 'front'
      || this.currentCameraView === 'back'
      || this.currentCameraView === 'left'
      || this.currentCameraView === 'right';

    let visible = sidePreset;
    if (this.currentCameraView === 'perspective') {
      const offset = this.camera.position.clone().sub(this.controls.target);
      const horizontal = Math.hypot(offset.x, offset.z);
      const elevation = Math.atan2(Math.abs(offset.y), Math.max(horizontal, 1e-6));

      // Once a preset is left, evaluate the *current* elevation immediately.
      // If the orbit lands inside the ceiling range, the ceiling stays/appears in
      // that same motion instead of requiring a later exit-and-reentry cycle.
      visible = this.ceilingVisible
        ? elevation <= CEILING_EXIT_ELEVATION
        : elevation <= CEILING_ENTER_ELEVATION;
    }

    if (!force && visible === this.ceilingVisible) return;
    this.ceilingVisible = visible;
    this.ceilingGroup.visible = visible;
    this.architecturalShadeGroup.children.forEach((shade) => {
      if (shade.userData.ceilingShade) shade.visible = visible;
    });
    this.updateLightFixtureVisibility(this.bridge.getSnapshot());
    this.updateRoomDimensionVisibility();
  }

  private updateRoomDimensionVisibility() {
    // Room dimensions are temporarily hidden whenever the ceiling is visible.
    // Item spacing, product dimensions and clearance helpers remain untouched.
    this.helperGroup.children.forEach((object) => {
      if (object.userData.helperRole === 'roomDimensions') object.visible = !this.ceilingVisible;
    });
  }

  private rebuildWalls(snapshot: PlannerSnapshot) {
    this.disposeGroup(this.wallsGroup);
    this.lastOpeningHighlightKey = '';
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
    const blocked = snapshot.openings
      .filter((opening) => opening.wallId === wall.id && opening.sillHeight <= 0.025)
      .map((opening) => ({
        // Stop at the outside of the casing, not the raw opening. The old run
        // continued underneath half of the door frame, producing the little split
        // at the jamb. This makes baseboard and casing meet edge-to-edge.
        start: Math.max(0, opening.offset - opening.width / 2 - (opening.type === 'window' ? 0.04 : 0.075) / 2),
        end: Math.min(wall.length, opening.offset + opening.width / 2 + (opening.type === 'window' ? 0.04 : 0.075) / 2)
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
        // A small material-side bounce term replaces the indirect light that a
        // single forward-rendered shadow map cannot calculate in an enclosed room.
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(wallColor),
          roughness: 0.94,
          side: THREE.DoubleSide,
          emissive: new THREE.Color(wallColor),
          emissiveIntensity: 0.45
        }),
        // Miter faces deliberately ignore scene lighting and shadowing so the
        // architectural cut stays the exact same white from every camera angle.
        new THREE.MeshBasicMaterial({ color: JUNCTION_COLOR, side: THREE.DoubleSide, toneMapped: false })
      ]
    );
    body.receiveShadow = true;
    body.castShadow = false;
    body.name = `Wall ${wall.index + 1} Segment`;
    this.tagCutawaySurface(body, wall);
    this.tagExportPart(body, 'Walls', wall.id, `Wall ${wall.index + 1}`, this.wallYaw(wall));
    this.wallsGroup.add(body);
    this.addWallCornerShade(wall, start, end, innerBottom, innerTop, inner, snapshot);
  }

  private addWallCornerShade(
    wall: ReturnType<typeof getRoomWalls>[number],
    start: number,
    end: number,
    bottom: number,
    top: number,
    inner: { start: Vec2; end: Vec2 },
    snapshot: PlannerSnapshot
  ) {
    // Room-space corner occlusion remains stable across camera cutaways. One
    // transparent quad per solid wall segment also respects doors and windows.
    const inset = 0.0015;
    const points: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
      new THREE.Vector3(inner.start.x + wall.inward.x * inset, bottom, inner.start.z + wall.inward.z * inset),
      new THREE.Vector3(inner.end.x + wall.inward.x * inset, bottom, inner.end.z + wall.inward.z * inset),
      new THREE.Vector3(inner.end.x + wall.inward.x * inset, top, inner.end.z + wall.inward.z * inset),
      new THREE.Vector3(inner.start.x + wall.inward.x * inset, top, inner.start.z + wall.inward.z * inset)
    ];
    const geometry = this.makeQuadGeometry(points);
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
      start, bottom, end, bottom, end, top, start, top
    ], 2));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        wallLength: { value: wall.length },
        roomHeight: { value: snapshot.room.height }
      },
      vertexShader: `
        varying vec2 vWallPosition;
        void main() {
          vWallPosition = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float wallLength;
        uniform float roomHeight;
        varying vec2 vWallPosition;
        void main() {
          float floorEdge = 1.0 - smoothstep(0.0, 1.35, vWallPosition.y);
          float ceilingEdge = 1.0 - smoothstep(0.0, 0.28, roomHeight - vWallPosition.y);
          float cornerWidth = mix(0.75, 1.3, floorEdge);
          float startCorner = 1.0 - smoothstep(0.0, cornerWidth, vWallPosition.x);
          float endCorner = 1.0 - smoothstep(0.0, cornerWidth, wallLength - vWallPosition.x);
          float corner = max(startCorner, endCorner);
          float seam = max(
            1.0 - smoothstep(0.0, 0.24, vWallPosition.x),
            1.0 - smoothstep(0.0, 0.24, wallLength - vWallPosition.x)
          );
          float opacity = corner * (0.09 + 0.02 * floorEdge + 0.008 * ceilingEdge)
            + 0.030 * seam
            + 0.025 * floorEdge + 0.008 * ceilingEdge;
          gl_FragColor = vec4(0.065, 0.062, 0.064, min(opacity, 0.20));
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const shade = new THREE.Mesh(geometry, material);
    shade.renderOrder = 1;
    this.tagCutawaySurface(shade, wall);
    this.architecturalShadeGroup.add(shade);
  }

  private addFloorPerimeterShade(snapshot: PlannerSnapshot) {
    const bounds = roomBounds(snapshot.room.vertices);
    const width = Math.min(1.1, Math.max(0.25, Math.min(bounds.width, bounds.depth) * 0.24));
    const edge = this.insetRoomVertices(snapshot, WALL_THICKNESS / 2);
    const inner = this.insetRoomVertices(snapshot, WALL_THICKNESS / 2 + width);
    const walls = getRoomWalls(snapshot.room);

    for (const wall of walls) {
      const next = (wall.index + 1) % edge.length;
      const geometry = this.makeQuadGeometry([
        new THREE.Vector3(edge[wall.index].x, 0.004, edge[wall.index].z),
        new THREE.Vector3(edge[next].x, 0.004, edge[next].z),
        new THREE.Vector3(inner[next].x, 0.004, inner[next].z),
        new THREE.Vector3(inner[wall.index].x, 0.004, inner[wall.index].z)
      ]);
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
        0, 0, wall.length, 0, wall.length, 1, 0, 1
      ], 2));
      const material = new THREE.ShaderMaterial({
        uniforms: { wallLength: { value: wall.length } },
        vertexShader: `
          varying vec2 vEdgePosition;
          void main() {
            vEdgePosition = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float wallLength;
          varying vec2 vEdgePosition;
          void main() {
            float fromWall = 1.0 - smoothstep(0.0, 1.0, vEdgePosition.y);
            float contact = 1.0 - smoothstep(0.0, 0.12, vEdgePosition.y);
            float nearCorner = max(
              1.0 - smoothstep(0.0, 0.8, vEdgePosition.x),
              1.0 - smoothstep(0.0, 0.8, wallLength - vEdgePosition.x)
            );
            float opacity = fromWall * (0.17 + 0.08 * nearCorner) + 0.08 * contact;
            gl_FragColor = vec4(0.045, 0.045, 0.055, opacity);
          }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const shade = new THREE.Mesh(geometry, material);
      shade.renderOrder = 1;
      this.architecturalShadeGroup.add(shade);
    }
  }

  private addBaseboard(
    wall: ReturnType<typeof getRoomWalls>[number],
    start: number,
    end: number,
    snapshot: PlannerSnapshot
  ) {
    if (end - start < 0.03) return;
    const profile = (BASEBOARD_STYLES.find((style) => style.id === snapshot.room.baseboardStyle) ?? BASEBOARD_STYLES[0]).profile;
    const positions: number[] = [];
    const uvs: number[] = [];
    const geometry = new THREE.BufferGeometry();
    const edges = profile.map(([projection, y]) => {
      const points = this.wallSegmentEdgePoints(wall, start, end, WALL_THICKNESS / 2 + projection, snapshot);
      return {
        start: new THREE.Vector3(points.start.x, y, points.start.z),
        end: new THREE.Vector3(points.end.x, y, points.end.z)
      };
    });

    // UV coordinates are expressed in physical metres. Floor/baseboard textures are
    // configured with repeats-per-metre, so a baseboard using the floor material
    // keeps the same real-world texture scale on every profile and angled wall.
    const profileDistances = [0];
    for (let index = 1; index < profile.length; index += 1) {
      const [prevX, prevY] = profile[index - 1];
      const [x, y] = profile[index];
      profileDistances[index] = profileDistances[index - 1] + Math.hypot(x - prevX, y - prevY);
    }
    const last = profile[profile.length - 1];
    const first = profile[0];
    const profilePerimeter = profileDistances[profile.length - 1] + Math.hypot(first[0] - last[0], first[1] - last[1]);
    const runLength = end - start;

    const triangle = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      c: THREE.Vector3,
      materialIndex: number,
      uvA: [number, number],
      uvB: [number, number],
      uvC: [number, number]
    ) => {
      geometry.addGroup(positions.length / 3, 3, materialIndex);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1]);
    };
    for (let index = 0; index < profile.length; index += 1) {
      const next = (index + 1) % profile.length;
      const a = edges[index];
      const b = edges[next];
      const highlight = profile[index][1] > 0.01 && Math.abs(profile[index][1] - profile[next][1]) < 0.001 ? 1 : 0;
      const v0 = profileDistances[index];
      const v1 = next === 0 ? profilePerimeter : profileDistances[next];
      triangle(a.start, a.end, b.end, highlight, [0, v0], [runLength, v0], [runLength, v1]);
      triangle(a.start, b.end, b.start, highlight, [0, v0], [runLength, v1], [0, v1]);
    }
    const caps = THREE.ShapeUtils.triangulateShape(profile.map(([x, y]) => new THREE.Vector2(x, y)), []);
    for (const [a, b, c] of caps) {
      const uvA: [number, number] = [profile[a][0], profile[a][1]];
      const uvB: [number, number] = [profile[b][0], profile[b][1]];
      const uvC: [number, number] = [profile[c][0], profile[c][1]];
      triangle(edges[a].start, edges[b].start, edges[c].start, 0, uvA, uvB, uvC);
      triangle(edges[c].end, edges[b].end, edges[a].end, 0, uvC, uvB, uvA);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();

    let materials: THREE.Material[];
    let floorMatchedMaterial: THREE.MeshStandardMaterial | null = null;
    let floorMatchedDefinition: FloorFinishDefinition | null = null;
    if (snapshot.room.baseboardMaterial === 'materials') {
      floorMatchedDefinition = floorFinishDefinition(snapshot.room.floorFinish);
      floorMatchedMaterial = new THREE.MeshStandardMaterial({
        color: floorMatchedDefinition.fallbackColor,
        roughness: floorMatchedDefinition.fallbackRoughness,
        metalness: 0,
        envMapIntensity: floorMatchedDefinition.envMapIntensity,
        side: THREE.DoubleSide
      });
      floorMatchedMaterial.normalScale.set(floorMatchedDefinition.normalScale, floorMatchedDefinition.normalScale);
      floorMatchedMaterial.name = `Baseboard - ${floorMatchedDefinition.name}`;
      this.configureFloorMaterialShader(floorMatchedMaterial, floorMatchedDefinition);
      const cached = this.floorMapResults.get(floorMatchedDefinition.id);
      if (cached) {
        this.applyFloorMaps(floorMatchedMaterial, floorMatchedDefinition, cached);
        floorMatchedMaterial.name = `Baseboard - ${floorMatchedDefinition.name}`;
      }
      // Use the same lit floor finish for profile faces and ledges. Their different
      // normals provide the highlight naturally without tinting the texture.
      materials = [floorMatchedMaterial, floorMatchedMaterial];
    } else {
      const baseColor = new THREE.Color(snapshot.room.baseboardColor);
      materials = [
        new THREE.MeshBasicMaterial({ color: baseColor, side: THREE.DoubleSide, toneMapped: false }),
        new THREE.MeshBasicMaterial({ color: baseColor.clone().lerp(new THREE.Color(0xffffff), 0.28), side: THREE.DoubleSide, toneMapped: false })
      ];
    }

    const mesh = new THREE.Mesh(geometry, materials);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = `Baseboard ${wall.index + 1} Segment`;
    this.tagCutawaySurface(mesh, wall);
    this.tagExportPart(mesh, 'Floors', `baseboard:${wall.id}`, `Baseboard ${wall.index + 1}`, this.wallYaw(wall));
    this.wallsGroup.add(mesh);

    if (floorMatchedMaterial && floorMatchedDefinition && !this.floorMapResults.has(floorMatchedDefinition.id)) {
      const material = floorMatchedMaterial;
      const definition = floorMatchedDefinition;
      void this.loadFloorFinishMaps(definition).then((maps) => {
        // If the room was rebuilt while the texture was loading, this mesh/material
        // has already been disposed and should not be revived.
        if (this.disposed || mesh.parent !== this.wallsGroup || mesh.material !== materials) return;
        this.applyFloorMaps(material, definition, maps);
        material.name = `Baseboard - ${definition.name}`;
        this.requestRender();
      });
    }
  }

  private addOpeningFrame(opening: PlannerSnapshot['openings'][number], snapshot: PlannerSnapshot, wallThickness: number) {
    const wall = getRoomWalls(snapshot.room).find((candidate) => candidate.id === opening.wallId);
    if (!wall) return;
    const isWindow = opening.type === 'window';
    const frame = isWindow ? 0.04 : 0.075;
    const frameDepth = wallThickness + (isWindow ? 0.02 : 0.04);
    const casingColor = isWindow ? 0xcfcecb : 0xdedbd8;
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
    const alignedBox = (along: number, y: number, alongSize: number, boxHeight: number, depth: number, normalOffset = 0, color: THREE.ColorRepresentation = TRIM_COLOR, stableTrim = false) => {
      const point = wallPoint(wall, along);
      const trim = stableTrim || color === TRIM_COLOR;
      const trimColor = color === TRIM_COLOR ? casingColor : color;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(alongSize, boxHeight, depth),
        trim ? new THREE.MeshBasicMaterial({ color: trimColor, toneMapped: false }) : material(color)
      );
      mesh.rotation.y = yaw;
      mesh.position.set(point.x + wall.inward.x * normalOffset, y, point.z + wall.inward.z * normalOffset);
      if (trim && typeof trimColor === 'number') mesh.userData.stableTrimColor = trimColor;
      mesh.castShadow = false;
      mesh.receiveShadow = !trim;
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

    // Door casings are wider and project farther into the room. Window frames
    // remain slim, with a separate projecting sill instead of a door header.
    alignedBox(opening.offset - opening.width / 2, (top + bottom) / 2, frame, top - bottom, frameDepth);
    alignedBox(opening.offset + opening.width / 2, (top + bottom) / 2, frame, top - bottom, frameDepth);
    alignedBox(opening.offset, top, opening.width + frame, frame, frameDepth);
    if (isWindow) {
      alignedBox(opening.offset, bottom, opening.width + 0.1, 0.04, frameDepth + 0.02, 0.012, 0xe9e6e2, true);
    } else {
      alignedBox(opening.offset, top + frame * 0.42, opening.width + frame * 1.55, 0.014, frameDepth + 0.016, 0.008, 0xece9e5, true);
    }

    if (opening.type === 'window') {
      const sashDepth = 0.047;
      const sashOffset = wallThickness / 2 + 0.007;
      const sashRail = Math.min(0.055, opening.width * 0.095, opening.height * 0.095);
      const panes = glazingAreas(opening);
      for (const [index, pane] of panes.entries()) {
        const paneWidth = pane.right - pane.left;
        const paneHeight = pane.top - pane.bottom;
        const centreAlong = (pane.left + pane.right) / 2;
        const slideOffset = opening.variant === 'sliding-window' && index === 1 ? 0.014 : 0;
        const face = sashOffset + slideOffset;
        // Glass extends behind the sash by 8 mm on every side. Every rail then
        // overlaps the outer casing or its neighbour as dimensions change.
        glassPanel(centreAlong, paneWidth + 0.016, pane.bottom - 0.008, pane.top + 0.008, face + 0.003);
        for (const side of [pane.left, pane.right]) {
          alignedBox(side, (pane.bottom + pane.top) / 2, sashRail, paneHeight + sashRail + 0.002, sashDepth, face, 0xe3e0db);
        }
        for (const edge of [pane.bottom, pane.top]) {
          alignedBox(centreAlong, edge, paneWidth + sashRail + 0.002, sashRail, sashDepth, face, 0xe3e0db);
        }
      }
      if (opening.variant === 'single-hung-window') {
        const split = bottom + opening.height * 0.53;
        alignedBox(opening.offset, split, Math.min(0.075, opening.width * 0.12), 0.018, 0.017, sashOffset + sashDepth / 2 + 0.004, 0xa7a7a2);
      }
      if (opening.variant === 'sliding-window') {
        alignedBox(opening.offset, bottom + 0.014, opening.width - 0.025, 0.018, 0.055, sashOffset + 0.012, 0xbab8b2);
      }
      return;
    }

    if (opening.variant === 'door-frame') return;

    const leafWidth = Math.max(0.1, opening.width - frame + 0.018);
    const leafTop = top - frame / 2 + 0.014;
    const leafBottom = bottom + 0.003;
    const leafDepth = 0.044;
    const leafOffset = wallThickness / 2 + 0.023;
    const isDouble = opening.variant === 'double-door' || opening.variant === 'glass-double-door';
    const paneAreas = glazingAreas(opening);
    const leafCentres = isDouble
      ? [opening.offset - leafWidth / 4, opening.offset + leafWidth / 4]
      : [opening.offset];
    for (const [index, along] of leafCentres.entries()) {
      const width = leafWidth / leafCentres.length;
      const leafLeft = along - width / 2;
      const leafRight = along + width / 2;
      const pane = paneAreas.find((area) => (area.left + area.right) / 2 > leafLeft && (area.left + area.right) / 2 < leafRight);
      const solid = (left: number, right: number, low: number, high: number, color: THREE.ColorRepresentation = 0xcbbca7) => {
        if (right - left <= 0.001 || high - low <= 0.001) return;
        alignedBox((left + right) / 2, (low + high) / 2, right - left, high - low, leafDepth, leafOffset, color);
      };
      if (pane) {
        glassPanel((pane.left + pane.right) / 2, pane.right - pane.left + 0.016,
          pane.bottom - 0.008, pane.top + 0.008, leafOffset + 0.008);
        solid(leafLeft, pane.left + 0.012, leafBottom, leafTop);
        solid(pane.right - 0.012, leafRight, leafBottom, leafTop);
        solid(pane.left, pane.right, leafBottom, pane.bottom + 0.012);
        solid(pane.left, pane.right, pane.top - 0.012, leafTop);
        // A shallow raised panel gives the solid lower section of glazed doors
        // the same crafted finish as an opaque leaf.
        if (pane.bottom - leafBottom > 0.24) {
          alignedBox(along, (leafBottom + pane.bottom) / 2, Math.max(0.08, width - 0.13), pane.bottom - leafBottom - 0.08,
            0.006, leafOffset + leafDepth / 2 + 0.004, 0xd8c9b5);
        }
      } else {
        solid(leafLeft, leafRight, leafBottom, leafTop);
        const insetWidth = Math.max(0.07, width - 0.13);
        const panelFace = leafOffset + leafDepth / 2 + 0.004;
        for (const [low, high] of [[leafBottom + 0.14, leafBottom + (leafTop - leafBottom) * 0.43],
          [leafBottom + (leafTop - leafBottom) * 0.51, leafTop - 0.14]]) {
          if (high - low < 0.07) continue;
          alignedBox(along, (low + high) / 2, insetWidth, high - low, 0.006, panelFace, 0xd8c9b5);
          for (const x of [along - insetWidth / 2, along + insetWidth / 2]) {
            alignedBox(x, (low + high) / 2, 0.012, high - low, 0.012, panelFace + 0.005, 0xb6a48e);
          }
        }
      }
      const latchSide = isDouble ? (index === 0 ? 1 : -1) : 1;
      const handleX = along + latchSide * Math.max(0.035, width / 2 - 0.075);
      const handleY = Math.min(1.05, leafTop * 0.57);
      alignedBox(handleX, handleY, 0.032, 0.12, 0.012, leafOffset + leafDepth / 2 + 0.015, 0xaaa399);
      alignedBox(handleX - latchSide * 0.035, handleY, 0.08, 0.014, 0.022, leafOffset + leafDepth / 2 + 0.026, 0xc8c1b5);
    }
    if (isDouble) alignedBox(opening.offset, (leafBottom + leafTop) / 2, 0.022, leafTop - leafBottom, 0.049, leafOffset, 0xb4a794);
  }

  private syncOpeningHighlight(snapshot: SceneSnapshot) {
    const selected = snapshot.selectedOpeningId ?? null;
    const highlightKey = `${selected ?? '-'}|${this.hoverOpeningId ?? '-'}`;
    if (highlightKey === this.lastOpeningHighlightKey) return;
    this.lastOpeningHighlightKey = highlightKey;
    this.wallsGroup.traverse((object) => {
      const openingId = typeof object.userData.openingId === 'string' ? object.userData.openingId : null;
      if (!openingId || !(object instanceof THREE.Mesh)) return;
      const active = openingId === selected || openingId === this.hoverOpeningId;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of materials) {
        if (mat instanceof THREE.MeshBasicMaterial) {
          if (typeof object.userData.stableTrimColor === 'number') {
            mat.color.setHex(active ? SELECTION_COLOR : object.userData.stableTrimColor);
            mat.opacity = 1;
            mat.transparent = false;
            continue;
          }
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
      const viewCutaway = previousHidden ? facing > CUTAWAY_EXIT_FACING : facing > CUTAWAY_ENTER_FACING;
      nextState.set(wall.id, crossingWall || viewCutaway);
    }

    const cutawayChanged = [...nextState.entries()].some(([id, hidden]) => this.wallHiddenState.get(id) !== hidden)
      || this.wallHiddenState.size !== nextState.size;
    this.wallHiddenState = nextState;
    for (const group of [this.wallsGroup, this.floorGroup, this.architecturalShadeGroup]) group.traverse((object) => {
      const wallId = typeof object.userData.cutawayWallId === 'string' ? object.userData.cutawayWallId : null;
      const wallIds = Array.isArray(object.userData.cutawayWallIds)
        ? object.userData.cutawayWallIds.filter((id: unknown): id is string => typeof id === 'string')
        : wallId ? [wallId] : [];
      if (!wallIds.length) return;
      // A junction belongs to every adjoining wall; hide it whenever one of those
      // walls is cut away so no white seam is left floating in the Cutaway view opening.
      const hidden = wallIds.some((id) => nextState.get(id) ?? false);
      if (force || object.visible === hidden) object.visible = !hidden;
    });
    if (cutawayChanged && snapshot.showRoomDimensions) {
      // Camera orbit only changes which room-wall dimensions belong above the
      // shell versus on the cutaway edge. Rebuild that one static helper set;
      // product/spacing annotations should not churn while the camera moves.
      this.rebuildRoomDimensionHelpers(snapshot);
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
      if (this.contactShadows.size) {
        this.disposeGroup(this.contactShadowGroup);
        this.contactShadows.clear();
      }
      return;
    }

    const live = new Set(snapshot.objects.map((o) => o.id));
    for (const [id, group] of this.objectModels) {
      if (live.has(id)) continue;
      this.disposeObject(group);
      this.objectGroup.remove(group);
      this.objectModels.delete(id);
      const contact = this.contactShadows.get(id);
      if (contact) {
        this.disposeGroup(contact);
        this.contactShadowGroup.remove(contact);
        this.contactShadows.delete(id);
      }
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
        const contact = this.createContactShadow(object.productId);
        this.contactShadows.set(object.id, contact);
        this.contactShadowGroup.add(contact);
      }
      group.position.set(object.x, 0, object.z);
      group.rotation.y = object.rotationY;
      const contact = this.contactShadows.get(object.id);
      if (contact) {
        contact.position.set(object.x, 0, object.z);
        contact.rotation.y = object.rotationY;
      }
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

  /** Soft floor occlusion follows the actual support points, independently of
   * the directional and window shadows. It never alters the model material. */
  private createContactShadow(id: keyof typeof PRODUCTS) {
    const p = PRODUCTS[id];
    const group = new THREE.Group();
    const patch = (width: number, depth: number, x: number, z: number, feather: number, opacity: number, round = false) => {
      const extent = new THREE.Vector2(width + feather * 2, depth + feather * 2);
      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uExtent: { value: extent },
          uHalf: { value: new THREE.Vector2(width / 2, depth / 2) },
          uFeather: { value: feather },
          uOpacity: { value: opacity },
          uRound: { value: round ? 1 : 0 }
        },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          varying vec2 vUv;
          uniform vec2 uExtent;
          uniform vec2 uHalf;
          uniform float uFeather;
          uniform float uOpacity;
          uniform int uRound;
          void main() {
            vec2 p = (vUv - 0.5) * uExtent;
            vec2 q = abs(p) - uHalf;
            float rectDistance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
            float circleDistance = length(p) - uHalf.x;
            float distanceToContact = uRound == 1 ? circleDistance : rectDistance;
            float alpha = uOpacity * (1.0 - smoothstep(-0.012, uFeather, distanceToContact));
            gl_FragColor = vec4(0.10, 0.09, 0.08, alpha);
          }
        `
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(extent.x, extent.y), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.006, z);
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      group.add(mesh);
    };

    if (id === 'sofa' || id === 'armchair') {
      patch(p.width * 0.72, p.depth * 0.55, 0, 0.03, 0.03, 0.10);
      for (const x of [-p.width * 0.38, p.width * 0.38]) {
        for (const z of [-p.depth * 0.28, p.depth * 0.28]) patch(0.07, 0.07, x, z, 0.03, 0.32);
      }
    } else if (id === 'dining-table' || id === 'coffee-table') {
      for (const x of [-p.width * 0.39, p.width * 0.39]) {
        for (const z of [-p.depth * 0.36, p.depth * 0.36]) patch(0.08, 0.08, x, z, 0.03, 0.32);
      }
    } else if (id === 'chair') {
      for (const x of [-p.width * 0.32, p.width * 0.32]) {
        for (const z of [-p.depth * 0.28, p.depth * 0.28]) patch(0.055, 0.055, x, z, 0.03, 0.28);
      }
    } else if (id === 'cabinet' || id === 'bookcase') {
      patch(p.width, p.depth, 0, 0, 0.03, 0.36);
    } else if (id === 'rug') {
      patch(p.width, p.depth, 0, 0, 0.03, 0.10);
    } else if (id === 'plant') {
      patch(0.31, 0.31, 0, 0, 0.03, 0.34, true);
    }
    return group;
  }

  /** A fixed, neutral shape cue keeps unlit placeholder geometry readable.
   * It depends only on face orientation, with no room lights or occlusion. */
  private shadeModelFaces(group: THREE.Group) {
    group.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const normals = node.geometry.getAttribute('normal');
      if (!normals) return;
      const colours = new Float32Array(normals.count * 3);
      for (let i = 0; i < normals.count; i += 1) {
        const shade = 0.75 + 0.19 * Math.max(0, normals.getY(i))
          + 0.06 * Math.max(0, normals.getZ(i));
        colours[i * 3] = shade;
        colours[i * 3 + 1] = shade;
        colours[i * 3 + 2] = shade;
      }
      node.geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    });
  }

  private createPlaceholderModel(id: keyof typeof PRODUCTS) {
    const p = PRODUCTS[id];
    const group = new THREE.Group();
    // Model colour remains independent of the room rig; contact AO belongs on
    // the floor underneath it, while castShadow preserves the projected shadow.
    const baseMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.swatch), vertexColors: true });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x4d4c48, vertexColors: true });
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xe4dfd4, vertexColors: true });
    const greenMat = new THREE.MeshStandardMaterial({ color: 0x54765a, vertexColors: true });

    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material = baseMat) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true; // allow objects to cast a shadow
      mesh.receiveShadow = true; // allow object to get shadow from other objects
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
      rug.receiveShadow = false;
      group.add(rug);
    } else if (id === 'plant') {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.32, 18), baseMat);
      pot.position.y = 0.16;
      pot.castShadow = true;
      pot.receiveShadow = false;
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

    this.shadeModelFaces(group);
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
    textOutlinePx = themeMetric('dimension-text-outline-px'),
    targetPixelHeight = themeMetric('room-dimension-label-screen-px'),
    fontWeight = 700
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
    textOutlinePx?: number;
    targetPixelHeight?: number;
    fontWeight?: number;
  }) {
    const label = labelStyle === 'camera-card'
      ? this.createProductDimensionBadge(
          text,
          labelHeight,
          textOutlinePx,
          targetPixelHeight
        )
      : this.createMeasurementTextPlane(
          text,
          labelHeight,
          textOutlinePx,
          targetPixelHeight,
          fontWeight
        );

    const destination = parent ?? this.helperGroup;

    const draw = (points: THREE.Vector3[]) => {
      return parent
        ? this.makeLocalLine(
            parent,
            points,
            color,
            0.92,
            dashed,
            overlay,
            widthPx
          )
        : this.makeLine(
            points,
            color,
            0.92,
            dashed,
            overlay,
            widthPx
          );
    };

    const worldWidth =
      typeof label.userData.labelWorldWidth === 'number'
        ? label.userData.labelWorldWidth
        : labelHeight * 1.4;

    const length = start.distanceTo(end);

    const initialGap = Math.min(
      Math.max(worldWidth + 0.11, 0.16),
      length * 0.7
    );

    const direction = end.clone().sub(start).normalize();

    const mid = start
      .clone()
      .add(end)
      .multiplyScalar(0.5);

    const firstEnd = mid
      .clone()
      .addScaledVector(direction, -initialGap / 2);

    const secondStart = mid
      .clone()
      .addScaledVector(direction, initialGap / 2);

    const firstLine = draw([
      start,
      firstEnd
    ]);

    const secondLine = draw([
      secondStart,
      end
    ]);

    // Keep label centered on the measurement.
    label.position
      .copy(start)
      .add(end)
      .multiplyScalar(0.5);

    if (labelStyle === 'world') {
      label.userData.cameraFacingMeasurementLabel = true;

      label.userData.measurementStart = start.clone();
      label.userData.measurementEnd = end.clone();

      // Room dimensions use their own pair of Line2 objects.
      label.userData.dynamicMeasurementGap = true;
      label.userData.measurementGapStart = start.clone();
      label.userData.measurementGapEnd = end.clone();
      label.userData.measurementGapFirstLine = firstLine;
      label.userData.measurementGapSecondLine = secondLine;
      label.userData.measurementGapPaddingPx = 10;
    }

    destination.add(label);

    return label;
  }

  private updateMeasurementLineGaps() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);

    const projectedStart = new THREE.Vector3();
    const projectedEnd = new THREE.Vector3();

    const corner = new THREE.Vector3();

    this.camera.updateMatrixWorld(true);
    this.helperGroup.updateWorldMatrix(true, true);

    this.helperGroup.traverse((object) => {
      if (!object.userData.dynamicMeasurementGap) return;

      const start =
        object.userData.measurementGapStart as THREE.Vector3 | undefined;

      const end =
        object.userData.measurementGapEnd as THREE.Vector3 | undefined;

      const firstLine =
        object.userData.measurementGapFirstLine as Line2 | undefined;

      const secondLine =
        object.userData.measurementGapSecondLine as Line2 | undefined;

      if (!start || !end || !firstLine || !secondLine) return;

      const worldLength = start.distanceTo(end);

      if (worldLength < 1e-6) return;

      // --------------------------------------------------
      // Dimension line length in SCREEN pixels
      // --------------------------------------------------

      projectedStart.copy(start).project(this.camera);
      projectedEnd.copy(end).project(this.camera);

      const startPxX =
        (projectedStart.x * 0.5 + 0.5) * width;

      const startPxY =
        (-projectedStart.y * 0.5 + 0.5) * height;

      const endPxX =
        (projectedEnd.x * 0.5 + 0.5) * width;

      const endPxY =
        (-projectedEnd.y * 0.5 + 0.5) * height;

      const lineDx = endPxX - startPxX;
      const lineDy = endPxY - startPxY;

      const screenLineLength =
        Math.hypot(lineDx, lineDy);

      if (screenLineLength < 1e-4) return;

      const pixelsPerWorld =
        screenLineLength / worldLength;

      // Unit direction of dimension line on screen
      const screenDirX = lineDx / screenLineLength;
      const screenDirY = lineDy / screenLineLength;

      // --------------------------------------------------
      // Find the label's actual projected width ALONG
      // the dimension line.
      // --------------------------------------------------

      object.updateWorldMatrix(true, false);

      const aspect =
        Number(object.userData.labelAspect) || 1;

      const localCorners = [
        [-aspect / 2, -0.5],
        [ aspect / 2, -0.5],
        [ aspect / 2,  0.5],
        [-aspect / 2,  0.5]
      ];

      let minProjection = Infinity;
      let maxProjection = -Infinity;

      for (const [x, y] of localCorners) {
        corner
          .set(x, y, 0)
          .applyMatrix4(object.matrixWorld)
          .project(this.camera);

        const px =
          (corner.x * 0.5 + 0.5) * width;

        const py =
          (-corner.y * 0.5 + 0.5) * height;

        const projection =
          px * screenDirX +
          py * screenDirY;

        minProjection = Math.min(
          minProjection,
          projection
        );

        maxProjection = Math.max(
          maxProjection,
          projection
        );
      }

      const labelExtentPx =
        maxProjection - minProjection;

      const paddingPx =
        Number(
          object.userData.measurementGapPaddingPx
        ) || 10;

      // Full screen-space break needed around label
      const desiredGapPx =
        labelExtentPx + paddingPx * 2;

      // Convert back into world-space distance
      const desiredGapWorld =
        desiredGapPx / pixelsPerWorld;

      const gap = THREE.MathUtils.clamp(
        desiredGapWorld,
        0.12,
        worldLength * 0.72
      );

      // --------------------------------------------------
      // Update the two line pieces
      // --------------------------------------------------

      const direction =
        end.clone().sub(start).normalize();

      const mid =
        start.clone().add(end).multiplyScalar(0.5);

      const firstEnd =
        mid
          .clone()
          .addScaledVector(direction, -gap / 2);

      const secondStart =
        mid
          .clone()
          .addScaledVector(direction, gap / 2);

      (firstLine.geometry as LineGeometry).setPositions([
        start.x,
        start.y,
        start.z,

        firstEnd.x,
        firstEnd.y,
        firstEnd.z
      ]);

      (secondLine.geometry as LineGeometry).setPositions([
        secondStart.x,
        secondStart.y,
        secondStart.z,

        end.x,
        end.y,
        end.z
      ]);
    });
  }

  private updateSpacingMeasurementLines() {
    if (
      !this.spacingDimensionGroup?.visible ||
      !this.spacingDimensionLines
    ) {
      return;
    }

    const viewportWidth =
      Math.max(1, this.container.clientWidth);

    const viewportHeight =
      Math.max(1, this.container.clientHeight);

    const positions: number[] = [];

    const projectedStart = new THREE.Vector3();
    const projectedEnd = new THREE.Vector3();
    const corner = new THREE.Vector3();

    const addSegment = (
      a: THREE.Vector3,
      b: THREE.Vector3
    ) => {
      positions.push(
        a.x, a.y, a.z,
        b.x, b.y, b.z
      );
    };

    for (const label of this.spacingDimensionLabels.values()) {
      if (!label.visible) continue;

      const start = label.userData.measurementStart as THREE.Vector3 | undefined;

      const end = label.userData.measurementEnd as THREE.Vector3 | undefined;

      const measurementDirection = label.userData.spacingMeasurementDirection as THREE.Vector3 | undefined;

      if (!start || !end || !measurementDirection) {
        continue;
      }

      const worldLength =
        start.distanceTo(end);

      if (worldLength < 1e-6) {
        continue;
      }

      // --------------------------------------------------
      // Dimension line length on screen
      // --------------------------------------------------

      projectedStart
        .copy(start)
        .project(this.camera);

      projectedEnd
        .copy(end)
        .project(this.camera);

      const startPxX =
        (projectedStart.x * 0.5 + 0.5) *
        viewportWidth;

      const startPxY =
        (-projectedStart.y * 0.5 + 0.5) *
        viewportHeight;

      const endPxX =
        (projectedEnd.x * 0.5 + 0.5) *
        viewportWidth;

      const endPxY =
        (-projectedEnd.y * 0.5 + 0.5) *
        viewportHeight;

      const dx = endPxX - startPxX;
      const dy = endPxY - startPxY;

      const screenLength =
        Math.hypot(dx, dy);

      let gap = Math.min(
        0.2,
        worldLength * 0.7
      );

      if (screenLength > 1e-4) {
        const pixelsPerWorld =
          screenLength / worldLength;

        const screenDirX =
          dx / screenLength;

        const screenDirY =
          dy / screenLength;

        /*
        * Spacing labels use a fixed-size canvas/plane,
        * but the actual text may occupy only part of it.
        *
        * dynamicSpacingTextAspect therefore gives a more
        * accurate visible-text width than labelAspect.
        */
        const visibleAspect =
          Number(
            label.userData.dynamicSpacingTextAspect
          ) ||
          Number(label.userData.labelAspect) ||
          1;

        label.updateWorldMatrix(true, false);

        const localCorners = [
          [-visibleAspect / 2, -0.5],
          [ visibleAspect / 2, -0.5],
          [ visibleAspect / 2,  0.5],
          [-visibleAspect / 2,  0.5]
        ];

        let minProjection = Infinity;
        let maxProjection = -Infinity;

        for (const [x, y] of localCorners) {
          corner
            .set(x, y, 0)
            .applyMatrix4(label.matrixWorld)
            .project(this.camera);

          const px =
            (corner.x * 0.5 + 0.5) *
            viewportWidth;

          const py =
            (-corner.y * 0.5 + 0.5) *
            viewportHeight;

          const projection =
            px * screenDirX +
            py * screenDirY;

          minProjection =
            Math.min(
              minProjection,
              projection
            );

          maxProjection =
            Math.max(
              maxProjection,
              projection
            );
        }

        const visibleLabelWidthPx =
          maxProjection - minProjection;

        const paddingPx =
          Number(
            label.userData.spacingGapPaddingPx
          ) || 10;

        const desiredGapPx =
          visibleLabelWidthPx +
          paddingPx * 2;

        const desiredGapWorld =
          desiredGapPx / pixelsPerWorld;

        gap = THREE.MathUtils.clamp(
          desiredGapWorld,
          0.12,
          worldLength * 0.72
        );
      }

      // --------------------------------------------------
      // Main measurement line
      // --------------------------------------------------

      if (worldLength > gap + 0.04) {
        const direction =
          end
            .clone()
            .sub(start)
            .normalize();

        const mid =
          start
            .clone()
            .add(end)
            .multiplyScalar(0.5);

        addSegment(
          start,
          mid
            .clone()
            .addScaledVector(
              direction,
              -gap / 2
            )
        );

        addSegment(
          mid
            .clone()
            .addScaledVector(
              direction,
              gap / 2
            ),
          end
        );
      } else {
        // Gap is too short to draw useful side segments.
        // Leave only the end ticks visible.
        // addSegment(start, end);
      }

      // --------------------------------------------------
      // Spacing end ticks
      // Keep these independent from the dynamic gap.
      // --------------------------------------------------

      const perpendicular =
        new THREE.Vector3(
          -measurementDirection.z,
          0,
          measurementDirection.x
        ).multiplyScalar(0.05);

      addSegment(
        start.clone().sub(perpendicular),
        start.clone().add(perpendicular)
      );

      addSegment(
        end.clone().sub(perpendicular),
        end.clone().add(perpendicular)
      );
    }

    const geometry = this.spacingDimensionLines.geometry as LineSegmentsGeometry;

    if (positions.length) {
      geometry.setPositions(positions);
      this.spacingDimensionLines.visible = true;
    } else {
      this.spacingDimensionLines.visible = false;
    }
  }

  private configureAnnotationTexture(texture: THREE.CanvasTexture) {
    texture.colorSpace = THREE.SRGBColorSpace;
    // Mipmaps + anisotropy matter much more than raw canvas resolution when a
    // world-space label is seen at a steep angle. This avoids the alternating
    // pixelated/blurry look of plain bilinear filtering while keeping labels cheap.
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = Math.min(12, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  }

  private drawOutlinedAnnotationText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, outlinePx: number, fillStyle: string) {
    // A two-stage halo gives small labels a cleaner edge than one very thick stroke.
    // outlinePx <= 0 intentionally disables the halo (used for room dimensions).
    if (outlinePx > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.98)';
      ctx.lineWidth = outlinePx + 2;
      ctx.strokeText(text, x, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.98)';
      ctx.lineWidth = outlinePx;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = fillStyle;
    ctx.fillText(text, x, y);
  }

  private createMeasurementTextPlane(text: string, height: number, outlinePx: number = themeMetric('dimension-text-outline-px'), targetPixelHeight: number = themeMetric('room-dimension-label-screen-px'), fontWeight = 700) {
    const fontPx = themeMetric('dimension-texture-font-px');
    const textureScale = 2;
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `${fontWeight} ${fontPx}px Inter, system-ui, sans-serif`;
    const measuredWidth = Math.ceil(probe.measureText(text).width);
    const paddingX = 14 + outlinePx * 2;
    const paddingY = 10 + outlinePx * 2;
    const logicalWidth = Math.max(72, measuredWidth + paddingX * 2);
    const logicalHeight = Math.max(84, fontPx + paddingY * 2);

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(logicalWidth * textureScale);
    canvas.height = Math.ceil(logicalHeight * textureScale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(textureScale, textureScale);
    ctx.clearRect(0, 0, logicalWidth, logicalHeight);
    ctx.font = `${fontWeight} ${fontPx}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const textHex = `#${DIMENSION_TEXT_COLOR.toString(16).padStart(6, '0')}`;
    this.drawOutlinedAnnotationText(ctx, text, logicalWidth / 2, logicalHeight / 2 + 1, outlinePx, textHex);

    const texture = this.configureAnnotationTexture(new THREE.CanvasTexture(canvas));
    const aspect = logicalWidth / logicalHeight;
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
    // Text remains in world space but draws after the scene and selection outline.
    plane.layers.set(ANNOTATION_TEXT_LAYER);
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
    const textureScale = 2;
    const paddingX = themeMetric('product-dimension-card-padding-x-px');
    const paddingY = themeMetric('product-dimension-card-padding-y-px');
    const radius = themeMetric('product-dimension-card-radius-px');
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `700 ${fontPx}px Inter, system-ui, sans-serif`;
    const measuredWidth = Math.ceil(probe.measureText(text).width);
    const logicalWidth = Math.max(88, measuredWidth + paddingX * 2 + outlinePx * 2);
    const logicalHeight = Math.max(84, fontPx + paddingY * 2 + outlinePx * 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(logicalWidth * textureScale);
    canvas.height = Math.ceil(logicalHeight * textureScale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(textureScale, textureScale);
    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const cardInset = 2;
    ctx.beginPath();
    ctx.roundRect(cardInset, cardInset, logicalWidth - cardInset * 2, logicalHeight - cardInset * 2, radius);
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
    this.drawOutlinedAnnotationText(
      ctx,
      text,
      logicalWidth / 2,
      logicalHeight / 2 + 1,
      outlinePx,
      `#${DIMENSION_TEXT_COLOR.toString(16).padStart(6, '0')}`
    );

    const texture = this.configureAnnotationTexture(new THREE.CanvasTexture(canvas));
    const aspect = logicalWidth / logicalHeight;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(height * aspect, height, 1);
    // Product badges keep their existing Sprite behaviour on the text layer.
    sprite.layers.set(ANNOTATION_TEXT_LAYER);
    sprite.userData.measurementLabel = true;
    sprite.userData.labelAspect = aspect;
    sprite.userData.labelWorldWidth = height * aspect;
    sprite.userData.targetPixelHeight = targetPixelHeight;
    sprite.renderOrder = 31;
    return sprite;
  }

  /**
   * Keep room/spacing labels readable without turning them into billboards.
   * Their yaw/baseline remains attached to the dimension line. We preserve the
   * camera-based 180° upright flip, then rotate only around the label's local X
   * axis so its face can pitch toward the camera.
   */
  private updateMeasurementLabelOrientation() {
    const projectedStart = new THREE.Vector3();
    const projectedEnd = new THREE.Vector3();

    const cameraWorldQuaternion = new THREE.Quaternion();
    const desiredWorldQuaternion = new THREE.Quaternion();
    const parentWorldQuaternion = new THREE.Quaternion();
    const inverseParentQuaternion = new THREE.Quaternion();

    const rollQuaternion = new THREE.Quaternion();
    const localZAxis = new THREE.Vector3(0, 0, 1);

    this.camera.updateMatrixWorld(true);
    this.camera.getWorldQuaternion(cameraWorldQuaternion);

    this.helperGroup.updateWorldMatrix(true, true);

    this.helperGroup.traverse((object) => {
      if (!object.userData.cameraFacingMeasurementLabel) return;
      if (!object.visible) return;

      const start =
        object.userData.measurementStart as THREE.Vector3 | undefined;

      const end =
        object.userData.measurementEnd as THREE.Vector3 | undefined;

      if (!start || !end) return;

      projectedStart.copy(start).project(this.camera);
      projectedEnd.copy(end).project(this.camera);

      const dx = projectedEnd.x - projectedStart.x;
      const dy = projectedEnd.y - projectedStart.y;

      if (dx * dx + dy * dy < 1e-10) return;

      // Treat a dimension line as directionless:
      // 0° and 180° represent the same line.
      let lineAngle = Math.atan2(dy, dx);

      lineAngle = THREE.MathUtils.euclideanModulo(
        lineAngle,
        Math.PI
      );

      const maxRoll =
        THREE.MathUtils.degToRad(30);

      // Instead of flipping instantly at 90°, transition smoothly
      // from +30° to -30° around the vertical position.
      const vertical =
        Math.PI / 2;

      const transitionWidth =
        THREE.MathUtils.degToRad(18);

      let readableAngle: number;

      if (lineAngle < vertical - transitionWidth) {
        readableAngle = Math.min(
          lineAngle,
          maxRoll
        );
      } else if (lineAngle > vertical + transitionWidth) {
        const oppositeAngle =
          lineAngle - Math.PI;

        readableAngle = Math.max(
          oppositeAngle,
          -maxRoll
        );
      } else {
        // Smooth transition through the "straight" / vertical point.
        const t = THREE.MathUtils.smoothstep(
          lineAngle,
          vertical - transitionWidth,
          vertical + transitionWidth
        );

        readableAngle = THREE.MathUtils.lerp(
          maxRoll,
          -maxRoll,
          t
        );
      }

      // Face camera.
      desiredWorldQuaternion.copy(
        cameraWorldQuaternion
      );

      // Apply readable screen-space roll.
      rollQuaternion.setFromAxisAngle(
        localZAxis,
        readableAngle
      );

      desiredWorldQuaternion.multiply(
        rollQuaternion
      );

      // Convert world orientation into local orientation.
      if (object.parent) {
        object.parent.getWorldQuaternion(
          parentWorldQuaternion
        );

        inverseParentQuaternion
          .copy(parentWorldQuaternion)
          .invert();

        object.quaternion
          .copy(inverseParentQuaternion)
          .multiply(desiredWorldQuaternion);
      } else {
        object.quaternion.copy(
          desiredWorldQuaternion
        );
      }
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
      const targetPixels = Number(object.userData.targetPixelHeight) || themeMetric('room-dimension-label-screen-px');
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
    return JSON.stringify({
      selectedId: snapshot.selectedId ?? null,
      selectedProduct: selected?.productId ?? null,
      showClearance: !!snapshot.showClearance,
      showRoomDimensions: !!snapshot.showRoomDimensions,
      showProductDimensions: !!snapshot.showProductDimensions,
      showSpacingDimensions: !!snapshot.showSpacingDimensions,
      measurementSystem: snapshot.measurementSystem ?? 'metric',
      roomDimensionState: snapshot.showRoomDimensions ? {
        height: snapshot.room.height,
        vertices: snapshot.room.vertices.map((vertex) => [vertex.x, vertex.z]),
        hidden: snapshot.showRoomDimensions ? [...this.wallHiddenState.entries()] : null
      } : null
    });
  }

  private spacingHelperStateKey(snapshot: SceneSnapshot) {
    if (!snapshot.showSpacingDimensions || !snapshot.selectedId || !this.options.showFurniture) return 'off';
    return JSON.stringify({
      selectedId: snapshot.selectedId,
      objects: snapshot.objects.map((object) => [object.id, object.productId, object.x, object.z, object.rotationY]),
      room: snapshot.room.vertices.map((vertex) => [vertex.x, vertex.z]),
      measurementSystem: snapshot.measurementSystem ?? 'metric'
    });
  }

  private snapHelperStateKey(snapshot: SceneSnapshot) {
    const snap = snapshot.activeSnap;
    if (!snap || snap.kind === 'none') return 'off';
    return JSON.stringify(snap);
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

  private removeHelperRole(role: string) {
    const matches = this.helperGroup.children.filter((object): object is THREE.Group => (
      object instanceof THREE.Group && object.userData.helperRole === role
    ));
    for (const group of matches) {
      this.helperGroup.remove(group);
      this.disposeGroup(group);
    }
  }

  private rebuildRoomDimensionHelpers(snapshot: SceneSnapshot) {
    this.removeHelperRole('roomDimensions');
    if (snapshot.showRoomDimensions) this.addRoomDimensions(snapshot, snapshot.measurementSystem ?? 'metric');
    this.updateRoomDimensionVisibility();
  }

  private rebuildSnapHelpers(snapshot: SceneSnapshot) {
    this.removeHelperRole('snapGuides');
    const snap = snapshot.activeSnap;
    if (!snap || snap.kind === 'none') return;

    const parent = new THREE.Group();
    parent.userData.helperRole = 'snapGuides';
    const bounds = roomBounds(snapshot.room.vertices);
    if (snap.x) {
      this.makeLocalLine(parent, [
        new THREE.Vector3(snap.x.value, 0.025, bounds.minZ),
        new THREE.Vector3(snap.x.value, 0.025, bounds.maxZ)
      ], SELECTION_COLOR, 0.72, true, true);
    }
    if (snap.z) {
      this.makeLocalLine(parent, [
        new THREE.Vector3(bounds.minX, 0.025, snap.z.value),
        new THREE.Vector3(bounds.maxX, 0.025, snap.z.value)
      ], SELECTION_COLOR, 0.72, true, true);
    }
    this.helperGroup.add(parent);
  }

  private rebuildHelpers(snapshot: SceneSnapshot) {
    this.spacingDimensionGroup = null;
    this.spacingDimensionLines = null;
    this.spacingDimensionLabels.clear();
    this.disposeGroup(this.helperGroup);
    const system = snapshot.measurementSystem ?? 'metric';

    if (snapshot.showRoomDimensions) this.addRoomDimensions(snapshot, system);
    this.updateRoomDimensionVisibility();

    if (!snapshot.selectedId || !this.options.showFurniture) return;
    const selected = snapshot.objects.find((o) => o.id === snapshot.selectedId);
    if (!selected) return;

    if (snapshot.showClearance) this.addClearanceGuide(selected);
    if (snapshot.showProductDimensions) this.addProductDimensions(selected, system);
    if (snapshot.showSpacingDimensions) this.syncSpacingHelpers(snapshot);
    this.rebuildSnapHelpers(snapshot);
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
    const parent = new THREE.Group();
    parent.userData.helperRole = 'roomDimensions';

    for (const wall of getRoomWalls(snapshot.room)) {
      const hidden = this.wallHiddenState.get(wall.id) ?? false;
      const outward = new THREE.Vector3(-wall.inward.x, 0, -wall.inward.z);
      const tangent = new THREE.Vector3(wall.tangent.x, 0, wall.tangent.z);
      // Keep room dimensions tucked close to the wall shell so the diagonal end
      // marks nearly kiss the face, matching the product references more closely.
      const offset = hidden ? 0.11 : 0.095;
      const dimensionY = hidden ? -0.08 : snapshot.room.height + 0.045; // lower = farther down
      const start = new THREE.Vector3(wall.start.x + outward.x * offset, dimensionY, wall.start.z + outward.z * offset);
      const end = new THREE.Vector3(wall.end.x + outward.x * offset, dimensionY, wall.end.z + outward.z * offset);

      this.addLabelledMeasurementLine({
        parent,
        start,
        end,
        text: this.annotationLength(wall.length, system),
        color: DIMENSION_COLOR,
        widthPx: 1.55,
        dashed: false,
        overlay: true,
        labelHeight: themeMetric('dimension-label-height'),
        // Room dimensions are intentionally plain dark text. Spacing/product
        // dimensions retain their white halo for contrast over furniture/floors.
        textOutlinePx: 0,
        targetPixelHeight: themeMetric('room-dimension-label-screen-px'),
        fontWeight: 500
      });

      const witness = outward.clone().multiplyScalar(0.068);
      this.makeLocalLine(parent, [start.clone().sub(witness), start.clone().add(witness)], DIMENSION_COLOR, 0.95, false, true, 1.3);
      this.makeLocalLine(parent, [end.clone().sub(witness), end.clone().add(witness)], DIMENSION_COLOR, 0.95, false, true, 1.3);

      const tickDirection = tangent.clone().add(outward).normalize().multiplyScalar(0.052);
      this.makeLocalLine(parent, [start.clone().sub(tickDirection), start.clone().add(tickDirection)], DIMENSION_COLOR, 0.95, false, true, 1.45);
      this.makeLocalLine(parent, [end.clone().sub(tickDirection), end.clone().add(tickDirection)], DIMENSION_COLOR, 0.95, false, true, 1.45);
    }

    this.helperGroup.add(parent);
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

  private createDynamicSpacingLabel(initialText: string) {
    const logicalWidth = 360;
    const logicalHeight = 108;
    const canvas = document.createElement('canvas');
    canvas.width = logicalWidth;
    canvas.height = logicalHeight;
    const ctx = canvas.getContext('2d')!;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Dynamic spacing labels can change several times per second while dragging.
    // Mipmap regeneration is unnecessary at their ~30 px display size and was one
    // of the biggest sources of GPU upload stalls in the old rebuild path.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    const aspect = logicalWidth / logicalHeight;
    const geometry = new THREE.PlaneGeometry(aspect, 1);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    const label = new THREE.Mesh(geometry, material);
    label.layers.set(ANNOTATION_TEXT_LAYER);
    label.userData.measurementLabel = true;
    label.userData.labelAspect = aspect;
    label.userData.labelWorldWidth = themeMetric('dimension-label-height') * aspect;
    label.userData.targetPixelHeight = themeMetric('spacing-dimension-label-screen-px');
    label.scale.set(themeMetric('dimension-label-height'), themeMetric('dimension-label-height'), 1);
    label.userData.dynamicSpacingCanvas = canvas;
    label.userData.dynamicSpacingContext = ctx;
    label.userData.dynamicSpacingTexture = texture;
    label.userData.dynamicSpacingText = '';
    label.renderOrder = 30;
    this.updateDynamicSpacingLabel(label, initialText);
    return label;
  }

  private updateDynamicSpacingLabel(label: THREE.Mesh, text: string) {
    if (label.userData.dynamicSpacingText === text) return;
    const canvas = label.userData.dynamicSpacingCanvas as HTMLCanvasElement | undefined;
    const ctx = label.userData.dynamicSpacingContext as CanvasRenderingContext2D | undefined;
    const texture = label.userData.dynamicSpacingTexture as THREE.CanvasTexture | undefined;
    if (!canvas || !ctx || !texture) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fontPx = 58;
    ctx.font = `700 ${fontPx}px Inter, system-ui, sans-serif`;
    const measuredTextWidth = ctx.measureText(text).width;
    label.userData.dynamicSpacingTextAspect = Math.min(
      canvas.width / canvas.height,
      (measuredTextWidth + themeMetric('spacing-dimension-text-outline-px') * 4 + 24) / canvas.height
    );
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    this.drawOutlinedAnnotationText(
      ctx,
      text,
      canvas.width / 2,
      canvas.height / 2 + 1,
      themeMetric('spacing-dimension-text-outline-px'),
      `#${DIMENSION_TEXT_COLOR.toString(16).padStart(6, '0')}`
    );
    label.userData.dynamicSpacingText = text;
    texture.needsUpdate = true;
  }

  private ensureSpacingHelpers() {
    if (this.spacingDimensionGroup && this.spacingDimensionLines) return;

    const parent = new THREE.Group();
    parent.userData.helperRole = 'spacingDimensions';

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions([0, 0, 0, 0, 0, 0]);
    const material = new LineMaterial({
      color: SPACING_COLOR,
      linewidth: 1.65,
      transparent: false,
      opacity: 1,
      dashed: false,
      depthTest: false,
      depthWrite: false,
      worldUnits: false
    });
    this.lineResolution(material);
    const lines = new LineSegments2(geometry, material);
    lines.renderOrder = 24;
    lines.visible = false;
    parent.add(lines);

    for (const side of ['front', 'back', 'left', 'right'] as const) {
      const label = this.createDynamicSpacingLabel('0 cm');
      label.visible = false;
      label.userData.spacingSide = side;
      parent.add(label);
      this.spacingDimensionLabels.set(side, label);
    }

    this.spacingDimensionGroup = parent;
    this.spacingDimensionLines = lines;
    this.helperGroup.add(parent);
  }

  
  private syncSpacingHelpers(snapshot: SceneSnapshot) {
    if (
      !snapshot.showSpacingDimensions ||
      !snapshot.selectedId ||
      !this.options.showFurniture
    ) {
      if (this.spacingDimensionGroup) {
        this.spacingDimensionGroup.visible = false;
      }

      return;
    }

    const selected = snapshot.objects.find(
      (object) => object.id === snapshot.selectedId
    );

    if (!selected) return;

    this.ensureSpacingHelpers();

    const parent = this.spacingDimensionGroup!;

    parent.visible = true;

    for (const label of this.spacingDimensionLabels.values()) {
      label.visible = false;
    }

    const system =
      snapshot.measurementSystem ?? 'metric';

    const others = snapshot.objects.filter(
      (object) => object.id !== selected.id
    );

    const measurements = spacingMeasurements(
      selected,
      snapshot.room,
      others
    );

    for (const measurement of measurements) {
      const origin = new THREE.Vector3(
        measurement.origin.x,
        0.075,
        measurement.origin.z
      );

      const end = new THREE.Vector3(
        measurement.end.x,
        0.075,
        measurement.end.z
      );

      const label =
        this.spacingDimensionLabels.get(
          measurement.side
        )!;

      const text = formatLength(
        measurement.distance,
        system
      );

      this.updateDynamicSpacingLabel(
        label,
        text
      );

      label.visible = true;

      label.position
        .copy(origin)
        .add(end)
        .multiplyScalar(0.5);

      // Same orientation system as room dimensions.
      label.userData.cameraFacingMeasurementLabel = true;

      const storedStart =
        (
          label.userData.measurementStart as THREE.Vector3 | undefined
        ) ?? new THREE.Vector3();

      const storedEnd =
        (
          label.userData.measurementEnd as THREE.Vector3 | undefined
        ) ?? new THREE.Vector3();

      const storedDirection =
        (
          label.userData.spacingMeasurementDirection as THREE.Vector3 | undefined
        ) ?? new THREE.Vector3();

      storedStart.copy(origin);
      storedEnd.copy(end);

      storedDirection.set(
        measurement.direction.x,
        0,
        measurement.direction.z
      );

      label.userData.measurementStart =
        storedStart;

      label.userData.measurementEnd =
        storedEnd;

      label.userData.spacingMeasurementDirection =
        storedDirection;

      label.userData.spacingGapPaddingPx = 10;
    }

    // Spacing uses its shared LineSegments geometry,
    // separate from the room-dimension Line2 implementation.
    this.updateSpacingMeasurementLines();
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
      // The Cutaway view system hides these foreground walls; don't let their invisible planes steal dragging.
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

  private dragMappingFor(selected: PlacedObject) {
    this.camera.updateMatrixWorld(true);

    const right3 = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up3 = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const forward3 = this.controls.target.clone().sub(this.camera.position);
    const rightLength = Math.hypot(right3.x, right3.z);
    const projectedUpLength = Math.hypot(up3.x, up3.z);
    const projectedForwardLength = Math.hypot(forward3.x, forward3.z);

    const screenRight: Vec2 = rightLength > 1e-5
      ? { x: right3.x / rightLength, z: right3.z / rightLength }
      : { x: 1, z: 0 };

    let screenUp: Vec2;
    let verticalProjection = projectedUpLength;
    if (projectedUpLength > 0.08) {
      screenUp = { x: up3.x / projectedUpLength, z: up3.z / projectedUpLength };
    } else if (projectedForwardLength > 1e-5) {
      // At near eye-level views the camera's visual up vector is almost vertical,
      // so it carries no useful X/Z movement. Continue the screen-Y gesture into
      // room depth instead of collapsing the drag to a single horizontal axis.
      screenUp = { x: forward3.x / projectedForwardLength, z: forward3.z / projectedForwardLength };
      verticalProjection = 0.38;
    } else {
      screenUp = { x: -screenRight.z, z: screenRight.x };
      verticalProjection = 1;
    }

    // OrbitControls does not roll the camera, but orthogonalizing here makes the
    // drag basis stable even if that ever changes or a preset introduces tiny drift.
    const dot = screenUp.x * screenRight.x + screenUp.z * screenRight.z;
    screenUp = { x: screenUp.x - screenRight.x * dot, z: screenUp.z - screenRight.z * dot };
    const upLength = Math.hypot(screenUp.x, screenUp.z);
    if (upLength > 1e-5) {
      screenUp.x /= upLength;
      screenUp.z /= upLength;
    } else {
      screenUp = { x: -screenRight.z, z: screenRight.x };
    }

    const product = PRODUCTS[selected.productId];
    const anchor = new THREE.Vector3(selected.x, Math.max(0.04, product.height * 0.45), selected.z);
    const cameraSpace = anchor.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const depth = Math.max(0.35, -cameraSpace.z);
    const viewportHeight = Math.max(1, this.container.clientHeight);
    const worldPerPixel = (2 * depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))) / viewportHeight;

    return {
      screenRight,
      screenUp,
      worldPerPixelX: worldPerPixel / Math.max(0.45, rightLength),
      worldPerPixelY: worldPerPixel / Math.max(0.32, verticalProjection)
    };
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
      // Shift+empty-space is the inspection gesture: OrbitControls receives the
      // pointer-down, but the active furniture remains selected so its dimensions
      // stay visible while orbiting to another side.
      if (!event.shiftKey) this.bridge.select(null);
      return;
    }
    const before = structuredClone(this.bridge.getSnapshot()) as PlannerSnapshot;
    this.bridge.select(id);
    const selected = this.bridge.getSnapshot().objects.find((object) => object.id === id);
    if (!selected) return;
    const mapping = this.dragMappingFor(selected);
    this.dragging = {
      id,
      before,
      snap: { kind: 'none' },
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: selected.x,
      startZ: selected.z,
      ...mapping
    };
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
      const snapshot = this.bridge.getSnapshot();
      const moving = snapshot.objects.find((o) => o.id === this.dragging!.id);
      if (!moving) return;

      const dxPixels = event.clientX - this.dragging.startClientX;
      const dyPixels = this.dragging.startClientY - event.clientY;
      const rightDistance = dxPixels * this.dragging.worldPerPixelX;
      const upDistance = dyPixels * this.dragging.worldPerPixelY;
      const rawX = this.dragging.startX
        + this.dragging.screenRight.x * rightDistance
        + this.dragging.screenUp.x * upDistance;
      const rawZ = this.dragging.startZ
        + this.dragging.screenRight.z * rightDistance
        + this.dragging.screenUp.z * upDistance;

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
        this.requestRender();
      }
      this.bridge.updateObject(moving.id, patch);
      // Keep every moving annotation on the same immediate path as the mesh rather
      // than waiting for the store subscription's next RAF. Spacing helpers are now
      // persistent, so this is an in-place buffer/canvas update rather than a rebuild.
      const liveSnapshot = this.bridge.getSnapshot();
      this.syncHelperTransforms(liveSnapshot);
      if (liveSnapshot.showSpacingDimensions) {
        this.syncSpacingHelpers(liveSnapshot);
        this.lastSpacingHelperKey = this.spacingHelperStateKey(liveSnapshot);
      }
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
        this.requestRender();
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
    const snapshot = this.bridge.getSnapshot();
    this.syncSpacingHelpers(snapshot);
    this.lastSpacingHelperKey = this.spacingHelperStateKey(snapshot);
    this.rebuildSnapHelpers(snapshot);
    this.lastSnapHelperKey = this.snapHelperStateKey(snapshot);
    this.requestRender();
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
    this.requestRender();
  }

  private leavePresetForManualNavigation() {
    if (this.currentCameraView === 'perspective') return;
    // Camera presets are transient presentation views. An actual orbit returns
    // to free Cutaway view behavior without moving the camera to the default position.
    // Zoom/pan preserve the preset; pointer interaction with furniture cannot exit it.
    this.currentCameraView = 'perspective';
    this.bridge.cameraViewChanged?.('perspective');
    this.updateCeilingVisibility(true);
    this.updateCutawayWalls(true);
  }

  private onControlsChange = () => {
    if (this.controlsInteracting && this.currentCameraView !== 'perspective') {
      const currentDirection = this.camera.position.clone().sub(this.controls.target);
      if (currentDirection.lengthSq() > 1e-8 && this.controlsInteractionStartDirection.lengthSq() > 1e-8) {
        currentDirection.normalize();
        // Zoom changes only the radius and pan moves camera + target together, so
        // neither meaningfully changes this direction. Orbit does. Use a tiny
        // angular tolerance to ignore floating-point drift while preserving presets
        // during wheel zoom and right-button panning.
        const orbitThreshold = THREE.MathUtils.degToRad(0.12);
        const dot = THREE.MathUtils.clamp(currentDirection.dot(this.controlsInteractionStartDirection), -1, 1);
        if (dot < Math.cos(orbitThreshold)) this.leavePresetForManualNavigation();
      }
    }
    this.requestRender();
  };
  private onControlsStart = () => {
    this.controlsInteracting = true;
    this.controlsInteractionStartDirection.copy(this.camera.position).sub(this.controls.target);
    if (this.controlsInteractionStartDirection.lengthSq() > 1e-8) this.controlsInteractionStartDirection.normalize();
    this.requestRender();
  };
  private onControlsEnd = () => {
    this.controlsInteracting = false;
    this.requestRender();
  };

  private requestRender = () => {
    if (this.disposed || this.animationFrame) return;
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private animate = () => {
    this.animationFrame = 0;
    if (this.disposed) return;
    const controlsChanged = this.controls.update();
    this.updateCeilingVisibility();
    this.updateCutawayWalls();
    this.updateMeasurementLabelOrientation();
    this.updateMeasurementLabelScale();
    this.updateMeasurementLineGaps();
    this.updateSpacingMeasurementLines();

    // Native MSAA keeps ordinary room geometry and floor textures crisp. Only a
    // selected product needs the composer's outline pass.
    this.camera.layers.set(SCENE_LAYER);
    if (this.outlinePass.selectedObjects.length) this.composer.render();
    else this.renderer.render(this.scene, this.camera);

    const previousAutoClear = this.renderer.autoClear;
    const previousBackground = this.scene.background;
    const previousCameraLayerMask = this.camera.layers.mask;
    try {
      this.renderer.autoClear = false;
      // Three.js WebGLBackground force-clears when Scene.background is a Color,
      // even if autoClear is false. Temporarily suppress only the background for
      // the annotation overlay so the completed 3D frame is preserved.
      this.scene.background = null;
      this.camera.layers.set(ANNOTATION_TEXT_LAYER);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.camera.layers.mask = previousCameraLayerMask;
      this.scene.background = previousBackground;
      this.renderer.autoClear = previousAutoClear;
    }

    // OrbitControls damping needs a few follow-up frames, but an idle scene should do
    // no RAF/GPU work at all. `change` events also schedule a frame during interaction.
    if (this.controlsInteracting || controlsChanged) this.requestRender();
  };
}
