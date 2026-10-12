import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { ProductModelLibrary } = await vite.ssrLoadModule('/src/renderer/productModels.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { PRODUCTS } = await vite.ssrLoadModule('/src/core/products.ts');
const { emptyRoomSnapshot, parseProjectSnapshot, usePlannerStore: store } = await vite.ssrLoadModule('/src/store.ts');

function asset() {
  const scene = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 0.8, 2);
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(4, 3, -7);
  scene.add(mesh);
  return { scene, geometry, material, texture };
}

test('centres and grounds GLB geometry, preserves metre scale, and shares one load across instances', async () => {
  const source = asset();
  let loads = 0;
  const library = new ProductModelLibrary(async () => { loads++; return source.scene; });
  const [a, b] = await Promise.all([library.loadModel('/model.glb'), library.loadModel('/model.glb')]);
  assert.equal(loads, 1);
  assert.equal(a, b);
  const one = library.instantiate(a), two = library.instantiate(a);
  const bounds = new THREE.Box3().setFromObject(one, true);
  assert.ok(Math.abs(bounds.min.y) < 1e-6);
  assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).x) < 1e-6);
  assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).z) < 1e-6);
  assert.ok(bounds.getSize(new THREE.Vector3()).distanceTo(new THREE.Vector3(1, 0.8, 2)) < 1e-6);
  assert.notEqual(one, two);
  assert.equal(one.children[0].children[0].geometry, two.children[0].children[0].geometry);
  const disposed = [];
  for (const resource of [source.geometry, source.material, source.texture]) resource.addEventListener('dispose', () => disposed.push(resource));
  PlannerScene.prototype.disposeGroup.call({}, one);
  assert.equal(disposed.length, 0, 'removing an instance must retain resources for other instances');
  library.dispose();
  assert.equal(disposed.length, 3, 'library releases geometry, material and texture once');
});

test('failed GLBs can be retried and empty GLBs are rejected', async () => {
  let loads = 0;
  const library = new ProductModelLibrary(async () => { if (++loads === 1) throw new Error('Offline'); return asset().scene; });
  await assert.rejects(library.loadModel('/model.glb'), /Offline/);
  library.retry('/model.glb');
  await library.loadModel('/model.glb');
  assert.equal(loads, 2);
  library.dispose();
  const empty = new ProductModelLibrary(async () => new THREE.Group());
  await assert.rejects(empty.loadModel('/empty.glb'), /no usable geometry/);
  empty.dispose();
});

test('an asset finishing after unmount releases its resources', async () => {
  const source = asset();
  let resolve;
  const library = new ProductModelLibrary(() => new Promise((done) => { resolve = done; }));
  let releases = 0;
  source.geometry.addEventListener('dispose', () => releases++);
  const loading = library.loadModel('/model.glb');
  library.dispose();
  resolve(source.scene);
  await assert.rejects(loading, /disposed/);
  assert.equal(releases, 1);
});

test('replaced model versions release their resources and a late superseded request cannot replace the fresh asset', async () => {
  const old = asset(), fresh = asset();
  let resolveOld, loads = 0, released = 0;
  old.geometry.addEventListener('dispose',()=>released++);
  const library = new ProductModelLibrary(() => ++loads===1 ? new Promise(done=>{resolveOld=done;}) : Promise.resolve(fresh.scene));
  const pending = library.loadModel('/version.glb');
  library.releaseModel('/version.glb');
  const current = await library.loadModel('/version.glb');
  resolveOld(old.scene);
  await assert.rejects(pending,/replaced/);
  assert.equal(released,1);
  assert.equal(await library.loadModel('/version.glb'),current);
  library.releaseModel('/version.glb');
  library.dispose();
});

test('a delayed GLB attaches only to current instances and retains moved/rotated placements', async () => {
  let resolve;
  let snapshot = { objects: [
    { id: 'removed', productId: 'hospitalbed', x: 0, z: 0, rotationY: 0 },
    { id: 'kept', productId: 'hospitalbed', x: 1, z: 2, rotationY: 0 }
  ], selectedId: 'kept' };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, {
    options: { showFurniture: true }, bridge: { getSnapshot: () => snapshot },
    objectModels: new Map(), contactShadows: new Map(), objectGroup: new THREE.Group(),
    floorGroup: new THREE.Group(), wallsGroup: new THREE.Group(), ceilingGroup: new THREE.Group(),
    contactShadowGroup: new THREE.Group(), outlinePass: { selectedObjects: [] },
    productModels: new ProductModelLibrary(() => new Promise((done) => { resolve = done; })),
    productModelRequests: new Map(), productModelTemplates: new Map(), productModelErrors: new Set(),
    disposed: false, requestRender() {}
  });
  scene.syncObjects(snapshot);
  assert.equal(scene.productModelRequests.size, 1);
  snapshot = { ...snapshot, objects: [
    { id: 'kept', productId: 'hospitalbed', x: 3, z: -1, rotationY: Math.PI / 2 },
    { id: 'duplicate', productId: 'hospitalbed', x: -2, z: 1, rotationY: 0 }
  ] };
  scene.syncObjects(snapshot);
  resolve(asset().scene);
  await Promise.all(scene.productModelRequests.values());
  assert.equal(scene.objectModels.has('removed'), false);
  const kept = scene.objectModels.get('kept');
  assert.equal(kept.userData.productModelLoaded, true);
  assert.deepEqual(kept.position.toArray(), [3, 0, -1]);
  assert.equal(kept.rotation.y, Math.PI / 2);
  assert.equal(scene.objectModels.get('duplicate').userData.productModelLoaded, true);
  assert.equal(scene.outlinePass.selectedObjects[0], kept);
  const item = scene.collectExportItems().find((item) => item.category === 'Furniture' && item.id === 'kept');
  assert.ok(item);
  const exported = scene.buildExportItem(item);
  assert.ok(exported, 'loaded furniture remains part of semantic room export');
  const exportBounds = new THREE.Box3().setFromObject(exported, true);
  assert.ok(exportBounds.getSize(new THREE.Vector3()).distanceTo(new THREE.Vector3(2, 0.8, 1)) < 1e-6);
  scene.disposeGroup(scene.objectGroup);
  scene.disposeGroup(scene.contactShadowGroup);
  scene.productModels.dispose();
});

test('the C8c bed is placeable and survives a portable room round trip', () => {
  assert.match(PRODUCTS.hospitalbed.model.url, /^\/models\/C8c\.glb\?v=/);
  assert.match(PRODUCTS.hospitalbed.id, /^model-/);
  assert.ok(PRODUCTS.hospitalbed.width < 2 && PRODUCTS.hospitalbed.depth < 3);
  const before = store.getState();
  store.setState({ ...emptyRoomSnapshot(), selectedId: null });
  try {
    store.getState().addObject('hospitalbed');
    assert.equal(store.getState().objects.length, 1);
    const decoded = parseProjectSnapshot(JSON.parse(JSON.stringify(store.getState())));
    assert.equal(decoded.objects[0].productId, PRODUCTS.hospitalbed.id);
  } finally { store.setState(before); }
});
