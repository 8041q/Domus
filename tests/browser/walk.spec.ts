import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function readyToPlan(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Plan room', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Catalogue', exact: true })).toBeVisible();
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(page.locator('.viewport canvas')).toBeVisible();
}

async function layout(page: Page) {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Download layout only/ }).click();
  const filename = await (await downloaded).path();
  return JSON.parse(await readFile(filename!, 'utf8')).snapshot;
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
  await expect(page.getByRole('note', { name: 'Walk controls' })).toBeVisible();
  await expect(canvas).toHaveAttribute('aria-label', 'Walk through room');
  await expect(canvas).toBeFocused();
  await expect(page.locator('.selection-panel')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('walk-view.png') });

  await changesView(page, () => page.keyboard.press('w', { delay: 220 }), 'W walks forward');
  await changesView(page, () => page.keyboard.press('ArrowRight', { delay: 220 }), 'Arrow keys move across the floor');
  await changesView(page, () => dragView(page, 'left', 90, 30), 'Left drag looks around');
  await changesView(page, () => dragView(page, 'right', 55, 15), 'Right drag moves across the floor');
  await changesView(page, () => page.mouse.wheel(0, 200), 'Wheel walks backward');
  for (const key of ['r', 'x', 'Delete', 'Backspace']) await page.keyboard.press(key);
  await expect(canvas).toBeVisible();
  const walked = await layout(page);
  expect(walked).toEqual(before);

  await canvas.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Free cam', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('note', { name: 'Walk controls' })).toHaveCount(0);
  await expect(canvas).toHaveAttribute('aria-label', '3D room view');
  await expect(page.locator('.selection-panel')).toBeVisible();

  await walk.click();
  await page.getByRole('button', { name: /Exit walk/ }).click();
  await expect(walk).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('note', { name: 'Walk controls' })).toHaveCount(0);

  await walk.click();
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Top', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas).toHaveAttribute('aria-label', '3D room view');
  await expect(page.getByRole('note', { name: 'Walk controls' })).toHaveCount(0);
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
