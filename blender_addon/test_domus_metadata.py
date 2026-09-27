"""Run with: blender -b --factory-startup --python blender_addon/test_domus_metadata.py"""

import json
import os
import struct
import sys
import tempfile

import bpy

sys.path.insert(0, os.path.dirname(__file__))
import domus_metadata


def glb_json(path):
    with open(path, "rb") as handle:
        data = handle.read()
    assert data[:4] == b"glTF"
    chunk_length, chunk_type = struct.unpack_from("<I4s", data, 12)
    assert chunk_type == b"JSON"
    return json.loads(data[20:20 + chunk_length])


domus_metadata.register()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

root = bpy.data.objects.new("Coffee Table", None)
bpy.context.collection.objects.link(root)
bpy.ops.mesh.primitive_cube_add(location=(0.4, -0.3, 0.25))
mesh = bpy.context.object
mesh.name = "Top"
mesh.dimensions = (2.0, 1.0, 0.5)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
mesh.parent = root
bpy.context.view_layer.objects.active = root

assert bpy.ops.domus.read_model() == {"FINISHED"}
props = root.domus_metadata
assert props.product_id == "coffee-table"
assert (round(props.width, 3), round(props.depth, 3), round(props.height, 3)) == (2, 1, 0.5)
assert abs(props.collision_offset_x - 0.4) < 1e-5
assert abs(props.collision_offset_y + 0.3) < 1e-5
try:
    bpy.ops.domus.save_metadata()
    raise AssertionError("Missing category should reject saving")
except RuntimeError as error:
    assert "Category" in str(error)
props.category = "Tables"
props.clearance_front = 0.4
props.tags = {"support-surface"}
assert bpy.ops.domus.save_metadata() == {"FINISHED"}
assert root["domus_product_id"] == "coffee-table"
assert abs(root["domus_clearance_front_m"] - 0.4) < 1e-5
props.name = "Changed in panel"
props.tags = set()
assert bpy.ops.domus.load_metadata() == {"FINISHED"}
assert props.name == "Coffee Table"
assert props.tags == {"support-surface"}

with tempfile.TemporaryDirectory() as directory:
    path = os.path.join(directory, "coffee-table.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_extras=True)
    gltf = glb_json(path)
    extras = next(node["extras"] for node in gltf["nodes"] if node["name"] == "Coffee Table")
    assert extras["domus_schema_version"] == 1
    assert extras["domus_product_id"] == "coffee-table"
    assert extras["domus_category"] == "Tables"
    assert extras["domus_width_m"] == 2.0
    assert extras["domus_interaction_tags"] == "support-surface"

print("DOMUS_METADATA_TEST_OK")
