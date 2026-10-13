# Preparing and importing furniture models

## Install the Blender add-on

In Blender 4.2 or newer, open
**Edit → Preferences → Add-ons → Install from Disk** and select
[`blender_addon/domus_metadata_addon.zip`](../blender_addon/domus_metadata_addon.zip).
Leave **Overwrite** checked and select **Enable on Install**, or enable the new
**Domus Product Metadata** entry after installation. Version 0.4.1 automatically
disables the legacy single-file/v0.3 package and migrates the existing inputs,
including category names, without changing your saved metadata or model parts.
You do not need to disable or uninstall the previous version first.

For later upgrades, install the same ZIP again with **Overwrite** checked. An
enabled add-on detects the replaced files and reloads itself within a second,
preserving the source and metadata inputs. Installing identical contents is
also safe. If the add-on is disabled, enable it after installing.

The ZIP contains the Python add-on and its
shared category schema; install the ZIP rather than the individual Python file.

To rebuild the ZIP after editing its sources:

```bash
python blender_addon/package_addon.py
```

## Prepare a product collection

1. Put all parts of one product in a collection. Child collections are included,
   so a bed can contain separate frame, mattress, pillow and hardware collections.
   Keep reference planes and unrelated objects outside it.
2. Open **3D View → Sidebar → Domus**, choose **Collection**, and select the
   **Product collection**. **Use Active Collection** uses the active Outliner
   collection. **Object hierarchy** remains available for a root and its children.
3. Enter a **Name** and **Category**. Under **Model External Dimensions**, choose **Use Measured Size** to fill
   the display size from the complete product, or enter its manufacturer size
   directly. Width, depth and height are required, positive values **in metres**:
   enter `0.995`, not `995`, for a 995 mm width.
4. Set **Prefer walls**, **Blocks other furniture**, and front/back/side use-space
   clearance if needed. **Price** is optional. Hover a field or button for an
   explanation, including measurement axes and clearance directions.
5. Choose **Save Metadata**, then save the `.blend` file. Every save remeasures
   evaluated geometry, including nested parts, transforms and modifiers. It
   preserves the display size you entered.
6. Choose **Export Product GLB** and save the file. This saves metadata again,
   uses Blender's built-in glTF exporter in GLB mode with **Custom Properties**
   enabled, exporting only the chosen product with evaluated
   modifiers, and converts the scene unit scale to metres. All parts must be
   visible and selectable. The source assembly, transforms and previous selection are preserved.

Blender collections do not directly export their custom properties to glTF.
The add-on creates a small **Domus Metadata** Empty inside the chosen collection
to carry them; it does not reparent the product parts. The export includes this
Empty automatically. Selection is prepared internally by **Export Product GLB**;
there is no separate Select Product for Export button.

### Materials and transparency

The add-on exports node materials and embeds their image textures in the GLB.
Ordinary Principled BSDF materials retain their authored colours, roughness,
metalness and supported material extensions.

Version 0.4.1 also prepares transparent emission decals automatically. It recognises
an Image Texture whose **Color** drives an **Emission** shader and whose **Alpha**
drives a **Mix Shader**, with a white **Transparent BSDF** in its first shader input
and Emission in its second. This includes the icon plane in the original C8c bed.
Blender's native exporter drops that graph's transparency; the add-on supplies an
equivalent Principled material only during export, preserving emission strength,
alpha, UV mapping and sidedness. Source nodes, materials and shared meshes are
restored even if export fails or is cancelled. Re-export existing GLBs to receive
the correction; the add-on does not rewrite source `.blend` files.

This is a conversion for that connected shader pattern, not general shader baking.
It does not assume that every RGBA texture should be transparent. Other shader
graphs still follow Blender's native glTF support.

Domus adds a subtle neutral reflection environment to imported PBR materials.
Furniture still responds to the room lights and shadows; the paired-suns preset
uses its existing environment instead. Blender Material Preview uses its own HDRI
and colour-management settings, so the room view will not be an exact preview match.

## Display size and actual size

The size entered in the panel is catalogue/display information. It appears on
the furniture card and in the selection panel. It never stretches a model or
changes its collision footprint.

The actual size is measured internally on every save and measured again from
the exported GLB on import. Placement, collision, 2D footprints, 3D measurements
and AI layout checks use the actual geometry. Domus centres it horizontally and
places its lowest point on the floor. Blender X is width, Y is depth and Z is
height; a product's front faces Blender −Y, which becomes Domus +Z.

