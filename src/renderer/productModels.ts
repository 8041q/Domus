import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Shared geometry/materials belong to this library, never to placed instances. */
export class ProductModelLibrary {
  private requests = new Map<string, Promise<THREE.Group>>();
  private templates = new Set<THREE.Group>();
  private templatesByUrl = new Map<string, THREE.Group>();
  private disposed = false;

  constructor(private load = async (url: string) => {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    return (await new GLTFLoader().loadAsync(url)).scene;
  }) {}

  loadModel(url: string): Promise<THREE.Group> {
    let request = this.requests.get(url);
    if (!request) {
      request = this.load(url).then((scene) => {
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
        template.traverse((node) => {
          node.userData.sharedProductAsset = true;
          if (node instanceof THREE.Mesh) {
            node.castShadow = true;
            node.receiveShadow = true;
          }
        });
        this.templatesByUrl.set(url, template);
        return template;
      });
      this.requests.set(url, request);
    }
    return request;
  }

  instantiate(template: THREE.Group) {
    if (this.disposed) throw new Error('Model library was disposed.');
    return clone(template) as THREE.Group;
  }

  retry(url: string) { this.requests.delete(url); }

  releaseModel(url: string) {
    this.requests.delete(url);
    const template = this.templatesByUrl.get(url);
    if (template) this.release(template);
  }

  dispose() {
    this.disposed = true;
    for (const template of this.templates) this.release(template);
    this.requests.clear();
    this.templatesByUrl.clear();
  }

  private release(template: THREE.Group) {
    const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
    template.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      resources.add(node.geometry);
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        resources.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.add(value);
      }
    });
    for (const resource of resources) resource.dispose();
    const bitmaps = new Set<{ close: () => void }>();
    for (const resource of resources) if (resource instanceof THREE.Texture && typeof resource.image?.close === 'function') bitmaps.add(resource.image);
    for (const bitmap of bitmaps) bitmap.close();
    template.clear();
    this.templates.delete(template);
    for (const [url, loaded] of this.templatesByUrl) if (loaded === template) this.templatesByUrl.delete(url);
  }
}
