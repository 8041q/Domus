import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(async () => vite.close());
const { ModelContactShadows } = await vite.ssrLoadModule('/src/renderer/modelContactShadows.ts');
const { createFloorCastShadow } = await vite.ssrLoadModule('/src/renderer/floorCastShadow.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');

function renderer() {
  return {
    target: new THREE.WebGLRenderTarget(8, 8), colour: new THREE.Color('#987654'), alpha: .3,
    autoClear: false, shadowMap: { enabled: true }, renders: 0,
    getRenderTarget() { return this.target; }, setRenderTarget(target) { this.target = target; },
    getClearColor(value) { return value.copy(this.colour); }, getClearAlpha() { return this.alpha; },
    setClearColor(value, alpha) { this.colour.set(value); this.alpha = alpha; }, clear() {},
    render(scene, camera) { this.renders++; this.capture = scene.children[0]; this.camera = camera; }
  };
}

test('live furniture moves and wall-snap rotations keep the baked contact aligned before state synchronization', () => {
  const template = new THREE.Group();
  const support = new THREE.Mesh(new THREE.BoxGeometry(.2, .05, .3), new THREE.MeshStandardMaterial());
  support.position.set(.35, .025, -.45);
  template.add(support);
  const gpu = renderer();
  const library = new ModelContactShadows(gpu);
  const contact = library.create(template);
  const model = new THREE.Group();
  model.add(template.clone());
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { objectModels: new Map([['bed', model]]), contactShadows: new Map([['bed', contact]]) });
  const localContact = contact.children[0].position.clone();
  const mask = contact.children[0].material.uniforms.contactMask.value;

  for (const [x, z, rotationY] of [[1, 2, 0], [3, 1, Math.PI / 2], [.5, 3, -Math.PI / 2]]) {
    scene.syncObjectTransform('bed', x, z, rotationY);
    model.updateMatrixWorld(true);
    contact.updateMatrixWorld(true);
    const contactPoint = contact.children[0].getWorldPosition(new THREE.Vector3());
    const supportPoint = model.children[0].children[0].getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(contactPoint.x - supportPoint.x) < 1e-6);
    assert.ok(Math.abs(contactPoint.z - supportPoint.z) < 1e-6);
    assert.equal(contactPoint.y, .007, 'Contact remains on the floor');
    assert.equal(contact.rotation.y, rotationY);
    assert.ok(contact.children[0].position.equals(localContact), 'Baked support offsets stay in model space');
    assert.equal(contact.children[0].material.uniforms.contactMask.value, mask);
  }
  assert.equal(gpu.renders, 1, 'Dragging repositions the existing contact without rebaking');
  scene.contactShadows.clear();
  assert.doesNotThrow(() => scene.syncObjectTransform('bed', 2, 2, 0), 'A missing contact cannot prevent a model move');
  assert.deepEqual(model.position.toArray(), [2, 0, 2]);
  library.dispose();
  support.geometry.dispose(); support.material.dispose();
  contact.children[0].geometry.dispose(); contact.children[0].material.dispose(); gpu.target.dispose();
});

test('contact capture retains the curved underside and excludes floor decals and elevated geometry', () => {
  const model = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff' });
  const wheel = new THREE.Mesh(new THREE.SphereGeometry(.1, 32, 24), material);
  wheel.position.set(.2, .1, -.3);
  model.add(wheel);
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial({ transparent: true }));
  decal.rotation.x = -Math.PI / 2;
  model.add(decal);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, .2, 2), material);
  body.position.y = .5;
  model.add(body);
  const originalColour = material.color.clone();
  const gpu = renderer(), originalTarget = gpu.target, originalClear = gpu.colour.clone();
  const library = new ModelContactShadows(gpu);
  const contact = library.create(model);
  assert.equal(gpu.capture.children[1].material.visible, false, 'Transparent floor graphics cannot become contact stamps');
  gpu.capture.updateMatrixWorld(true);
  const hit = (x, z) => {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, -.1, z), new THREE.Vector3(0, 1, 0), .001, gpu.camera.far);
    return ray.intersectObject(gpu.capture, true).filter(hit => hit.object.material.visible);
  };
  assert.ok(hit(.205, -.295).length > 0);
  assert.ok(hit(.25, -.3).length > 0);
  assert.equal(hit(.29, -.21).length, 0, 'The corner of the wheel bounds must stay empty');
  assert.equal(hit(0, 0).length, 0, 'Elevated body must not fill the contact layer');
  assert.equal(gpu.target, originalTarget);
  assert.equal(gpu.colour.equals(originalClear), true);
  assert.equal(gpu.alpha, .3); assert.equal(gpu.autoClear, false); assert.equal(gpu.shadowMap.enabled, true);
  assert.equal(wheel.material, material); assert.equal(material.color.equals(originalColour), true);
  const duplicate = library.create(model);
  assert.equal(gpu.renders, 1, 'Moving or duplicating a model reuses the underside mask');
  assert.equal(contact.children[0].material.uniforms.contactMask.value, duplicate.children[0].material.uniforms.contactMask.value);
  assert.notEqual(contact.children[0].material, duplicate.children[0].material);
  let released = 0;
  // Release applies to the render target, not a placed plane's shared texture.
  library.masks.get(model).target.addEventListener('dispose', () => released++);
  library.release(model); library.dispose();
  assert.equal(released, 1);
  for (const group of [contact, duplicate]) group.traverse(node => { if (node.isMesh) { node.geometry.dispose(); node.material.dispose(); } });
  model.traverse(node => { if (node.isMesh) node.geometry.dispose(); });
  material.dispose(); decal.material.dispose(); originalTarget.dispose();
});

