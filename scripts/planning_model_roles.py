"""Conservative, private role classification for geometry-only planning copies.

All bounds are evaluated world-space metres in the original Blender Z-up axes.
The caller can discard labels and ancestry immediately after classification; no
source names need to be written into the generated GLB.
"""

import math
import re


# These opaque CAD identities are only used while inspecting the private source.
# Both complete heads and the separate face/rim/optical pieces need their lobes.
_LAMP_HEAD_PREFIXES = (
    "15f43eaf6a88780b37d43ee71e556b64ca9e6807",
    "38e3ae415bec5da2a286c5ae69492b238ee6be4e",
    "ae4a81952ff71754dbaf21717126b3b624dd73",
    "94d97faf53d858fff522b52fe684be1808916a3d",
    "ab0c24b4150686b54c159a30197ed5c11f39a534",
)
_LAMP_CANOPY_PREFIX = "92327058f8b4d5888b109a2d58068848dae9fcdc"
_FEATURE_WORDS = re.compile(r"\b(rail|guard|panel|board|handle|lens|optical|reflector)\b")
_THIN_WORDS = re.compile(r"\b(pole|rod|tube|shaft|link|arm|bar|strut)\b")
_BULK_WORDS = re.compile(r"\b(wheel|caster|castor|cover|housing|case|canopy|base|chassis)\b")
_FRAME_WORDS = re.compile(r"\b(base|chassis|platform|frame)\b")


def classify_part(label, ancestry, lo, hi, lower, upper, lamp=False):
    """Return ``feature``, ``thin`` or confidently remeshable ``bulk``.

    Unknown parts stay on feature-preserving simplification. Only recognisable
    bulky components thicker than 25 mm can enter the experimental remesher.
    The spatial tests catch large boards whose CAD names and parents are opaque.
    """
    try:
        if not all(len(bounds) == 3 for bounds in (lo, hi, lower, upper)):
            return "feature"
        values = [float(value) for bounds in (lo, hi, lower, upper) for value in bounds]
        if not all(math.isfinite(value) for value in values):
            return "feature"
        size = [float(hi[i]) - float(lo[i]) for i in range(3)]
        dimensions = [float(upper[i]) - float(lower[i]) for i in range(3)]
        if min(size) < 0 or min(dimensions) <= 0:
            return "feature"
        center = [(float(lo[i]) + float(hi[i])) / 2 for i in range(3)]
    except (TypeError, ValueError):
        return "feature"

    source_label = str(label or "").casefold()
    # Underscores separate imported rig roles such as BODY_HeadLeftPanel.
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(label or "") + " " + str(ancestry or ""))
    text = re.sub(r"[^\w]+|_", " ", text).casefold()
    if _FEATURE_WORDS.search(text):
        return "feature"

    if lamp:
        if source_label.startswith(_LAMP_HEAD_PREFIXES):
            return "feature"
        # Preserve unrecognised lower head components too, including tilted heads.
        height_fraction = (center[2] - lower[2]) / dimensions[2]
        if height_fraction < .60 and sorted(size)[1] > .12:
            return "feature"
    else:
        long_axis = 0 if dimensions[0] > dimensions[1] else 1
        width_axis = 1 - long_axis
        length_fraction = (center[long_axis] - lower[long_axis]) / dimensions[long_axis]
        width_fraction = (center[width_axis] - lower[width_axis]) / dimensions[width_axis]
        near_end = length_fraction < .15 or length_fraction > .85
        if near_end and size[width_axis] > .55 * dimensions[width_axis] and size[2] > .20 * dimensions[2]:
            return "feature"
        if (abs(width_fraction - .5) > .35 and size[2] > .18 * dimensions[2]
                and size[long_axis] > .25 * dimensions[long_axis]):
            return "feature"

    ordered = sorted(size)
    if (ordered[1] < .05 and ordered[2] > max(.06, ordered[1] * 5)) or _THIN_WORDS.search(text):
        return "thin"

    # An assembly can have a broad bounding box while its hollow tube walls are
    # only a millimetre thick. Vertex relocation may flatten opposite walls into
    # coincident faces, so preserve positions on large chassis/frame assemblies.
    if not lamp and ordered[2] > .40 * dimensions[long_axis] and _FRAME_WORDS.search(text):
        return "thin"

    if ordered[0] <= .025:
        return "feature"
    known_bulk = bool(_BULK_WORDS.search(text))
    if lamp:
        known_bulk = known_bulk or source_label.startswith(_LAMP_CANOPY_PREFIX)
    else:
        # End assemblies often contain slots, bumper shapes and control plaques.
        # A broad chassis parent is not enough to remesh those parts safely.
        if near_end:
            return "feature"
        # Large open chassis/platform assemblies also retain their own topology.
        if ordered[2] > .40 * dimensions[long_axis]:
            return "feature"

    return "bulk" if known_bulk else "feature"
