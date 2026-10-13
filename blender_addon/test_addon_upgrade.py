"""Factory-mode install/upgrade regression; all preferences and installs are temporary."""
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
import importlib
import os
import sys

import bpy
import addon_utils

LEGACY = '''
bl_info = {"name": "Domus Product Metadata", "version": (0, 1, 0), "blender": (4, 2, 0)}
import bpy
from bpy.props import StringProperty, FloatProperty, EnumProperty, PointerProperty
class DomusMetadata(bpy.types.PropertyGroup):
    name: StringProperty()
    category: EnumProperty(items=[("Seating", "Seating", ""), ("Decor", "Decor", ""), ("Removed", "Removed", "")])
    width: FloatProperty()
    depth: FloatProperty()
    height: FloatProperty()
class DOMUS_OT_refresh_geometry(bpy.types.Operator):
    bl_idname = "domus.refresh_geometry"
    bl_label = "Legacy geometry"
    def execute(self, context): return {"FINISHED"}
class DOMUS_PT_metadata(bpy.types.Panel):
    bl_idname = "DOMUS_PT_metadata"
    bl_label = "Product Metadata"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    def draw(self, context): pass
CLASSES = (DomusMetadata, DOMUS_OT_refresh_geometry, DOMUS_PT_metadata)
def register():
    for cls in CLASSES: bpy.utils.register_class(cls)
    bpy.types.Object.domus_metadata = PointerProperty(type=DomusMetadata)
def unregister():
    del bpy.types.Object.domus_metadata
    for cls in reversed(CLASSES): bpy.utils.unregister_class(cls)
'''

directory = Path(__file__).resolve().parent
with TemporaryDirectory(prefix="domus-addon-upgrade-", dir=directory) as temporary:
    root = Path(temporary).resolve()
    # Never touch the user's installed add-ons or saved preferences.
    os.environ["BLENDER_USER_SCRIPTS"] = str(root / "scripts")
    os.environ["BLENDER_USER_CONFIG"] = str(root / "config")
    os.environ["BLENDER_USER_EXTENSIONS"] = str(root / "extensions")
    bpy.utils.refresh_script_paths()
    addons = Path(bpy.utils.user_resource("SCRIPTS", path="addons", create=True)).resolve()
    assert root in addons.parents, addons
    sys.path.insert(0, str(addons))
    legacy_zip = root / "legacy.zip"
    package_legacy = "--package" in sys.argv
    with ZipFile(legacy_zip, "w") as archive:
        if package_legacy:
            # The previous collection-based package used these same classes,
            # with only unconditional register/unregister and no update watcher.
            source = (directory / "domus_metadata.py").read_text().split("PROPERTIES =")[0]
            source = source.replace('"version": (0, 4, 1)', '"version": (0, 3, 0)')
            source += '''
def register():
    for cls in CLASSES: bpy.utils.register_class(cls)
    bpy.types.Object.domus_metadata = PointerProperty(type=DomusMetadata)
    bpy.types.Collection.domus_metadata = PointerProperty(type=DomusMetadata)
    bpy.types.Collection.domus_model_root = PointerProperty(type=bpy.types.Object)
    bpy.types.Scene.domus_product_source = PointerProperty(type=DomusProductSource)
def unregister():
    del bpy.types.Scene.domus_product_source
    del bpy.types.Collection.domus_model_root
    del bpy.types.Collection.domus_metadata
    del bpy.types.Object.domus_metadata
    for cls in reversed(CLASSES): bpy.utils.unregister_class(cls)
'''
            archive.writestr("domus_metadata/", "")
            archive.writestr("domus_metadata/__init__.py", source)
            archive.write(directory / "catalogue_schema.json", "domus_metadata/catalogue_schema.json")
        else:
            archive.writestr("domus_metadata.py", LEGACY)
    assert bpy.ops.preferences.addon_install(filepath=str(legacy_zip), overwrite=True, enable_on_install=True) == {"FINISHED"}
    legacy = sys.modules["domus_metadata"]
    assert legacy.__addon_enabled__
    cube = bpy.context.active_object
    props = cube.domus_metadata
    props.name, props.category = "Retained hospital bed", "Hospital Bed" if package_legacy else "Seating"
    props.width, props.depth, props.height = 1, 2, 0.8
    if not package_legacy:
        unknown = bpy.data.objects.new("Legacy unknown category", None)
        bpy.context.scene.collection.objects.link(unknown)
        unknown.domus_metadata.category = "Removed"
    cube["domus_name"] = "Saved metadata stays"
    assert bpy.ops.preferences.addon_install(filepath=str(directory / "domus_metadata_addon.zip"), overwrite=True, enable_on_install=True) == {"FINISHED"}
    module = sys.modules["domus_product_metadata"]
    # Background Blender doesn't pump UI timers; run the queued first tick.
    module.complete_registration()
    assert module.__addon_enabled__ and not legacy.__addon_enabled__
    assert "domus_metadata" not in bpy.context.preferences.addons
    assert cube.domus_metadata.name == "Retained hospital bed"
    assert cube.domus_metadata.category == ("Hospital Bed" if package_legacy else "Others")
    assert cube.domus_metadata.depth == 2
    if not package_legacy:
        assert unknown.domus_metadata.category == "UNSET"
    assert cube["domus_name"] == "Saved metadata stays"
    assert bpy.types.Operator.bl_rna_get_subclass_py("DOMUS_OT_refresh_geometry", None) is None
    collection = bpy.data.collections.new("Retained source")
    bpy.context.scene.collection.children.link(collection)
    bpy.context.scene.domus_product_source.collection = collection
    collection.domus_metadata.name = "Collection fields stay"
    collection.domus_metadata.category = "Hospital Bed"
    # Reinstall the exact same ZIP while enabled, with Blender's default options.
    assert bpy.ops.preferences.addon_install(filepath=str(directory / "domus_metadata_addon.zip"), overwrite=True) == {"FINISHED"}
    assert module.check_for_update() == 1.0
    assert module.__addon_enabled__
    # Then install a newer ZIP under the same filename/module while still enabled.
    update_zip = root / "domus_metadata_addon.zip"
    with ZipFile(update_zip, "w") as archive:
        archive.writestr("domus_product_metadata/", "")
        source = (directory / "domus_metadata.py").read_text().replace('"version": (0, 4, 1)', '"version": (0, 4, 2)')
        archive.writestr("domus_product_metadata/__init__.py", source)
        archive.write(directory / "catalogue_schema.json", "domus_product_metadata/catalogue_schema.json")
    assert bpy.ops.preferences.addon_install(filepath=str(update_zip), overwrite=True) == {"FINISHED"}
    assert module.check_for_update() is None
    assert module.bl_info["version"] == (0, 4, 2)
    assert module.__addon_enabled__
    assert bpy.context.scene.domus_product_source.collection == collection
    assert collection.domus_metadata.name == "Collection fields stay"
    assert collection.domus_metadata.category == "Hospital Bed"
    assert cube.domus_metadata.name == "Retained hospital bed"
    # Register twice and disable twice: no duplicate classes or stale pointers.
    module.register()
    assert collection.domus_metadata.name == "Collection fields stay"
    module.unregister()
    module.unregister()
    assert not hasattr(bpy.types.Object, "domus_metadata")
    module.__addon_enabled__ = False
    sys.path.remove(str(addons))
print("DOMUS_ADDON_UPGRADE_TEST_OK")
