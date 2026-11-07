"""Run with python3 -m unittest discover -s tests -p '*_test.py'."""

import importlib.util
from pathlib import Path
import unittest


_SPEC = importlib.util.spec_from_file_location(
    "planning_model_roles", Path(__file__).resolve().parents[1] / "scripts" / "planning_model_roles.py")
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
classify_part = _MODULE.classify_part


class PlanningModelRolesTest(unittest.TestCase):
    def classify(self, label="opaque CAD identity", ancestry="", lo=(-.1, -.1, .2), hi=(.1, .1, .4), **kwargs):
        return classify_part(label, ancestry, lo, hi, (-.5, -1.1, 0), (.5, 1.1, 1.3), **kwargs)

    def test_unknown_geometry_is_not_remeshed(self):
        self.assertEqual(self.classify(), "feature")

    def test_confident_local_housing_is_bulk(self):
        self.assertEqual(self.classify(ancestry="C8c | Base_Chassis.001"), "bulk")
        self.assertEqual(self.classify(label="Motor housing"), "bulk")

    def test_guard_parent_protects_opaque_mesh(self):
        self.assertEqual(self.classify(ancestry="BODY_HeadLeftPanel"), "feature")
        self.assertEqual(self.classify(ancestry="Rail_Head_L_Carrier.001 Base_Chassis"), "feature")

    def test_boards_are_protected_by_position_on_either_source_axis(self):
        self.assertEqual(self.classify(lo=(-.43, -.99, .3), hi=(.43, -.9, .8)), "feature")
        result = classify_part("CAD", "Ground chassis", (-.99, -.43, .3), (-.9, .43, .8),
                               (-1.1, -.5, 0), (1.1, .5, 1.3))
        self.assertEqual(result, "feature")

    def test_sideguard_is_protected_spatially(self):
        self.assertEqual(self.classify(ancestry="Base chassis", lo=(.43, -.5, .3), hi=(.49, .5, .8)), "feature")

    def test_thin_pole_is_not_remeshed_even_inside_base(self):
        self.assertEqual(self.classify(ancestry="Base chassis", lo=(0, 0, .2), hi=(.015, .015, 1.2)), "thin")

    def test_small_thickness_and_end_housing_stay_features(self):
        self.assertEqual(self.classify(label="cover", lo=(-.1, -.1, .2), hi=(.1, .1, .225)), "feature")
        self.assertEqual(self.classify(label="housing", lo=(-.1, .9, .2), hi=(.1, 1.0, .4)), "feature")

    def test_large_hollow_chassis_preserves_positions_despite_broad_bounds(self):
        self.assertEqual(self.classify(ancestry="Base chassis", lo=(-.2, -.9, .1), hi=(.2, .9, .4)), "thin")
        # V8v's broad BODY_Base contains ~1.2 mm tube walls. The whole-object
        # thickness cannot be used as a safe relocation allowance for those walls.
        result = classify_part("opaque CAD", "BODY_Base", (-.376, -.394, .085), (1.542, .369, .266),
                               (-.468, -.562, 0), (1.796, .523, 1.329))
        self.assertEqual(result, "thin")
        self.assertEqual(self.classify(ancestry="Platform frame", lo=(-.2, -.9, .1), hi=(.2, .9, .4)), "thin")

    def test_large_frame_ancestry_does_not_override_board_or_guard_protection(self):
        self.assertEqual(self.classify(ancestry="BODY_Base Rail_Head_L_Carrier", lo=(-.2, -.9, .1), hi=(.2, .9, .4)), "feature")

    def test_lamp_head_identity_overrides_bulk_ancestry(self):
        self.assertEqual(self.classify(label="15F43EAF6A88780B37D43EE71E556B64CA9E6807|:|source", ancestry="housing", lamp=True), "feature")

    def test_lamp_canopy_can_be_remeshed(self):
        self.assertEqual(self.classify(label="92327058F8B4D5888B109A2D58068848DAE9FCDC|:|source", lo=(-.2, -.2, 1.0), hi=(.2, .2, 1.2), lamp=True), "bulk")

    def test_invalid_bounds_do_not_enter_remesher(self):
        self.assertEqual(self.classify(lo=(float("nan"), 0, 0)), "feature")
        self.assertEqual(self.classify(lo=(1, 0, 0)), "feature")


if __name__ == "__main__":
    unittest.main()
