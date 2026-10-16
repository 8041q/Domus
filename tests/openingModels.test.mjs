import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { OpeningModelLibrary, openingModelUrl, fitOpeningModel } = await vite.ssrLoadModule('/src/renderer/openingModels.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { emptyRoomSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { prepareOpeningAsset } = await vite.ssrLoadModule('/src/renderer/openingMaterials.ts');
const { ProductModelLibrary } = await vite.ssrLoadModule('/src/renderer/productModels.ts');

const door = { id: 'imported-door', type: 'door', variant: 'single-door', wallId: 'wall-v0-v1', offset: 2,
  width: .9, height: 2.08, sillHeight: 0 };
function template(width = 1, height = 2, depth = .15) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial());
  mesh.position.set(4, 5, -3);
  mesh.userData.sharedProductAsset = true;
  group.add(mesh);
  return group;
}
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`); }

test('architectural URLs stay separate from furniture, with unmapped styles left procedural', () => {
  assert.equal(openingModelUrl(door), '/internal/architecture/openings/single_door.glb');
  for (const variant of ['double-door', 'door-frame', 'full-height-window', 'wall-opening']) {
    assert.equal(openingModelUrl({ type: variant.endsWith('window') ? 'window' : 'door', variant }), undefined);
  }
  assert.equal(openingModelUrl({ type: 'opening', variant: 'single-window' }), undefined);
  assert.equal(openingModelUrl({ type: 'window', variant: 'single-door' }), undefined);
});

test('off-centre models fit resized apertures without changing depth or shared geometry', () => {
  const original = template();
  const positions = original.children[0].geometry.attributes.position.array.slice();
  for (const [width, height] of [[.45, .4], [.9, 2.08], [4, 3.3]]) {
    const model = fitOpeningModel(original.clone(), 'single-door', width, height);
    const bounds = new THREE.Box3().setFromObject(model, true);
    const size = bounds.getSize(new THREE.Vector3());
    close(size.x, width); close(size.y, height); close(size.z, .15);
    close(bounds.min.y, 0); close(bounds.getCenter(new THREE.Vector3()).x, 0); close(bounds.getCenter(new THREE.Vector3()).z, 0);
  }
  assert.deepEqual(original.children[0].geometry.attributes.position.array, positions);
  assert.deepEqual(original.children[0].position.toArray(), [4, 5, -3]);
  const sideways = fitOpeningModel(template(.16, 2, 1.56), 'glass-double-door', 1.8, 2.1);
  const size = new THREE.Box3().setFromObject(sideways, true).getSize(new THREE.Vector3());
  close(size.x, 1.8); close(size.y, 2.1); close(size.z, .16);
  assert.equal(fitOpeningModel(new THREE.Group(), 'single-door', .9, 2), null);
});

test('independent resizing retains jamb thickness and a round handle embedded in the leaf mesh', () => {
  const frame = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial();
  const add = (name, size, position) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), paint);
    mesh.name = name; mesh.position.set(...position); frame.add(mesh); return mesh;
  };
  add('left jamb', [.08, 2, .12], [-.46, 1, 0]);
  add('right jamb', [.08, 2, .12], [.46, 1, 0]);
  add('header', [1, .08, .12], [0, 1.96, 0]);
  const leaf = new THREE.BoxGeometry(.82, 1.88, .04).translate(0, .98, 0);
  const handle = new THREE.SphereGeometry(.04, 12, 8).translate(.33, 1.05, .1);
  const handleStart = leaf.attributes.position.count;
  const body = new THREE.Mesh(mergeGeometries([leaf, handle]), paint); body.name = 'leaf and fittings'; frame.add(body);
  for (const [width, height] of [[.65, 2.6], [2.4, 1.6]]) {
    const fitted = fitOpeningModel(frame.clone(), 'single-door', width, height);
    const left = fitted.getObjectByName('left jamb');
    close(new THREE.Box3().setFromObject(left, true).getSize(new THREE.Vector3()).x, .08);
    const header = fitted.getObjectByName('header');
    close(new THREE.Box3().setFromObject(header, true).getSize(new THREE.Vector3()).y, .08);
    const positions = fitted.getObjectByName('leaf and fittings').geometry.attributes.position;
    const handleBounds = new THREE.Box3();
    for (let i = handleStart; i < positions.count; i++) handleBounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(positions, i));
    const dimensions = handleBounds.getSize(new THREE.Vector3());
    close(dimensions.x, .08); close(dimensions.y, .08); close(dimensions.z, .08);
    close(handleBounds.getCenter(new THREE.Vector3()).y, 1.05);
    const bounds = new THREE.Box3().setFromObject(fitted, true).getSize(new THREE.Vector3());
    close(bounds.x, width); close(bounds.y, height);
  }
});

test('architectural glass repairs and neutral reflections leave furniture materials alone', async () => {
  const makeAsset = () => {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 1 }); material.name = 'Glass_Clear';
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, .04), material)); return group;
  };
  const library = new ProductModelLibrary(async () => makeAsset(), prepareOpeningAsset);
  const environment = new THREE.Texture();
  library.setOpeningEnvironment(environment);
  const architecture = await library.loadModel('/internal/architecture/openings/sliding_glass_pathway.glb');
  const glass = architecture.children[0].children[0].material;
  assert.ok(glass instanceof THREE.MeshPhysicalMaterial); assert.equal(glass.metalness, 0);
  assert.equal(glass.transparent, true); assert.equal(glass.depthWrite, false);
  assert.equal(glass.envMap, environment);
  library.setEnvironment(null);
  assert.equal(glass.envMap, environment, 'Cinematic lighting does not remove architectural reflections');
  const exported = library.cloneForExport(glass);
  assert.equal(exported.envMap, null); assert.equal(exported.transparent, true);
  const furniture = await library.loadModel('/models/fixture.glb');
  assert.equal(furniture.children[0].children[0].material.metalness, 1);
  assert.equal(furniture.children[0].children[0].material.transparent, false);
  library.dispose(); environment.dispose(); exported.dispose();
});

test('loading uses one request, creates independent instances and suppresses disposed callbacks', async () => {
  let resolve, loads = 0, ready = 0;
  const asset = template();
  const library = new OpeningModelLibrary({ loadModel() { loads++; return new Promise(done => { resolve = done; }); },
    instantiate: value => value.clone() }, () => ready++);
  assert.equal(library.create(door), null);
  assert.equal(library.create(door), null);
  assert.equal(loads, 1);
  resolve(asset); await new Promise(setImmediate);
  assert.equal(ready, 1);
  const first = library.create(door), second = library.create({ ...door, width: 2 });
  assert.notEqual(first, second);
  close(new THREE.Box3().setFromObject(first, true).getSize(new THREE.Vector3()).x, .9);
  close(new THREE.Box3().setFromObject(second, true).getSize(new THREE.Vector3()).x, 2);
  library.dispose(); assert.equal(library.create(door), null);
  const late = new OpeningModelLibrary({ loadModel: () => new Promise(done => { resolve = done; }) }, () => ready++);
  late.create(door); late.dispose(); resolve(asset); await new Promise(setImmediate);
  assert.equal(ready, 1);
});

test('failed model requests keep the generated assembly without repeated requests', async () => {
  let loads = 0;
  const library = new OpeningModelLibrary({ loadModel() { loads++; return Promise.reject(new Error('missing')); } }, () => assert.fail());
  const warn = console.warn;
  console.warn = () => {};
  try {
    const scene = Object.create(PlannerScene.prototype);
    Object.assign(scene, { wallsGroup: new THREE.Group(), openingModels: library });
    const snapshot = { ...emptyRoomSnapshot(), openings: [door] };
    scene.addOpeningFrame(door, snapshot, .05);
    assert.ok(scene.wallsGroup.children.length > 5, 'Generated door remains visible during loading');
    await new Promise(setImmediate);
    assert.equal(library.create(door), null); assert.equal(loads, 1);
    scene.disposeGroup(scene.wallsGroup);
  } finally { console.warn = warn; library.dispose(); }
});

test('imported assemblies retain wall metadata, door flips, export grouping and shared resources', () => {
  const scene = Object.create(PlannerScene.prototype);
  const asset = template();
  Object.assign(scene, { wallsGroup: new THREE.Group(),
    openingModels: { create: opening => fitOpeningModel(asset.clone(), opening.variant, opening.width, opening.height) } });
  const snapshot = { ...emptyRoomSnapshot(), openings: [door] };
  scene.addOpeningFrame(door, snapshot, .05);
  const root = scene.wallsGroup.children[0];
  assert.equal(scene.wallsGroup.children.length, 1, 'No generated trim duplicates the GLB');
  assert.equal(root.userData.domusExportCategory, 'Frames');
  assert.equal(root.userData.domusExportItemId, door.id);
  root.traverse(node => {
    assert.equal(node.userData.openingId, door.id);
    assert.equal(node.userData.cutawayWallId, door.wallId);
  });
  const exported = scene.buildExportItem({ category: 'Frames', id: door.id, name: 'Door 1', rotationY: 0,
    sources: [{ object: root, logicalRoot: false }] });
  const bounds = new THREE.Box3().setFromObject(exported, true).getSize(new THREE.Vector3());
  close(bounds.x, .9); close(bounds.y, 2.08);
  const normal = root.rotation.y;
  scene.disposeGroup(scene.wallsGroup);
  scene.addOpeningFrame({ ...door, doorFlipped: true }, snapshot, .05);
  close(scene.wallsGroup.children[0].rotation.y - normal, Math.PI);
  let disposed = false;
  asset.children[0].geometry.addEventListener('dispose', () => { disposed = true; });
  scene.disposeGroup(scene.wallsGroup);
  assert.equal(disposed, false, 'Wall rebuilds do not dispose library-owned geometry');
});
