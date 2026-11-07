import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readExportedRoom } from './roomFile';

test.skip(process.env.VITE_DOMUS_INTERIOR_WALLS !== '1', 'Requires the interior walls build.');

test('draws a physical divider, edits its spaces and exports them through a saved room', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const project = page.getByRole('button', { name: 'Project', exact: true });
  await expect(project).toBeEnabled();
  await page.getByRole('button', { name: 'Fit room', exact: true }).click();
  const plan = page.getByLabel('Editable room floor plan', { exact: true });
  const box = await plan.boundingBox();
  expect(box).toBeTruthy();
  const { x, y, width, height } = box!;
  // The initial room is 5.2 × 3.8 m and the Fit room control centres it.
  const scale = Math.max(6, Math.min(180, (width - 128) / 5.2, (height - 128) / 3.8));
  await page.getByLabel('Draw a division').getByRole('button', { name: 'Wall', exact: true }).click();
  await page.mouse.click(x + width / 2, y + height / 2 - 1.9 * scale);
  await page.mouse.click(x + width / 2, y + height / 2 + 1.9 * scale);
  const spaces = page.locator('.space-list button');
  await expect(spaces).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(spaces).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(spaces).toHaveCount(2);

  await page.getByRole('button', { name: 'Plan room', exact: true }).click();
  const picker = page.getByRole('button', { name: /^Editing space:/ });
  await expect(picker).toBeVisible();
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await page.getByRole('button', { name: 'Walls down', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Walls down', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Room finishes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Space name' }).fill('Reception');
  await page.getByRole('region', { name: 'Floor finish' }).getByRole('button', { name: /Terrazzo/ }).first().click();
  await picker.click();
  const spaceList = page.getByRole('listbox', { name: 'Editing space' });
  await expect(spaceList.getByRole('option')).toHaveCount(2);
  await spaceList.getByRole('option', { name: 'Reception', exact: true }).press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Space name' }).fill('Consultation');
  await expect(picker).toHaveAccessibleName('Editing space: Consultation');

  await project.click();
  await page.getByRole('menuitem', { name: /^Save/ }).click();
  await page.getByRole('textbox', { name: 'Room name' }).fill('Two spaces');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.project-status')).toContainText('Saved in this browser');
  await page.reload();
  await expect(page.locator('.project-status')).toContainText('Two spaces');
  await expect(spaces).toHaveCount(2);
  await expect(spaces.filter({ hasText: 'Reception' })).toBeVisible();
  await expect(spaces.filter({ hasText: 'Consultation' })).toBeVisible();

  const download = page.waitForEvent('download');
  await project.click();
  await page.getByRole('menuitem', { name: /^Export room/ }).click();
  const file = (await (await download).path())!;
  const room = await readExportedRoom(file);
  expect(room.snapshot.dividers).toHaveLength(1);
  expect(room.snapshot.dividers[0].kind).toBe('wall');
  expect(room.snapshot.spaces.find((space: { name: string }) => space.name === 'Reception').floorFinish).toMatch(/^terrazzo-/);
  const glb = await readFile(file);
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  expect(gltf.nodes.some((node: { name?: string }) => node.name?.startsWith('Interior wall'))).toBe(true);
});
