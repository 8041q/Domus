"""Collection-based product metadata for Blender's built-in GLB exporter."""

bl_info = {
    "name": "Domus Product Metadata", "author": "Domus", "version": (0, 4, 1),
    "blender": (4, 2, 0), "location": "View3D > Sidebar > Domus",
    "description": "Prepare a complete product collection for the Domus catalogue", "category": "Object",
}

import json
import math
import ast
import hashlib
import importlib
import sys
from contextlib import contextmanager
from types import ModuleType
from pathlib import Path

import bpy
import numpy as np
from bpy.props import BoolProperty, EnumProperty, FloatProperty, PointerProperty, StringProperty
from bpy.types import Operator, Panel, PropertyGroup
from bpy_extras.io_utils import ExportHelper

SCHEMA = json.loads(Path(__file__).with_name("catalogue_schema.json").read_text(encoding="utf-8"))
SCHEMA_VERSION = SCHEMA["version"]
CATEGORIES = [("UNSET", "Choose category", "Required: choose the group used to find this model in Domus")] + [(name, name, SCHEMA["categoryDescriptions"][name]) for name in SCHEMA["categories"]]
DISPLAY_KEYS = {"width": "domus_display_width_m", "depth": "domus_display_depth_m", "height": "domus_display_height_m"}
EDITABLE_KEYS = {"name": "domus_name", "category": "domus_category", "price_label": "domus_price_label",
                 "collision": "domus_collision", "wall_affinity": "domus_wall_affinity",
                 "clearance_front": "domus_clearance_front_m", "clearance_back": "domus_clearance_back_m", "clearance_sides": "domus_clearance_sides_m"}
RETIRED_KEYS = ("domus_product_id", "domus_interaction_tags", "domus_allow_overlap_with", "domus_can_rest_on", "domus_swatch")
GEOMETRY_TYPES = {"MESH", "CURVE", "SURFACE", "FONT", "META"}


def product_target(context):
    source = context.scene.domus_product_source
    return source.collection if source.mode == "COLLECTION" else source.object or context.active_object


def product_objects(target):
    if isinstance(target, bpy.types.Collection):
        return list(target.all_objects)
    objects, stack = [], [target]
    while stack:
        obj = stack.pop()
        objects.append(obj)
        stack.extend(obj.children)
    return objects


