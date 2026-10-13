"""Factory-mode material export regression; source .blend files are never saved."""
import json
from pathlib import Path
import struct
import sys
import tempfile

import bpy
import numpy as np

directory = Path(__file__).resolve().parent
sys.path.insert(0, str(directory))
import domus_metadata as addon


def read_glb(path):
    data = Path(path).read_bytes()
    length = struct.unpack_from("<I", data, 12)[0]
    return json.loads(data[20:20 + length]), data[28 + length:]


def material_state(material):
    tree = material.node_tree
    return ([node.name for node in tree.nodes],
            [(link.from_node.name, link.from_socket.identifier, link.to_node.name, link.to_socket.identifier)
             for link in tree.links],
            [(node.name, node.image) for node in tree.nodes if node.type == "TEX_IMAGE"])


def emission_material(name, image, strength):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    texture = tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.inputs["Location"].default_value = (.1, .2, 0)
    coordinates = tree.nodes.new("ShaderNodeTexCoord")
    tree.links.new(coordinates.outputs["UV"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    emission = tree.nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = strength
    transparent = tree.nodes.new("ShaderNodeBsdfTransparent")
    mix = tree.nodes.new("ShaderNodeMixShader")
    tree.links.new(texture.outputs["Color"], emission.inputs["Color"])
    tree.links.new(texture.outputs["Alpha"], mix.inputs[0])
    tree.links.new(transparent.outputs[0], mix.inputs[1])
    tree.links.new(emission.outputs[0], mix.inputs[2])
    tree.links.new(mix.outputs[0], output.inputs["Surface"])
    material.use_backface_culling = True
    return material


addon.register()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
collection = bpy.data.collections.new("Export product")
bpy.context.scene.collection.children.link(collection)
source = bpy.context.scene.domus_product_source
source.collection = collection
props = collection.domus_metadata
props.name, props.category = "Alpha regression", "Others"
props.width, props.depth, props.height = 1, 1, 1

# A generated RGBA texture contains both fully transparent and opaque pixels.
image = bpy.data.images.new("Alpha fixture", 2, 2, alpha=True)
image.pixels[:] = [1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, .5, 1, 1, 1, 1]
material = emission_material("Transparent decal", image, .5)
bright = emission_material("Bright decal", image, 2)
opaque = bpy.data.materials.new("Ordinary PBR")
opaque.use_nodes = True
principled = next(node for node in opaque.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
principled.inputs["Metallic"].default_value = .2
principled.inputs["Roughness"].default_value = .7
texture = opaque.node_tree.nodes.new("ShaderNodeTexImage")
texture.image = image
opaque.node_tree.links.new(texture.outputs["Color"], principled.inputs["Base Color"])
assert addon.transparent_emission_nodes(opaque) is None, "RGBA alone must not imply transparency"
unsupported = emission_material("Tinted transparent", image, 1)
next(node for node in unsupported.node_tree.nodes if node.type == "BSDF_TRANSPARENT").inputs["Color"].default_value = (.5, 1, 1, 1)
assert addon.transparent_emission_nodes(unsupported) is None

objects = []
for index, mat in enumerate((material, bright, opaque)):
    bpy.ops.mesh.primitive_cube_add(location=(index * 2, 0, .5))
    obj = bpy.context.object
    for owner in list(obj.users_collection): owner.objects.unlink(obj)
    collection.objects.link(obj)
    obj.data.materials.append(mat)
    objects.append(obj)

# A duplicate inside and an unrelated object outside share the mesh data.
duplicate = objects[0].copy()
collection.objects.link(duplicate)
objects.append(duplicate)
outside = objects[0].copy()
bpy.context.scene.collection.objects.link(outside)
# Preserve even an unused object override hidden behind a DATA-linked slot.
objects[0].material_slots[0].link = "OBJECT"
objects[0].material_slots[0].material = opaque
objects[0].material_slots[0].link = "DATA"
# Exercise an originally OBJECT-linked slot, too.
objects[1].material_slots[0].link = "OBJECT"
objects[1].material_slots[0].material = bright
states = {mat: material_state(mat) for mat in (material, bright, opaque)}
slot_states = [(obj, obj.material_slots[0].link, obj.material_slots[0].material, obj.data) for obj in objects]
material_count = len(bpy.data.materials)


def assert_restored():
    for obj, link, mat, data in slot_states:
        assert obj.data == data and obj.material_slots[0].link == link
        assert obj.material_slots[0].material == mat
    assert outside.material_slots[0].material == material
    assert objects[0].data.materials[0] == material
    slot = objects[0].material_slots[0]
    slot.link = "OBJECT"
    assert slot.material == opaque, "hidden object override was changed"
    slot.link = "DATA"
    assert len(bpy.data.materials) == material_count, "temporary materials leaked"
    assert all(material_state(mat) == state for mat, state in states.items())
    assert set(bpy.context.selected_objects) == {outside}
    assert bpy.context.view_layer.objects.active == outside
    assert not any(obj.name.startswith("Domus Export Metres") for obj in bpy.data.objects)


def assert_transparent(gltf, binary, prefix, strength):
    mat = next(mat for mat in gltf["materials"] if mat["name"].startswith(prefix))
    assert mat["alphaMode"] == "BLEND"
    assert mat.get("doubleSided", False) is False
    pbr = mat["pbrMetallicRoughness"]
    assert pbr["baseColorFactor"] == [0, 0, 0, 1]
    assert pbr["metallicFactor"] == 0
    emission_strength = mat.get("extensions", {}).get("KHR_materials_emissive_strength", {}).get("emissiveStrength", 1)
    assert all(abs(value * emission_strength - strength) < 1e-6 for value in mat["emissiveFactor"])
    assert mat["extensions"]["KHR_materials_specular"]["specularFactor"] == 0
    alpha_texture = pbr["baseColorTexture"]
    assert all(abs(a-b) < 1e-6 for a, b in zip(
        alpha_texture["extensions"]["KHR_texture_transform"]["offset"], [.1, -.2]))
    image_def = gltf["images"][gltf["textures"][alpha_texture["index"]]["source"]]
    assert image_def["mimeType"] == "image/png" and "bufferView" in image_def
    view = gltf["bufferViews"][image_def["bufferView"]]
    png_path = Path(tempfile.gettempdir()) / "inspect-alpha.png"
    png_path.write_bytes(binary[view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]])
    loaded = bpy.data.images.load(str(png_path))
    try:
        pixels = np.empty(len(loaded.pixels), dtype=np.float32)
        loaded.pixels.foreach_get(pixels)
        assert pixels[3::4].min() == 0 and pixels[3::4].max() == 1
    finally:
        bpy.data.images.remove(loaded)


bpy.ops.object.select_all(action="DESELECT")
outside.select_set(True)
bpy.context.view_layer.objects.active = outside
with tempfile.TemporaryDirectory(prefix="domus-material-test-", dir=directory) as temporary:
    assert Path(temporary).resolve().is_relative_to(directory)
    # Blender's encoder creates temporary PNGs; keep these inside this test directory.
    previous_tempdir = tempfile.tempdir
    tempfile.tempdir = temporary
    try:
        path = str(Path(temporary) / "product.glb")
        for _ in range(2):
            assert bpy.ops.domus.export_product(filepath=path) == {"FINISHED"}
            gltf, binary = read_glb(path)
            assert_transparent(gltf, binary, "Transparent decal", .5)
            assert_transparent(gltf, binary, "Bright decal", 2)
            ordinary = next(mat for mat in gltf["materials"] if mat["name"] == "Ordinary PBR")
            assert ordinary.get("alphaMode", "OPAQUE") == "OPAQUE"
            assert abs(ordinary["pbrMetallicRoughness"]["metallicFactor"] - .2) < 1e-6
            assert abs(ordinary["pbrMetallicRoughness"]["roughnessFactor"] - .7) < 1e-6
            assert_restored()

        native_export = addon.export_selected_glb
        def injected_failure(_path):
            assert outside.material_slots[0].material == material
            assert objects[0].material_slots[0].material != material
            raise RuntimeError("Injected export failure")
        try:
            addon.export_selected_glb = injected_failure
            try:
                bpy.ops.domus.export_product(filepath=path)
                raise AssertionError("export should fail")
            except RuntimeError as error:
                assert "Injected export failure" in str(error)
            assert_restored()
            addon.export_selected_glb = lambda _path: {"CANCELLED"}
            assert bpy.ops.domus.export_product(filepath=path) == {"CANCELLED"}
            assert_restored()
        finally:
            addon.export_selected_glb = native_export

        if "--source-blend" in sys.argv:
            fixture = sys.argv[sys.argv.index("--source-blend") + 1]
            with bpy.data.libraries.load(fixture, link=False) as (_, loaded):
                loaded.materials = ["Material.001"]
            actual = loaded.materials[0]
            assert actual and addon.transparent_emission_nodes(actual)
            actual_state = material_state(actual)
            objects[0].data.materials[0] = actual
            assert bpy.ops.domus.export_product(filepath=path) == {"FINISHED"}
            gltf, _ = read_glb(path)
            # Blender increments the numeric suffix when making a material copy.
            exported = next(mat for mat in gltf["materials"] if mat.get("alphaMode") == "BLEND"
                            and mat.get("emissiveFactor") == [.5, .5, .5])
            assert exported["alphaMode"] == "BLEND" and "baseColorTexture" in exported["pbrMetallicRoughness"]
            assert exported["emissiveFactor"] == [.5, .5, .5]
            assert material_state(actual) == actual_state
            print("DOMUS_C8C_MATERIAL_TEST_OK")
    finally:
        tempfile.tempdir = previous_tempdir

print("DOMUS_MATERIAL_EXPORT_TEST_OK")
