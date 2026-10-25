import { defineConfig, devices } from '@playwright/test';

const softwareGraphics = Boolean(process.env.CI || process.env.DOMUS_TEST_SOFTWARE_GL) || process.platform !== 'darwin';

export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, timeout: process.env.CI ? 240_000 : 60_000,
  expect: { timeout: process.env.CI ? 60_000 : 15_000 }, retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://127.0.0.1:5199', trace: 'retain-on-failure', screenshot: 'only-on-failure', acceptDownloads: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: softwareGraphics ? .5 : 1, launchOptions: { args: ['--enable-webgl', '--use-gl=angle', `--use-angle=${softwareGraphics ? 'swiftshader' : 'metal'}`] } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true } } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: { command: 'node scripts/e2e-server.mjs', url: 'http://127.0.0.1:5199/api/health', reuseExistingServer: false, timeout: 60_000 },
});
