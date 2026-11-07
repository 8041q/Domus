import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { Document, NodeIO } from '@gltf-transform/core';
import { getBounds } from '@gltf-transform/functions';
import { simplifyPlanningShell } from '../scripts/simplify-planning-shell.mjs';
import { validateGLB } from '../scripts/asset-safety.mjs';

// A small furniture-like assembly: the opening and pole must survive even when
// the broad curved base gets new topology. No private authoring files are used.
function assembly() {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const colours = [[.08, .35, .7, 1], [.85, .85, .85, 1], [.2, .2, .2, 1]];
  const materials = colours.map(colour => document.createMaterial().setBaseColorFactor(colour));
  const add = (geometry, role, material) => {
    const primitive = document.createPrimitive().setMaterial(materials[material]);
    for (const [semantic, attribute] of [['POSITION', 'position'], ['NORMAL', 'normal']]) {
      primitive.setAttribute(semantic, document.createAccessor().setBuffer(buffer).setType('VEC3')
        .setArray(new Float32Array(geometry.getAttribute(attribute).array)));
    }
    primitive.setIndices(document.createAccessor().setBuffer(buffer).setType('SCALAR')
      .setArray(geometry.index ? new Uint32Array(geometry.index.array)
        : Uint32Array.from({ length: geometry.getAttribute('position').count }, (_, index) => index)));
    scene.addChild(document.createNode(`PRIVATE_PART_${role}`).setExtras({
      domus_part_role: role, source_authoring_label: 'PRIVATE_SOURCE_SENTINEL'
    }).setMesh(document.createMesh().addPrimitive(primitive)));
    geometry.dispose();
  };

  const outline = new THREE.Shape();
  outline.moveTo(-.5, .06); outline.lineTo(-.5, .5);
  outline.quadraticCurveTo(-.5, .6, -.4, .6); outline.lineTo(.4, .6);
  outline.quadraticCurveTo(.5, .6, .5, .5); outline.lineTo(.5, .06);
  outline.quadraticCurveTo(.5, 0, .44, 0); outline.lineTo(-.44, 0);
  outline.quadraticCurveTo(-.5, 0, -.5, .06);
  const hole = new THREE.Path();
  hole.absellipse(0, .36, .2, .1, 0, Math.PI * 2, true);
  outline.holes.push(hole);
  const board = new THREE.ExtrudeGeometry(outline, {
    depth: .05, bevelEnabled: true, bevelSegments: 8, bevelSize: .008,
    bevelThickness: .008, steps: 10, curveSegments: 64
  });
  board.translate(0, .5, .65); add(board, 'feature', 0);
  const pole = new THREE.CylinderGeometry(.012, .012, 1.4, 48, 20);
  pole.translate(.75, .7, .45); add(pole, 'thin', 2);
  const base = new THREE.SphereGeometry(1, 64, 40);
  base.scale(.55, .14, .9); base.translate(0, .14, 0); add(base, 'bulk', 1);
  scene.addChild(document.createNode('Planning model').setExtras({
    domus_schema_version: 2, domus_name: 'Synthetic planning model',
    domus_display_profile: 'static-exterior-v1',
    private_note: 'PRIVATE_CARRIER_SENTINEL'
  }));
  return document;
}

function triangles(document) {
  return document.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives())
    .reduce((sum, primitive) => sum + (primitive.getIndices()?.getCount()
      ?? primitive.getAttribute('POSITION').getCount()) / 3, 0);
}

function positionKeys(document) {
  const keys = new Set();
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const values = primitive.getAttribute('POSITION').getArray();
    for (let index = 0; index < values.length; index += 3) {
      keys.add(Array.from(values.subarray(index, index + 3), value => value.toFixed(6)).join(','));
    }
  }
  return keys;
}

