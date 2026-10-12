"""Build the installable add-on ZIP with its shared catalogue schema."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

directory = Path(__file__).resolve().parent
with ZipFile(directory / "domus_metadata_addon.zip", "w", ZIP_DEFLATED) as archive:
    archive.write(directory / "domus_metadata.py", "domus_metadata/__init__.py")
    archive.write(directory / "catalogue_schema.json", "domus_metadata/catalogue_schema.json")
print(directory / "domus_metadata_addon.zip")
