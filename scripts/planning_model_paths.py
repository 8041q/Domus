"""Validate private model-generation destinations before creating any files."""

from pathlib import Path


def _within(path, directory):
    return path == directory or directory in path.parents


def _overlaps(first, second):
    return _within(first, second) or _within(second, first)


def validate_output_paths(source, output, previews, repository):
    """Return resolved ``(source, output, previews)`` or raise ``ValueError``.

    A custom source tree can use its own sibling private directory, as synthetic
    fixtures do. Neither that tree nor the actual repository's publisher source
    folders may receive full-detail comparison references. Resolve destinations
    first so symlink aliases cannot bypass containment or publisher exclusions.
    """
    source, output, previews, repository = (
        Path(value).resolve() for value in (source, output, previews, repository))
    # Deliberately keep this lexical: a private/ symlink pointing to public/ must
    # not redefine the permitted private boundary to include the public tree.
    private_root = source.parent / "private"
    for destination in (output, previews):
        if _within(destination, source):
            raise ValueError("Generated outputs must be separate from the originals")
        if not _within(destination, private_root):
            raise ValueError("Generated models and comparisons must stay under the ignored private directory")
    if _overlaps(output, previews):
        raise ValueError("Keep reference comparisons outside the active model library")

    publisher_sources = {
        (base / name).resolve()
        for base in (private_root, repository / "private")
        for name in ("models", "openings")
    }
    if any(_overlaps(previews, directory) for directory in publisher_sources):
        raise ValueError("Private comparisons must never enter a publisher source directory")
    architectural_sources = {
        (base / "openings").resolve()
        for base in (private_root, repository / "private")
    }
    if any(_overlaps(output, directory) for directory in architectural_sources):
        raise ValueError("Planning models must not enter an architectural publisher source directory")
    return source, output, previews