function intersects(document, origin, direction) {
  const ray = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction));
  const meshes = [];
  for (const node of document.getRoot().listNodes()) for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(primitive.getAttribute('POSITION').getArray(), 3));
    geometry.setIndex(new THREE.BufferAttribute(primitive.getIndices().getArray(), 1));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.matrixAutoUpdate = false; mesh.matrix.fromArray(node.getWorldMatrix()); mesh.updateMatrixWorld(true);
    meshes.push(mesh);
  }
  const hit = ray.intersectObjects(meshes, false).length > 0;
  for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
  return hit;
}

function sphereFixture(instances, radius = 1) {
  const document = new Document(), buffer = document.createBuffer(), scene = document.createScene();
  const geometry = new THREE.SphereGeometry(radius, 48, 32);
  const primitive = document.createPrimitive();
  for (const [semantic, attribute] of [['POSITION', 'position'], ['NORMAL', 'normal']]) {
    primitive.setAttribute(semantic, document.createAccessor().setBuffer(buffer).setType('VEC3')
      .setArray(geometry.getAttribute(attribute).array.slice()));
  }
  primitive.setIndices(document.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(geometry.index.array.slice()));
  const mesh = document.createMesh().addPrimitive(primitive);
  for (const { scale = [1, 1, 1], translation = [0, 0, 0], role = 'feature' } of instances) {
    scene.addChild(document.createNode().setMesh(mesh).setScale(scale).setTranslation(translation)
      .setExtras({ domus_part_role: role }));
  }
  geometry.dispose();
  return document;
}

function thinFrameFixture() {
  const width = .606482, height = .181, length = 1.918;
  const innerWidth = .604082, innerHeight = .1786;
  const rectangle = (path, w, h, clockwise = false) => {
    const corners = clockwise
      ? [[-w/2, -h/2], [-w/2, h/2], [w/2, h/2], [w/2, -h/2]]
      : [[-w/2, -h/2], [w/2, -h/2], [w/2, h/2], [-w/2, h/2]];
    path.moveTo(...corners[0]);
    // Subdivision mimics dense CAD tessellation without using original assets.
    for (let side = 0; side < 4; side++) for (let step = 1; step <= 24; step++) {
      const start = corners[side], end = corners[(side + 1) % 4];
      path.lineTo(start[0] + (end[0] - start[0]) * step / 24,
        start[1] + (end[1] - start[1]) * step / 24);
    }
    path.closePath();
  };
  const shape = new THREE.Shape(), hole = new THREE.Path();
  rectangle(shape, width, height); rectangle(hole, innerWidth, innerHeight, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: length, steps: 10, bevelEnabled: true, bevelSegments: 4,
    bevelSize: .000161, bevelThickness: .000161
  });
  const document = new Document(), buffer = document.createBuffer();
  const primitive = document.createPrimitive().setMaterial(document.createMaterial().setBaseColorFactor([.8, .8, .8, 1]));
  for (const [semantic, attribute] of [['POSITION', 'position'], ['NORMAL', 'normal']]) {
    primitive.setAttribute(semantic, document.createAccessor().setBuffer(buffer).setType('VEC3')
      .setArray(geometry.getAttribute(attribute).array.slice()));
  }
  primitive.setIndices(document.createAccessor().setBuffer(buffer).setType('SCALAR')
    .setArray(Uint32Array.from({ length: geometry.getAttribute('position').count }, (_, index) => index)));
  document.createScene().addChild(document.createNode().setExtras({ domus_part_role: 'thin' })
    .setMesh(document.createMesh().addPrimitive(primitive)));
  geometry.dispose();
  return { document, length };
}

function wallIntersections(document, origin, direction) {
  const ray = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction));
  const hits = [];
  for (const node of document.getRoot().listNodes()) for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(primitive.getAttribute('POSITION').getArray(), 3));
    geometry.setIndex(new THREE.BufferAttribute(primitive.getIndices().getArray(), 1));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.matrixAutoUpdate = false; mesh.matrix.fromArray(node.getWorldMatrix()); mesh.updateMatrixWorld(true);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    hits.push(...ray.intersectObject(mesh, false).map(hit => ({
      point: hit.point, distance: hit.distance, normal: hit.face.normal.clone().applyNormalMatrix(normalMatrix)
    })));
    geometry.dispose(); mesh.material.dispose();
  }
  return hits.sort((a, b) => a.distance - b.distance);
}