test('failed contact capture restores the renderer and releases its target without caching a broken mask', () => {
  const gpu = renderer(), priorTarget = gpu.target, priorColour = gpu.colour.clone();
  let releases = 0;
  gpu.render = () => { gpu.target.addEventListener('dispose', () => releases++); throw new Error('Capture failed'); };
  const model = new THREE.Group();
  model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  const library = new ModelContactShadows(gpu);
  assert.throws(() => library.create(model), /Capture failed/);
  assert.equal(gpu.target, priorTarget); assert.ok(gpu.colour.equals(priorColour));
  assert.equal(gpu.alpha, .3); assert.equal(gpu.autoClear, false); assert.equal(gpu.shadowMap.enabled, true);
  assert.equal(releases, 1); assert.equal(library.masks.size, 0);
  library.dispose(); priorTarget.dispose();
  model.children[0].geometry.dispose(); model.children[0].material.dispose();
});

test('the broad floor pass follows the live key-light map without altering model illumination', () => {
  const light = new THREE.DirectionalLight();
  light.shadow.intensity = .6;
  const room = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 4 }, { x: 0, z: 4 }];
  const receiver = createFloorCastShadow(room, light);
  const gpu = renderer(), previousTarget = gpu.target;
  receiver.onBeforeRender(gpu);
  assert.equal(receiver.material.uniforms.ready.value, 0);
  light.shadow.map = new THREE.WebGLRenderTarget(16, 16);
  const sources = [], destinations = [], steps = [];
  const render = gpu.render.bind(gpu);
  gpu.render = (scene, camera) => {
    const uniforms = scene.children[0].material.uniforms;
    sources.push(uniforms.castMap?.value ?? uniforms.source.value);
    destinations.push(gpu.target);
    if (uniforms.blurStep) steps.push(uniforms.blurStep.value.clone());
    render(scene, camera);
  };
  receiver.onBeforeRender(gpu);
  assert.equal(sources[0], light.shadow.map.texture, 'Decode must use the current key-light depth map');
  assert.equal(destinations[0].texture, sources[1]);
  assert.equal(destinations[1].texture, sources[2]);
  assert.equal(destinations[2], destinations[0], 'Final vertical blur can reuse the decoded mask target');
  assert.ok(sources.every((source, index) => source !== destinations[index].texture), 'No pass can sample its own render target');
  assert.equal(receiver.material.uniforms.castMap.value, destinations[2].texture);
  assert.equal(receiver.material.uniforms.ready.value, 1);
  assert.ok(steps[0].x > 0 && steps[0].y === 0 && steps[1].x === 0 && steps[1].y > 0);
  assert.equal(gpu.target, previousTarget); assert.equal(gpu.autoClear, false); assert.equal(gpu.shadowMap.enabled, true);
  assert.equal(receiver.material.uniforms.castMatrix.value, light.shadow.matrix);
  assert.equal(light.shadow.intensity, .6);
  assert.equal(receiver.castShadow, false);
  assert.equal(receiver.material.lights, false, 'Sun masks must not darken the whole floor through this extra pass');
  const positions = receiver.geometry.getAttribute('position');
  let area = 0;
  for (let i = 0; i < positions.count; i += 3) {
    const ax = positions.getX(i), az = positions.getZ(i);
    const bx = positions.getX(i + 1), bz = positions.getZ(i + 1);
    const cx = positions.getX(i + 2), cz = positions.getZ(i + 2);
    area += Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
  }
  assert.ok(Math.abs(area - 7) < 1e-6, 'Shadow receiver must stay inside the concave floor');
  let releases = 0;
  for (const target of new Set(destinations)) target.addEventListener('dispose', () => releases++);
  receiver.geometry.dispose(); receiver.material.dispose(); light.shadow.map.dispose(); previousTarget.dispose();
  assert.equal(releases, 2, 'Removing the receiver releases both filter targets');
});

test('a failed cast-shadow filter restores rendering and hides its incomplete mask', () => {
  const light = new THREE.DirectionalLight();
  light.shadow.map = new THREE.WebGLRenderTarget(16, 16);
  const receiver = createFloorCastShadow([{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 0, z: 2 }], light);
  const gpu = renderer(), previousTarget = gpu.target;
  gpu.render = () => { throw new Error('Filter failed'); };
  assert.throws(() => receiver.onBeforeRender(gpu), /Filter failed/);
  assert.equal(receiver.material.uniforms.ready.value, 0);
  assert.equal(gpu.target, previousTarget); assert.equal(gpu.autoClear, false); assert.equal(gpu.shadowMap.enabled, true);
  receiver.geometry.dispose(); receiver.material.dispose(); light.shadow.map.dispose(); previousTarget.dispose();
});
