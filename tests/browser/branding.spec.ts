import { test, expect } from '@playwright/test';

for (const origin of ['http://127.0.0.1:5199', 'http://127.0.0.1:5200']) {
  test(`brand assets and install metadata survive packaging at ${origin}`, async ({ request }) => {
    await expect.poll(async () => {
      try { return (await request.get(`${origin}/api/health`)).status(); } catch { return 0; }
    }).toBe(200);
    const document = await request.get(origin);
    const html = await document.text();
    expect(html).toContain('rel="manifest" href="/site.webmanifest"');
    if (origin.endsWith('5200')) {
      expect(html).toContain('content="https://127.0.0.1:5200/brand/social-card.png"');
      const head = await request.head(origin);
      expect(head.headers()['content-length']).toBe(String(Buffer.byteLength(html)));
    }
    const manifestResponse = await request.get(`${origin}/site.webmanifest`);
    expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json');
    const manifest = await manifestResponse.json();
    expect(manifest.icons).toHaveLength(4);
    for (const icon of manifest.icons) {
      const response = await request.get(origin + icon.src);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('image/png');
      const png = await response.body(), size = Number(icon.sizes.split('x')[0]);
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    }
    for (const [asset, mime] of [['/favicon.ico', 'image/x-icon'], ['/brand/favicon.svg', 'image/svg+xml'], ['/brand/apple-touch-icon.png', 'image/png'], ['/brand/social-card.png', 'image/png']]) {
      const response = await request.get(origin + asset);
      expect(response.status(), asset).toBe(200);
      expect(response.headers()['content-type'], asset).toContain(mime);
    }
    const social = await (await request.get(`${origin}/brand/social-card.png`)).body();
    expect([social.readUInt32BE(16), social.readUInt32BE(20)]).toEqual([1200, 630]);
  });
}

test('the logo loads without stretching or hiding controls on desktop and phone', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
    const logo = page.locator('.brand-mark');
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    const bounds = await logo.boundingBox();
    expect(bounds!.width).toBe(bounds!.height);
    const project = await page.getByRole('button', { name: 'Project', exact: true }).boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThan(project!.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `private/branding/app-${viewport.width < 500 ? 'phone' : 'desktop'}.png` });
  }
});