test('thin hollow frames retain separated outward and inward wall surfaces', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'domus-planning-thin-frame-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'frame.glb');
  const { document, length } = thinFrameFixture();
  const io = new NodeIO(); await io.write(input, document);
  // The smaller target represents this component's quota within a larger model.
  // Quality must take priority when that quota would otherwise flatten a wall.
  for (const targetTriangles of [1500, 24]) {
    const output = path.join(directory, `candidate-${targetTriangles}.glb`);
    const report = await simplifyPlanningShell(input, output, {
      targetTriangles, maxError: .003, stableSurfaceError: .003, thinSurfaceError: .0005
    });
    assert.ok(report.afterTriangles < report.beforeTriangles / 2, 'The wall must still be substantially simplified');
    const result = await io.read(output);
    // A silhouette test cannot detect opposing faces collapsed onto one plane.
    // Test both sides of the 1.2 mm wall, including face winding, along its length.
    for (const z of [.2, .35, .5, .65, .8].map(fraction => fraction * length)) for (const y of [-.045, 0, .045]) {
      const outer = wallIntersections(result, [.4, y, z], [-1, 0, 0])[0];
      const inner = wallIntersections(result, [0, y, z], [1, 0, 0])[0];
      assert.ok(outer && inner, `Both wall surfaces must exist at y=${y}, z=${z}`);
      assert.ok(outer.point.x - inner.point.x >= .0007,
        `Opposing wall surfaces collapsed to a ${(outer.point.x - inner.point.x) * 1000} mm separation`);
      assert.ok(outer.normal.x > .9, 'The outside wall must face outward (+X)');
      assert.ok(inner.normal.x < -.9, 'The cavity wall must face inward (-X)');
    }
  }
});

for (const method of ['protected', 'remesh']) {
  test(`${method} planning simplification preserves openings, thin parts and broad colours`, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'domus-planning-shell-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const input = path.join(directory, 'source.glb'), output = path.join(directory, 'candidate.glb');
    const io = new NodeIO(), source = assembly();
    const before = triangles(source), bounds = getBounds(source.getRoot().listScenes()[0]);
    const originalPositions = positionKeys(source);
    await io.write(input, source);
    const originalBytes = await readFile(input);

    const report = await simplifyPlanningShell(input, output, {
      method, targetTriangles: 2500, maxError: .003, remeshResolution: 128
    });
    const result = await io.read(output), after = triangles(result);
    assert.deepEqual(await readFile(input), originalBytes, 'Generating a candidate must not overwrite its input');
    // Authored hard seams take priority over the old 50% reduction target.
    assert.ok(after < before * .8, `${before} input triangles should be substantially reduced (got ${after})`);
    assert.equal(report.beforeTriangles, before); assert.equal(report.afterTriangles, after);
    if (method === 'remesh') assert.ok(report.remeshedParts > 0, 'The bulky base should receive new topology');
    else assert.equal(report.remeshedParts, 0);

    const afterBounds = getBounds(result.getRoot().listScenes()[0]);
    for (const edge of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(afterBounds[edge][axis] - bounds[edge][axis]) <= .003,
        `${edge} bound on axis ${axis} drifted by over 3 mm`);
    }
    assert.ok([...positionKeys(result)].some(key => !originalPositions.has(key)),
      'The simplified mesh should be able to reposition vertices rather than only remove original indices');
    assert.equal(intersects(result, [0, .86, 2], [0, 0, -1]), false, 'The board handle must remain a genuine opening');
    assert.equal(intersects(result, [.35, .86, 2], [0, 0, -1]), true, 'The board around the handle must remain');
    assert.equal(intersects(result, [.75, .85, 2], [0, 0, -1]), true, 'The thin pole must not disappear during remeshing');

    for (const mesh of result.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      for (const semantic of ['POSITION', 'NORMAL']) {
        const attribute = primitive.getAttribute(semantic);
        assert.ok(attribute, `Missing ${semantic}`);
        assert.ok(Array.from(attribute.getArray()).every(Number.isFinite), `${semantic} contains a non-finite value`);
      }
    }
    const colours = result.getRoot().listMaterials().map(material => material.getBaseColorFactor());
    for (const expected of [[.08, .35, .7, 1], [.85, .85, .85, 1], [.2, .2, .2, 1]]) {
      assert.ok(colours.some(actual => actual.every((value, index) => Math.abs(value - expected[index]) < 1e-6)),
        `Missing broad material colour ${expected}`);
    }
    const gltf = validateGLB(await readFile(output));
    for (const field of ['animations', 'skins', 'textures', 'images', 'cameras']) assert.equal(gltf[field]?.length ?? 0, 0);
    assert.equal(JSON.stringify(gltf).includes('PRIVATE_'), false, 'Private names and metadata must not survive');
    assert.equal(JSON.stringify(gltf).includes('domus_part_role'), false, 'Processing classifications must stay private');
    assert.equal(gltf.nodes.find(node => node.extras?.domus_schema_version)?.extras.domus_name, 'Synthetic planning model');
  });
}

