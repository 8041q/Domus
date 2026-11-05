import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const requests = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();
let renderer: THREE.WebGLRenderer | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;

/** Serialize captures through one temporary WebGL context. Cache the generated
 * PNG by immutable asset revision, including across browser reloads. */
export function modelThumbnail(url: string): Promise<string> {
  const existing = requests.get(url);
  if (existing) return existing;
  const request = queue.then(() => capture(url));
  queue = request.catch(() => undefined);
  requests.set(url, request);
  request.catch(() => requests.delete(url));
  return request;
}

async function capture(url: string): Promise<string> {
  const key = new URL('/__domus_thumbnail_v2', location.origin);
  key.searchParams.set('asset', url);
  const cache = await globalThis.caches?.open('domus-model-thumbnails-v2').catch(() => undefined);
  const cached = await cache?.match(key.href).catch(() => undefined);
  if (cached) return URL.createObjectURL(await cached.blob());
  clearTimeout(idle);
  const scene = new THREE.Scene();
  const model = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url)).scene;
  try {
    renderer ??= new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(320, 240, false);
    renderer.setClearColor(0xd9dde3, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    scene.add(model, new THREE.HemisphereLight(0xffffff, 0x8995a6, 3));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(3, 5, 4); scene.add(light);
    const bounds = new THREE.Box3().setFromObject(model);
    if (bounds.isEmpty()) throw new Error('Cannot frame an empty model');
    const centre = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, .01);
    const camera = new THREE.OrthographicCamera(-radius * 4/3, radius * 4/3, radius, -radius, .01, radius * 12);
    camera.position.copy(centre).add(new THREE.Vector3(1.5, 1.1, 1.8).normalize().multiplyScalar(radius * 4));
    camera.lookAt(centre);
    renderer.render(scene, camera);
    const blob = await new Promise<Blob>((resolve, reject) => renderer!.domElement.toBlob(value => value ? resolve(value) : reject(new Error('Thumbnail capture failed')), 'image/png'));
    await cache?.put(key.href, new Response(blob, { headers: { 'Content-Type': 'image/png' } })).catch(() => undefined);
    return URL.createObjectURL(blob);
  } finally {
    const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
    model.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      resources.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        resources.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.add(value);
      }
    });
    resources.forEach(resource => resource.dispose());
    idle = setTimeout(() => { renderer?.dispose(); renderer?.forceContextLoss(); renderer = undefined; }, 3000);
  }
}