def metadata_root(target, create=False):
    if not isinstance(target, bpy.types.Collection):
        return target
    root = target.domus_model_root
    if root and root in list(target.all_objects):
        return root
    if not create:
        return None
    # glTF does not export collection custom properties. A lightweight Empty
    # carries them, with no reparenting or changes to the product's assembly.
    root = bpy.data.objects.new("Domus Metadata - " + target.name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.15
    target.objects.link(root)
    target.domus_model_root = root
    return root


def measured_bounds(context, target):
    """True evaluated vertices, including transforms, modifiers and instances."""
    graph = context.evaluated_depsgraph_get()
    members = set(product_objects(target))
    metres_per_unit = context.scene.unit_settings.scale_length or 1.0
    lower, upper = [math.inf] * 3, [-math.inf] * 3
    count = 0
    for instance in graph.object_instances:
        original = instance.object.original
        # Instance parents belong to the product even when their source
        # geometry lives in a separate reusable collection.
        parent = instance.parent.original if instance.parent else None
        if original not in members and parent not in members:
            continue
        evaluated = instance.object
        if evaluated.type not in GEOMETRY_TYPES:
            continue
        mesh = evaluated.to_mesh()
        if mesh is None:
            continue
        try:
            if len(mesh.vertices):
                # Blender bundles NumPy. Bulk reads avoid millions of Python
                # vertex/matrix calls for detailed multipart products such as C8c.
                coordinates = np.empty((len(mesh.vertices), 3), dtype=np.float32)
                mesh.vertices.foreach_get("co", coordinates.ravel())
                matrix = np.asarray(instance.matrix_world, dtype=np.float64)
                points = (coordinates @ matrix[:3, :3].T + matrix[:3, 3]) * metres_per_unit
                if not np.isfinite(points).all():
                    return None
                minimum, maximum = points.min(axis=0), points.max(axis=0)
                for axis in range(3):
                    lower[axis] = min(lower[axis], float(minimum[axis]))
                    upper[axis] = max(upper[axis], float(maximum[axis]))
                count += len(mesh.vertices)
        finally:
            evaluated.to_mesh_clear()
    if not count or not all(math.isfinite(value) for value in lower + upper):
        return None
    return lower, upper


def invalid_fields(props):
    missing = []
    if not props.name.strip():
        missing.append("Name")
    if props.category == "UNSET":
        missing.append("Category")
    for field in DISPLAY_KEYS:
        if not math.isfinite(getattr(props, field)) or getattr(props, field) <= 0:
            missing.append(field.title() + " in metres")
    return missing


def use_measured_size(context, target):
    bounds = measured_bounds(context, target)
    if bounds:
        lower, upper = bounds
        props = target.domus_metadata
        if not props.name.strip():
            props.name = target.name
        for field, axis in (("width", 0), ("depth", 1), ("height", 2)):
            setattr(props, field, max(upper[axis] - lower[axis], 0.001))
    return bounds


class DomusMetadata(PropertyGroup):
    name: StringProperty(name="Name", default="", description="Required: the name shown for this model in the Domus catalogue")
    category: EnumProperty(name="Category", items=CATEGORIES, default="UNSET", description="Required: the hospital product group used by the catalogue filter")
    width: FloatProperty(name="Width (m)", min=0, precision=4, default=0, description="Required external width along Blender X, in metres (995 mm = 0.995 m). Shown in the catalogue; does not scale geometry")
    depth: FloatProperty(name="Depth (m)", min=0, precision=4, default=0, description="Required external depth along Blender Y, in metres. Shown in the catalogue; placement uses the measured geometry")
    height: FloatProperty(name="Height (m)", min=0, precision=4, default=0, description="Required external height along Blender Z, in metres. Shown in the catalogue; actual height is measured on save")
    collision: BoolProperty(name="Blocks other furniture", default=True, description="Prevent other furniture from overlapping this product during normal placement. Its footprint is measured automatically")
    wall_affinity: BoolProperty(name="Prefer walls", default=False, description="Snap the back of this product to nearby walls when placing it in Domus")
    clearance_front: FloatProperty(name="Front (m)", min=0, precision=3, default=0, description="Recommended free space for access in front of the model, facing Blender -Y, in metres. Zero means no clearance guide")
    clearance_back: FloatProperty(name="Back (m)", min=0, precision=3, default=0, description="Recommended free space behind the model, facing Blender +Y, in metres. Zero means no clearance guide")
    clearance_sides: FloatProperty(name="Sides (m)", min=0, precision=3, default=0, description="Recommended free space on each side of the model along Blender X, in metres. Zero means no clearance guide")
    price_label: StringProperty(name="Price", description="Optional price text shown in Domus, including currency if desired, for example €299", default="")


class DomusProductSource(PropertyGroup):
    mode: EnumProperty(name="Source", items=[("COLLECTION", "Collection", "All parts in this collection and its child collections"),
                                             ("OBJECT", "Object hierarchy", "A root object and all its descendants")], default="COLLECTION", description="Choose which complete model is measured and exported")
    collection: PointerProperty(name="Product collection", type=bpy.types.Collection, description="The collection containing every model part; includes child collections and excludes unrelated scene objects")
    object: PointerProperty(name="Root object", type=bpy.types.Object, description="The model's root and all its children. If empty, use the active object and its children")


class DOMUS_OT_use_collection(Operator):
    bl_idname = "domus.use_collection"
    bl_label = "Use Active Collection"
    bl_description = "Use the collection currently active in the Outliner"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        collection = context.view_layer.active_layer_collection.collection
        if collection == context.scene.collection:
            self.report({"ERROR"}, "Choose a product collection, not the entire scene")
            return {"CANCELLED"}
        context.scene.domus_product_source.collection = collection
        context.scene.domus_product_source.mode = "COLLECTION"
        return {"FINISHED"}


class DOMUS_OT_read_model(Operator):
    bl_idname = "domus.read_model"
    bl_label = "Use Measured Size"
    bl_description = "Fill the display size from the complete model, including transforms and modifiers"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        target = product_target(context)
        if not target or not use_measured_size(context, target):
            self.report({"ERROR"}, "Choose a product collection or hierarchy containing geometry")
            return {"CANCELLED"}
        return {"FINISHED"}


class DOMUS_OT_load_metadata(Operator):
    bl_idname = "domus.load_metadata"
    bl_label = "Load Saved Metadata"
    bl_description = "Restore the product's display and placement settings"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        target = product_target(context)
        root = metadata_root(target) if target else None
        # Reimported GLBs may keep their metadata on a descendant rather than
        # the collection's generated Empty. Find one unambiguous product.
        if target and (not root or not root.get("domus_schema_version")):
            candidates = [obj for obj in product_objects(target) if obj.get("domus_schema_version")]
            root = candidates[0] if len(candidates) == 1 else None
        if not root or root.get("domus_schema_version") not in (1, SCHEMA_VERSION):
            self.report({"ERROR"}, "This product has no supported saved Domus metadata")
            return {"CANCELLED"}
        props = target.domus_metadata
        for field, key in EDITABLE_KEYS.items():
            if key in root:
                value = root[key]
                if field == "category":
                    value = SCHEMA["legacyCategoryAliases"].get(value, value)
                    if value not in SCHEMA["categories"]:
                        value = "UNSET"
                setattr(props, field, value)
        for field, key in DISPLAY_KEYS.items():
            # Legacy dimensions may contain millimetres in metre fields.
            # A v1 import starts from measured geometry instead.
            if root.get("domus_schema_version") >= 2 and key in root:
                setattr(props, field, root[key])
        if root.get("domus_schema_version") == 1:
            use_measured_size(context, target)
        return {"FINISHED"}


class DOMUS_OT_save_metadata(Operator):
    bl_idname = "domus.save_metadata"
    bl_label = "Save Metadata"
    bl_description = "Measure the complete model and save its required display settings and automatic collision bounds"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        target = product_target(context)
        if not target:
            self.report({"ERROR"}, "Choose a product collection or root object")
            return {"CANCELLED"}
        props = target.domus_metadata
        missing = invalid_fields(props)
        if missing:
            self.report({"ERROR"}, "Complete: " + ", ".join(missing))
            return {"CANCELLED"}
        bounds = measured_bounds(context, target)
        if not bounds:
            self.report({"ERROR"}, "The product must contain usable geometry")
            return {"CANCELLED"}
        lower, upper = bounds
        dimensions = [upper[axis] - lower[axis] for axis in range(3)]
        if dimensions[0] <= 0 or dimensions[1] <= 0:
            self.report({"ERROR"}, "The model needs a non-zero width and depth")
            return {"CANCELLED"}
        root = metadata_root(target, create=True)
        # A collection imported from an older GLB must export only one metadata
        # carrier. Strip old product extras from its parts, preserving geometry.
        for obj in product_objects(target):
            if obj != root:
                for key in list(obj.keys()):
                    if key.startswith("domus_") and key != "domus_metadata":
                        del obj[key]
        for key in RETIRED_KEYS:
            if key in root:
                del root[key]
        root["domus_schema_version"] = SCHEMA_VERSION
        for field, key in {**EDITABLE_KEYS, **DISPLAY_KEYS}.items():
            value = getattr(props, field)
            root[key] = value.strip() if isinstance(value, str) else value
        for key, axis in (("width", 0), ("depth", 1), ("height", 2)):
            root["domus_" + key + "_m"] = max(dimensions[axis], 0.001)
        # Internal fields are recomputed on every save, never entered manually.
        root["domus_collision_width_m"] = dimensions[0]
        root["domus_collision_depth_m"] = dimensions[1]
        root["domus_collision_offset_x_m"] = 0.0
        root["domus_collision_offset_y_m"] = 0.0
        root["domus_bounds_center_x_m"] = (lower[0] + upper[0]) / 2
        root["domus_bounds_center_y_m"] = (lower[1] + upper[1]) / 2
        root["domus_bounds_min_z_m"] = lower[2]
        self.report({"INFO"}, "Measured geometry and metadata saved; save the .blend file, then export this product")
        return {"FINISHED"}


def select_export_objects(context, target):
    """Internal preparation for Blender's native selected-object GLB export."""
    objects = product_objects(target)
    if any(obj.name not in context.view_layer.objects or obj.hide_get() or obj.hide_viewport or obj.hide_select for obj in objects):
        raise ValueError("Make all product parts visible and selectable before exporting")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    context.view_layer.objects.active = metadata_root(target)


def transparent_emission_nodes(material):
    """Recognize the supported image-alpha / transparent / emission graph only."""
    tree = material.node_tree
    if not tree:
        return None
    output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output), None)
    if not output or not output.inputs["Surface"].is_linked:
        return None
    mix = output.inputs["Surface"].links[0].from_node
    if mix.type != "MIX_SHADER" or not all(socket.is_linked for socket in mix.inputs[:3]):
        return None
    transparent, emission = (mix.inputs[index].links[0].from_node for index in (1, 2))
    alpha = mix.inputs[0].links[0].from_socket
    if transparent.type != "BSDF_TRANSPARENT" or emission.type != "EMISSION":
        return None
    color = transparent.inputs["Color"]
    if color.is_linked or any(abs(channel - 1) > 1e-6 for channel in color.default_value):
        return None
    if alpha.node.type != "TEX_IMAGE" or alpha.name != "Alpha" or not alpha.node.image:
        return None
    emission_color = emission.inputs["Color"]
    if not emission_color.is_linked or emission_color.links[0].from_socket != alpha.node.outputs["Color"]:
        return None
    # Textured/animated strengths require baking or animation support outside this repair.
    if emission.inputs["Strength"].is_linked or tree.animation_data:
        return None
    return output, emission, alpha.node