test('planning simplification rejects invalid options before touching an input or output', async () => {
  for (const options of [
    { method: 'unsupported' }, { targetTriangles: 11 }, { targetTriangles: 12.5 },
    { maxError: 0 }, { maxError: -1 }, { maxError: NaN },
    { stableSurfaceError: 0 }, { stableSurfaceError: NaN }, { thinSurfaceError: 0 }, { thinSurfaceError: NaN },
    { remeshResolution: 3 }, { remeshResolution: 257 }, { remeshResolution: 64.5 }
  ]) {
    await assert.rejects(simplifyPlanningShell('/nonexistent/planning-source.glb', undefined, options),
      /Invalid planning simplification options/);
  }
});

test('geometry-only planning simplification rejects textured input without modifying it', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'domus-planning-texture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'textured.glb'), output = path.join(directory, 'candidate.glb');
  const document = assembly();
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=', 'base64');
  const texture = document.createTexture('private original texture').setMimeType('image/png').setImage(image);
  document.getRoot().listMaterials()[0].setBaseColorTexture(texture);
  await new NodeIO().write(input, document);
  const originalBytes = await readFile(input);
  await assert.rejects(simplifyPlanningShell(input, output), /static, texture-free/);
  assert.deepEqual(await readFile(input), originalBytes);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('planning simplification rejects morph targets before changing their topology', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'domus-planning-morph-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'morph.glb'), output = path.join(directory, 'candidate.glb');
  const document = sphereFixture([{}]);
  const primitive = document.getRoot().listMeshes()[0].listPrimitives()[0];
  const positions = primitive.getAttribute('POSITION');
  primitive.addTarget(document.createPrimitiveTarget().setAttribute('POSITION', document.createAccessor()
    .setBuffer(positions.getBuffer()).setType('VEC3').setArray(new Float32Array(positions.getArray().length))));
  await new NodeIO().write(input, document);
  const originalBytes = await readFile(input);
  await assert.rejects(simplifyPlanningShell(input, output), /static|morph/i);
  assert.deepEqual(await readFile(input), originalBytes);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('scaled planning meshes are simplified using world metres', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'domus-planning-scale-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'scaled.glb'), output = path.join(directory, 'candidate.glb');
  const io = new NodeIO();
  await io.write(input, sphereFixture([{ scale: [10, 10, 10], role: 'bulk' }]));
  await simplifyPlanningShell(input, output, { targetTriangles: 100, maxError: .003 });
  const result = await io.read(output);
  // Original vertices lie on the 10 metre sphere. Working in local units would
  // permit about 15 mm radial drift while still preserving the overall bounds.
  let maximumRadialDrift = 0;
  for (const node of result.getRoot().listNodes()) for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
    const positions = primitive.getAttribute('POSITION').getArray();
    const matrix = new THREE.Matrix4().fromArray(node.getWorldMatrix());
    for (let index = 0; index < positions.length; index += 3) {
      const point = new THREE.Vector3(...positions.subarray(index, index + 3)).applyMatrix4(matrix);
      maximumRadialDrift = Math.max(maximumRadialDrift, Math.abs(point.length() - 10));
    }
  }
  assert.ok(maximumRadialDrift <= .003, `World surface drift reached ${maximumRadialDrift} metres`);
});

