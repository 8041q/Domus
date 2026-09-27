# Preparing a product in Blender

The [Domus Product Metadata add-on](../blender_addon/domus_metadata.py) writes catalogue and placement data to a model root object. It has **Save Metadata** but no export control. Use Blender's normal glTF exporter for the model file.

## Install and use

1. In Blender 4.2 or newer, open **Edit → Preferences → Add-ons → Install from Disk** and choose `blender_addon/domus_metadata.py`. Enable **Domus Product Metadata**.
2. Put all parts of one product under a single root object (an Empty or a mesh), then select that root. Open **3D View → Sidebar → Domus**.
3. Choose **Fill Empty Fields**. The add-on reads the root name, a material colour, and the evaluated bounds of all mesh descendants. It uses the scene unit scale to express dimensions in metres. Fill in the category and any other fields that need your input. **Refresh Dimensions** deliberately replaces dimensions and collider values after geometry changes.
4. Choose **Save Metadata**. The add-on checks the product ID, name, category, dimensions, collision footprint and swatch, then writes custom properties onto the root object. Save the `.blend` file with Blender's normal **File → Save**.
5. Use **File → Export → glTF 2.0** and choose **glTF Binary (.glb)**. Under **Include**, enable **Custom Properties**. Export the root *and* its mesh descendants (for example, export the containing collection). If the root is omitted, its metadata is omitted too.

The panel's **Load Saved Metadata** button reads the root's Domus custom properties back into its controls. This is useful after importing a GLB that already contains them.

## Orientation and placement

The product's local **X** is width, local **Y** is depth, and local **Z** is height. The front faces Blender **−Y**, which becomes Domus **+Z** after glTF axis conversion. The add-on measures mesh descendants in the root's axes, including their transforms and modifiers. The saved bounds centre and base height describe an off-centre or elevated root origin; a future Domus model loader can use these to align the geometry with its placement footprint. Clearances and collision offsets use the same local axes and metres.

Choose a stable, unique lowercase product ID such as `oak-coffee-table`. Categories currently match Domus's catalogue: Seating, Tables, Storage, and Decor. Price label is optional; it can be filled later. Tags and overlap rules match the semantic placement fields in `src/core/types.ts`.

## Saved fields

All properties are stored on the root object and, with **Custom Properties** enabled, appear as glTF node `extras`. `domus_schema_version` is currently `1`. Other keys have the `domus_` prefix:

| Keys | Meaning |
| --- | --- |
| `product_id`, `name`, `category`, `price_label`, `swatch` | Catalogue identity and display fields. Swatch is `#RRGGBB`. |
| `width_m`, `depth_m`, `height_m` | Product dimensions in metres. |
| `bounds_center_x_m`, `bounds_center_y_m`, `bounds_min_z_m` | Geometry position relative to the root origin. |
| `collision`, `collision_width_m`, `collision_depth_m`, `collision_offset_x_m`, `collision_offset_y_m` | Collision footprint and local offset. |
| `clearance_front_m`, `clearance_back_m`, `clearance_sides_m`, `wall_affinity` | Placement rules. |
| `interaction_tags`, `allow_overlap_with`, `can_rest_on` | Comma-separated semantic tags. |

The add-on prepares GLBs with the metadata Domus needs. The current Domus catalogue still uses procedural placeholder furniture; loading external product GLBs into the app is a separate integration step.

## Blender integration check

From the repository root, with Blender on your path:

```bash
blender -b --factory-startup --python blender_addon/test_domus_metadata.py
```

The check builds a small model, verifies required fields and geometry, exports it through Blender's built-in glTF exporter, and checks the GLB node extras.
