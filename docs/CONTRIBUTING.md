# Contributing

## Tests

Install the Playwright browsers once:

```bash
npx playwright install chromium firefox webkit
```

Then run:

```bash
npm test
npm run test:e2e
```

The browser tests build the app and start test servers automatically. GitHub Actions runs Chromium and WebKit on macOS, Firefox on Ubuntu, and the unit tests on each push and pull request. It does not create releases.

To run the interior-wall browser test:

```bash
VITE_DOMUS_INTERIOR_WALLS=1 npm run test:e2e -- tests/browser/interior-walls.spec.ts --project=chromium
```