test('shared mesh instances retain independent transforms and part processing', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'domus-planning-instances-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'instances.glb'), output = path.join(directory, 'candidate.glb');
  const source = sphereFixture([
    { translation: [-1, 0, 0], role: 'feature' },
    { translation: [1, 0, 0], scale: [-.5, 2, .5], role: 'thin' }
  ], .2);
  const bounds = getBounds(source.getRoot().listScenes()[0]);
  const io = new NodeIO(); await io.write(input, source);
  const report = await simplifyPlanningShell(input, output, { targetTriangles: 1500, maxError: .003 });
  assert.equal(report.beforeTriangles, triangles(source) * 2, 'Count both rendered instances of the shared mesh');
  assert.equal(report.parts.length, 2, 'Process differently classified instances independently');
  const result = await io.read(output), afterBounds = getBounds(result.getRoot().listScenes()[0]);
  for (const edge of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(afterBounds[edge][axis] - bounds[edge][axis]) <= .003);
  }
  assert.equal(intersects(result, [-1, 0, 2], [0, 0, -1]), true);
  assert.equal(intersects(result, [1, .3, 2], [0, 0, -1]), true);
  assert.equal(intersects(result, [0, 0, 2], [0, 0, -1]), false);
});

test('surface transfer interpolates authored normals and keeps opposite thin faces separate', async () => {
  const { transferSurfaceNormals, coincidentOppositeArea } = await import('../scripts/simplify-planning-shell.mjs');
  const positions = new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,.0001, 0,1,.0001, 1,0,.0001]);
  const indices = new Uint32Array([0,1,2,3,4,5]);
  const sourceNormals = new Float32Array([0,0,1, .6,0,.8, 0,.6,.8, 0,0,-1, 0,0,-1, 0,0,-1]);
  const destination = new Float32Array([.25,.25,0, .25,.25,.0001]);
  const normals = new Float32Array([0,0,1, 0,0,-1]);
  transferSurfaceNormals(positions, indices, sourceNormals, destination, normals, .001);
  const expected = new THREE.Vector3(.15,.15,.9).normalize();
  assert.ok(new THREE.Vector3().fromArray(normals).distanceTo(expected)<1e-6);
  assert.deepEqual(Array.from(normals.slice(3)),[0,0,-1]);
  assert.equal(coincidentOppositeArea(positions, indices),0);
  assert.equal(coincidentOppositeArea(positions,new Uint32Array([0,1,2,0,2,1])),.5);
});

