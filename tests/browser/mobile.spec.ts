import { readExportedRoom } from './roomFile';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Phone workspace' });
async function ready(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
  await expect(navigation(page)).toBeVisible();
}
async function project(page: Page, action: RegExp) {
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: action }).click();
}
async function snapshot(page: Page) {
  const result = page.waitForEvent('download');
  await project(page, /^Export room/);
  const document = await readExportedRoom((await (await result).path())!);
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-loading-locked', 'true');
  return document.snapshot;
}
async function expand(page: Page, id: string) {
  const sheet = page.locator(`[data-sheet="${id}"]`);
  await expect(sheet).toBeVisible();
  if (await sheet.locator('.mobile-sheet-body').isHidden()) await sheet.locator('.mobile-sheet-handle').click();
  return sheet;
}

test('phone authoring keeps the canvas visible across room, furniture, finishes and exploration', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  let bounds = (await page.locator('canvas').boundingBox())!;
  expect(bounds.y).toBeLessThan(90); expect(bounds.y + bounds.height).toBeLessThan(790);
  await expect(page.locator('body')).toHaveJSProperty('scrollHeight', 844);
  const room = await expand(page, 'room');
  page.once('dialog', dialog => dialog.accept());
  await room.getByRole('button', { name: 'L-shape', exact: true }).click();
  const height = room.getByRole('textbox', { name: 'Room height in metres' });
  await height.fill('2.85'); await height.blur();
  await room.getByRole('button', { name: /Close .* tools/ }).click();
  expect((await snapshot(page)).room.vertices).toHaveLength(6);
  await navigation(page).getByRole('button', { name: 'Furniture', exact: true }).click();
  await expect(page.locator('.loading-status')).toHaveCount(0);
  const catalogue = await expand(page, 'catalogue');
  await catalogue.getByRole('button', { name: /^3-seat sofa/ }).click();
  const item = await expand(page, 'selection');
  await item.getByRole('button', { name: '90° right', exact: true }).click();
  const furnished = await snapshot(page);
  expect(furnished.room.height).toBe(2.85); expect(furnished.objects).toHaveLength(1);
  expect(furnished.objects[0].rotationY).not.toBe(0);
  await navigation(page).getByRole('button', { name: 'Finishes', exact: true }).click();
  const finishes = await expand(page, 'finishes');
  await finishes.getByRole('button', { name: 'Wall: Warm ivory', exact: true }).click();
  expect((await snapshot(page)).room.wallColor).not.toBe(furnished.room.wallColor);
  await navigation(page).getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.locator('canvas')).toHaveAttribute('aria-label', 'Walk through room');
  await expect(page.locator('.mobile-sheet')).toHaveCount(0);
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Free cam', exact: true }).click();
  await expect(navigation(page).getByRole('button', { name: 'Explore', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('canvas')).toHaveAttribute('aria-label', '3D room view');
  for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 430, height: 932 }]) {
    await page.setViewportSize(size);
    // Landscape with a mouse can use the desktop shell; a real touch context is
    // covered separately. The narrow sizes always use compact chrome.
    if (size.width <= 820) {
      await expect(navigation(page)).toBeVisible();
      bounds = (await page.locator('canvas').boundingBox())!;
      expect(bounds.y).toBeLessThan(90); expect(bounds.width).toBeLessThanOrEqual(size.width);
      await page.screenshot({ path: info.outputPath(`mobile-${size.width}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await navigation(page).getByRole('button', { name: 'Furniture', exact: true }).click();
  expect((await snapshot(page)).objects).toEqual(furnished.objects);
  expect(errors).toEqual([]);
});

test('phone project files, local saves and Back dismissal preserve the current work', async ({ page }) => {
  await ready(page);
  await expand(page, 'room');
  await page.goBack();
  await expect(page.locator('.mobile-sheet')).toHaveCount(0);
  await expect(navigation(page)).toBeVisible();
  await project(page, /^Save/);
  await expect(page.locator('.project-progress')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Room name', exact: true }).fill('Phone room');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.project-status')).toContainText('Saved in this browser');
  await page.reload();
  await expect(page.locator('.project-status')).toContainText('Phone room');
  await project(page, /^Open saved room/);
  await page.getByRole('button', { name: /^Phone room/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.project-status')).toContainText('Phone room');
  const download = page.waitForEvent('download'); await project(page, /^Export room(?! layout)/);
  await expect(page.locator('.project-progress')).toHaveCount(0);
  const file = await (await download).path(); expect(file).toBeTruthy();
  await page.getByLabel('Import Domus draft').setInputFiles(file!);
  await expect(page.locator('.project-status')).toContainText('Phone room');
  await expect(navigation(page).getByRole('button', { name: 'Room', exact: true })).toHaveAttribute('aria-current', 'page');
  const before = await snapshot(page);
  await page.getByLabel('Import Domus draft').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"broken":true}') });
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('dialog', { name: 'Import room', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await snapshot(page)).toEqual(before);
});

test('phone project actions export PDF and GLB while retaining furniture and canvas', async ({ page }) => {
  await ready(page);
  await navigation(page).getByRole('button', { name: 'Furniture', exact: true }).click();
  await expect(page.locator('.loading-status')).toHaveCount(0);
  const catalogue = await expand(page, 'catalogue');
  await catalogue.getByRole('button', { name: /^3-seat sofa/ }).click();
  const before = await snapshot(page);
  for (const [action, signature] of [[/^Export room/, 'glTF'], [/^Export to PDF/, '%PDF']] as const) {
    const downloaded = page.waitForEvent('download'); await project(page, action);
    const file = await (await downloaded).path();
    expect((await readFile(file!)).subarray(0, 4).toString()).toBe(signature);
    await expect(page.locator('.loading-status')).toHaveCount(0);
    await expect(page.locator('canvas')).toBeVisible();
    expect(await snapshot(page)).toEqual(before);
  }
});

test('responsive chrome preserves the mounted renderer, selection and camera framing', async ({ page }) => {
  await ready(page);
  await navigation(page).getByRole('button', { name: 'Furniture', exact: true }).click();
  await expect(page.locator('.loading-status')).toHaveCount(0);
  const catalogue = await expand(page, 'catalogue');
  await catalogue.getByRole('button', { name: /^3-seat sofa/ }).click();
  await page.evaluate(() => { (window as unknown as { originalCanvas: Element | null }).originalCanvas = document.querySelector('canvas'); });
  const before = await snapshot(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(navigation(page)).toHaveCount(0);
  await expect(page.locator('.selection-panel')).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('canvas') === (window as unknown as { originalCanvas: Element }).originalCanvas)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(navigation(page)).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('canvas') === (window as unknown as { originalCanvas: Element }).originalCanvas)).toBe(true);
  expect(await snapshot(page)).toEqual(before);
});
