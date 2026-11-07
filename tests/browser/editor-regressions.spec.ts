import { expect, test, type Locator, type Page } from '@playwright/test';

async function editSlider(slider: Locator) {
  const initial = await slider.inputValue();
  const box = (await slider.boundingBox())!;
  await slider.focus();
  await slider.click({ position: { x: Math.round(box.width * 0.72), y: Math.round(box.height / 2) } });
  const pointerValue = await slider.inputValue();
  expect(pointerValue).not.toBe(initial);
  // WebKit can blur the range on mouse release. Keep the existing focus where supported.
  if (!(await slider.evaluate(node => document.activeElement === node))) await slider.focus();
  await slider.press('ArrowLeft');
  expect(await slider.inputValue()).not.toBe(pointerValue);
  return { initial, pointerValue };
}

async function openPlanner(page: Page) {
  await page.getByRole('button', { name: 'Plan room', exact: true }).click();
  await expect(page.locator('.viewport canvas')).toBeVisible();
  await expect(page.locator('.loading-status')).toHaveCount(0);
}

test('opening position and furniture rotation retain separate pointer and keyboard undo steps', async ({ page }) => {
  await page.goto('/');
  const selectOpening = () => page.getByRole('combobox', { name: 'Selected opening' }).selectOption('window-1');
  const openingSlider = page.locator('.opening-editor input[type="range"]').first();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await selectOpening();
  const opening = await editSlider(openingSlider);
  await undo.click(); await selectOpening();
  await expect(openingSlider).toHaveValue(opening.pointerValue);
  await undo.click(); await selectOpening();
  await expect(openingSlider).toHaveValue(opening.initial);

  await openPlanner(page);
  await page.getByRole('button', { name: /^3-seat sofa/ }).click();
  const selectSofa = () => page.getByRole('button', { name: 'Select 3-seat sofa', exact: true }).click();
  const rotationSlider = page.getByRole('slider', { name: 'Furniture rotation in degrees' });
  const rotation = await editSlider(rotationSlider);
  await undo.click(); await selectSofa();
  await expect(rotationSlider).toHaveValue(rotation.pointerValue);
  await undo.click(); await selectSofa();
  await expect(rotationSlider).toHaveValue(rotation.initial);
});

test('Sun Light and lighting undo keep the active 3D canvas', async ({ page }) => {
  await page.goto('/');
  await openPlanner(page);
  const canvas = (await page.locator('.viewport canvas').elementHandle())!;
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  const sunlight = page.getByRole('checkbox', { name: 'Sun Light', exact: true });
  const slider = page.getByRole('slider', { name: 'Sun height angle' });
  const { initial, pointerValue } = await editSlider(slider);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.click(); await expect(slider).toHaveValue(pointerValue);
  await undo.click(); await expect(slider).toHaveValue(initial);

  await sunlight.uncheck();
  await expect(slider).toBeDisabled();
  await undo.click();
  await expect(sunlight).toBeChecked();
  await expect(slider).toBeEnabled();
  expect(await canvas.evaluate(node => node.isConnected)).toBe(true);
});
