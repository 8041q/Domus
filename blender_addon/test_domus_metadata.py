"""Run with blender -b --factory-startup --python blender_addon/test_domus_metadata.py."""
import json
import math
import os
import struct
import sys
import tempfile
from types import SimpleNamespace

import bpy
from mathutils import Matrix, Vector, Quaternion

sys.path.insert(0, os.path.dirname(__file__))
import domus_metadata as addon


def glb_json(path):
    with open(path, "rb") as handle:
        header = handle.read(20)
        return json.loads(handle.read(struct.unpack_from("<I", header, 12)[0]))


def exported_bounds(gltf):
    low, high = [math.inf] * 3, [-math.inf] * 3
    def walk(index, parent):
        node = gltf["nodes"][index]
        if "matrix" in node:
            matrix = Matrix([node["matrix"][i:i+4] for i in range(0,16,4)]).transposed()
        else:
            rotation = node.get("rotation", [0,0,0,1])
            matrix = Matrix.LocRotScale(Vector(node.get("translation", [0,0,0])), Quaternion((rotation[3], *rotation[:3])), Vector(node.get("scale", [1,1,1])))
        world = parent @ matrix
        if "mesh" in node:
            for primitive in gltf["meshes"][node["mesh"]]["primitives"]:
                accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
                for x in (accessor["min"][0], accessor["max"][0]):
                    for y in (accessor["min"][1], accessor["max"][1]):
                        for z in (accessor["min"][2], accessor["max"][2]):
                            p = world @ Vector((x,y,z))
                            for axis in range(3): low[axis], high[axis] = min(low[axis],p[axis]), max(high[axis],p[axis])
        for child in node.get("children", []): walk(child,world)
    for root in gltf["scenes"][gltf.get("scene",0)]["nodes"]: walk(root,Matrix.Identity(4))
    return tuple(high[i]-low[i] for i in range(3))


addon.register()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
collection = bpy.data.collections.new("Hospital Bed")
bpy.context.scene.collection.children.link(collection)
nested = bpy.data.collections.new("Pillows")
collection.children.link(nested)


def cube(name, target, location, dimensions):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    for owner in list(obj.users_collection): owner.objects.unlink(obj)
    target.objects.link(obj)
    return obj


frame = cube("Frame", collection, (0,0,.5), (1,2,1))
array = frame.modifiers.new("Test evaluated geometry", "ARRAY")
array.count = 2
array.relative_offset_displace = (2,0,0)
pillow = cube("Pillow", nested, (.5,0,1), (.5,.5,.2))
outside = cube("Unrelated object", bpy.context.scene.collection, (30,0,0), (20,20,20))
source = bpy.context.scene.domus_product_source
source.collection = collection
assert source.mode == "COLLECTION"
props = collection.domus_metadata
assert bpy.ops.domus.read_model() == {"FINISHED"}
assert props.name == "Hospital Bed"
assert all(abs(a-b)<1e-5 for a,b in zip((props.width,props.depth,props.height),(300,200,110)))
assert [props.bl_rna.properties[field].name for field in addon.DISPLAY_KEYS] == ["Length (cm)", "Width (cm)", "Height (cm)"]
assert not hasattr(props,"product_id") and not hasattr(props,"swatch")
assert not hasattr(props,"collision_width") and not hasattr(props,"tags")
try:
    bpy.ops.domus.save_metadata()
    raise AssertionError("Missing category should reject saving")
except RuntimeError as error: assert "Category" in str(error)
assert collection.domus_model_root is None
props.category = "Hospital Bed"
props.width, props.depth, props.height = 99.5, 218, 40
props.clearance_front = .2
original_parents = [obj.parent for obj in (frame,pillow)]
original_world = [obj.matrix_world.copy() for obj in (frame,pillow)]
assert bpy.ops.domus.save_metadata() == {"FINISHED"}
root = collection.domus_model_root
assert "domus_product_id" not in root
assert all(abs(root[key]-expected)<1e-5 for key,expected in (("domus_width_m",3),("domus_depth_m",2),("domus_height_m",1.1)))
assert abs(root["domus_display_width_m"]-.995)<1e-5
assert abs(root["domus_display_depth_m"]-2.18)<1e-5
assert abs(root["domus_display_height_m"]-.4)<1e-5
assert root["domus_collision_width_m"] == root["domus_width_m"]
assert original_parents == [obj.parent for obj in (frame,pillow)]
props.width = 0
try:
    bpy.ops.domus.save_metadata()
    raise AssertionError("Zero display width should reject saving")
