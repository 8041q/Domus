"""Domus product metadata editor for Blender. Export with Blender's glTF exporter."""

bl_info = {
    "name": "Domus Product Metadata",
    "author": "Domus",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar > Domus",
    "description": "Prepare product metadata for Blender's built-in glTF/GLB export",
    "category": "Object",
}

import re
import unicodedata

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, PointerProperty, StringProperty
from bpy.types import Operator, Panel, PropertyGroup
from mathutils import Vector


SCHEMA_VERSION = 1
KEYS = {
    "product_id": "domus_product_id",
    "name": "domus_name",
    "category": "domus_category",
    "width": "domus_width_m",
    "depth": "domus_depth_m",
    "height": "domus_height_m",
    "bounds_center_x": "domus_bounds_center_x_m",
    "bounds_center_y": "domus_bounds_center_y_m",
    "bounds_min_z": "domus_bounds_min_z_m",
    "collision_width": "domus_collision_width_m",
    "collision_depth": "domus_collision_depth_m",
    "collision_offset_x": "domus_collision_offset_x_m",
    "collision_offset_y": "domus_collision_offset_y_m",
    "clearance_front": "domus_clearance_front_m",
    "clearance_back": "domus_clearance_back_m",
    "clearance_sides": "domus_clearance_sides_m",
    "wall_affinity": "domus_wall_affinity",
    "collision": "domus_collision",
    "price_label": "domus_price_label",
    "swatch": "domus_swatch",
    "tags": "domus_interaction_tags",
    "allow_overlap_with": "domus_allow_overlap_with",
    "can_rest_on": "domus_can_rest_on",
}

CATEGORIES = [("UNSET", "Choose category", "Required for the Domus catalogue"),
              ("Seating", "Seating", ""), ("Tables", "Tables", ""),
              ("Storage", "Storage", ""), ("Decor", "Decor", "")]
TAGS = [
    ("floor-covering", "Floor covering", "Rugs and similar floor items"),
    ("support-surface", "Support surface", "Can support future surface items"),
    ("tuckable-table", "Tuckable table", "Allows compatible seating to overlap"),
    ("tuckable-seating", "Tuckable seating", "Can tuck under a compatible table"),
    ("surface-item", "Surface item", "Decor that can rest on a surface"),
]
TAG_IDS = tuple(item[0] for item in TAGS)


def slugify(value):
    ascii_name = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()))


def model_meshes(root):
    stack = [root]
    while stack:
        obj = stack.pop()
        if obj.type == "MESH":
            yield obj
        stack.extend(obj.children)


def measured_bounds(context, root):
    """Evaluated mesh bounds in root axes, using the scene's metres-per-unit."""
    depsgraph = context.evaluated_depsgraph_get()
    origin = root.matrix_world.translation
    rotation_inverse = root.matrix_world.to_quaternion().inverted()
    metres_per_unit = context.scene.unit_settings.scale_length or 1.0
    points = []
    for obj in model_meshes(root):
        evaluated = obj.evaluated_get(depsgraph)
        if not evaluated.data or not len(evaluated.data.vertices):
            continue
        for corner in evaluated.bound_box:
            world = evaluated.matrix_world @ Vector(corner)
            points.append((rotation_inverse @ (world - origin)) * metres_per_unit)
    if not points:
        return None
    lower = [min(point[axis] for point in points) for axis in range(3)]
    upper = [max(point[axis] for point in points) for axis in range(3)]
    return lower, upper


def material_swatch(root):
    for obj in model_meshes(root):
        for material in obj.data.materials:
            if material is None:
                continue
            color = material.diffuse_color
            if material.use_nodes and material.node_tree:
                principled = next((node for node in material.node_tree.nodes
                                   if node.type == "BSDF_PRINCIPLED"), None)
                if principled:
                    color = principled.inputs["Base Color"].default_value
            # Blender's colours are linear; CSS swatches are sRGB.
            def srgb(component):
                component = max(0.0, min(1.0, component))
                return component * 12.92 if component <= 0.0031308 else 1.055 * component ** (1 / 2.4) - 0.055
            return "#" + "".join(f"{round(srgb(component) * 255):02x}" for component in color[:3])
    return ""


