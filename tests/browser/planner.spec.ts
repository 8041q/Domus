import { readExportedRoom } from './roomFile';
import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
}
async function menu(page: Page, name: string | RegExp) {
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name }).click();
}
async function plan(page: Page) {
  await page.getByRole('button', { name: 'Plan room', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Catalogue', exact: true })).toBeVisible();
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(page.locator('canvas')).toBeVisible();
}
async function save(page: Page, name: string) {
  await menu(page, /^Save/);
  await expect(page.locator('.project-progress')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Room name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.project-progress')).toHaveCount(0);
  await expect(page.locator('.project-status')).toContainText(name);
  await expect(page.locator('.project-status')).toContainText('Saved in this browser');
}
async function layout(page: Page) {
  const downloaded = page.waitForEvent('download'); await menu(page, /^Export room/);
  const document = await readExportedRoom((await (await downloaded).path())!);
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('data-loading-locked', 'true');
  return document.snapshot;
}

test('room editing, typed values, named saving, undo and recovery survive reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await page.getByRole('button', { name: 'L-shape', exact: true }).click();
  await page.getByRole('textbox', { name: 'Room height in metres' }).fill('3.10');
  await save(page, 'Browser room');
  await page.reload();
  await expect(page.locator('.project-status')).toContainText('Browser room');
  await expect(page.getByRole('textbox', { name: 'Room height in metres' })).toHaveValue('3.10');
  await plan(page);
  await page.getByRole('button', { name: /^3-seat sofa/ }).click();
  await page.getByRole('button', { name: '90° right', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select 3-seat sofa' })).toBeVisible();
  await save(page, 'Browser furnished');
  await page.reload(); await plan(page);
  await expect(page.getByRole('button', { name: 'Select 3-seat sofa' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('reference room reopens its retained model after the source is removed', async ({ page, browser, request }) => {
  await ready(page); await plan(page);
  await page.getByRole('button', { name: /^fixture-bed/ }).click();
  await save(page, 'Portable fixture');
  const downloadEvent = page.waitForEvent('download');
  await menu(page, /^Export room/);
  await expect(page.locator('.project-progress')).toHaveCount(0);
  const download = await downloadEvent; const filename = await download.path(); expect(filename).toBeTruthy();
  const { root } = JSON.parse(await readFile(path.join(os.tmpdir(), 'domus-browser-5199.json'), 'utf8'));
  const source = path.join(root, 'public', 'models', 'fixture-bed.glb'), bytes = await readFile(source);
  const fresh = await browser.newContext({ acceptDownloads: true });
  try {
    await unlink(source); await request.post('/api/model-catalogue/rescan');
    const other = await fresh.newPage(); await ready(other);
    await other.getByLabel('Import Domus draft').setInputFiles(filename!);
    await expect(other.locator('.project-status')).toContainText('Portable fixture');
    await plan(other);
    await expect(other.getByRole('button', { name: 'Select fixture-bed' })).toBeVisible();
    await expect(other.getByText(/Could not load fixture-bed/)).toHaveCount(0);
    await expect(other.getByRole('button', { name: /^fixture-bed/ })).toHaveCount(0);
    await save(other, 'Transferred fixture');
    await other.reload(); await plan(other);
    await expect(other.getByRole('button', { name: 'Select fixture-bed' })).toBeVisible();
  } finally { await fresh.close(); await writeFile(source, bytes); await request.post('/api/model-catalogue/rescan'); }
});

test('malformed imports preserve the active room and unsaved-change dialogs protect replacement', async ({ page }) => {
  await ready(page); await save(page, 'Protected');
  await page.getByRole('textbox', { name: 'Room height in metres' }).fill('2.90');
  await page.getByRole('textbox', { name: 'Room height in metres' }).blur();
  await menu(page, /^New room/);
  await page.getByRole('textbox', { name: 'Room name', exact: true }).fill('Replacement');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Room height in metres' })).toHaveValue('2.90');
  await page.getByLabel('Import Domus draft').setInputFiles({ name: 'broken.domus.json', mimeType: 'application/json', buffer: Buffer.from('{"room":{}}') });
  await expect(page.getByRole('alert')).toContainText(/invalid|valid|undefined/i);
  await expect(page.locator('.project-status')).toContainText('Protected');
});

test('PDF retains furniture while GLB exports architecture only and preserves the editor', async ({ page }, testInfo) => {
  await ready(page); await plan(page); await page.getByRole('button', { name: /^3-seat sofa/ }).click();
  for (const [action, signature] of [[/^Export room/, 'glTF'], [/^Export to PDF/, '%PDF']] as const) {
    const downloaded = page.waitForEvent('download'); await menu(page, action);
    const download = await downloaded;
    const filename = testInfo.outputPath(signature === '%PDF' ? 'room-report.pdf' : 'room.glb');
    await download.saveAs(filename);
    const exported = await readFile(filename!);
    expect(exported.subarray(0, 4).toString()).toBe(signature);
    if (signature === 'glTF') {
      const document = JSON.parse(exported.subarray(20, 20 + exported.readUInt32LE(12)).toString());
      expect(document.nodes.some((node: { name?: string }) => /Furniture|sofa/i.test(node.name ?? ''))).toBe(false);
      expect(document.nodes.some((node: { name?: string }) => node.name === 'Walls')).toBe(true);
    }
    await expect(page.locator('.loading-status')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Select 3-seat sofa' })).toBeVisible();
  }
});

test('PDF export handles a small room with adjacent short and angled sides', async ({ page }, testInfo) => {
  await ready(page);
  const snapshot = await layout(page);
  snapshot.room = { ...snapshot.room, width: 2.4, depth: 2.2, shapeKind: 'custom', vertices: [
    { id: 'v0', x: 0, z: 0 }, { id: 'v1', x: 1.3, z: 0 }, { id: 'v2', x: 2.4, z: 1.1 },
    { id: 'v3', x: 2.4, z: 2.2 }, { id: 'v4', x: 0, z: 2.2 }
  ] };
  snapshot.objects = []; snapshot.unplacedObjects = []; snapshot.openings = []; snapshot.spaces = [];
  await page.getByLabel('Import Domus draft').setInputFiles({ name: 'small-angled.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'domus-room', version: 1, name: 'Small angled room', snapshot })) });
  await expect(page.locator('.project-status')).toContainText('Small angled room');
  await plan(page);
  const downloaded = page.waitForEvent('download'); await menu(page, /^Export to PDF/);
  const filename = testInfo.outputPath('small-angled-report.pdf');
  await (await downloaded).saveAs(filename);
  expect((await readFile(filename)).subarray(0, 4).toString()).toBe('%PDF');
  await expect(page.locator('.loading-status')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Catalogue', exact: true })).toBeVisible();
});

test('view switches, finishes and keyboard dialogs remain usable at desktop sizes', async ({ page }) => {
  await ready(page); await page.setViewportSize({ width: 1280, height: 720 });
  for (let i = 0; i < 4; i++) {
    await plan(page);
    await page.getByRole('button', { name: 'Top', exact: true }).click();
    await page.getByRole('button', { name: 'Build room', exact: true }).click();
    await expect(page.getByLabel('Editable room floor plan', { exact: true })).toBeVisible();
  }
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.project-progress')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Room name', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('local runtime rejects foreign AI calls, wrong content types, missing assets and unknown hosts', async ({ request }) => {
  expect((await request.get('/api/health')).status()).toBe(200);
  expect((await request.get('/internal/architecture/openings/not-present.glb')).status()).toBe(404);
  expect((await request.get('/src/store.ts')).status()).toBe(404);
  expect((await request.get('/', { headers: { Host: 'other.example:5199' } })).status()).toBe(403);
  expect((await request.post('/api/ai/turn', { headers: { Origin: 'https://other.example' }, data: {} })).status()).toBe(403);
  expect((await request.post('/api/ai/turn', { headers: { 'Content-Type': 'text/plain' }, data: '{}' })).status()).toBe(415);
});

test('opening dimensions round trip and furniture drags commit one undoable move', async ({ page }) => {
  await ready(page);
  await page.getByRole('combobox', { name: 'Selected opening' }).selectOption('window-1');
  await page.getByLabel('Width in metres', { exact: true }).fill('1.60');
  await page.getByLabel('Width in metres', { exact: true }).press('Enter');
  await save(page, 'Openings'); await page.reload();
  await page.getByRole('combobox', { name: 'Selected opening' }).selectOption('window-1');
  await expect(page.getByLabel('Width in metres', { exact: true })).toHaveValue('1.60');
  await plan(page); await page.getByRole('button', { name: /^3-seat sofa/ }).click();
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  const before = await layout(page);
  const viewport = await page.locator('.viewport canvas').boundingBox(); expect(viewport).toBeTruthy();
  const x = viewport!.x + viewport!.width / 2, y = viewport!.y + viewport!.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 90, y + 40, { steps: 10 }); await page.mouse.up();
  const moved = await layout(page);
  expect([moved.objects[0].x, moved.objects[0].z]).not.toEqual([before.objects[0].x, before.objects[0].z]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undone = await layout(page); expect(undone.objects).toEqual(before.objects);
  await page.getByRole('button', { name: 'Room finishes', exact: true }).click();
  await page.getByRole('button', { name: 'Wood Floor 057', exact: true }).click();
  expect((await layout(page)).room.floorFinish).toBe('wood-floor-057');
});

test('duplicated tabs get independent recovery identities and cannot overwrite stale saves', async ({ page, context }) => {
  await ready(page); await save(page, 'Two tabs');
  const opened = page.waitForEvent('popup'); await page.evaluate(() => window.open(location.href, '_blank'));
  const other = await opened;
  await expect(other.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
  expect(await other.evaluate(() => sessionStorage.getItem('domus-tab-id'))).not.toBe(await page.evaluate(() => sessionStorage.getItem('domus-tab-id')));
  await menu(other, /^Open saved room/); await other.getByRole('button', { name: /^Two tabs/ }).click();
  await expect(other.locator('.project-status')).toContainText('Two tabs');
  await page.getByLabel('Room height in metres').fill('3.00'); await save(page, 'Two tabs');
  await other.getByLabel('Room height in metres').fill('3.10');
  await menu(other, /^Save/); await expect(other.locator('.project-progress')).toHaveCount(0);
  await other.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('another tab');
  await other.close();
});
