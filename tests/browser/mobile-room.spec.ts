import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

type Vertex = { id: string; x: number; z: number };
type Opening = { id: string; wallId: string; width: number; height: number };
type RoomSnapshot = { room: { shapeKind: string; vertices: Vertex[] }; openings: Opening[] };
const roomSheet = (page: Page) => page.locator('[data-sheet="room"]');

async function layout(page: Page): Promise<RoomSnapshot> {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Project', exact: true }).tap();
  await page.getByRole('menuitem', { name: /^Download layout only/ }).tap();
  return JSON.parse(await readFile((await (await download).path())!, 'utf8')).snapshot;
}

async function expandRoom(page: Page) {
  const sheet = roomSheet(page);
  await expect(sheet).toBeVisible();
  if (await sheet.locator('.mobile-sheet-body').isHidden()) await sheet.locator('.mobile-sheet-handle').tap();
  if (!(await sheet.getAttribute('class'))?.includes('mobile-sheet-expanded')) await sheet.locator('.mobile-sheet-handle').tap();
  return sheet;
}

async function fitRoom(page: Page, snapshot: RoomSnapshot) {
  await page.getByRole('button', { name: 'Fit room', exact: true }).tap();
  const box = (await page.getByLabel('Editable room floor plan', { exact: true }).boundingBox())!;
  const vertices = snapshot.room.vertices;
  const minX = Math.min(...vertices.map(vertex => vertex.x)), maxX = Math.max(...vertices.map(vertex => vertex.x));
  const minZ = Math.min(...vertices.map(vertex => vertex.z)), maxZ = Math.max(...vertices.map(vertex => vertex.z));
  const scale = Math.max(6, Math.min(180, (box.width - 128) / (maxX - minX), (box.height - 128) / (maxZ - minZ)));
  return (x: number, z: number) => ({ x: box.x + box.width / 2 + (x - (minX + maxX) / 2) * scale,
    y: box.y + box.height / 2 + (z - (minZ + maxZ) / 2) * scale });
}

test('touch Room tools author shapes, walls, openings and corners with explicit actions', async ({ browser, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox does not support Playwright touch emulation.');
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5199', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Project', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Editable room floor plan', { exact: true })).toBeVisible();
    for (const button of await page.locator('.workspace-toolbar button, .plan-view-controls button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }

    let sheet = await expandRoom(page);
    await sheet.getByRole('button', { name: 'Angled corner', exact: true }).tap();
    await expect(sheet.getByRole('button', { name: 'Angled corner', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByText('Fine snap', { exact: true }).tap();
    await expect(sheet.getByRole('checkbox', { name: /Fine snap/ })).toBeChecked();
    await sheet.locator('.mobile-sheet-close').tap();
    const shaped = await layout(page);
    expect(shaped.room.vertices).toHaveLength(5);

    // Select a clear perimeter segment through the same visible canvas used by touch authors.
    const walls = shaped.room.vertices.map((start, index, vertices) => {
      const end = vertices[(index + 1) % vertices.length];
      return { id: `wall-${start.id}-${end.id}`, start, end, length: Math.hypot(end.x - start.x, end.z - start.z) };
    });
    const wall = walls.filter(candidate => !shaped.openings.some(opening => opening.wallId === candidate.id)).sort((a, b) => b.length - a.length)[0];
    let at = await fitRoom(page, shaped);
    const midpoint = at((wall.start.x + wall.end.x) / 2, (wall.start.z + wall.end.z) / 2);
    await page.touchscreen.tap(midpoint.x, midpoint.y);
    await expect(page.getByRole('region', { name: 'Wall settings tools' })).toBeVisible();
    sheet = await expandRoom(page);
    const length = sheet.getByRole('textbox', { name: 'Adjust length in metres', exact: true });
    const nextLength = (Math.ceil(wall.length * 20) + 4) / 20;
    await length.fill(nextLength.toFixed(2));
    await sheet.locator('.wall-editor .opening-editor-title').tap();
    await expect(length).toHaveValue(nextLength.toFixed(2));
    await sheet.getByRole('button', { name: 'Split wall', exact: true }).tap();
    const split = await layout(page);
    expect(split.room.vertices).toHaveLength(6);
    const splitVertex = split.room.vertices.find(vertex => !shaped.room.vertices.some(previous => previous.id === vertex.id))!;
    const firstWallId = `wall-${wall.start.id}-${splitVertex.id}`;

    await sheet.getByRole('button', { name: 'Door', exact: true }).tap();
    const openingEditor = sheet.locator('.opening-editor');
    await expect(openingEditor).toBeVisible();
    await openingEditor.getByRole('textbox', { name: 'Width in metres', exact: true }).fill('0.80');
    await openingEditor.locator('.opening-editor-title strong').tap();
    await openingEditor.getByRole('textbox', { name: 'Height in metres', exact: true }).fill('2.00');
    await openingEditor.locator('.opening-editor-title strong').tap();
    const opened = await layout(page);
    const added = opened.openings.find(opening => !split.openings.some(previous => previous.id === opening.id))!;
    expect(added.wallId).toBe(firstWallId); expect(added.width).toBe(.8); expect(added.height).toBe(2);
    await openingEditor.getByRole('button', { name: 'Remove', exact: true }).tap();
    const removed = await layout(page);
    expect(removed.openings).toEqual(split.openings);

    await sheet.locator('.mobile-sheet-close').tap();
    at = await fitRoom(page, removed);
    const corner = removed.room.vertices[0], point = at(corner.x, corner.z);
    await page.touchscreen.tap(point.x, point.y);
    await expect(page.getByRole('region', { name: 'Corner settings tools' })).toBeVisible();
    sheet = await expandRoom(page);
    const x = sheet.getByRole('textbox', { name: 'Corner X in metres', exact: true });
    const nextX = Math.round((corner.x - .1) * 100) / 100;
    await x.fill(nextX.toFixed(2)); await sheet.locator('.wall-editor .opening-editor-title').tap();
    await expect(x).toHaveValue(nextX.toFixed(2));
    const moved = await layout(page);
    expect(moved.room.vertices.find(vertex => vertex.id === corner.id)?.x).toBe(nextX);
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    expect(await layout(page)).toEqual(removed);
    await page.getByRole('button', { name: 'Redo', exact: true }).tap();
    expect(await layout(page)).toEqual(moved);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
