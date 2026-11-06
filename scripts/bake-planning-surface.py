"""Bake source shading normals onto generated display geometry, entirely in private/."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy


METADATA_FIELDS = {
    'domus_mount', 'domus_schema_version', 'domus_name', 'domus_category',
    'domus_display_profile', 'domus_display_width_m', 'domus_display_depth_m',
    'domus_display_height_m', 'domus_collision', 'domus_clearance_front_m',
    'domus_clearance_back_m', 'domus_clearance_sides_m',
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def bake_surface(reference, target, output, resolution=2048):
    reference, target, output = (Path(p).resolve() for p in [reference, target, output])
    private = next((p for p in reference.parents if p.name == 'private'), None)
    if private is None or not all(private in p.parents for p in [target, output]):
        raise ValueError('Bake inputs and outputs must remain in the same private tree')
    if output in [reference, target] or any((private / name) in output.parents for name in ['models', 'openings']):
        raise ValueError('Review bakes separately before activation')
    if resolution not in [256, 512, 1024, 2048, 4096]:
        raise ValueError('Unsupported normal-map resolution')
    hashes = {p: digest(p) for p in [reference, target]}
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(reference))
    sources = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not sources:
        raise ValueError('No reference geometry')
    for obj in list(bpy.context.scene.objects):
        if obj not in sources:
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in sources:
        obj.select_set(True)
    # One acceleration structure makes selected-to-active baking practical.
    bpy.context.view_layer.objects.active = sources[0]
    bpy.ops.object.join()
    source = bpy.context.object
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.import_scene.gltf(filepath=str(target))
    targets = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    carriers = [o for o in bpy.context.selected_objects if o.type == 'EMPTY' and o.get('domus_schema_version')]
    if not targets:
        raise ValueError('No display geometry')
    bpy.ops.object.select_all(action='DESELECT')
    for obj in targets:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.object.join()
    display = bpy.context.object
    display.name = display.data.name = 'Display surface'
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    # Join only coincident positions for UV connectivity. No reduction or global smoothing.
    bpy.ops.mesh.remove_doubles(threshold=1e-7)
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=.0002)
    bpy.ops.object.mode_set(mode='OBJECT')
    # Cycles and glTF must use the SAME tangent basis. Retained custom normals
    # otherwise override flat faces only in the export, reintroducing triangular patches.
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for polygon in display.data.polygons:
        polygon.use_smooth = False
    display.data.update()
    display.data.calc_loop_triangles()
    triangles = len(display.data.loop_triangles)
    if triangles > 60000:
        raise ValueError('Display exceeds 60000 triangles')
    uv = display.data.uv_layers.active.data
    coverage = 0
    for triangle in display.data.loop_triangles:
        a, b, c = (uv[i].uv for i in triangle.loops)
        coverage += abs((b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y))/2
    if coverage < .1:
        raise ValueError('Normal-map UV atlas has insufficient coverage')
    image = bpy.data.images.new('Generated surface normals', width=resolution, height=resolution, alpha=False)
    image.colorspace_settings.name = 'Non-Color'
    image.generated_color = (.5, .5, 1, 1)
    materials = list(display.data.materials)
    for material in materials:
        material.use_nodes = True
        node = material.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = image
        node.name = 'Generated normal bake'
        material.node_tree.nodes.active = node
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 1
    bake = scene.render.bake
    bake.use_selected_to_active = True
    bake.use_cage = True
    bake.cage_extrusion = .006
    bake.max_ray_distance = .02
    bake.margin = 8
    bake.use_clear = True
    bake.normal_space = 'TANGENT'
    bpy.ops.object.select_all(action='DESELECT')
    source.select_set(True)
    display.select_set(True)
    bpy.context.view_layer.objects.active = display
    bpy.ops.object.bake(type='NORMAL')
    for material in materials:
        nodes, links = material.node_tree.nodes, material.node_tree.links
        normal = nodes.new('ShaderNodeNormalMap')
        normal.space = 'TANGENT'
        links.new(nodes['Generated normal bake'].outputs['Color'], normal.inputs['Color'])
        shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
        links.new(normal.outputs['Normal'], shader.inputs['Normal'])
        material.name = 'Display finish'
        for key in list(material.keys()):
            del material[key]
    image.filepath_raw = str(output.with_suffix('.normal.png'))
    image.file_format = 'PNG'
    image.save()
    image.pack()
    for obj in [display, *carriers]:
        for key in list(obj.keys()):
            if obj == display or key not in METADATA_FIELDS:
                del obj[key]
    for key in list(display.data.keys()):
        del display.data[key]
    bpy.ops.object.select_all(action='DESELECT')
    display.select_set(True)
    for obj in carriers:
        obj.name = 'Planning model'
        obj.select_set(True)
    # Export selection excludes every full-reference mesh and material.
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True,
        export_extras=True, export_animations=False, export_cameras=False, export_lights=False, export_tangents=True)
    for path, expected in hashes.items():
        if digest(path) != expected:
            raise RuntimeError('Bake input changed')
    report = {'triangles': triangles, 'resolution': resolution, 'uvCoverage': coverage,
        'referenceSha256': hashes[reference], 'targetSha256': hashes[target],
        'outputSha256': digest(output), 'inputsUnchanged': True}
    output.with_suffix('.bake.json').write_text(json.dumps(report, indent=2)+'\n')
    print('SURFACE_BAKE '+json.dumps(report), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resolution', type=int, default=2048)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    bake_surface(args.reference, args.target, args.output, args.resolution)


if __name__ == '__main__':
    main()
