import { test, expect } from '@playwright/test';

test('phone numeric drafts retain valid dimensions and rotation when invalid input is committed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
  const roomSheet = page.locator('[data-sheet="room"]');
  await expect(roomSheet).toBeVisible();
  await roomSheet.locator('.mobile-sheet-handle').click();
  const height = page.getByRole('textbox', { name: 'Room height in metres' });
  await expect(height).toHaveValue('2.60');
  for (const invalid of ['not a number', '0.20', '']) {
    await height.fill(invalid); await height.blur();
    await expect(height).toHaveValue('2.60');
    await expect(height).toHaveAttribute('aria-invalid', 'true');
    await expect(roomSheet.getByRole('alert')).toBeVisible();
  }
  await height.fill('2,80'); await height.blur();
  await expect(height).toHaveValue('2.80');
  await expect(height).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(height).toHaveValue('2.60');

  await page.getByRole('navigation', { name: 'Phone workspace' }).getByRole('button', { name: 'Furniture', exact: true }).click();
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await page.getByRole('button', { name: /^3-seat sofa/ }).click();
  const selection = page.locator('[data-sheet="selection"]');
  await expect(selection).toBeVisible();
  await selection.locator('.mobile-sheet-handle').click();
  const angle = selection.locator('.angle-input input');
  await angle.fill('bad'); await angle.blur();
  await expect(angle).toHaveValue('0.0');
  await expect(angle).toHaveAttribute('aria-invalid', 'true');
  await expect(selection.getByRole('alert')).toContainText('Enter an angle');
  await angle.fill('45'); await angle.blur();
  await expect(angle).toHaveValue('45.0');
  await angle.fill('360'); await angle.blur();
  await expect(angle).toHaveValue('45.0');
  await expect(angle).toHaveAttribute('aria-invalid', 'true');
});