@contextmanager
def prepared_export_materials(objects):
    """Use export-only copies; object overrides never alter shared mesh slots."""
    assignments, copies = [], {}
    try:
        for obj in objects:
            for index, slot in enumerate(obj.material_slots):
                original = slot.material
                if not original:
                    continue
                nodes = transparent_emission_nodes(original)
                if nodes is None:
                    continue
                if original not in copies:
                    temporary = original.copy()
                    copies[original] = temporary
                    output, emission, texture = (temporary.node_tree.nodes[node.name] for node in nodes)
                    tree = temporary.node_tree
                    principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
                    principled.inputs["Base Color"].default_value = (0, 0, 0, 1)
                    principled.inputs["Metallic"].default_value = 0
                    principled.inputs["Roughness"].default_value = 1
                    principled.inputs["Specular IOR Level"].default_value = 0
                    principled.inputs["Emission Strength"].default_value = emission.inputs["Strength"].default_value
                    tree.links.new(texture.outputs["Color"], principled.inputs["Emission Color"])
                    tree.links.new(texture.outputs["Alpha"], principled.inputs["Alpha"])
                    tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
                    # The old Emission must not remain in the node tree: the native
                    # exporter also searches nodes by type when gathering emission.
                    tree.nodes.remove(emission)
                original_link = slot.link
                slot.link = "OBJECT"
                assignments.append((obj, index, original_link, slot.material))
                slot.material = copies[original]
        yield
    finally:
        for obj, index, link, material in reversed(assignments):
            slot = obj.material_slots[index]
            slot.material = material
            slot.link = link
        for material in copies.values():
            bpy.data.materials.remove(material)