There are no Product ID, manual collider, Interaction or Swatch inputs. IDs
belong to the import server. Collision bounds come from geometry. The former
Interaction controls described advanced tag-based overlap exceptions, which
remain internal to procedural catalogue products. Swatch meant a catalogue
preview colour; imported products now derive it from their materials. Neither
field needs to be entered in Blender.

Categories come from the shared
[`catalogue_schema.json`](../blender_addon/catalogue_schema.json): Hospital Bed,
Homecare Bed, Children Bed, Baby Crib, Spinal Therapy Bed, Examination Table,
Operating Table, Gynaecological Table, Bedside Table, Medical Chair, IV Stand,
Stretcher, Patient Trolley, Medical trolley, Decoration and Others. Bedside Table
appears once. These same categories are used by the project catalogue. Older
broad categories migrate to Others, except Decor/Rugs, which migrate to Decoration.
Choose a more specific category when re-exporting an old model. Rebuild/reinstall
the add-on ZIP after changing the shared schema.

## Automatic import into Domus

Copy the exported `.glb` into **`public/models/` in the repository root**.
Subfolders are supported. Keep one product per GLB. With **`npm run dev`**
running, additions, edits, renames and removals update the catalogue automatically
without editing source code or reloading the current room. **`npm run preview`**
also scans the source folder through its catalogue API and updates open pages
every two seconds. Models load when placed; duplicates share their loaded asset.

For a missed change, run **`npm run models:rescan`** in a second terminal.
This forces a fresh read of every GLB, including files whose size and timestamp
have not changed. It uses the running server's import queue and ID registry and
updates open planners. Pass a different server URL when needed, for example
**`npm run models:rescan -- http://localhost:4173`** for preview. The command reports
unavailable models and import issues and exits with an error if any file fails.

The server assigns a UUID to each new file and stores it in the generated
**`model-catalogue.json`** at the project root. Copies receive different IDs,
including copies with identical old Blender IDs. Updating the same file keeps
its ID while it remains at the same path. A renamed file is a new import with a
new ID. Keep this registry with
project backups and source control so saved rooms continue to resolve products.

Removed files are cleaned from the catalogue and registry, including their
aliases and metadata. Open planners remove their placed/unplaced instances,
release loaded assets and remove their references from undo/redo history. Saved
rooms discard missing-model instances when opened; their room geometry and
remaining furniture are preserved. Stored room files are updated when saved.
Only retired UUIDs remain in the registry, preventing those IDs from being used
again. Re-adding the same file gets a new ID and does not restore old placements.
Invalid or incomplete files that still exist show an import issue and retain
their identity, allowing a corrected export to replace them.

Plain GLBs without metadata also import automatically, using the filename as
their name, **Others** as the category, and measured geometry for display size.
Older v1 metadata is supported, but its manually entered dimensions and collider
values are not trusted. The original C8c file still contains its extra reference
plane; it is preserved until re-exported with only the product collection.

A static deployment includes the catalogue/models present at build time. It
must be rebuilt to include changes; live scanning requires the Vite dev or
preview server. Edit `public/models/`, not the generated `dist/` folder.

## Metadata schema and checks

Schema v2 stores custom properties on exactly one exported metadata carrier:

| Fields | Meaning |
| --- | --- |
| `domus_name`, `domus_category`, `domus_price_label` | Display fields; price is optional. |
| `domus_display_width_m`, `domus_display_depth_m`, `domus_display_height_m` | Required catalogue size in metres. |
| `domus_width_m`, `domus_depth_m`, `domus_height_m` | Actual measured geometry size. |
| `domus_collision_width_m`, `domus_collision_depth_m`, offsets and bounds fields | Automatically generated internal placement data. |
| `domus_collision`, `domus_wall_affinity`, clearance fields | Simple placement preferences. |

Run the Blender integration check with:

```bash
blender -b --factory-startup --python-exit-code 1 --python blender_addon/test_domus_metadata.py
```

The check covers multipart and nested collections, required fields, display-size
preservation, automatic geometry/colliders, modifiers, selected-only exports,
non-default scene units, and restoration of source transforms. It has been run
successfully with Blender 4.5 and 5.2.

Material export and restoration checks:

```bash
blender -b --factory-startup --python-exit-code 1 --python blender_addon/test_material_export.py
```

Append `-- --source-blend /path/to/C8c.blend` to also check the original C8c decal
material without changing or saving its source file.