def fill_from_model(context, root, overwrite_geometry=False):
    props = root.domus_metadata
    if not props.product_id:
        props.product_id = slugify(root.name)
    if not props.name:
        props.name = root.name
    if not props.swatch:
        props.swatch = material_swatch(root) or "#999999"
    bounds = measured_bounds(context, root)
    if bounds:
        lower, upper = bounds
        dimensions = [upper[index] - lower[index] for index in range(3)]
        for field, value in zip(("width", "depth", "height"), dimensions):
            if overwrite_geometry or getattr(props, field) <= 0:
                setattr(props, field, value)
        new_collider = props.collision_width <= 0 or props.collision_depth <= 0
        if overwrite_geometry or props.collision_width <= 0:
            props.collision_width = dimensions[0]
        if overwrite_geometry or props.collision_depth <= 0:
            props.collision_depth = dimensions[1]
        props.bounds_center_x = (lower[0] + upper[0]) / 2
        props.bounds_center_y = (lower[1] + upper[1]) / 2
        props.bounds_min_z = lower[2]
        if overwrite_geometry or new_collider:
            props.collision_offset_x = props.bounds_center_x
            props.collision_offset_y = props.bounds_center_y
    return bounds


def invalid_fields(props):
    missing = []
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", props.product_id):
        missing.append("Product ID (lowercase letters, digits and hyphens)")
    if not props.name.strip():
        missing.append("Name")
    if props.category == "UNSET":
        missing.append("Category")
    for field in ("width", "depth", "height"):
        if getattr(props, field) <= 0:
            missing.append(field.title())
    if props.collision and (props.collision_width <= 0 or props.collision_depth <= 0):
        missing.append("Collision footprint")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", props.swatch):
        missing.append("Swatch (#RRGGBB)")
    return missing


class DomusMetadata(PropertyGroup):
    product_id: StringProperty(name="Product ID", description="Stable catalogue ID", default="")
    name: StringProperty(name="Name", default="")
    category: EnumProperty(name="Category", items=CATEGORIES, default="UNSET")
    width: FloatProperty(name="Width", min=0, precision=4, default=0, description="Metres, along local X")
    depth: FloatProperty(name="Depth", min=0, precision=4, default=0, description="Metres, along local Y")
    height: FloatProperty(name="Height", min=0, precision=4, default=0, description="Metres, along local Z")
    bounds_center_x: FloatProperty(name="Bounds centre X", precision=4)
    bounds_center_y: FloatProperty(name="Bounds centre Y", precision=4)
    bounds_min_z: FloatProperty(name="Bounds base Z", precision=4)
    collision_width: FloatProperty(name="Collider width", min=0, precision=4)
    collision_depth: FloatProperty(name="Collider depth", min=0, precision=4)
    collision_offset_x: FloatProperty(name="Collider offset X", precision=4)
    collision_offset_y: FloatProperty(name="Collider offset Y", precision=4)
    clearance_front: FloatProperty(name="Front", min=0, precision=3, default=0)
    clearance_back: FloatProperty(name="Back", min=0, precision=3, default=0)
    clearance_sides: FloatProperty(name="Sides", min=0, precision=3, default=0)
    wall_affinity: BoolProperty(name="Prefer walls", default=False)
    collision: BoolProperty(name="Blocks other furniture", default=True)
    price_label: StringProperty(name="Price label", description="Optional display text, e.g. €299", default="")
    swatch: StringProperty(name="Swatch", description="CSS colour in #RRGGBB format", default="")
    tags: EnumProperty(name="Tags", items=TAGS, options={"ENUM_FLAG"})
    allow_overlap_with: EnumProperty(name="May overlap", items=TAGS, options={"ENUM_FLAG"})
    can_rest_on: EnumProperty(name="Can rest on", items=TAGS, options={"ENUM_FLAG"})


class DOMUS_OT_read_model(Operator):
    bl_idname = "domus.read_model"
    bl_label = "Fill Empty Fields"
    bl_description = "Read name, material colour and evaluated mesh bounds; preserve entered values"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        root = context.active_object
        if not root:
            return {"CANCELLED"}
        if not fill_from_model(context, root):
            self.report({"WARNING"}, "No mesh found under the selected root")
        return {"FINISHED"}


