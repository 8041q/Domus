import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

const manifest = JSON.parse(await readFile('public/optimized-models/manifest.json', 'utf8'));
const filename = process.argv[2] ?? 'C8c.glb';
const derivative = manifest.models[filename];
if (!derivative || process.argv.length > 3) throw new Error('Usage: npm run models:benchmark -- [model-file.glb]. Run models:optimize first.');
console.log('Geometry-only benchmark: embedded textures are skipped; these timings are not browser load time or GPU frame rate.');
for (const [name, file] of [['original', 'public/models/' + filename], ['optimized', 'public' + derivative.url]]) {
  const bytes = await readFile(file);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  loader.register(() => ({ name: 'benchmark-textures', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  const started = performance.now();
  const { scene } = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const parseMs = performance.now() - started;
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene, true);
  const meshes = [];
  scene.traverse(node => { if (node.isMesh) meshes.push(node); });
  const rays = [];
  for (let x = 1; x <= 8; x++) for (let z = 1; z <= 8; z++) rays.push(new THREE.Raycaster(
    new THREE.Vector3(THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, x / 9), bounds.max.y + 1,
      THREE.MathUtils.lerp(bounds.min.z, bounds.max.z, z / 9)), new THREE.Vector3(0, -1, 0)));
  const measure = () => {
    rays[0].intersectObject(scene, true);
    const times = [], hits = [];
    for (const ray of rays) {
      const start = performance.now();
      hits.push(ray.intersectObject(scene, true)[0]?.distance ?? null);
      times.push(performance.now() - start);
    }
    times.sort((a,b) => a - b);
    return { medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * .95)], hits };
  };
  const ordinary = measure();
  const treeStart = performance.now();
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    if ((geometry.index?.count ?? geometry.attributes.position.count) / 3 < 1000) continue;
    geometry.boundsTree ??= new MeshBVH(geometry, { indirect: true, targetLeafSize: 16 });
    mesh.raycast = acceleratedRaycast;
  }
  const buildMs = performance.now() - treeStart;
  rays.forEach(ray => { ray.firstHitOnly = true; });
  const accelerated = measure();
  let maxPickingDifference = 0;
  for (let i = 0; i < rays.length; i++) {
    if (ordinary.hits[i] == null !== (accelerated.hits[i] == null)) throw new Error('Picking hit mismatch');
    if (ordinary.hits[i] != null) maxPickingDifference = Math.max(maxPickingDifference, Math.abs(ordinary.hits[i] - accelerated.hits[i]));
  }
  const row = { name, bytes: bytes.length, meshes: meshes.length, parseMs, buildMs,
    pickingMedianMs: ordinary.medianMs, acceleratedPickingMedianMs: accelerated.medianMs,
    acceleratedPickingP95Ms: accelerated.p95Ms, maxPickingDifference };
  console.log(JSON.stringify(row));
}