test('simplification retains distinct roughness and specular extensions', async t => {
  const { KHRMaterialsSpecular } = await import('@gltf-transform/extensions');
  const directory=await mkdtemp(path.join(os.tmpdir(),'domus-finishes-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const document=sphereFixture([{}]), materials=document.createExtension(KHRMaterialsSpecular);
  const material=document.createMaterial().setRoughnessFactor(.048634).setMetallicFactor(.7)
    .setExtension('KHR_materials_specular',materials.createSpecular().setSpecularFactor(.8).setSpecularColorFactor([.52,.56,.58]));
  document.getRoot().listMeshes()[0].listPrimitives()[0].setMaterial(material);
  const io=new NodeIO().registerExtensions([KHRMaterialsSpecular]);
  const input=path.join(directory,'input.glb'),output=path.join(directory,'output.glb');
  await io.write(input,document);await simplifyPlanningShell(input,output);
  const result=(await io.read(output)).getRoot().listMaterials()[0];
  assert.equal(result.getRoughnessFactor(),.048634);
  assert.equal(result.getMetallicFactor(),.7);
  assert.deepEqual(result.getExtension('KHR_materials_specular').getSpecularColorFactor(),[.52,.56,.58]);
});

test('surface restoration preserves a verified geometry budget and restores source finishes', async t => {
  const {restorePlanningSurfaces}=await import('../scripts/restore-planning-surfaces.mjs');
  const directory=await mkdtemp(path.join(os.tmpdir(),'domus-surface-restore-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const io=new NodeIO(),reference=sphereFixture([{}]);
  reference.getRoot().listMeshes()[0].listPrimitives()[0].setMaterial(reference.createMaterial().setRoughnessFactor(.048634).setBaseColorFactor([.8,.8,.8,1]));
  const source=path.join(directory,'reference.glb'),baseline=path.join(directory,'baseline.glb'),output=path.join(directory,'output.glb');
  await io.write(source,reference);const before=await io.read(source);
  before.getRoot().listMaterials()[0].setRoughnessFactor(.65);
  before.getRoot().listScenes()[0].addChild(before.createNode().setExtras({domus_schema_version:2,domus_display_profile:'topology-exterior-v2',private_note:'PRIVATE_SENTINEL'}));
  await io.write(baseline,before);
  const report=await restorePlanningSurfaces(baseline,source,output),result=await io.read(output);
  assert.equal(report.unmatched,0);assert.equal(triangles(result),triangles(before));
  const carrier=result.getRoot().listNodes().find(n=>n.getExtras().domus_schema_version);
  assert.equal(carrier.getExtras().domus_display_profile,'topology-exterior-v2');
  assert.equal(carrier.getExtras().private_note,undefined);
  assert.deepEqual(positionKeys(result),positionKeys(before));
  assert.equal(result.getRoot().listMaterials()[0].getRoughnessFactor(),.048634);
  const {optimizeModel}=await import('../scripts/optimize-models.mjs');
  const optimized=await optimizeModel(output,path.join(directory,'runtime.glb'));
  assert.equal(optimized.after.triangles,report.afterTriangles,'Compression must not simplify a restored display mesh again');
});

test('surface restoration keeps broad manufactured faces flat at bevel-adjacent corners', async t => {
  const {restorePlanningSurfaces}=await import('../scripts/restore-planning-surfaces.mjs');
  const directory=await mkdtemp(path.join(os.tmpdir(),'domus-flat-faces-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const d=new Document(),buffer=d.createBuffer(),scene=d.createScene(),g=new THREE.BoxGeometry(1,1,.1);
  const p=d.createPrimitive().setMaterial(d.createMaterial());
  for(const [semantic,name]of [['POSITION','position'],['NORMAL','normal']])p.setAttribute(semantic,d.createAccessor().setBuffer(buffer).setType('VEC3').setArray(g.getAttribute(name).array.slice()));
  p.setIndices(d.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(g.index.array.slice()));scene.addChild(d.createNode().setMesh(d.createMesh().addPrimitive(p)));g.dispose();
  const io=new NodeIO(),source=path.join(directory,'source.glb'),baseline=path.join(directory,'baseline.glb'),output=path.join(directory,'output.glb');await io.write(source,d);
  const normals=p.getAttribute('NORMAL').getArray(),positions=p.getAttribute('POSITION').getArray();
  for(let i=0;i<normals.length;i+=3)new THREE.Vector3().fromArray(positions,i).normalize().toArray(normals,i);
  await io.write(baseline,d);await restorePlanningSurfaces(baseline,source,output);
  for(const mesh of (await io.read(output)).getRoot().listMeshes())for(const primitive of mesh.listPrimitives()){
    const pos=primitive.getAttribute('POSITION').getArray(),n=primitive.getAttribute('NORMAL').getArray(),indices=primitive.getIndices().getArray();
    for(let i=0;i<indices.length;i+=3){const ids=Array.from(indices.subarray(i,i+3));const face=new THREE.Triangle(...ids.map(v=>new THREE.Vector3().fromArray(pos,v*3))).getNormal(new THREE.Vector3());for(const v of ids)assert.ok(face.dot(new THREE.Vector3().fromArray(n,v*3))>.9999);}
  }
});
