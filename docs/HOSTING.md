# Hosting a public version

Public hosting requires a prepared server package and a durable library of published furniture models. A regular static website host is not sufficient.

To prepare a package on the computer that holds the models:

```bash
npm run package:public -- /path/to/new-release
```

Only deploy the package produced by this command. **Never deploy the project workspace or files from `og_models/`.** See [architectural models](architectural-models.md) for model details.
