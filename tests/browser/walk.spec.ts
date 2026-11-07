import { readExportedRoom } from './roomFile';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function readyToPlan(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
  const phoneNavigation = page.getByRole('navigation', { name: 'Phone workspace' });
  if (await phoneNavigation.isVisible()) {
    await phoneNavigation.getByRole('button', { name: 'Furniture', exact: true }).click();
    await expect(page.locator('[data-sheet="catalogue"]')).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'Plan room', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Catalogue', exact: true })).toBeVisible();
  }
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(page.locator('.viewport canvas')).toBeVisible();
}

async function layout(page: Page) {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Export room/ }).click();
  const filename = await (await downloaded).path();
  const document = await readExportedRoom(filename!);
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-loading-locked', 'true');
  return document.snapshot;
}

async function changesView(page: Page, action: () => Promise<unknown>, message: string) {
  const canvas = page.locator('.viewport canvas');
  const before = await canvas.screenshot();
  await action();
  // Compare the current frame, without depending on a browser-specific golden
  // image. Collision geometry and exact camera deltas have separate unit tests.
  await expect.poll(async () => !(await canvas.screenshot()).equals(before), { message }).toBe(true);
}

async function dragView(page: Page, button: 'left' | 'right', dx: number, dy: number) {
  const bounds = (await page.locator('.viewport canvas').boundingBox())!;
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up({ button });
}

test('Walk supports keyboard and mouse navigation without editing furniture, and exits to planner views', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await readyToPlan(page);
  await page.getByRole('button', { name: /^3-seat sofa/ }).click();
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(page.locator('.selection-panel')).toBeVisible();
  const before = await layout(page);
  const canvas = page.locator('.viewport canvas');
  const walk = page.getByRole('button', { name: 'Walk', exact: true });
  await expect(canvas).toHaveAttribute('aria-label', '3D room view');

  await walk.click();
  await expect(walk).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Walk controls' })).toBeVisible();
  await expect(canvas).toHaveAttribute('aria-label', 'Walk through room');
  await expect(canvas).toBeFocused();
  await expect(canvas).toHaveCSS('outline-style', 'none');
  await expect(page.locator('.selection-panel')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('walk-view.png') });

  await changesView(page, () => page.keyboard.press('w', { delay: 220 }), 'W walks forward');
  await expect(canvas).toHaveCSS('outline-style', 'none');
  await changesView(page, () => page.keyboard.press('ArrowRight', { delay: 220 }), 'Arrow keys move across the floor');
  await changesView(page, () => dragView(page, 'left', 90, 30), 'Left drag looks around');
  await changesView(page, () => dragView(page, 'right', 55, 15), 'Right drag moves across the floor');
  await page.getByRole('button', { name: 'Pan', exact: true }).click();
  await expect(canvas).toBeFocused();
  await changesView(page, () => dragView(page, 'left', 40, 10), 'Pan tool uses the primary button');
  await page.getByRole('button', { name: 'Look', exact: true }).click();
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await changesView(page, () => page.mouse.wheel(0, 200), 'Wheel changes magnification');
  await changesView(page, () => page.getByRole('button', { name: 'Zoom in', exact: true }).click(), 'Zoom buttons change magnification');
  for (const key of ['r', 'x', 'Delete', 'Backspace']) await page.keyboard.press(key);
  await expect(canvas).toBeVisible();
  const walked = await layout(page);
  expect(walked).toEqual(before);

  await canvas.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Free cam', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Walk controls' })).toHaveCount(0);
  await expect(canvas).toHaveAttribute('aria-label', '3D room view');
  await expect(page.locator('.selection-panel')).toBeVisible();

  await walk.click();
  await page.getByRole('button', { name: /Exit walk/ }).click();
  await expect(walk).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('region', { name: 'Walk controls' })).toHaveCount(0);

  await walk.click();
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Top', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas).toHaveAttribute('aria-label', '3D room view');
  await expect(page.getByRole('region', { name: 'Walk controls' })).toHaveCount(0);
  await canvas.focus();
  await page.keyboard.press('r');
  const edited = await layout(page);
  expect(edited.objects[0].rotationY).not.toBe(before.objects[0].rotationY);
  expect(edited.objects).toHaveLength(before.objects.length);
  expect(errors).toEqual([]);
});

