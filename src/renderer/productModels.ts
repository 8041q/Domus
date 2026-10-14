import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { ModelPicking } from './modelPicking';

// Model-only bounced light: keep pale finishes legible against the brighter shell.
export const PRODUCT_ENVIRONMENT_INTENSITY = 0.85;

/** Shared geometry/materials belong to this library, never to placed instances. */
export class ProductModelLibrary {
  private requests = new Map<string, Promise<THREE.Group>>();
  private templates = new Set<THREE.Group>();
  private templatesByUrl = new Map<string, THREE.Group>();
  private disposed = false;
  private picking = new ModelPicking();
  private environment: THREE.Texture | null = null;
  private environmentIntensity = PRODUCT_ENVIRONMENT_INTENSITY;
  private originalEnvironments = new WeakMap<THREE.MeshStandardMaterial, { map: THREE.Texture | null; intensity: number }>();

  constructor(private load = async (url: string) => {
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js')
    ]);
    return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url)).scene;
  }) {}

  loadModel(url: string): Promise<THREE.Group> {
    let request = this.requests.get(url);
    if (!request) {
      request = this.load(url).then(async (scene) => {
        const template = new THREE.Group();
        template.add(scene);
        this.templates.add(template);
        if (this.disposed || this.requests.get(url) !== request) {
          this.release(template);
          throw new Error('Model library was disposed or this asset was replaced.');
        }
        scene.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(scene, true);
        if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
          this.release(template);
          throw new Error('The GLB contains no usable geometry.');
        }
        const centre = bounds.getCenter(new THREE.Vector3());
        // Keep the export's metre scale, proportions and relative node transforms.
        // Move its complete scene so off-centre origins do not affect placement.
        template.position.set(-centre.x, -bounds.min.y, -centre.z);
        const pickingMeshes: THREE.Mesh[] = [];
        template.traverse((node) => {
          node.userData.sharedProductAsset = true;
          if (node instanceof THREE.Mesh) {
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            node.castShadow = materials.some((material) => material.visible && !material.transparent
              && (!(material instanceof THREE.MeshPhysicalMaterial) || material.transmission === 0));
            node.receiveShadow = true;
            const geometry = node.geometry;
            const triangleCount = (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3;
            // Preserve authored index order and exports. Small procedural parts
            // do not benefit from paying the cost of building a tree.
            if (!(node instanceof THREE.SkinnedMesh) && !Object.keys(geometry.morphAttributes).length && triangleCount >= 1000) {
              pickingMeshes.push(node);
            }
          }
        });
        try {
          for (const mesh of pickingMeshes) {
            if (this.disposed || this.requests.get(url) !== request) throw new Error('Model library was disposed or this asset was replaced.');
            mesh.geometry.boundsTree ??= await this.picking.build(mesh.geometry);
            mesh.raycast = acceleratedRaycast;
          }
          if (this.disposed || this.requests.get(url) !== request) throw new Error('Model library was disposed or this asset was replaced.');
        } catch (error) { this.release(template); throw error; }
        this.applyEnvironment(template);
        this.templatesByUrl.set(url, template);
        return template;
      });
      this.requests.set(url, request);
    }
    return request;
  }

  instantiate(template: THREE.Group) {
    if (this.disposed) throw new Error('Model library was disposed.');
    const instance = clone(template) as THREE.Group;
    // Object3D.clone does not copy an instance's custom raycast function.
    instance.traverse((node) => {
      if (node instanceof THREE.Mesh && node.geometry.boundsTree && !(node instanceof THREE.SkinnedMesh)
        && !Object.keys(node.geometry.morphAttributes).length) node.raycast = acceleratedRaycast;
    });
    return instance;
  }

  retry(url: string) { this.requests.delete(url); }

  /** The renderer owns this texture; imported asset resources remain library-owned. */
  setEnvironment(texture: THREE.Texture | null, intensity = PRODUCT_ENVIRONMENT_INTENSITY) {
    if (this.environment === texture && this.environmentIntensity === intensity) return;
    this.environment = texture;
    this.environmentIntensity = intensity;
    for (const template of this.templates) this.applyEnvironment(template);
  }

  cloneForExport(material: THREE.Material) {
    const exported = material.clone();
    if (material instanceof THREE.MeshStandardMaterial && exported instanceof THREE.MeshStandardMaterial) {
      const original = this.originalEnvironments.get(material);
      if (original) {
        exported.envMap = original.map;
        exported.envMapIntensity = original.intensity;
      }
    }
    return exported;
  }

  private applyEnvironment(template: THREE.Group) {
    template.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        let original = this.originalEnvironments.get(material);
        if (!original) {
          original = { map: material.envMap, intensity: material.envMapIntensity };
          this.originalEnvironments.set(material, original);
        }
        // Explicit asset environment maps take precedence over the viewport fallback.
        const map = original.map ?? this.environment;
        if (material.envMap !== map) {
          material.envMap = map;
          material.needsUpdate = true;
        }
        material.envMapIntensity = !original.map && this.environment ? this.environmentIntensity : original.intensity;
      }
    });
  }

  releaseModel(url: string) {
    this.requests.delete(url);
    const template = this.templatesByUrl.get(url);
    if (template) this.release(template);
  }

  dispose() {
    this.disposed = true;
    this.picking.dispose();
    for (const template of this.templates) this.release(template);
    this.requests.clear();
    this.templatesByUrl.clear();
    this.environment = null;
  }

  private release(template: THREE.Group) {
    const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
    template.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      resources.add(node.geometry);
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (material instanceof THREE.MeshStandardMaterial) {
          const original = this.originalEnvironments.get(material);
          if (original) {
            material.envMap = original.map;
            material.envMapIntensity = original.intensity;
          }
        }
        resources.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.add(value);
      }
    });
    for (const resource of resources) {
      if (resource instanceof THREE.BufferGeometry) resource.boundsTree = undefined;
      resource.dispose();
    }
    const bitmaps = new Set<{ close: () => void }>();
    for (const resource of resources) if (resource instanceof THREE.Texture && typeof resource.image?.close === 'function') bitmaps.add(resource.image);
    for (const bitmap of bitmaps) bitmap.close();
    template.clear();
    this.templates.delete(template);
    for (const [url, loaded] of this.templatesByUrl) if (loaded === template) this.templatesByUrl.delete(url);
  }
}
