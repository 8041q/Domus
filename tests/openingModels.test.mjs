import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTestServer as createServer } from './helpers/vite.mjs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { existsSync } from 'node:fs';
import { readOpeningAsset } from './helpers/openingAsset.mjs';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { OpeningModelLibrary, openingModelUrl, fitOpeningModel, OPENING_MODELS } = await vite.ssrLoadModule('/src/renderer/openingModels.ts');
const { openingAxisMap } = await vite.ssrLoadModule('/src/renderer/openingResize.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
const { emptyRoomSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { prepareOpeningAsset } = await vite.ssrLoadModule('/src/renderer/openingMaterials.ts');
const { ProductModelLibrary } = await vite.ssrLoadModule('/src/renderer/productModels.ts');
const { getRoomWalls } = await vite.ssrLoadModule('/src/core/roomGeometry.ts');

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
  const body = new THREE.Mesh(mergeGeometries([leaf, handle]), paint); body.name = 'leaf and fittings'; frame.add(body);
  for (const [width, height] of [[.65, 2.6], [2.4, 1.6]]) {
    const fitted = fitOpeningModel(frame.clone(), 'single-door', width, height);
    const left = fitted.getObjectByName('left jamb');
    close(new THREE.Box3().setFromObject(left, true).getSize(new THREE.Vector3()).x, .08);
    const header = fitted.getObjectByName('header');
    close(new THREE.Box3().setFromObject(header, true).getSize(new THREE.Vector3()).y, .08);
    const positions = fitted.getObjectByName('leaf and fittings').geometry.attributes.position;
    const handleBounds = new THREE.Box3();
    for (let i = 0; i < positions.count; i++) if (positions.getZ(i) > .01) handleBounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(positions, i));
    const dimensions = handleBounds.getSize(new THREE.Vector3());
    close(dimensions.x, .08); close(dimensions.y, .08); close(dimensions.z, .08);
    close(handleBounds.getCenter(new THREE.Vector3()).y, 1.05 / 2 * height);
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
  assert.equal(glass.transmission, 0, 'Simple panes do not trigger a second refraction render');
  assert.equal(glass.forceSinglePass, true);
  assert.equal(architecture.children[0].children[0].userData.openingGlazing, true);
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

test('shared deformation keeps handle positions proportional and compresses profiles only when needed', () => {
  for (const target of [.45, 1, 2, 3.55]) {
    const map = openingAxisMap(2, target, [[0, .08], [.91, 1.09], [1.92, 2]]);
    close(map(0), 0); close(map(2), target);
    close((map(.91) + map(1.09)) / 2, target / 2);
    close(map(.08), .08);
    for (let i = 1; i <= 200; i++) assert.ok(map(i / 100) >= map((i - 1) / 100));
  }
});

test('a handle plate stays over its panel cutout when width and height change independently', () => {
  const shape = new THREE.Shape().moveTo(0, 0).lineTo(1, 0).lineTo(1, 2).lineTo(0, 2).closePath();
  const hole = new THREE.Path().moveTo(.13, .85).lineTo(.13, 1.05).lineTo(.23, 1.05).lineTo(.23, .85).closePath();
  shape.holes.push(hole);
  const paint = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  const panel = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: .04, bevelEnabled: false }), paint);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(.12, .22, .02).translate(.18, .95, .05), paint);
  plate.name = 'handle plate';
  const source = new THREE.Group(); source.add(panel, plate);
  for (const [width, height] of [[3.55, 1.63], [.65, 2.8]]) {
    const fitted = fitOpeningModel(source.clone(), 'single-door', width, height);
    fitted.updateMatrixWorld(true);
    const hardware = new THREE.Box3().setFromObject(fitted.getObjectByName('handle plate'), true);
    const centre = hardware.getCenter(new THREE.Vector3());
    close(centre.y, .95 / 2 * height);
    // The old per-island deformation left an uncovered strip beside the plate.
    for (let x = hardware.min.x - .025; x < hardware.max.x + .025; x += .005) {
      for (let y = hardware.min.y - .025; y < hardware.max.y + .025; y += .005) {
        const ray = new THREE.Raycaster(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
        assert.ok(ray.intersectObject(fitted, true).length, 'No exposed cutout beside a resized handle plate');
      }
    }
  }
});

test('selection excludes transparent architectural panes but retains solid frames', () => {
  const scene = Object.create(PlannerScene.prototype);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  frame.userData.openingId = door.id;
  const glass = frame.clone(); glass.userData.openingGlazing = true;
  const wallsGroup = new THREE.Group(); wallsGroup.add(frame, glass);
  Object.assign(scene, { wallsGroup, outlinePass: { selectedObjects: [] }, options: { interactiveArchitecture: true } });
  scene.syncOpeningHighlight({ selectedOpeningId: door.id });
  assert.deepEqual(scene.outlinePass.selectedObjects, [frame]);
});

