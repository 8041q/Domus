"""Compare private planning GLBs against an evaluated original, without editing either.

Run with Blender (file scripts disabled)::

  blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python scripts/verify-planning-models.py -- \
    --reference private/comparison/reference.glb \
    --candidates private/comparison/feature-5000.glb private/comparison/remesh-5000.glb \
    --output private/comparison/verification

The GLBs must share their metre scale, origin and orientation. The ray comparisons
include holes and independent parts; they do not compare only a bounding box or a
decimated baseline. Diagnostic images are measurements, not runtime model assets.
Use --render for optional matching Cycles CPU beauty views and a contact sheet.
"""

import argparse
import gc
import hashlib
import html
import json
import math
from pathlib import Path
import re
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.geometry import barycentric_transform
from mathutils.bvhtree import BVHTree


def fingerprint(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load_geometry(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    vertices, faces, shading = [], [], []
    offset = 0
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or obj.hide_render:
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        try:
            if not mesh.vertices or not mesh.polygons:
                continue
            points = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
            mesh.vertices.foreach_get('co', points)
            matrix = np.array(evaluated.matrix_world)
            points = points.reshape((-1, 3)) @ matrix[:3, :3].T + matrix[:3, 3]
            mesh.calc_loop_triangles()
            triangles = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
            mesh.loop_triangles.foreach_get('vertices', triangles)
            loops=np.empty(len(mesh.loop_triangles)*3,dtype=np.int32)
            mesh.loop_triangles.foreach_get('loops',loops)
            corner=np.array([n.vector[:] for n in mesh.corner_normals])[loops].reshape((-1,3,3))
            corner=corner@np.linalg.inv(matrix[:3,:3])
            corner/=np.maximum(np.linalg.norm(corner,axis=2,keepdims=True),1e-20)
            shading.append(corner.astype(np.float32))
            vertices.append(points)
            faces.append(triangles.reshape((-1, 3)) + offset)
            offset += len(points)
        finally:
            evaluated.to_mesh_clear()
    if not vertices:
        raise ValueError(f'No usable mesh geometry: {path}')
    points, triangles = np.concatenate(vertices), np.concatenate(faces)
    if not np.isfinite(points).all():
        raise ValueError(f'Non-finite mesh positions: {path}')
    result = {
        'bounds': [points.min(axis=0).tolist(), points.max(axis=0).tolist()],
        'triangles': len(triangles),
        'vertices': len(points),
        'tree': BVHTree.FromPolygons(points, triangles, all_triangles=True),
        'points':points,'faces':triangles,'shading':np.concatenate(shading),
    }
    return result


def views_for(bounds):
    lower, upper = np.array(bounds)
    centre = (lower + upper) / 2
    size = upper - lower
    span = float(size.max())
    corners = np.array([[x, y, z] for x in (lower[0], upper[0])
                        for y in (lower[1], upper[1]) for z in (lower[2], upper[2])])
    directions = [('front', (0, -1, 0)), ('back', (0, 1, 0)),
                  ('left', (-1, 0, 0)), ('right', (1, 0, 0)), ('top', (0, 0, 1))]
    for azimuth in range(0, 360, 45):
        elevation = math.radians(35)
        angle = math.radians(azimuth)
        directions.append((f'orbit-{azimuth:03d}',
                           (math.cos(angle) * math.cos(elevation),
                            math.sin(angle) * math.cos(elevation), math.sin(elevation))))
    views = []
    for name, direction in directions:
        backward = Vector(direction).normalized()
        right = backward.cross(Vector((0, 0, 1)))
        if right.length < .001:
            right = Vector((1, 0, 0))
        right.normalize()
        up = right.cross(backward).normalized()
        projected = corners - centre
        half_size = max(float(np.max(np.abs(projected @ np.array(right)))),
                        float(np.max(np.abs(projected @ np.array(up))))) * 1.08
        views.append({'name': name, 'kind': 'orthographic',
                      'eye': (centre + np.array(backward) * span * 2).tolist(),
                      'target': centre.tolist(), 'right': list(right), 'up': list(up),
                      'forward': list(-backward), 'halfSize': max(half_size, .001),
                      'maxDistance': span * 5})
    # These intentionally close views exercise perspective/disocclusion rather
    # than fitting the entire model on screen like the planning camera does.
    for name, sign in [('walk-front', -1), ('walk-back', 1)]:
        target = centre.copy()
        target[1] += sign * size[1] * .18
        target[2] = lower[2] + size[2] * .58
        eye = np.array([centre[0] + size[0] * .85,
                        centre[1] + sign * size[1] * .72,
                        lower[2] + max(size[2] * 1.05, .15)])
        forward = Vector(target - eye).normalized()
        right = forward.cross(Vector((0, 0, 1))).normalized()
        up = right.cross(forward).normalized()
        views.append({'name': name, 'kind': 'perspective', 'eye': eye.tolist(),
                      'target': target.tolist(), 'right': list(right), 'up': list(up),
                      'forward': list(forward), 'fovDegrees': 60, 'maxDistance': span * 5})
    return views


def sample(geometry, view, resolution):
    tree=geometry['tree']
    depth = np.full((resolution, resolution), np.nan, dtype=np.float32)
    normals = np.zeros((resolution, resolution, 3), dtype=np.float32)
    shading=np.zeros_like(normals)
    eye = Vector(view['eye'])
    right, up, forward = (Vector(view[key]) for key in ('right', 'up', 'forward'))
    perspective = view['kind'] == 'perspective'
    half_size = math.tan(math.radians(view['fovDegrees'] / 2)) if perspective else view['halfSize']
    for y in range(resolution):
        v = (1 - 2 * (y + .5) / resolution) * half_size
        row = eye + up * v
        for x in range(resolution):
            u = (2 * (x + .5) / resolution - 1) * half_size
            origin = eye if perspective else row + right * u
            direction = (forward + right * u + up * v).normalized() if perspective else forward
            hit, normal, index, distance = tree.ray_cast(origin, direction, view['maxDistance'])
            if index is not None:
                depth[y, x] = distance
                normals[y, x] = normal
                triangle=geometry['points'][geometry['faces'][index]]
                interpolated=barycentric_transform(hit,*[Vector(v) for v in triangle],*[Vector(v) for v in geometry['shading'][index]])
                # Display proxies use two-sided surfaces; compare the normal
                # seen by this camera, including the back-face shader flip.
                if interpolated.dot(direction)>0:interpolated.negate()
                shading[y,x]=interpolated.normalized()
    return {'depth': depth, 'normals': normals, 'shading':shading, 'mask': np.isfinite(depth)}


def enclosed_holes(mask):
    """Background disconnected from the image edge, including handle cut-outs."""
    height, width = mask.shape
    exterior = np.zeros_like(mask)
    pending = [(y, x) for y in range(height) for x in (0, width - 1) if not mask[y, x]]
    pending += [(y, x) for x in range(width) for y in (0, height - 1) if not mask[y, x]]
    while pending:
        y, x = pending.pop()
        if exterior[y, x] or mask[y, x]:
            continue
        exterior[y, x] = True
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < height and 0 <= nx < width and not exterior[ny, nx] and not mask[ny, nx]:
                pending.append((ny, nx))
    return ~mask & ~exterior


def percentile(values, q):
    return float(np.percentile(values, q)) if len(values) else None


def compare(reference, candidate, holes):
    expected, actual = reference['mask'], candidate['mask']
    overlap = expected & actual
    union = expected | actual
    depths = np.abs(reference['depth'][overlap] - candidate['depth'][overlap])
    dot = np.einsum('ij,ij->i', reference['normals'][overlap], candidate['normals'][overlap])
    angles = np.degrees(np.arccos(np.clip(dot, -1, 1)))
    shading_dot=np.einsum('ij,ij->i',reference['shading'][overlap],candidate['shading'][overlap])
    shading_angles=np.degrees(np.arccos(np.clip(shading_dot,-1,1)))
    return {
        'shadingNormalAngleP95Degrees':percentile(shading_angles,95),
        'silhouetteIoU': float(overlap.sum() / union.sum()) if union.any() else 1.0,
        'silhouetteRecall': float(overlap.sum() / expected.sum()) if expected.any() else 1.0,
        'silhouettePrecision': float(overlap.sum() / actual.sum()) if actual.any() else 0.0,
        'missingPixels': int((expected & ~actual).sum()),
        'extraPixels': int((actual & ~expected).sum()),
        'referenceHolePixels': int(holes.sum()),
        'filledHolePixels': int((holes & actual).sum()),
        'holeRetention': float((holes & ~actual).sum() / holes.sum()) if holes.any() else 1.0,
        'sharedHitPixels': int(overlap.sum()),
        'depthMeanMetres': float(depths.mean()) if len(depths) else None,
        'depthP95Metres': percentile(depths, 95),
        'depthMaxMetres': float(depths.max()) if len(depths) else None,
        'normalAngleP95Degrees': percentile(angles, 95),
    }


def save_png(path, pixels):
    height, width, _ = pixels.shape
    image = bpy.data.images.new('Private geometry diagnostic', width=width, height=height, alpha=True)
    try:
        # Input rows are top-down; Blender's pixel buffer starts at the bottom.
        image.pixels.foreach_set(np.ascontiguousarray(pixels[::-1], dtype=np.float32).ravel())
        image.filepath_raw = str(path)
        image.file_format = 'PNG'
        image.save()
    finally:
        bpy.data.images.remove(image)


def diagnostic(reference, candidate, holes):
    expected, actual = reference['mask'], candidate['mask']
    pixels = np.ones((*expected.shape, 4), dtype=np.float32)
    pixels[expected & actual, :3] = (.18, .42, .55)
    pixels[expected & ~actual, :3] = (.82, .12, .43)
    pixels[actual & ~expected, :3] = (.95, .25, .03)
    pixels[holes & ~actual, :3] = (.75, .9, .78)
    return pixels


def setup_render():
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 8
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new('Private comparison studio')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.7, .7, .7, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .6
    return scene


def render_views(path, folder, views, bounds):
    # Reload to guarantee that no camera/light from a previous asset leaks in.
    load_geometry(path)['tree'] = None
    scene = setup_render()
    centre = Vector((np.array(bounds[0]) + np.array(bounds[1])) / 2)
    span = float(np.max(np.array(bounds[1]) - np.array(bounds[0])))
    bpy.ops.mesh.primitive_plane_add(size=span * 5, location=(centre.x, centre.y, float(bounds[0][2]) - .005))
    floor = bpy.context.object
    floor.name = 'Private comparison ground'
    floor_material = bpy.data.materials.new('Neutral comparison ground')
    floor_material.diffuse_color = (.55, .55, .55, 1)
    floor.data.materials.append(floor_material)
    for delta, power in [((1, -2, 2), 1000), ((-2, -.5, 1), 600), ((0, 2, 2), 800)]:
        bpy.ops.object.light_add(type='AREA', location=centre + Vector(delta) * span)
        light = bpy.context.object
        light.data.energy, light.data.size = power, 4
        light.rotation_euler = (centre - light.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    scene.camera = camera
    folder.mkdir(parents=True, exist_ok=True)
    results = []
    for view in views:
        if view['name'] not in ('front', 'back', 'left', 'right', 'top', 'orbit-315', 'walk-front', 'walk-back'):
            continue
        camera.location = view['eye']
        camera.rotation_euler = (Vector(view['target']) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.data.type = 'PERSP' if view['kind'] == 'perspective' else 'ORTHO'
        if camera.data.type == 'PERSP':
            camera.data.angle = math.radians(view['fovDegrees'])
        else:
            camera.data.ortho_scale = view['halfSize'] * 2
        destination = folder / (view['name'] + '.png')
        scene.render.filepath = str(destination)
        bpy.ops.render.render(write_still=True)
        results.append(destination)
    return results


def contact_sheet(paths, destination, columns=8):
    if not paths:
        return
    tiles = []
    for path in paths:
        image = bpy.data.images.load(str(path), check_existing=False)
        try:
            width, height = image.size
            pixels = np.empty(width * height * 4, dtype=np.float32)
            image.pixels.foreach_get(pixels)
            tiles.append(pixels.reshape((height, width, 4))[::-1].copy())
        finally:
            bpy.data.images.remove(image)
    cell = tiles[0].shape[0]
    rows = math.ceil(len(tiles) / columns)
    sheet = np.ones((rows * cell, columns * cell, 4), dtype=np.float32)
    for index, tile in enumerate(tiles):
        row, column = divmod(index, columns)
        sheet[row * cell:(row + 1) * cell, column * cell:(column + 1) * cell] = tile
    save_png(destination, sheet)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--candidates', type=Path, nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resolution', type=int, default=128)
    parser.add_argument('--min-iou', type=float, default=.97)
    parser.add_argument('--max-bounds-drift', type=float, default=.003)
    parser.add_argument('--max-depth-p95', type=float, default=.01)
    parser.add_argument('--min-hole-retention', type=float, default=.90)
    parser.add_argument('--render', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    if not 32 <= args.resolution <= 1024:
        parser.error('--resolution must be between 32 and 1024')
    for name in ('min_iou', 'min_hole_retention'):
        if not 0 <= getattr(args, name) <= 1:
            parser.error(f'--{name.replace("_", "-")} must be between 0 and 1')
    if args.max_bounds_drift < 0 or args.max_depth_p95 < 0:
        parser.error('Distance thresholds must be non-negative')
    reference = args.reference.resolve(strict=True)
    candidates = [path.resolve(strict=True) for path in args.candidates]
    output = args.output.resolve()
    if 'private' not in output.parts or 'og_models' in output.parts:
        parser.error('Comparison output must be under an ignored private/ directory')
    inputs = [reference, *candidates]
    if len(set(inputs)) != len(inputs):
        parser.error('Reference and candidate paths must be distinct')
    if any(path.suffix.lower() != '.glb' for path in inputs):
        parser.error('Only GLB geometry inputs are supported')
    if output in inputs or any(output in path.parents for path in inputs):
        parser.error('Output must be separate from input assets')
    original_hashes = {str(path): fingerprint(path) for path in inputs}
    output.mkdir(parents=True, exist_ok=True)
    geometry = load_geometry(reference)
    bounds = np.array(geometry['bounds'])
    views = views_for(bounds)
    print('DOMUS_VERIFY_REFERENCE ' + json.dumps({'path': str(reference), 'triangles': geometry['triangles'], 'views': len(views)}), flush=True)
    reference_samples = {view['name']: sample(geometry, view, args.resolution) for view in views}
    holes = {name: enclosed_holes(data['mask']) for name, data in reference_samples.items()}
    report = {'schemaVersion': 1, 'shadingNormalsScope': 'interpolated vertex normals only; normal maps excluded', 'reference': {'file': str(reference), 'sha256': original_hashes[str(reference)],
              'triangles': geometry['triangles'], 'vertices': geometry['vertices'], 'bounds': geometry['bounds']},
              'resolution': args.resolution, 'views': views,
              'thresholds': {'minSilhouetteIoU': args.min_iou, 'maxBoundsDriftMetres': args.max_bounds_drift,
                             'maxDepthP95Metres': args.max_depth_p95, 'minHoleRetention': args.min_hole_retention},
              'diagnosticLegend': {'blue': 'shared silhouette', 'pink': 'missing source geometry',
                                   'orange': 'extra geometry / filled openings', 'paleGreen': 'preserved enclosed holes'},
              'candidates': []}
    del geometry
    gc.collect()
    html_rows = []
    diagnostic_paths = []
    for index, path in enumerate(candidates):
        name = f'{index + 1:02d}-' + re.sub(r'[^a-zA-Z0-9_.-]+', '-', path.stem)
        folder = output / name
        folder.mkdir(parents=True, exist_ok=True)
        geometry = load_geometry(path)
        candidate_bounds = np.array(geometry['bounds'])
        drift = float(np.max(np.abs(candidate_bounds - bounds)))
        item = {'file': str(path), 'sha256': original_hashes[str(path)], 'triangles': geometry['triangles'],
                'vertices': geometry['vertices'], 'bounds': geometry['bounds'], 'boundsDriftMetres': drift, 'views': []}
        cells = []
        failures = []
        if drift > args.max_bounds_drift:
            failures.append('bounds')
        for view in views:
            sampled = sample(geometry, view, args.resolution)
            metrics = compare(reference_samples[view['name']], sampled, holes[view['name']])
            metrics['name'] = view['name']
            view_failures = []
            if metrics['silhouetteIoU'] < args.min_iou:
                view_failures.append('silhouette')
            if metrics['depthP95Metres'] is None or metrics['depthP95Metres'] > args.max_depth_p95:
                view_failures.append('depth')
            # Tiny one-pixel holes are unstable at a finite ray resolution. They
            # remain reported, but only meaningful sampled openings gate quality.
            if metrics['referenceHolePixels'] >= 16 and metrics['holeRetention'] < args.min_hole_retention:
                view_failures.append('holes')
            metrics['failures'] = view_failures
            metrics['passed'] = not view_failures
            failures.extend(f'{view["name"]}:{reason}' for reason in view_failures)
            item['views'].append(metrics)
            image_path = folder / (view['name'] + '.png')
            save_png(image_path, diagnostic(reference_samples[view['name']], sampled, holes[view['name']]))
            diagnostic_paths.append(image_path)
            relative = image_path.relative_to(output).as_posix()
            cells.append(f'<figure><img src="{html.escape(relative)}"><figcaption>{view["name"]}: '
                         f'IoU {metrics["silhouetteIoU"]:.4f}; holes {metrics["holeRetention"]:.3f}; '
                         f'depth p95 {metrics["depthP95Metres"] if metrics["depthP95Metres"] is not None else "n/a"}</figcaption></figure>')
        item['minimumSilhouetteIoU'] = min(view['silhouetteIoU'] for view in item['views'])
        item['meanSilhouetteIoU'] = float(np.mean([view['silhouetteIoU'] for view in item['views']]))
        item['maximumDepthP95Metres'] = max((view['depthP95Metres'] for view in item['views'] if view['depthP95Metres'] is not None), default=None)
        item['minimumHoleRetention'] = min(view['holeRetention'] for view in item['views'] if view['referenceHolePixels'] >= 16) if any(view['referenceHolePixels'] >= 16 for view in item['views']) else 1.0
        item['maximumShadingNormalAngleP95Degrees']=max((v['shadingNormalAngleP95Degrees'] for v in item['views'] if v['shadingNormalAngleP95Degrees'] is not None),default=180)
        item['passed'] = not failures
        item['failures'] = failures
        report['candidates'].append(item)
        html_rows.append(f'<section><h2>{html.escape(path.name)} — {geometry["triangles"]:,} triangles</h2>'
                         f'<p>{"PASS" if item["passed"] else "FAIL"}: {html.escape(", ".join(failures))}</p><div class="views">' + ''.join(cells) + '</div></section>')
        print('DOMUS_VERIFY_CANDIDATE ' + json.dumps({key: item[key] for key in ('file', 'triangles', 'boundsDriftMetres', 'minimumSilhouetteIoU', 'meanSilhouetteIoU', 'maximumDepthP95Metres', 'minimumHoleRetention', 'passed', 'failures')}), flush=True)
        del geometry
        gc.collect()
    contact_sheet(diagnostic_paths, output / 'diagnostic-contact-sheet.png', columns=len(views))
    (output / 'comparison.html').write_text('<!doctype html><meta charset="utf-8"><title>Private geometry comparison</title>'
         '<style>body{font:14px system-ui;background:#eee;margin:24px}h2{margin-top:32px}.views{display:grid;grid-template-columns:repeat(5,minmax(160px,1fr));gap:8px}figure{margin:0;background:white;padding:8px}img{width:100%;image-rendering:pixelated}figcaption{font-size:12px}</style>'
         '<h1>Private geometry comparison</h1><p>Blue: shared silhouette. Pink: missing source geometry. Orange: extra geometry or filled openings. Green: preserved enclosed holes.</p>'
         + ''.join(html_rows), encoding='utf-8')
    if args.render:
        render_paths = []
        for index, path in enumerate(inputs):
            folder = output / 'renders' / ('reference' if index == 0 else f'{index:02d}-' + re.sub(r'[^a-zA-Z0-9_.-]+', '-', path.stem))
            render_paths.extend(render_views(path, folder, views, bounds))
        contact_sheet(render_paths, output / 'render-contact-sheet.png', columns=8)
        report['renderContactSheet'] = 'render-contact-sheet.png'
    report['inputsUnchanged'] = all(fingerprint(Path(path)) == digest for path, digest in original_hashes.items())
    if not report['inputsUnchanged']:
        raise RuntimeError('An input asset changed during verification')
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('DOMUS_VERIFY_REPORT ' + str(output / 'report.json'), flush=True)


if __name__ == '__main__':
    main()
