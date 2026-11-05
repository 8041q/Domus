"""Regression checks for full-detail references entering publishing libraries."""

import importlib.util
from pathlib import Path
import tempfile
import unittest


_SPEC = importlib.util.spec_from_file_location(
    "planning_model_paths", Path(__file__).resolve().parents[1] / "scripts" / "planning_model_paths.py")
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
validate_output_paths = _MODULE.validate_output_paths


class PlanningModelPathsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="domus-model-paths-")
        self.addCleanup(self.temporary.cleanup)
        self.repository = Path(self.temporary.name).resolve()
        self.source = self.repository / "og_models"
        self.source.mkdir()
        self.private = self.repository / "private"
        self.private.mkdir()
        self.output = self.private / "models"
        self.previews = self.private / "proxy-previews"

    def validate(self, source=None, output=None, previews=None):
        return validate_output_paths(source or self.source, output or self.output,
                                     previews or self.previews, self.repository)

    def test_normal_destinations_are_resolved(self):
        self.assertEqual(self.validate(), (self.source, self.output, self.previews))
        self.assertFalse(self.output.exists(), "Validation must not create destinations")

    def test_alternate_output_does_not_allow_references_in_canonical_models(self):
        with self.assertRaisesRegex(ValueError, "publisher source"):
            self.validate(output=self.private / "alternate-models", previews=self.output)
        with self.assertRaisesRegex(ValueError, "publisher source"):
            self.validate(output=self.private / "alternate-models", previews=self.output / "nested")

    def test_custom_source_cannot_hide_nested_canonical_publisher_output(self):
        source = self.output / "custom" / "og_models"
        private = source.parent / "private"
        with self.assertRaisesRegex(ValueError, "publisher source"):
            self.validate(source=source, output=private / "models", previews=private / "previews")

    def test_custom_source_outside_publisher_can_use_its_sibling_private_folder(self):
        source = self.repository / "fixtures" / "og_models"
        private = source.parent / "private"
        self.assertEqual(self.validate(source=source, output=private / "models", previews=private / "previews"),
                         (source, private / "models", private / "previews"))

    def test_outputs_never_enter_original_source_tree(self):
        for path in (self.source, self.source / "generated"):
            with self.assertRaisesRegex(ValueError, "originals"):
                self.validate(output=path)
            with self.assertRaisesRegex(ValueError, "originals"):
                self.validate(previews=path)

    def test_private_root_and_overlapping_destinations_are_rejected(self):
        for output, previews in ((self.private, self.previews), (self.output, self.private),
                                 (self.output, self.output), (self.output, self.output / "previews"),
                                 (self.previews / "models", self.previews)):
            with self.assertRaises(ValueError):
                self.validate(output=output, previews=previews)

    def test_architecture_library_is_not_a_model_or_comparison_destination(self):
        openings = self.private / "openings"
        for path in (openings, openings / "nested"):
            with self.assertRaisesRegex(ValueError, "architectural publisher"):
                self.validate(output=path)
            with self.assertRaisesRegex(ValueError, "publisher source"):
                self.validate(previews=path)

    def test_custom_source_architecture_library_is_also_protected(self):
        source = self.repository / "fixtures" / "og_models"
        private = source.parent / "private"
        with self.assertRaisesRegex(ValueError, "architectural publisher"):
            self.validate(source=source, output=private / "openings", previews=private / "previews")

    def test_symlink_outside_private_boundary_is_rejected(self):
        public = self.repository / "public"
        public.mkdir()
        link = self.private / "escaped"
        link.symlink_to(public, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "ignored private directory"):
            self.validate(output=link / "models")
        with self.assertRaisesRegex(ValueError, "ignored private directory"):
            self.validate(previews=link / "previews")

    def test_symlink_alias_of_publisher_library_cannot_receive_comparisons(self):
        library = self.private / "library"
        library.mkdir()
        self.output.symlink_to(library, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "publisher source"):
            self.validate(output=self.private / "alternate", previews=library / "previews")

    def test_private_root_symlink_cannot_redefine_boundary_as_public(self):
        self.private.rmdir()
        public = self.repository / "public"
        public.mkdir()
        self.private.symlink_to(public, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "ignored private directory"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
