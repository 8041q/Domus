import { test, expect, type Page } from '@playwright/test';

const sheet = (page: Page) => page.locator('[data-sheet="room"]');
const project = (page: Page) => page.getByRole('button', { name: 'Project', exact: true });
const historyPanel = (page: Page) => page.evaluate(() => Boolean(history.state?.__domusMobilePanel));

async function ready(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(project(page)).toBeEnabled();
  await expect(sheet(page)).toBeVisible();
  // Includes the effect setup/cleanup replay from the application's StrictMode.
  await expect.poll(() => historyPanel(page)).toBe(true);
}

test('phone Back dismisses only the top menu or dialog before the room sheet', async ({ page }) => {
  await ready(page);
  const url = page.url();
  await project(page).click();
  await expect(page.getByRole('menu', { name: 'Project actions' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('menu', { name: 'Project actions' })).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await expect.poll(() => historyPanel(page)).toBe(true);

  await project(page).click();
  await page.getByRole('menuitem', { name: /^New room/ }).click();
  await expect(page.getByRole('dialog', { name: 'New room' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await expect.poll(() => historyPanel(page)).toBe(true);
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => historyPanel(page)).toBe(false);
  expect(page.url()).toBe(url);
  await expect(page.getByRole('navigation', { name: 'Phone workspace' })).toBeVisible();
});

test('phone sheet replacement and responsive cleanup keep one transient history entry', async ({ page }) => {
  await ready(page);
  const historyLength = await page.evaluate(() => history.length);
  const roomTab = page.getByRole('navigation', { name: 'Phone workspace' }).getByRole('button', { name: 'Room', exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    await sheet(page).getByRole('button', { name: 'Close Room tools', exact: true }).click();
    await expect(sheet(page)).toHaveCount(0);
    await roomTab.click();
    await expect(sheet(page)).toBeVisible();
    await expect.poll(() => historyPanel(page)).toBe(true);
    await project(page).click();
    await page.getByRole('menuitem', { name: /^New room/ }).click();
    await expect(page.getByRole('dialog', { name: 'New room' })).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => historyPanel(page)).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sheet(page)).toBeVisible();
  await expect.poll(() => historyPanel(page)).toBe(true);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
});
