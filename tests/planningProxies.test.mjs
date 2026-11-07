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
  await writeFile(setup, `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.context.scene.unit_settings.scale_length = .01\nbpy.ops.mesh.primitive_cube_add(size=1, location=(100,200,300))\no=bpy.context.object\no.name='PRIVATE_SOURCE_SENTINEL'\no.dimensions=(200,100,80)\nbpy.ops.object.transform_apply(location=False,rotation=False,scale=True)\no.scale.x=-1\nfinish=bpy.data.materials.new('PRIVATE_FINISH_SENTINEL')\nfinish.use_nodes=True\nshader=finish.node_tree.nodes.get('Principled BSDF')\nshader.inputs['Roughness'].default_value=.048634\nshader.inputs['Metallic'].default_value=.7\nshader.inputs['Specular IOR Level'].default_value=.8\nshader.inputs['Specular Tint'].default_value=(.52,.56,.58,1)\no.data.materials.append(finish)\nfor p in o.data.polygons:p.use_smooth=True\no.data.normals_split_custom_set([tuple(o.data.vertices[l.vertex_index].co.normalized()) for l in o.data.loops])\nm=o.modifiers.new('Manufacturing detail','SUBSURF')\nm.subdivision_type='SIMPLE'\nm.levels=4\nbpy.ops.mesh.primitive_cube_add(size=10000)\nbpy.context.object.hide_render=True\nbpy.context.object.hide_set(True)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(original)})\n`);
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
  assert.equal(gltf.textures?.length,1);assert.equal(gltf.images?.length,1);
  for (const field of ['animations', 'skins', 'cameras']) assert.equal(gltf[field]?.length ?? 0, 0);
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
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  for (const name of ['C8c', 'D8d', 'V8v', 'Z7z', 'AInno20']) {
    const file = await readFile(path.join(output, `${name}-proxy.glb`));
    const document = await io.readBinary(file);

    // Baking a mirrored Blender object must keep its normals facing outwards.
    const { getBounds } = await import('@gltf-transform/functions');
    const bounds = getBounds(document.getRoot().listScenes()[0]);
    const sizes=bounds.min.map((v,i)=>bounds.max[i]-v).sort((a,b)=>a-b);
    for(const [i,expected] of [.8,1,2].entries())assert.ok(Math.abs(sizes[i]-expected)<.003);
    const centre = bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2);
    for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      const points = primitive.getAttribute('POSITION').getArray(), normals = primitive.getAttribute('NORMAL').getArray();
      for (let i = 0; i < points.length; i += 3) {
        const outward = [0, 1, 2].reduce((sum, axis) => sum + (points[i + axis] - centre[axis]) * normals[i + axis], 0);
        assert.ok(outward > 0, 'Mirrored source faces must not produce inward normals');
      }
    }
    assert.equal(file.includes(Buffer.from('PRIVATE_SOURCE_SENTINEL')), false);
    const finish=document.getRoot().listMaterials()[0];
    assert.ok(Math.abs(finish.getRoughnessFactor()-.048634)<1e-6);
    assert.ok(Math.abs(finish.getMetallicFactor()-.7)<1e-6);
    assert.ok(finish.getExtension('KHR_materials_specular'),'Specular response must survive generation');
    assert.equal(document.getRoot().listTextures().length, name === 'C8c' ? 1 : 0);
    if (name === 'C8c') for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      assert.ok(primitive.getAttribute('TEXCOORD_0')); assert.ok(primitive.getAttribute('TANGENT'));
      assert.ok(primitive.getMaterial().getNormalTexture());
    }
    assert.equal(document.getRoot().listAnimations().length, 0);
  }
  const reports=JSON.parse(await readFile(path.join(previews,'report.json'),'utf8'));
  for(const item of reports){
    assert.ok(item.minimumSilhouetteIoU>=.97,'Each copy must retain the source shape, regardless of normal-fan vertex duplication');
    assert.ok(item.boundsDriftMetres<=.003);assert.ok(item.proxyTriangles<=60000);
  }
  assert.equal(report.mode, 'topology-exterior');
  // Rebuilding one model keeps its display revision stable and retains other reports.
  await exec(blender, [...args, '--only', 'C8c'], { cwd: temp, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(JSON.parse(await readFile(path.join(previews, 'report.json'), 'utf8')).length, 5);
  assert.equal(sha256(await readFile(path.join(output, 'C8c-proxy.glb'))), sha256(bytes));
});
