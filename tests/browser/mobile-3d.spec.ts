import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PerspectiveCamera, Vector3 } from 'three';

async function layout(page: Page) {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Project', exact: true }).tap();
  await page.getByRole('menuitem', { name: /^Download room/ }).tap();
  return JSON.parse(await readFile((await (await downloaded).path())!, 'utf8')).snapshot;
}

test('phone 3D editing commits one touch drag and rolls it back when a second finger takes over', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP provides native multitouch input for this integration check.');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
    await page.getByRole('navigation', { name: 'Phone workspace' }).getByRole('button', { name: 'Furniture', exact: true }).tap();
    await expect(page.locator('.loading-status')).toHaveCount(0);
    const catalogue = page.locator('[data-sheet="catalogue"]');
    await expect(catalogue).toBeVisible();
    await catalogue.getByRole('button', { name: /^3-seat sofa/ }).tap();
    await expect(page.locator('[data-sheet="selection"]')).toBeVisible();
    await page.locator('[data-sheet="selection"]').getByRole('button', { name: /Close .* tools/ }).tap();
    await page.getByRole('button', { name: 'View', exact: true }).tap();
    await page.getByRole('button', { name: 'Top', exact: true }).tap();
    const initial = await layout(page);
    const canvas = page.locator('.viewport canvas');
    const bounds = (await canvas.boundingBox())!;
    const topPoint = (snapshot: typeof initial) => {
      const xs = snapshot.room.vertices.map((vertex: { x: number }) => vertex.x), zs = snapshot.room.vertices.map((vertex: { z: number }) => vertex.z);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      const camera = new PerspectiveCamera(32, bounds.width / bounds.height, 0.08, 100);
      camera.position.set(cx, Math.max(snapshot.room.height + 4, Math.max(maxX - minX, maxZ - minZ, 2) * 2), cz + 0.01);
      camera.lookAt(cx, snapshot.room.height * 0.5, cz); camera.updateMatrixWorld();
      const point = new Vector3(snapshot.objects[0].x, 0.4, snapshot.objects[0].z).project(camera);
      return { x: bounds.x + (point.x + 1) * bounds.width / 2, y: bounds.y + (1 - point.y) * bounds.height / 2 };
    };
    const cdp = await context.newCDPSession(page);
    const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ id: number; x: number; y: number }>) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    const first = topPoint(initial);
    await send('touchStart', [{ id: 1, ...first }]);
    for (let step = 1; step <= 5; step++) await send('touchMove', [{ id: 1, x: first.x + step * 5, y: first.y }]);
    await send('touchEnd', []);
    const committed = await layout(page);
    expect(committed.objects).toHaveLength(1);
    expect(committed.objects[0].x).not.toBe(initial.objects[0].x);

    const next = topPoint(committed);
    await send('touchStart', [{ id: 1, ...next }]);
    await send('touchMove', [{ id: 1, x: next.x + 28, y: next.y }]);
    // Let the edit preview reach the store/renderer before the next finger arrives.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await send('touchStart', [{ id: 1, x: next.x + 28, y: next.y }, { id: 2, x: next.x + 88, y: next.y }]);
    for (let step = 1; step <= 5; step++) await send('touchMove', [
      { id: 1, x: next.x + 28 - step * 2, y: next.y }, { id: 2, x: next.x + 88 + step * 2, y: next.y }
    ]);
    await send('touchEnd', []);
    expect((await layout(page)).objects).toEqual(committed.objects);
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    expect((await layout(page)).objects).toEqual(initial.objects);
    expect(errors).toEqual([]);
    await cdp.detach();
  } finally { await context.close(); }
});
