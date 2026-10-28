import { readExportedRoom } from './roomFile';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:5200';
async function menu(page: Page, action: RegExp) {
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name: action }).click();
}
test('master-free public release supports transfer, approved-model extraction, architecture GLB and PDF', async ({ browser, request }, info) => {
  await expect.poll(async () => { try { return (await request.get(origin + '/api/health')).status(); } catch { return 0; } }).toBe(200);
  const catalogue = await (await request.get(origin + '/api/model-catalogue')).json();
  const product = catalogue.products[0]; expect(product).toBeTruthy();
  // A modified/old client is allowed to save the display asset. It still cannot obtain a master.
  const display = await request.get(origin + product.model.url, { headers: { 'User-Agent': 'DomusClient/0.1-modified' } });
  expect(display.status()).toBe(200); expect((await display.body()).subarray(0, 4).toString()).toBe('glTF');
  for (const path of ['/models/fixture-bed.glb', '/private/models/fixture-bed.glb', '/@fs/private/models/fixture-bed.glb', '/api/model-catalogue/rescan', '/api/model-catalogue/compact']) expect((await request.get(origin + path)).status()).toBe(404);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  try {
    const page = await context.newPage(); await page.goto(origin);
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Plan room', exact: true }).click();
    await expect(page.locator('.loading-status')).toHaveCount(0);
    await page.getByRole('button', { name: /^fixture-bed/ }).click();
    await expect(page.locator('.loading-status')).toHaveCount(0);
    await menu(page, /^Save/); await page.getByRole('textbox', { name: 'Room name', exact: true }).fill('Public transfer');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const downloaded = page.waitForEvent('download'); await menu(page, /^Export room/);
    const transfer = await downloaded;
    expect(transfer.suggestedFilename()).toMatch(/\.glb$/);
    const file = await transfer.path();
    const document = await readExportedRoom(file!);
    expect(document.version).toBe(3); expect(document.products[0].hash).toBeNull();
    expect(document.snapshot.objects).toHaveLength(1);
    const other = await fresh.newPage(); await other.goto(origin);
    await expect(other.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
    await other.getByLabel('Import Domus draft').setInputFiles(file!);
    await expect(other.locator('.project-status')).toContainText('Public transfer');
    await other.getByRole('navigation', { name: 'Phone workspace' }).getByRole('button', { name: 'Furniture', exact: true }).click();
    await expect(other.locator('.loading-status')).toHaveCount(0);
    for (const [action, signature] of [[/^Export room/, 'glTF'], [/^Export to PDF/, '%PDF']] as const) {
      const event = other.waitForEvent('download'); await menu(other, action);
      const name = info.outputPath(signature === 'glTF' ? 'public-architecture.glb' : 'public-report.pdf'); await (await event).saveAs(name);
      const bytes = await readFile(name); expect(bytes.subarray(0, 4).toString()).toBe(signature);
      if (signature === 'glTF') {
        const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
        expect(gltf.nodes.some((node: { name?: string }) => /Furniture|fixture-bed/.test(node.name ?? ''))).toBe(false);
        expect(gltf.nodes.some((node: { name?: string }) => node.name === 'Frames')).toBe(true);
      }
      await expect(other.locator('.loading-status')).toHaveCount(0);
    }
  } finally { await context.close(); await fresh.close(); }
});
