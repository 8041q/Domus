import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {optimizeModel} from '../scripts/optimize-models.mjs';
const exec=promisify(execFile), root=fileURLToPath(new URL('../',import.meta.url));

test('normal bake restores a flat interior beside a bevel and survives glTF compression', {skip:!process.env.DOMUS_TEST_BLENDER}, async t=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'domus-normal-bake-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const directory=path.join(temp,'private','review');await mkdir(directory,{recursive:true});
  const fixture=path.join(temp,'fixture.py'), output=path.join(directory,'baked.glb');
  await writeFile(fixture,`import bpy,runpy,math,json\nfrom mathutils import Vector\nfrom pathlib import Path\ndirectory=Path(${JSON.stringify(directory)})\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_grid_add(x_subdivisions=24,y_subdivisions=24,size=1)\no=bpy.context.object\no.name='PRIVATE_REFERENCE_SENTINEL'\nfor p in o.data.polygons:p.use_smooth=True\no.data.normals_split_custom_set([(0.6,0,0.8) if o.data.vertices[l.vertex_index].co.x>.45 else (0,0,1) for l in o.data.loops])\nbpy.ops.export_scene.gltf(filepath=str(directory/'reference.glb'),export_format='GLB',export_tangents=False)\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_plane_add(size=1)\no=bpy.context.object\no.name='PRIVATE_TARGET_SENTINEL'\nfor p in o.data.polygons:p.use_smooth=True\no.data.normals_split_custom_set([(0.6,0,0.8) if o.data.vertices[l.vertex_index].co.x>0 else (0,0,1) for l in o.data.loops])\nm=bpy.data.materials.new('PRIVATE_FINISH_SENTINEL');m.use_nodes=True\nm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.05\no.data.materials.append(m)\nbpy.ops.export_scene.gltf(filepath=str(directory/'target.glb'),export_format='GLB')\nbake=runpy.run_path(${JSON.stringify(path.join(root,'scripts/bake-planning-surface.py'))})['bake_surface']\nreport=bake(directory/'reference.glb',directory/'target.glb',directory/'baked.glb',256)\nassert report['triangles']==2 and report['uvCoverage']>.1 and report['inputsUnchanged']\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.import_scene.gltf(filepath=str(directory/'baked.glb'))\no=next(o for o in bpy.context.scene.objects if o.type=='MESH');mesh=o.data\nmesh.calc_loop_triangles();mesh.calc_tangents()\npoint=Vector((-.15,.15,0));found=False\nfor triangle in mesh.loop_triangles:\n a,b,c=[mesh.vertices[i].co for i in triangle.vertices]\n from mathutils.geometry import barycentric_transform,intersect_point_tri\n if not intersect_point_tri(point,a,b,c):continue\n weights=barycentric_transform(point,a,b,c,Vector((1,0,0)),Vector((0,1,0)),Vector((0,0,1)))\n uv=sum((mesh.uv_layers.active.data[i].uv*w for i,w in zip(triangle.loops,weights)),Vector((0,0)))\n normal=sum((mesh.corner_normals[i].vector*w for i,w in zip(triangle.loops,weights)),Vector()).normalized()\n tangent=sum((mesh.loops[i].tangent*w for i,w in zip(triangle.loops,weights)),Vector()).normalized()\n sign=sum(mesh.loops[i].bitangent_sign*w for i,w in zip(triangle.loops,weights))\n image=next(n.image for n in o.data.materials[triangle.material_index].node_tree.nodes if n.type=='TEX_IMAGE')\n x,y=int(uv.x*image.size[0]),int(uv.y*image.size[1]);offset=(y*image.size[0]+x)*4\n pixel=Vector(tuple(image.pixels[offset+k]*2-1 for k in range(3)))\n result=(tangent*pixel.x+normal.cross(tangent)*sign*pixel.y+normal*pixel.z).normalized()\n assert result.angle(Vector((0,0,1)))<math.radians(1),str(result)\n found=True;break\nassert found\n`);
  await exec(process.env.DOMUS_TEST_BLENDER,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',fixture],{maxBuffer:5*1024*1024});
  const bytes=await readFile(output);
  for(const sentinel of ['PRIVATE_REFERENCE_SENTINEL','PRIVATE_TARGET_SENTINEL','PRIVATE_FINISH_SENTINEL'])assert.equal(bytes.includes(Buffer.from(sentinel)),false);
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS),doc=await io.read(output);
  assert.equal(doc.getRoot().listTextures().length,1);
  assert.ok(Math.abs(doc.getRoot().listMaterials()[0].getRoughnessFactor()-.05)<1e-6);
  // The synthetic plane lacks the generator's prepared-shell marker; add it to
  // exercise the same no-second-simplification path as production models.
  doc.getRoot().listScenes()[0].addChild(doc.createNode().setExtras({domus_schema_version:2,domus_display_profile:'topology-exterior-v2'}));
  await io.write(output,doc);
  const result=await optimizeModel(output,path.join(directory,'compressed.glb'));
  assert.equal(result.after.triangles,2);
  const {MeshoptDecoder}=await import('meshoptimizer');await MeshoptDecoder.ready;
  const compressed=await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}).read(path.join(directory,'compressed.glb'));
  assert.deepEqual(compressed.getRoot().listTextures()[0].getImage(),doc.getRoot().listTextures()[0].getImage());
  for(const mesh of compressed.getRoot().listMeshes())for(const primitive of mesh.listPrimitives()){
    assert.ok(primitive.getMaterial().getNormalTexture());
    assert.ok(primitive.getAttribute('TANGENT'));assert.ok(primitive.getAttribute('TEXCOORD_0'));
  }
});