test('PDF export from Walk restores walking and its planner return view', async ({ page }) => {
  await readyToPlan(page);
  const canvas = page.locator('.viewport canvas');
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.keyboard.press('w', { delay: 150 });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Export to PDF/ }).click();
  const filename = await (await downloaded).path();
  expect((await readFile(filename!)).subarray(0, 4).toString()).toBe('%PDF');
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(canvas).toHaveAttribute('aria-label', 'Walk through room');
  await expect(page.getByRole('button', { name: 'Walk', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await canvas.focus();
  await changesView(page, () => page.keyboard.press('a', { delay: 150 }), 'Walking resumes after PDF capture');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Free cam', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas).toHaveAttribute('aria-label', '3D room view');
});

test('phone Walk keeps controls in reach and supports touch navigation without a keyboard', async ({ browser, browserName }, testInfo) => {
  test.skip(browserName === 'firefox', 'Playwright does not emulate mobile Firefox.');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await readyToPlan(page);
    await page.getByRole('navigation', { name: 'Phone workspace' }).getByRole('button', { name: 'Explore', exact: true }).tap();
    const canvas = page.locator('.viewport canvas');
    const controls = page.getByRole('region', { name: 'Walk controls' });
    await expect(controls).toBeVisible();
    await expect(page.locator('.catalog-panel')).toBeHidden();
    await expect(page.locator('.walk-help-touch')).toBeVisible();
    await expect(page.locator('.walk-help-pointer')).toBeHidden();
    const box = (await controls.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(391);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    for (const button of await controls.getByRole('button').all()) {
      const target = (await button.boundingBox())!;
      expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath('phone-walk.png') });
    if (browserName === 'chromium') {
      const cdp = await context.newCDPSession(page);
      const bounds = (await canvas.boundingBox())!;
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      const gesture = async (kind: 'look' | 'pan' | 'pinch') => {
        const points = (step: number) => kind === 'look'
          ? [{ id: 1, x: x + step * 4, y }]
          : kind === 'pan'
            ? [{ id: 1, x: x - 40 + step * 3, y }, { id: 2, x: x + 40 + step * 3, y }]
            : [{ id: 1, x: x - 40 - step * 3, y }, { id: 2, x: x + 40 + step * 3, y }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) });
        for (let step = 1; step <= 12; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(step) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const scroll = await page.evaluate(() => window.scrollY);
      await changesView(page, () => gesture('look'), 'One finger looks around');
      await changesView(page, () => gesture('pan'), 'Two fingers pan');
      await changesView(page, () => gesture('pinch'), 'Pinch magnifies');
      expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
      await page.getByRole('button', { name: 'Pan', exact: true }).tap();
      await expect(page.getByRole('button', { name: 'Pan', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await changesView(page, () => gesture('look'), 'Pan tool allows a one-finger alternative');
      await cdp.detach();
    }
    await changesView(page, () => page.getByRole('button', { name: 'Zoom in', exact: true }).tap(), 'Touch zoom button magnifies');
    for (const size of [{ width: 844, height: 390 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(size);
      await expect(page.locator('.catalog-panel')).toBeHidden();
      const panel = (await controls.boundingBox())!;
      expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(size.width + 1);
      expect(panel.y + panel.height).toBeLessThanOrEqual(size.height);
      for (const button of await controls.getByRole('button').all()) {
        const target = (await button.boundingBox())!;
        expect(target.x).toBeGreaterThanOrEqual(0); expect(target.x + target.width).toBeLessThanOrEqual(size.width + 1);
      }
      await page.screenshot({ path: testInfo.outputPath(`phone-walk-${size.width}.png`) });
    }
    await page.getByRole('button', { name: /Exit walk/ }).tap();
    await expect(page.locator('[data-sheet="catalogue"]')).toBeVisible();
    await expect(controls).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
