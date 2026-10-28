import { test, expect, type Page } from '@playwright/test';

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Phone workspace' });

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`touch controls stay reachable at ${viewport.width}×${viewport.height}`, async ({ browser, browserName }) => {
    test.skip(browserName === 'firefox', 'Touch emulation is unavailable in Firefox.');
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await page.goto('http://127.0.0.1:5199');
      await expect(navigation(page)).toBeVisible();
      await page.getByRole('button', { name: '3D', exact: true }).tap();
      const reset = page.getByRole('button', { name: 'Reset view', exact: true });
      const resetBox = (await reset.boundingBox())!;
      const viewSwitch = (await page.getByRole('button', { name: '3D', exact: true }).boundingBox())!;
      expect(Math.abs(resetBox.y + resetBox.height / 2 - viewSwitch.y - viewSwitch.height / 2)).toBeLessThanOrEqual(1);
      expect(resetBox.x).toBeGreaterThanOrEqual(viewSwitch.x + viewSwitch.width);
      expect(resetBox.x + resetBox.width).toBeLessThanOrEqual(viewport.width);
      await reset.tap();
      await navigation(page).getByRole('button', { name: 'Furniture', exact: true }).tap();
      await expect(page.locator('.loading-status')).toHaveCount(0);
      const catalogue = page.locator('[data-sheet="catalogue"]');
      await expect(catalogue).toBeVisible();
      await page.getByRole('button', { name: 'View', exact: true }).tap();
      const viewButton = (await page.getByRole('button', { name: 'View', exact: true }).boundingBox())!;
      const viewMenu = (await page.locator('.mobile-view-menu').boundingBox())!;
      expect(Math.abs(viewMenu.x - viewButton.x)).toBeLessThanOrEqual(1);
      await expect(catalogue).toBeHidden();
      await page.getByRole('button', { name: 'Room finishes', exact: true }).tap();
      await expect(page.locator('[data-sheet="finishes"]')).toBeVisible();
      await expect(page.locator('.mobile-view-menu')).toHaveCount(0);
      // Dismiss View with Back without losing the underlying sheet.
      await navigation(page).getByRole('button', { name: 'Furniture', exact: true }).tap();
      await page.getByRole('button', { name: 'View', exact: true }).tap();
      await page.goBack();
      await expect(page.locator('.mobile-view-menu')).toHaveCount(0);
      await expect(catalogue).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('mobile-layout.png') });
    } finally { await context.close(); }
  });
}

test('changing responsive layout dismisses the old phone camera menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await navigation(page).getByRole('button', { name: 'Furniture', exact: true }).click();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('.mobile-view-menu')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(navigation(page)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.mobile-view-menu')).toHaveCount(0);
  await expect(page.locator('[data-sheet="catalogue"]')).toBeVisible();
});

test('a sheet swipe commits the focused draft and the next tap still resizes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const sheet = page.locator('[data-sheet="room"]');
  const handle = sheet.locator('.mobile-sheet-handle');
  await handle.click();
  const height = sheet.getByRole('textbox', { name: 'Room height in metres', includeHidden: true });
  await height.fill('2.85');
  // A touch browser can suppress click after a drag. Exercise that sequence
  // without blurring the input through a synthetic mouse press first.
  await handle.dispatchEvent('pointerdown', { pointerId: 1, button: 0, clientY: 200 });
  await handle.dispatchEvent('pointerup', { pointerId: 1, button: 0, clientY: 250 });
  await expect(sheet).toHaveClass(/mobile-sheet-peek/);
  await expect(height).not.toBeFocused();
  await handle.click();
  await expect(sheet).toHaveClass(/mobile-sheet-half/);
  await expect(height).toHaveValue('2.85');
  await handle.focus();
  await handle.press('Enter');
  await expect(sheet).toHaveClass(/mobile-sheet-expanded/);
  expect(errors).toEqual([]);
});
