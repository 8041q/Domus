import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateGLB } from '../scripts/asset-safety.mjs';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('original authoring models and backups are ignored and absent from the Git index', async () => {
  for (const name of ['og_models/original.blend', 'og_models/nested/original.blend1', 'og_models/source.glb']) {
    const { stdout } = await exec('git', ['check-ignore', '--no-index', name], { cwd: root });
    assert.equal(stdout.trim(), name);
  }
  const { stdout } = await exec('git', ['ls-files', '-z', '--', 'og_models'], { cwd: root });
  assert.equal(stdout, '', 'Original files must never enter the Git index');
});

test('Blender rebuilds isolated proxies with measured bounds and leaves its source intact', { skip: !process.env.DOMUS_TEST_BLENDER }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'domus-proxies-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'og_models'); await mkdir(source);
  const original = path.join(source, 'C8c_Rig.blend');
  const setup = path.join(temp, 'fixture.py');
  await writeFile(setup, `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.context.scene.unit_settings.scale_length = .01\nbpy.ops.mesh.primitive_cube_add(size=1, location=(100,200,300))\no=bpy.context.object\no.name='PRIVATE_SOURCE_SENTINEL'\no.dimensions=(200,100,80)\nbpy.ops.object.transform_apply(location=False,rotation=False,scale=True)\no.scale.x=-1\nm=o.modifiers.new('Manufacturing detail','SUBSURF')\nm.subdivision_type='SIMPLE'\nm.levels=4\nbpy.ops.mesh.primitive_cube_add(size=10000)\nbpy.context.object.hide_render=True\nbpy.context.object.hide_set(True)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original)})\n`);
  const blender = process.env.DOMUS_TEST_BLENDER;
  const flags = ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1'];
  await exec(blender, [...flags, '--python', setup], { cwd: temp });
  const originalHash = sha256(await readFile(original));
  for (const name of ['D8d', 'V8v', 'Z7z', 'AInno20']) await copyFile(original, path.join(source, `${name}_Rig.blend`));
  const output = path.join(temp, 'private/models'), previews = path.join(temp, 'private/previews');
  const args = [...flags, '--python', path.join(root, 'scripts/create-planning-proxies.py'), '--', '--source', source, '--output', output, '--previews', previews];
  await exec(blender, args, { cwd: temp, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(sha256(await readFile(original)), originalHash);
  const bytes = await readFile(path.join(output, 'C8c-proxy.glb'));
  const gltf = validateGLB(bytes);
  assert.equal(bytes.includes(Buffer.from('PRIVATE_SOURCE_SENTINEL')), false);
  for (const field of ['animations', 'skins', 'textures', 'images', 'cameras']) assert.equal(gltf[field]?.length ?? 0, 0);
  const metadata = gltf.nodes.find(node => node.extras?.domus_schema_version)?.extras;
  assert.equal(metadata.domus_name, 'C8c — planning model');
  assert.equal(metadata.domus_display_profile, 'topology-exterior-v2');
  for (const [field, value] of [['width', 1], ['depth', 2], ['height', .8]]) assert.ok(Math.abs(metadata[`domus_display_${field}_m`] - value) < 1e-5);
  const [report] = JSON.parse(await readFile(path.join(previews, 'report.json'), 'utf8'));
  assert.ok(report.proxyTriangles <= 60000); assert.equal(report.sourceUnchanged, true);
  assert.ok(report.minimumSilhouetteIoU >= .97); assert.ok(report.boundsDriftMetres <= .003);
  assert.equal(report.activated, true);
  // The display copies follow actual source geometry instead of product-name recipes.
  const { NodeIO } = await import('@gltf-transform/core');
  const io = new NodeIO(), geometry = new Set();
  for (const name of ['C8c', 'D8d', 'V8v', 'Z7z', 'AInno20']) {
    const file = await readFile(path.join(output, `${name}-proxy.glb`));
    const document = await io.readBinary(file);
    const positions = document.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives().flatMap(primitive => Array.from(primitive.getAttribute('POSITION').getArray())));
    geometry.add(sha256(Buffer.from(new Float32Array(positions).buffer)));
    // Baking a mirrored Blender object must keep its normals facing outwards.
    const { getBounds } = await import('@gltf-transform/functions');
    const bounds = getBounds(document.getRoot().listScenes()[0]);
    const centre = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);
    for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      const points = primitive.getAttribute('POSITION').getArray(), normals = primitive.getAttribute('NORMAL').getArray();
      for (let i = 0; i < points.length; i += 3) {
        const outward = [0, 1, 2].reduce((sum, axis) => sum + (points[i + axis] - centre[axis]) * normals[i + axis], 0);
        assert.ok(outward > 0, 'Mirrored source faces must not produce inward normals');
      }
    }
    assert.equal(file.includes(Buffer.from('PRIVATE_SOURCE_SENTINEL')), false);
    assert.equal(document.getRoot().listTextures().length, 0);
    assert.equal(document.getRoot().listAnimations().length, 0);
  }
  assert.ok(geometry.size <= 2, 'Identical source cubes must not invent different product shapes');
  assert.equal(report.mode, 'topology-exterior');
  // Rebuilding one model keeps its display revision stable and retains other reports.
  await exec(blender, [...args, '--only', 'C8c'], { cwd: temp, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(JSON.parse(await readFile(path.join(previews, 'report.json'), 'utf8')).length, 5);
  assert.equal(sha256(await readFile(path.join(output, 'C8c-proxy.glb'))), sha256(bytes));
});
