import { readExportedRoom } from './roomFile';
import { test, expect, type CDPSession, type Page } from '@playwright/test';

type Point = { x: number; y: number };
type Finger = Point & { id: number };

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
  await expect(page.getByRole('navigation', { name: 'Phone workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Room', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Editable room floor plan', { exact: true })).toBeVisible();
}

async function layout(page: Page) {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Project', exact: true }).tap();
  await page.getByRole('menuitem', { name: /^Export room/ }).tap();
  const filename = await (await downloaded).path();
  const document = await readExportedRoom(filename!);
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-loading-locked', 'true');
  return document.snapshot;
}

async function frame(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function send(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: Finger[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

async function drag(cdp: CDPSession, start: Point, dx: number, dy: number) {
  await send(cdp, 'touchStart', [{ id: 1, ...start }]);
  for (let step = 1; step <= 8; step++) await send(cdp, 'touchMove', [{ id: 1, x: start.x + dx * step / 8, y: start.y + dy * step / 8 }]);
  await send(cdp, 'touchEnd', []);
}

/** Match the initial documented fit, then retain that transform as geometry changes. */
async function initialRoomView(page: Page, snapshot: any) {
  const box = (await page.getByLabel('Editable room floor plan', { exact: true }).boundingBox())!;
  const vertices = snapshot.room.vertices as Array<{ id: string; x: number; z: number }>;
  const minX = Math.min(...vertices.map(vertex => vertex.x)), maxX = Math.max(...vertices.map(vertex => vertex.x));
  const minZ = Math.min(...vertices.map(vertex => vertex.z)), maxZ = Math.max(...vertices.map(vertex => vertex.z));
  const width = maxX - minX, depth = maxZ - minZ;
  const scale = Math.max(6, Math.min(180, (box.width - 128) / Math.max(width, 6.4), (box.height - 128) / Math.max(depth, 5)));
  const ox = Math.max(64, (box.width - width * scale) / 2) - minX * scale;
  const oz = Math.max(64, (box.height - depth * scale) / 2) - minZ * scale;
  return { box, at: (x: number, z: number): Point => ({ x: box.x + ox + x * scale, y: box.y + oz + z * scale }),
    west: { x: minX, z: (minZ + maxZ) / 2 }, corner: vertices.find(vertex => vertex.x === minX && vertex.z === maxZ)! };
}

test('phone 2D editing selects before dragging and corner edits remain undoable', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real multi-touch dispatch uses the Chromium DevTools protocol.');
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5199', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true });
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await ready(page);
    const before = await layout(page), view = await initialRoomView(page, before);
    const wall = view.at(view.west.x, view.west.z);
    await drag(cdp, wall, -24, 0);
    await expect(page.getByRole('region', { name: 'Wall settings tools' })).toBeVisible();
    expect(await layout(page)).toEqual(before);

    await drag(cdp, wall, -24, 0);
    const moved = await layout(page);
    expect(moved.room.vertices).not.toEqual(before.room.vertices);
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    expect(await layout(page)).toEqual(before);

    const corner = view.at(view.corner.x, view.corner.z);
    await drag(cdp, corner, -16, 12);
    await expect(page.getByRole('region', { name: 'Corner settings tools' })).toBeVisible();
    expect(await layout(page)).toEqual(before);
    await drag(cdp, corner, -16, 12);
    expect((await layout(page)).room.vertices).not.toEqual(before.room.vertices);
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    expect(await layout(page)).toEqual(before);
    expect(errors).toEqual([]);
  } finally { await cdp.detach(); await context.close(); }
});

test('a second finger cancels a 2D edit before navigation and preserves history across orientation', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Real multi-touch dispatch uses the Chromium DevTools protocol.');
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5199', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true });
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await ready(page);
    const before = await layout(page), view = await initialRoomView(page, before);
    const wall = view.at(view.west.x, view.west.z);
    await send(cdp, 'touchStart', [{ id: 1, ...wall }]); await send(cdp, 'touchEnd', []);
    await drag(cdp, wall, -24, 0);
    const committed = await layout(page);
    expect(committed.room.vertices).not.toEqual(before.room.vertices);
    const westX = Math.min(...committed.room.vertices.map((vertex: { x: number }) => vertex.x));
    const selectedWall = view.at(westX, view.west.z);
    const canvas = page.getByLabel('Editable room floor plan', { exact: true });
    const image = await canvas.screenshot();
    await send(cdp, 'touchStart', [{ id: 1, ...selectedWall }]);
    const preview = { id: 1, x: selectedWall.x + 24, y: selectedWall.y };
    await send(cdp, 'touchMove', [preview]); await frame(page);
    await expect.poll(async () => !(await canvas.screenshot()).equals(image), { message: 'The selected wall has an active edit preview' }).toBe(true);

    const second = { id: 2, x: selectedWall.x + 120, y: selectedWall.y + 25 };
    await send(cdp, 'touchStart', [preview, second]);
    for (let step = 1; step <= 8; step++) {
      await send(cdp, 'touchMove', [{ ...preview, x: preview.x - step * 2, y: preview.y + step }, { ...second, x: second.x + step * 3, y: second.y + step }]);
    }
    await send(cdp, 'touchEnd', []);
    expect(await layout(page)).toEqual(committed);
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    expect(await layout(page)).toEqual(before);
    await page.getByRole('button', { name: 'Redo', exact: true }).tap();
    expect(await layout(page)).toEqual(committed);

    await canvas.evaluate(element => { element.dataset.mobileCanvasIdentity = 'same-canvas'; });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(canvas).toHaveAttribute('data-mobile-canvas-identity', 'same-canvas');
    await expect.poll(async () => { const bounds = (await canvas.boundingBox())!; return bounds.y + bounds.height; }).toBeLessThanOrEqual(391);
    const bounds = (await canvas.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(391);
    await page.screenshot({ path: testInfo.outputPath('phone-plan-landscape.png') });
    expect(await layout(page)).toEqual(committed);
    expect(errors).toEqual([]);
  } finally { await cdp.detach(); await context.close(); }
});
