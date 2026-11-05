# Private model originals

- `og_models/` contains private original authoring files, including Blender backups.
- Never stage, commit, force-add, upload, or include anything from this folder in a public deployment.
- Never save changes to the originals. Inspect them locally with Blender file scripts disabled.
- Generate separate planning stand-ins with `npm run models:proxies`. Generated assets and previews belong under the ignored `private/` folder.
- Deploy only a package created by `package:public`; never deploy the project workspace.