def export_selected_glb(filepath):
    return bpy.ops.export_scene.gltf(filepath=filepath, export_format="GLB", export_extras=True,
                                     export_materials="EXPORT", export_image_format="AUTO",
                                     use_selection=True, export_apply=True, export_cameras=False, export_lights=False)


class DOMUS_OT_export_product(Operator, ExportHelper):
    bl_idname = "domus.export_product"
    bl_label = "Export Product GLB"
    bl_description = "Save metadata and export this complete model through Blender's built-in glTF exporter as GLB, with Custom Properties enabled"
    filename_ext = ".glb"
    filter_glob: StringProperty(default="*.glb", options={"HIDDEN"})

    def execute(self, context):
        previous_selection = list(context.selected_objects)
        previous_active = context.view_layer.objects.active
        try:
            if bpy.ops.domus.save_metadata() != {"FINISHED"}:
                return {"CANCELLED"}
            select_export_objects(context, product_target(context))
        except (RuntimeError, ValueError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        target = product_target(context)
        objects = product_objects(target)
        members = set(objects)
        roots = [obj for obj in objects if obj.parent not in members]
        saved = [(obj, obj.parent, obj.matrix_parent_inverse.copy(), obj.matrix_basis.copy(), obj.matrix_world.copy()) for obj in roots]
        wrapper = bpy.data.objects.new("Domus Export Metres", None)
        context.scene.collection.objects.link(wrapper)
        try:
            # Blender's glTF exporter writes Blender units as glTF metres. Use a
            # temporary selected parent to convert the scene's unit scale without
            # applying transforms or changing the source meshes/assembly.
            for obj, _, _, _, world in saved:
                obj.parent = wrapper
                obj.matrix_world = world
            factor = context.scene.unit_settings.scale_length or 1.0
            wrapper.scale = (factor, factor, factor)
            wrapper.select_set(True)
            context.view_layer.update()
            with prepared_export_materials(objects):
                result = export_selected_glb(self.filepath)
            if result != {"FINISHED"}:
                return {"CANCELLED"}
        except Exception as error:
            self.report({"ERROR"}, "Could not export product: " + str(error))
            return {"CANCELLED"}
        finally:
            for obj, parent, inverse, basis, _ in saved:
                obj.parent = parent
                obj.matrix_parent_inverse = inverse
                obj.matrix_basis = basis
            bpy.data.objects.remove(wrapper, do_unlink=True)
            context.view_layer.update()
            bpy.ops.object.select_all(action="DESELECT")
            for obj in previous_selection:
                if obj.name in context.view_layer.objects:
                    obj.select_set(True)
            context.view_layer.objects.active = previous_active
        self.report({"INFO"}, "Product exported in metres; copy the GLB into Domus public/models")
        return {"FINISHED"}


class DOMUS_PT_metadata(Panel):
    bl_label = "Product Metadata"
    bl_idname = "DOMUS_PT_metadata"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Domus"

    def draw(self, context):
        layout, source = self.layout, context.scene.domus_product_source
        layout.prop(source, "mode")
        if source.mode == "COLLECTION":
            layout.prop(source, "collection")
            layout.operator("domus.use_collection", icon="OUTLINER_COLLECTION")
        else:
            layout.prop(source, "object")
        target = product_target(context)
        if not target:
            layout.label(text="Choose the collection containing all product parts", icon="INFO")
            return
        props = target.domus_metadata
        layout.prop(props, "name")
        layout.prop(props, "category")
        box = layout.box()
        box.label(text="Model External Dimensions")
        for field in DISPLAY_KEYS:
            box.prop(props, field)
        box.operator("domus.read_model", icon="FILE_REFRESH")
        root = metadata_root(target)
        if root and root.get("domus_schema_version"):
            box.label(text="Last measured: %.3f × %.3f × %.3f m" % (root.get("domus_width_m", 0), root.get("domus_depth_m", 0), root.get("domus_height_m", 0)))
        box = layout.box()
        box.label(text="Placement")
        box.prop(props, "wall_affinity")
        box.prop(props, "collision")
        box.label(text="Collision bounds are automatic")
        for field in ("clearance_front", "clearance_back", "clearance_sides"):
            box.prop(props, field)
        layout.prop(props, "price_label")
        missing = invalid_fields(props)
        if missing:
            layout.label(text="Required: " + ", ".join(missing[:2]), icon="ERROR")
        layout.operator("domus.save_metadata", icon="CHECKMARK")
        layout.operator("domus.load_metadata", icon="IMPORT")
        layout.operator("domus.export_product", icon="EXPORT")
        layout.label(text="Domus assigns the catalogue ID on import")


CLASSES = (DomusMetadata, DomusProductSource, DOMUS_OT_use_collection, DOMUS_OT_read_model,
           DOMUS_OT_load_metadata, DOMUS_OT_save_metadata, DOMUS_OT_export_product, DOMUS_PT_metadata)

PROPERTIES = ((bpy.types.Scene, "domus_product_source"), (bpy.types.Collection, "domus_model_root"),
              (bpy.types.Collection, "domus_metadata"), (bpy.types.Object, "domus_metadata"))
REGISTRATION_KEY = "_domus_metadata_registration"


def installed_signature():
    return hashlib.sha256(Path(__file__).read_bytes() + Path(__file__).with_name("catalogue_schema.json").read_bytes()).digest()


def check_for_update():
    """Install from Disk replaces files without reloading an enabled add-on."""
    try:
        if installed_signature() != _installed_signature:
            ast.parse(Path(__file__).read_text(encoding="utf-8"))
            json.loads(Path(__file__).with_name("catalogue_schema.json").read_text(encoding="utf-8"))
            module = sys.modules[__name__]
            saved = capture_metadata()
            unregister()
            importlib.invalidate_caches()
            importlib.reload(module)
            module.register()
            module.restore_metadata(saved)
            return None
    except (OSError, SyntaxError, json.JSONDecodeError):
        # The installer can be between removal and extraction; retry shortly.
        return 1.0
    except Exception as error:
        print("Domus add-on update failed:", error)
        return None
    return 1.0


def capture_metadata():
    saved = []
    for target in [*bpy.data.objects, *bpy.data.collections]:
        if hasattr(target, "domus_metadata"):
            props = target.domus_metadata
            values = {key: getattr(props, key) for key in DomusMetadata.__annotations__ if hasattr(props, key)}
            category = values.get("category", "UNSET")
            category = SCHEMA["legacyCategoryAliases"].get(category, category)
            values["category"] = category if any(item[0] == category for item in CATEGORIES) else "UNSET"
            saved.append((target, values))
    return saved


def restore_metadata(saved):
    for target, values in saved:
        for key, value in values.items():
            setattr(target.domus_metadata, key, value)


def clear_registration():
    # Unlike driver_namespace, this survives opening another .blend file.
    previous = sys.modules.pop(REGISTRATION_KEY, None)
    if previous:
        timer, classes = previous.timer, previous.classes
        if bpy.app.timers.is_registered(timer):
            bpy.app.timers.unregister(timer)
    else:
        # Earlier versions didn't retain their registered Python classes.
        classes = []
        for name, base in [(cls.__name__, cls.__bases__[0]) for cls in CLASSES] + [
                ("DOMUS_OT_refresh_geometry", Operator), ("DOMUS_OT_select_product", Operator)]:
            registered = base.bl_rna_get_subclass_py(name, None)
            if registered:
                classes.append(registered)
    for owner, name in PROPERTIES:
        if hasattr(owner, name):
            delattr(owner, name)
    for cls in reversed(classes):
        if cls.is_registered:
            bpy.utils.unregister_class(cls)


def register():
    # Blender restricts scene data while enabling add-ons. Defer migration until
    # the next UI tick, so old RNA values can be read before replacing classes.
    if not hasattr(bpy.data, "objects"):
        if not bpy.app.timers.is_registered(complete_registration):
            bpy.app.timers.register(complete_registration, first_interval=0.01)
        return
    complete_registration()


def complete_registration():
    if bpy.app.timers.is_registered(complete_registration):
        bpy.app.timers.unregister(complete_registration)
    saved = capture_metadata()
    # Migrate the legacy module automatically when this stable package is enabled.
    if __name__ == "domus_product_metadata":
        import addon_utils
        legacy = sys.modules.get("domus_metadata")
        if legacy and getattr(legacy, "__addon_enabled__", False):
            addon_utils.disable("domus_metadata", default_set=True)
    clear_registration()
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Object.domus_metadata = PointerProperty(type=DomusMetadata)
    bpy.types.Collection.domus_metadata = PointerProperty(type=DomusMetadata)
    bpy.types.Collection.domus_model_root = PointerProperty(type=bpy.types.Object)
    bpy.types.Scene.domus_product_source = PointerProperty(type=DomusProductSource)
    restore_metadata(saved)
    global _installed_signature
    _installed_signature = installed_signature()
    runtime = ModuleType(REGISTRATION_KEY)
    runtime.timer, runtime.classes = check_for_update, CLASSES
    sys.modules[REGISTRATION_KEY] = runtime
    bpy.app.timers.register(check_for_update, first_interval=1.0, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(complete_registration):
        bpy.app.timers.unregister(complete_registration)
    clear_registration()


if __name__ == "__main__":
    register()