class DOMUS_OT_refresh_geometry(Operator):
    bl_idname = "domus.refresh_geometry"
    bl_label = "Refresh Dimensions"
    bl_description = "Recalculate bounds and collider from the model after geometry changes"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        root = context.active_object
        if not root or not fill_from_model(context, root, overwrite_geometry=True):
            self.report({"ERROR"}, "Select a model root containing at least one mesh")
            return {"CANCELLED"}
        return {"FINISHED"}


class DOMUS_OT_load_metadata(Operator):
    bl_idname = "domus.load_metadata"
    bl_label = "Load Saved Metadata"
    bl_description = "Read Domus custom properties from this object, including a reimported GLB"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        root = context.active_object
        if not root or root.get("domus_schema_version") != SCHEMA_VERSION:
            self.report({"ERROR"}, "Selected object has no supported Domus metadata")
            return {"CANCELLED"}
        props = root.domus_metadata
        for field, key in KEYS.items():
            if key not in root:
                continue
            value = root[key]
            if field in ("tags", "allow_overlap_with", "can_rest_on"):
                setattr(props, field, set(filter(None, str(value).split(","))) & set(TAG_IDS))
            else:
                setattr(props, field, value)
        return {"FINISHED"}


class DOMUS_OT_save_metadata(Operator):
    bl_idname = "domus.save_metadata"
    bl_label = "Save Metadata"
    bl_description = "Store Domus fields as exportable custom properties on the selected root"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        root = context.active_object
        if not root:
            return {"CANCELLED"}
        if not fill_from_model(context, root):
            self.report({"ERROR"}, "Selected root must contain at least one mesh")
            return {"CANCELLED"}
        props = root.domus_metadata
        missing = invalid_fields(props)
        if missing:
            self.report({"ERROR"}, "Complete: " + ", ".join(missing))
            return {"CANCELLED"}
        root["domus_schema_version"] = SCHEMA_VERSION
        for field, key in KEYS.items():
            value = getattr(props, field)
            if field in ("tags", "allow_overlap_with", "can_rest_on"):
                value = ",".join(tag for tag in TAG_IDS if tag in value)
            root[key] = value
        self.report({"INFO"}, "Metadata saved on " + root.name + "; save the .blend file to keep it")
        return {"FINISHED"}


class DOMUS_PT_metadata(Panel):
    bl_label = "Product Metadata"
    bl_idname = "DOMUS_PT_metadata"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Domus"

    def draw(self, context):
        layout = self.layout
        root = context.active_object
        if not root:
            layout.label(text="Select the model root object", icon="INFO")
            return
        props = root.domus_metadata
        layout.label(text="Root: " + root.name)
        layout.operator("domus.read_model", icon="EYEDROPPER")
        layout.prop(props, "product_id")
        layout.prop(props, "name")
        layout.prop(props, "category")
        box = layout.box()
        box.label(text="Size in metres (X / Y / Z)")
        for field in ("width", "depth", "height"):
            box.prop(props, field)
        box.operator("domus.refresh_geometry", icon="FILE_REFRESH")
        box = layout.box()
        box.label(text="Placement")
        box.prop(props, "wall_affinity")
        box.prop(props, "collision")
        if props.collision:
            for field in ("collision_width", "collision_depth", "collision_offset_x", "collision_offset_y"):
                box.prop(props, field)
        box.label(text="Clearance in metres; front is Blender -Y")
        for field in ("clearance_front", "clearance_back", "clearance_sides"):
            box.prop(props, field)
        box = layout.box()
        box.label(text="Interaction")
        for field in ("tags", "allow_overlap_with", "can_rest_on"):
            box.prop(props, field)
        layout.prop(props, "price_label")
        layout.prop(props, "swatch")
        missing = invalid_fields(props)
        if missing:
            layout.label(text="Required: " + ", ".join(missing[:2]), icon="ERROR")
        layout.operator("domus.save_metadata", icon="CHECKMARK")
        if root.get("domus_schema_version") == SCHEMA_VERSION:
            layout.operator("domus.load_metadata", icon="IMPORT")
        layout.label(text="Then save .blend and export GLB")
        layout.label(text="Enable Include > Custom Properties")


CLASSES = (DomusMetadata, DOMUS_OT_read_model, DOMUS_OT_refresh_geometry,
           DOMUS_OT_load_metadata, DOMUS_OT_save_metadata, DOMUS_PT_metadata)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Object.domus_metadata = PointerProperty(type=DomusMetadata)


def unregister():
    del bpy.types.Object.domus_metadata
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
