"""Create static, simplified exterior display copies of private Blender originals.
Run through `npm run models:proxies`. Blender never saves a source .blend file.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import shutil
import subprocess
import tempfile

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from planning_model_roles import classify_part
from planning_model_paths import validate_output_paths

RECIPES = {
    'c8c': {'name': 'C8c', 'category': 'Hospital Bed'},
    'd8d': {'name': 'D8d', 'category': 'Hospital Bed'},
    'v8v': {'name': 'V8v', 'category': 'Hospital Bed', 'stableSurfaceError': .003, 'thinSurfaceError': .0005},
    'z7z': {'name': 'Z7z', 'category': 'Hospital Bed', 'stableSurfaceError': .003},
    'ainno20': {'name': 'AInno20', 'category': 'Others', 'lamp': True},
}


def fingerprint(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def material(name, color, metallic=0):
    result = bpy.data.materials.new(name)
    result.diffuse_color = color
    result.use_nodes = True
    shader = result.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = color
    shader.inputs['Roughness'].default_value = .65
    shader.inputs['Metallic'].default_value = metallic
    return result


def source_palette(mesh):
    colors = []
    cache = source_palette.cache
    for mat in mesh.materials:
        key = mat.as_pointer() if mat else 0
        if key in cache:
            colors.append(cache[key]); continue
        color = (.8, .8, .8, 1)
        metallic = 0
        if mat:
            color = tuple(mat.diffuse_color)
            if mat.use_nodes:
                shader = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
                if shader:
                    color = tuple(shader.inputs['Base Color'].default_value)
                    metallic = shader.inputs['Metallic'].default_value
                # Reduce linked image appearance to one broad colour; never export
                # the image, UV coordinates, decals or its fine visual information.
                texture = next((n for n in mat.node_tree.nodes if n.type=='TEX_IMAGE' and n.image and n.outputs['Color'].is_linked),None)
                if texture and len(texture.image.pixels):
                    pixels=np.empty(len(texture.image.pixels),dtype=np.float32)
                    texture.image.pixels.foreach_get(pixels)
                    pixels=pixels.reshape((-1,4));sample=pixels[::max(1,len(pixels)//4096)]
                    coverage=float(np.mean(sample[:,3]>.1))
                    sample=sample[sample[:,3]>.1]
                    if len(sample):
                        average=sample[:,:3].mean(axis=0)
                        if float(average.max()-average.min())<.15:source_palette.monochrome_textures.add(key)
                        if coverage<.65 and float(average.max()-average.min())<.15:
                            source_palette.decals.add(key)
                        color=tuple(average)+(1,)
        # Keep broad colours, without images, original shaders or material names.
        value=(tuple(round(max(0,min(1,float(c)))*24)/24 for c in color[:3])+(1,),round(float(metallic)*2)/2)
        cache[key]=value; colors.append(value)
    return colors or [((.8,.8,.8,1),0)]


def visible_collections(collection, allowed=True):
    result = set()
    allowed = allowed and not collection.hide_render
    if allowed:
        result.update(o.as_pointer() for o in collection.objects)
    for child in collection.children:
        result.update(visible_collections(child, allowed))
    return result


def extract_shell(path, recipe):
    from mathutils.bvhtree import BVHTree
    source_palette.cache={}
    source_palette.decals=set()
    source_palette.monochrome_textures=set()
    bpy.ops.wm.open_mainfile(filepath=str(path),load_ui=False,use_scripts=False)
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    renderable = visible_collections(bpy.context.scene.collection)
    lower,upper = np.full(3,np.inf),np.full(3,-np.inf)
    parts=[]; source_triangles=0
    for obj in list(bpy.context.view_layer.objects):
        if obj.type!='MESH' or obj.hide_render or not obj.visible_get() or obj.as_pointer() not in renderable:
            continue
        # Source/reference duplicates and rig collision helpers are not product skin.
        label=obj.name.lower()
        if label.startswith(('source ', 'source|', 'source |', 'collision ', 'reference ')):
            continue
        evaluated=obj.evaluated_get(graph);mesh=evaluated.to_mesh()
        try:
            if not mesh.vertices or not mesh.polygons:continue
            coordinates=np.empty(len(mesh.vertices)*3,dtype=np.float64);mesh.vertices.foreach_get('co',coordinates)
            matrix=np.array(evaluated.matrix_world)
            coordinates=(coordinates.reshape((-1,3))@matrix[:3,:3].T+matrix[:3,3])*bpy.context.scene.unit_settings.scale_length
            lo,hi=coordinates.min(axis=0),coordinates.max(axis=0)
            lower=np.minimum(lower,lo);upper=np.maximum(upper,hi)
            mesh.calc_loop_triangles()
            faces=np.empty(len(mesh.loop_triangles)*3,dtype=np.int32);mesh.loop_triangles.foreach_get('vertices',faces)
            # Baking a mirrored world transform reverses handedness. Preserve the
            # original outward winding before regenerating normals in a new scene.
            if np.linalg.det(matrix[:3,:3])<0:
                faces=faces.reshape((-1,3))[:,[0,2,1]].reshape(-1)
            materials=np.empty(len(mesh.loop_triangles),dtype=np.int32);mesh.loop_triangles.foreach_get('material_index',materials)
            source_triangles+=len(materials)
            size=hi-lo; sorted_size=sorted(size)
            palette=source_palette(mesh)
            decal_slots=[i for i,mat in enumerate(mesh.materials) if mat and (mat.as_pointer() in source_palette.decals or (size.min()<.003 and mat.as_pointer() in source_palette.monochrome_textures))]
            keep=~np.isin(materials,decal_slots)
            if not np.any(keep):continue
            ancestors=[];parent=obj.parent
            while parent:
                ancestors.append(parent.name.lower());parent=parent.parent
            parts.append({'positions':coordinates.astype(np.float32),'faces':faces.reshape((-1,3))[keep],'materialIndices':materials[keep],'palette':palette,'lo':lo,'hi':hi,
                          'label':label,'ancestry':' '.join(ancestors),
                          'significant':size.max()>=.075 and sorted_size[-1]*sorted_size[-2]>=.0018 and not any(word in label for word in ['cable','cord','wire'])})
        finally:evaluated.to_mesh_clear()
    if not parts or not np.isfinite(upper-lower).all():raise ValueError('No visible product surfaces')
    dimensions=upper-lower
    for part in parts:
        part['role']=classify_part(part['label'],part['ancestry'],part['lo'],part['hi'],lower,upper,recipe.get('lamp',False))
    # Keep measured extremal components instead of stretching the remaining model
    # back into its original envelope after removing a small component.
    for part in parts:
        part['extremal']=bool(np.any(np.abs(part['lo']-lower)<1e-5) or np.any(np.abs(part['hi']-upper)<1e-5))
    offsets=np.cumsum([0]+[len(p['positions']) for p in parts[:-1]])
    vertices=np.concatenate([p['positions'] for p in parts])
    faces=np.concatenate([p['faces']+offsets[i] for i,p in enumerate(parts)])
    owners=np.repeat(np.arange(len(parts)),[len(p['faces']) for p in parts])
    tree=BVHTree.FromPolygons(vertices,faces,all_triangles=True)
    counts=np.zeros(len(parts),dtype=np.int32)
    center=Vector(((lower+upper)/2).tolist());span=float(dimensions.max())*1.25
    directions=[Vector((0,0,1))]
    for elevation in [-15,0,25,50,75]:
        e=math.radians(elevation)
        for azimuth in range(0,360,45):
            a=math.radians(azimuth)
            directions.append(Vector((math.cos(a)*math.cos(e),math.sin(a)*math.cos(e),math.sin(e))))
    resolution=72
    for view in directions:
        right=view.cross(Vector((0,0,1)))
        if right.length<.01:right=Vector((1,0,0))
        right.normalize();up=right.cross(view).normalized()
        origin=center+view*span*2
        for y in range(resolution):
            row=origin+up*((y+.5)/resolution-.5)*span
            for x in range(resolution):
                hit,normal,index,distance=tree.ray_cast(row+right*((x+.5)/resolution-.5)*span,-view,span*4)
                if index is not None:counts[owners[index]]+=1
    del tree,vertices,faces,owners
    kept=[p for i,p in enumerate(parts) if p['extremal'] or (p['significant'] and counts[i]>=2)]
    print('DOMUS_SHELL_SELECTION '+json.dumps({'name':recipe['name'],'candidates':len(parts),'kept':len(kept),'sourceTriangles':source_triangles}),flush=True)
    return kept, parts, dimensions.tolist(), source_triangles, (lower,upper)


def rebuild_shell(parts, dimensions, recipe, source_bounds, clean=True):
    import bmesh
    # Remove all source rigs, names, images, actions and custom properties first.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    palette={};objects=[]
    for index,part in enumerate(parts):
        mesh=bpy.data.meshes.new('Display surface')
        mesh.from_pydata(part['positions'].tolist(),[],part['faces'].tolist());mesh.update()
        for color,metallic in part['palette']:
            key=(color,metallic)
            if key not in palette:palette[key]=material('Display colour '+str(len(palette)),color,metallic)
            mesh.materials.append(palette[key])
        mesh.polygons.foreach_set('material_index',part['materialIndices'])
        obj=bpy.data.objects.new('Surface '+str(index),mesh);bpy.context.scene.collection.objects.link(obj)
        obj['domus_part_role']=part['role']
        bpy.context.view_layer.objects.active=obj
        if clean:
            bm=bmesh.new();bm.from_mesh(mesh)
            bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00005)
            bmesh.ops.dissolve_limit(bm,angle_limit=math.radians(1),verts=list(bm.verts),edges=list(bm.edges),delimit={'MATERIAL'})
            bm.to_mesh(mesh);bm.free();mesh.update()
        for polygon in obj.data.polygons:polygon.use_smooth=True
        obj.data.set_sharp_from_angle(angle=math.radians(40))
        # Sharp edges already define the split normals used by the GLB exporter.
        # Avoid per-object operator evaluation (quadratic on large CAD assemblies).
        objects.append(obj)
    # The source may have its long bed axis in X; standardize the displayed footprint.
    rotate=not recipe.get('lamp') and dimensions[0]>dimensions[1]
    lower,upper=source_bounds
    origin=Vector(((lower[0]+upper[0])/2,(lower[1]+upper[1])/2,lower[2]))
    for obj in objects:
        for vertex in obj.data.vertices:
            vertex.co-=origin
    if rotate:
        for obj in objects:
            for vertex in obj.data.vertices:vertex.co=(-vertex.co.y,vertex.co.x,vertex.co.z)
        dimensions=[dimensions[1],dimensions[0],dimensions[2]]
    bpy.context.view_layer.update()
    bpy.context.view_layer.update()
    return objects,dimensions


def preview(scene, objects, dimensions, filename):
    target = Vector((0, 0, dimensions[2]/2))
    span = max(dimensions)
    bpy.ops.object.camera_add(location=target+Vector((1.5, -1.8, 1.1))*span)
    camera = bpy.context.object
    camera.rotation_euler = (target-camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'; camera.data.ortho_scale = span*1.55
    scene.camera = camera
    for delta, power in [((1, -2, 2), 1000), ((-2, -.5, 1), 600), ((0, 2, 2), 800)]:
        bpy.ops.object.light_add(type='AREA', location=target+Vector(delta)*span)
        light = bpy.context.object; light.data.energy = power; light.data.size = 4
        light.rotation_euler = (target-light.location).to_track_quat('-Z', 'Y').to_euler()
    scene.world = bpy.data.worlds.new('Preview')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.7, .7, .7, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .5
    scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'; scene.cycles.samples = 16
    scene.render.resolution_x = 600; scene.render.resolution_y = 600; scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'; scene.render.filepath = str(filename)
    bpy.ops.render.render(write_still=True)


def export_geometry(filename):
    bpy.ops.export_scene.gltf(filepath=str(filename),export_format='GLB',export_extras=True,
                             export_animations=False,export_cameras=False,export_lights=False,export_texcoords=False)


def add_metadata(recipe,dimensions):
    carrier=bpy.data.objects.new('Planning model',None);bpy.context.scene.collection.objects.link(carrier)
    metadata={'domus_schema_version':2,'domus_name':recipe['name']+' — planning model',
              'domus_category':recipe['category'],'domus_display_profile':'topology-exterior-v2',
              'domus_collision':True,'domus_clearance_front_m':0,'domus_clearance_back_m':0,'domus_clearance_sides_m':0}
    for axis,key in enumerate(['width','depth','height']):metadata['domus_display_'+key+'_m']=dimensions[axis]
    for key,value in metadata.items():carrier[key]=value


def verify(reference,candidates,directory,resolution):
    import runpy
    previous=sys.argv
    try:
        sys.argv=['verify-planning-models.py','--','--reference',str(reference),'--candidates',*[str(p) for p in candidates],
                  '--output',str(directory),'--resolution',str(resolution)]
        runpy.run_path(str(Path(__file__).with_name('verify-planning-models.py')),run_name='__main__')
    finally:sys.argv=previous
    return json.loads((directory/'report.json').read_text())


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=Path('og_models'))
    parser.add_argument('--output',type=Path,default=Path('private/models'))
    parser.add_argument('--previews',type=Path,default=Path('private/proxy-previews'))
    parser.add_argument('--only')
    parser.add_argument('--compare-only',action='store_true',help='Generate and verify candidates without replacing the active model')
    parser.add_argument('--skip-previews',action='store_true')
    parser.add_argument('--qa-resolution',type=int,default=256)
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    source,output,previews=validate_output_paths(args.source,args.output,args.previews,Path(__file__).resolve().parent.parent)
    files=sorted(source.glob('*.blend'))
    if args.only:files=[p for p in files if p.stem.split('_')[0].lower()==args.only.lower()]
    if not files:raise ValueError('No matching Blender originals found')
    if not 32<=args.qa_resolution<=1024:raise ValueError('QA resolution must be between 32 and 1024')
    output.mkdir(parents=True,exist_ok=True);previews.mkdir(parents=True,exist_ok=True)
    report_path=previews/('comparison-report.json' if args.compare_only else 'report.json')
    report=[]
    for path in files:
        recipe=RECIPES.get(path.stem.split('_')[0].lower())
        if not recipe:raise ValueError(f'No planning-model recipe for {path.name}')
        before_hash=fingerprint(path)
        parts,all_parts,dimensions,source_triangles,source_bounds=extract_shell(path,recipe)
        retained_count=len(parts)
        comparison=(previews/'topology-comparison'/recipe['name']).resolve()
        if previews not in comparison.parents:raise ValueError('Comparison directory escapes private previews')
        comparison.mkdir(parents=True,exist_ok=True)
        reference=comparison/'reference.glb'
        _,normalized_dimensions=rebuild_shell(all_parts,dimensions,recipe,source_bounds,clean=False)
        export_geometry(reference)
        objects,_=rebuild_shell(parts,dimensions,recipe,source_bounds)
        add_metadata(recipe,normalized_dimensions)
        shell=comparison/'source-shell.glb';export_geometry(shell)
        del all_parts,parts,objects
        candidates=[];summaries={}
        node=shutil.which('node') or '/usr/local/bin/node'
        for method in ['protected','remesh']:
            for target_count in [5000,10000,20000]:
                candidate=comparison/f'{method}-{target_count}.glb'
                options={'method':method,'targetTriangles':target_count,'maxError':.003,'remeshResolution':64}
                if 'stableSurfaceError' in recipe:options['stableSurfaceError']=recipe['stableSurfaceError']
                if 'thinSurfaceError' in recipe:options['thinSurfaceError']=recipe['thinSurfaceError']
                candidate.unlink(missing_ok=True)
                result=subprocess.run([node,str(Path(__file__).with_name('simplify-planning-shell.mjs')),str(shell),str(candidate),json.dumps(options)],
                                      capture_output=True,text=True)
                if result.returncode:
                    failure={'method':method,'targetTriangles':target_count,'rejected':True,'error':result.stderr[-3000:]}
                    candidate.with_suffix('.json').write_text(json.dumps(failure,indent=2)+'\n')
                    print('DOMUS_CANDIDATE_REJECTED '+json.dumps(failure),flush=True)
                    continue
                summary=json.loads(result.stdout.strip().splitlines()[-1]);summaries[candidate.name]=summary
                (candidate.with_suffix('.json')).write_text(json.dumps(summary,indent=2)+'\n')
                candidates.append(candidate)
                print('DOMUS_CANDIDATE '+json.dumps({key:summary[key] for key in ['method','targetTriangles','beforeTriangles','afterTriangles','remeshedParts','boundsDriftMetres']}),flush=True)
        qa=verify(reference,candidates,comparison/'verification',args.qa_resolution) if candidates else {'candidates':[]}
        passing=[entry for entry in qa['candidates'] if entry['passed'] and entry['triangles']<=60000]
        if fingerprint(path)!=before_hash:raise RuntimeError('Original unexpectedly changed')
        if not passing:
            raise ValueError(f"{recipe['name']}: no candidate passed visual geometry checks; active model retained. See {comparison/'verification/report.json'}")
        winner=min(passing,key=lambda item:(item['triangles'],-item['minimumSilhouetteIoU'],item['file']))
        selected=Path(winner['file']);summary=summaries[selected.name]
        target=output/(recipe['name']+'-proxy.glb')
        if not args.compare_only:
            with tempfile.NamedTemporaryFile(dir=output,prefix='planning-',suffix='.tmp',delete=False) as stream:
                temporary=Path(stream.name)
                with selected.open('rb') as incoming:shutil.copyfileobj(incoming,stream)
            try:temporary.replace(target)
            finally:temporary.unlink(missing_ok=True)
        if not args.skip_previews:
            bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.import_scene.gltf(filepath=str(selected))
            objects=[obj for obj in bpy.context.scene.objects if obj.type=='MESH']
            preview(bpy.context.scene,objects,normalized_dimensions,previews/(recipe['name']+'-proxy.png'))
        item={'name':recipe['name'],'sourceTriangles':source_triangles,'proxyTriangles':summary['afterTriangles'],
              'dimensionsMetres':normalized_dimensions,'bytes':selected.stat().st_size,'sourceUnchanged':True,
              'mode':'topology-exterior','method':summary['method'],'retainedParts':retained_count,
              'selectedCandidate':selected.name,'remeshedParts':summary['remeshedParts'],
              'minimumSilhouetteIoU':winner['minimumSilhouetteIoU'],'minimumHoleRetention':winner['minimumHoleRetention'],
              'boundsDriftMetres':winner['boundsDriftMetres'],'verification':str(comparison/'verification/report.json'),
              'activated':not args.compare_only}
        report.append(item);print('DOMUS_PROXY '+json.dumps(item),flush=True)
        # Persist each verified result even if a later model in a batch fails.
        updated={item['name']:item for item in json.loads(report_path.read_text())} if report_path.exists() else {}
        updated.update({item['name']:item for item in report})
        report_path.write_text(json.dumps([updated[name] for name in sorted(updated)],indent=2)+'\n')


if __name__=='__main__':main()