test('architectural finishes have restrained satin reflections without affecting furniture', () => {
  const group = new THREE.Group();
  const finish = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: .05, clearcoat: 1, clearcoatRoughness: 0 });
  finish.name = 'White Vinyl'; finish.roughnessMap = new THREE.Texture();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(), finish));
  prepareOpeningAsset(group, '/internal/architecture/openings/glass_door.glb');
  assert.ok(finish.roughness >= .75); assert.ok(finish.metalness <= .05);
  assert.equal(finish.clearcoat, 0); assert.equal(finish.roughnessMap, null);
});

test('baseboards meet imported aperture edges and retain generated-casing clearance for fallback styles', async () => {
  const library = new OpeningModelLibrary({ loadModel: async () => template(), instantiate: model => model.clone() }, () => {});
  const snapshot = { ...emptyRoomSnapshot(), openings: [door] };
  const scene = Object.create(PlannerScene.prototype), runs = [];
  Object.assign(scene, { openingModels: library, addBaseboard: (_wall, start, end) => runs.push([start, end]) });
  const wall = getRoomWalls(snapshot.room).find(wall => wall.id === door.wallId);
  scene.addBaseboardRuns(wall, snapshot);
  close(runs[0][1], door.offset - door.width / 2 - .0375);
  library.create(door); await new Promise(setImmediate); runs.length = 0;
  scene.addBaseboardRuns(wall, snapshot);
  close(runs[0][1], door.offset - door.width / 2);
  close(runs[1][0], door.offset + door.width / 2);
  assert.equal(library.frameOverhang({ ...door, variant: 'double-door' }), .0375);
  library.dispose();
});

test('supplied GLBs retain their bounds and door hardware sizes at the reported stretched dimensions', async t => {
  if (!Object.values(OPENING_MODELS).every(({ file }) => existsSync('public/internal/architecture/openings/' + file))) {
    t.skip('Local architectural GLBs are not present.'); return;
  }
  for (const [variant, { file, rotationY = 0 }] of Object.entries(OPENING_MODELS)) {
    const source = await readOpeningAsset('public/internal/architecture/openings/' + file);
    const oriented = new THREE.Group(); oriented.rotation.y = rotationY; oriented.add(source.clone()); oriented.updateMatrixWorld(true);
    const originalBounds = new THREE.Box3().setFromObject(oriented, true), originalSize = originalBounds.getSize(new THREE.Vector3());
    const hardware = mesh => variant === 'single-door' ? mesh.material.name === 'Metal black'
      : variant === 'glass-door' ? mesh.name.startsWith('Plane')
      : variant === 'glass-double-door' ? mesh.name === 'Handle'
      : variant === 'semi-glass-door' ? mesh.name === 'Cylinder001' : false;
    let originalHardware;
    oriented.traverse(mesh => { if (mesh.isMesh && hardware(mesh)) originalHardware = new THREE.Box3().setFromObject(mesh, true); });
    for (const [width, height] of [[3.55, 1.63], [.65, 2.8], [3, .7], [3.55, .65]]) {
      const fitted = fitOpeningModel(source.clone(), variant, width, height);
      const size = new THREE.Box3().setFromObject(fitted, true).getSize(new THREE.Vector3());
      close(size.x, width); close(size.y, height); close(size.z, originalSize.z);
      if (originalHardware && height > 1) {
        const mesh = fitted.children.find(hardware), box = new THREE.Box3().setFromObject(mesh, true);
        const before = originalHardware.getSize(new THREE.Vector3()), after = box.getSize(new THREE.Vector3());
        close(after.x, before.x); close(after.y, before.y); close(after.z, before.z);
        const originalRatio = (originalHardware.getCenter(new THREE.Vector3()).y - originalBounds.min.y) / originalSize.y;
        assert.ok(Math.abs(box.getCenter(new THREE.Vector3()).y / height - originalRatio) < .008, variant + ' handle height should follow the source ratio');
        if (variant === 'semi-glass-door') {
          close(box.min.x + width / 2, originalHardware.min.x - originalBounds.min.x);
          close(box.max.x + width / 2, originalHardware.max.x - originalBounds.min.x);
        }
      }
      if (variant === 'high-window') {
        fitted.updateMatrixWorld(true);
        for (const side of [-1, 1]) for (const face of [-1, 1]) {
          const hits = inset => new THREE.Raycaster(new THREE.Vector3(side * (width / 2 - inset), height / 2, face), new THREE.Vector3(0, 0, -face)).intersectObject(fitted, true);
          assert.ok(hits(.1).some(hit => !/glass/i.test(hit.object.material.name)), 'Both jambs retain their full profile');
          assert.ok(hits(.16).every(hit => /glass/i.test(hit.object.material.name)), 'Neither jamb grows into the visible pane');
        }
      }
      fitted.traverse(mesh => { if (mesh.isMesh) mesh.geometry.dispose(); });
    }
  }
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