except RuntimeError as error: assert "Width in centimetres" in str(error)
props.width = 99.5
props.name = "Changed"
assert bpy.ops.domus.load_metadata() == {"FINISHED"}
assert props.name == "Hospital Bed" and abs(props.width-99.5)<1e-5
for field in addon.DISPLAY_KEYS.keys() | addon.EDITABLE_KEYS.keys():
    assert props.bl_rna.properties[field].description, field
for field in ("mode", "collection", "object"):
    assert source.bl_rna.properties[field].description, field
assert props.bl_rna.properties["name"].name == "Name"
assert props.bl_rna.properties["price_label"].name == "Price"
assert source.bl_rna.properties["mode"].name == "Source"
assert len(addon.SCHEMA["categories"]) == 16
assert len(set(addon.SCHEMA["categories"])) == 16
assert all(description for _, _, description in addon.CATEGORIES)
assert not any(getattr(cls,"bl_idname",None)=="domus.select_product" for cls in addon.CLASSES)

class LayoutRecorder:
    def __init__(self): self.labels, self.operators, self.fields = [], [], []
    def box(self): return self
    def prop(self, _props, field, **_kwargs): self.fields.append(field)
    def label(self, text, **_kwargs): self.labels.append(text)
    def operator(self, operator, **_kwargs): self.operators.append(operator)

layout = LayoutRecorder()
addon.DOMUS_PT_metadata.draw(SimpleNamespace(layout=layout),bpy.context)
assert "Model External Dimensions" in layout.labels
assert layout.fields.index("depth") < layout.fields.index("width") < layout.fields.index("height")
assert "domus.select_product" not in layout.operators
assert {"domus.save_metadata","domus.load_metadata","domus.export_product"}.issubset(layout.operators)
assert not any(text.startswith(("Catalogue size", "Display only", "Use-space clearance", "Export includes")) for text in layout.labels)
root["manufacturer_test"] = "Preserve custom properties"
bpy.ops.object.select_all(action="DESELECT")
outside.select_set(True)
bpy.context.view_layer.objects.active = outside

with tempfile.TemporaryDirectory(dir=os.path.dirname(__file__)) as directory:
    path = os.path.join(directory,"hospital-bed.glb")
    assert bpy.ops.domus.export_product(filepath=path) == {"FINISHED"}
    gltf = glb_json(path)
    carriers = [node["extras"] for node in gltf["nodes"] if node.get("extras",{}).get("domus_schema_version")]
    assert len(carriers) == 1
    assert carriers[0]["domus_schema_version"] == 2
    assert carriers[0]["domus_category"] == "Hospital Bed"
    assert carriers[0]["manufacturer_test"] == "Preserve custom properties"
    assert "domus_product_id" not in carriers[0]
    assert not any(node.get("name") == outside.name for node in gltf["nodes"])
    assert all(abs(a-b)<1e-5 for a,b in zip(exported_bounds(gltf),(3,1.1,2)))
    # Centimetre scene units, un-applied scaling, nested collection parts and
    # evaluated modifiers must agree with the actual GLB's metre dimensions.
    bpy.context.scene.unit_settings.scale_length = .01
    props.width, props.depth, props.height = 3,2,1.1
    assert bpy.ops.domus.export_product(filepath=path) == {"FINISHED"}
    gltf = glb_json(path)
    assert all(abs(a-b)<1e-6 for a,b in zip(exported_bounds(gltf),(.03,.011,.02)))
    assert abs(root["domus_width_m"]-.03)<1e-6
    for obj, parent, world in zip((frame,pillow),original_parents,original_world):
        assert obj.parent == parent
        assert all(abs(obj.matrix_world[row][col]-world[row][col])<1e-6 for row in range(4) for col in range(4))
    assert not any(obj.name.startswith("Domus Export Metres") for obj in bpy.data.objects)
    assert set(bpy.context.selected_objects) == {outside}
    assert bpy.context.view_layer.objects.active == outside

# Saved pre-0.4.2 property groups remain correct even when loaded after registration.
legacy = bpy.data.collections.new("Saved metre inputs")
for field, value in (("width", .995), ("depth", 2.18), ("height", .4)):
    legacy.domus_metadata[field] = value
assert abs(legacy.domus_metadata.width - 99.5) < 1e-5
assert abs(legacy.domus_metadata.depth - 218) < 1e-5
assert abs(legacy.domus_metadata.height - 40) < 1e-5
addon.register()
assert abs(legacy.domus_metadata.width - 99.5) < 1e-5, "repeat registration must not convert twice"
props = collection.domus_metadata

# Loading older saved metadata maps broad categories to the current choices.
root["domus_category"] = "Decor"
assert bpy.ops.domus.load_metadata() == {"FINISHED"}
assert props.category == "Decoration"

print("DOMUS_METADATA_TEST_OK")
