import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { emptyRoomSnapshot, parseProjectSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { roomReportData } = await vite.ssrLoadModule('/src/core/roomReport.ts');
const { roomViewSummary, coverageArea } = await vite.ssrLoadModule('/src/core/roomReportGeometry.ts');
const { getRoomWalls, roomBounds } = await vite.ssrLoadModule('/src/core/roomGeometry.ts');
const { normalizeProjectDetails } = await vite.ssrLoadModule('/src/core/projectDetails.ts');
const { ReportDocument, wrapReportText } = await vite.ssrLoadModule('/src/core/reportLayout.ts');
const { drawReportPlanKey } = await vite.ssrLoadModule('/src/core/roomReportViews.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');

test('reports distinguish entered real-life sizes, geometry fallbacks and catalogue sizes without changing placement', () => {
  const snapshot = emptyRoomSnapshot();
  const product = { id: 'bed', name: 'Bed', category: 'Hospital Bed', width: 1, depth: 1.5, height: 0.5, displayDimensions: { width: 1.2, depth: 2.1, height: 0.9 }, model: { url: '/bed.glb' } };
  snapshot.objects = [{ id: 'a', productId: 'bed', x: 1.5, z: 2, rotationY: -Math.PI / 2 }];
  snapshot.unplacedObjects = [{ id: 'b', productId: 'bed' }, { id: 'c', productId: 'bed' }];
  const before = structuredClone(snapshot), report = roomReportData(snapshot, { bed: product });
  assert.equal(report.furniture[0].dimensions, '1.20 × 2.10 × 0.90');
  assert.equal(report.furniture[0].geometryDimensions, '1.00 × 1.50 × 0.50');
  assert.equal(report.furniture[0].dimensionSource, 'Real-life dimensions');
  assert.deepEqual(report.furniture.map((item) => [item.quantity, item.status]), [[1, 'In room'], [2, 'Not placed']]);
  assert.equal(report.instances[0].rotation, 270); assert.deepEqual(snapshot, before);
  const noEntered = { ...product, displayDimensions: undefined };
  assert.equal(roomReportData(snapshot, { bed: noEntered }).furniture[0].dimensionSource, 'Real-life size not supplied');
  assert.equal(roomReportData(snapshot, { bed: { ...noEntered, model: undefined } }).furniture[0].dimensionSource, 'Catalogue dimensions');
  assert.equal(roomReportData(snapshot, {}).furniture[0].dimensions, 'Unavailable');
});

test('legacy metadata defaults are blank, new fields validate and preserve imports', () => {
  const details = normalizeProjectDetails({ company: 'Example', notes: 'Notes' });
  for (const key of ['revision', 'status', 'roomPurpose', 'location']) assert.equal(details[key], '');
  assert.throws(() => normalizeProjectDetails({ status: 'Anything' }), /status/);
  assert.throws(() => normalizeProjectDetails({ roomPurpose: 'x'.repeat(121) }), /purpose/);
  const snapshot = emptyRoomSnapshot(); snapshot.room.projectDetails = { ...details, revision: 'R3', status: 'Approved', roomPurpose: 'Patient room', location: 'Ward 2' };
  assert.deepEqual(parseProjectSnapshot(snapshot).room.projectDetails, snapshot.room.projectDetails);
});

test('clipped overlapping apertures deduct a union area and are counted once on a wall', () => {
  const snapshot = emptyRoomSnapshot(), wall = getRoomWalls(snapshot.room)[0];
  snapshot.openings = [
    { id: 'a', type: 'opening', variant: 'wall-opening', wallId: wall.id, offset: 1, width: 2, height: 1.5, sillHeight: 0 },
    { id: 'b', type: 'window', variant: 'single-window', wallId: wall.id, offset: 1.5, width: 2, height: 2, sillHeight: 0.5 }
  ];
  const view = roomViewSummary(snapshot, 'front', [wall.id]);
  // Areas 3 + 4 minus their shared 1.5 × 1 rectangle.
  assert.equal(view.netArea, wall.length * snapshot.room.height - 5.5);
  assert.equal(view.openingCount, 2); assert.equal(view.length, wall.length); assert.equal(view.span, wall.length);
  snapshot.openings[1].sillHeight = 2.5;
  assert.ok(roomViewSummary(snapshot, 'front', [wall.id]).netArea >= 0);
  assert.equal(coverageArea([{ start: 0, end: 2, bottom: 0, top: 2 }, { start: 0, end: 2, bottom: 0, top: 2 }]), 4);
});

test('circular boundary runs wrap the perimeter, merge aperture pieces and distinguish length from span', () => {
  const snapshot = emptyRoomSnapshot('circle'), walls = getRoomWalls(snapshot.room);
  const runIds = [...walls.slice(28), ...walls.slice(0, 8)].map((wall) => wall.id);
  snapshot.openings = [{ id: 'across-zero', type: 'opening', variant: 'wall-opening', wallId: walls[0].id, offset: 0, width: 1.2, height: 1, sillHeight: 0.5 }];
  const summary = roomViewSummary(snapshot, 'front', runIds);
  assert.equal(summary.boundaries.length, 1); assert.equal(summary.openingCount, 1);
  assert.equal(summary.boundaries[0].openings.length, 1);
  assert.ok(Math.abs(summary.boundaries[0].openings[0].end - summary.boundaries[0].openings[0].start - 1.2) < 1e-7);
  assert.ok(Math.abs(summary.grossArea - summary.netArea - 1.2) < 1e-7);
  assert.ok(summary.length > summary.span);
  const disjoint = roomViewSummary(snapshot, 'left', [walls[0].id, walls[4].id]);
  assert.equal(disjoint.boundaries.length, 2);
  assert.deepEqual(new Set(disjoint.hiddenWallIds), new Set([walls[0].id, walls[4].id]));
});

test('fixed-view summaries consume actual renderer cutaways for rectangle, circle, angled and recessed rooms', () => {
  for (const shape of ['rectangle', 'circle', 'angled-corner', 'recess']) {
    const snapshot = emptyRoomSnapshot(shape), bounds = roomBounds(snapshot.room.vertices);
    const scene = Object.create(PlannerScene.prototype);
    Object.assign(scene, { sceneSnapshot: () => snapshot, options: {}, currentCameraView: 'front', wallHiddenState: new Map(),
      wallsGroup: new THREE.Group(), floorGroup: new THREE.Group(), architecturalShadeGroup: new THREE.Group(), updateInteriorWallView: () => {},
      camera: { position: new THREE.Vector3((bounds.minX + bounds.maxX) / 2, snapshot.room.height / 2, bounds.minZ - 10) } });
    for (const [view, x, z] of [['front', (bounds.minX + bounds.maxX) / 2, bounds.minZ - 10], ['right', bounds.maxX + 10, (bounds.minZ + bounds.maxZ) / 2],
      ['back', (bounds.minX + bounds.maxX) / 2, bounds.maxZ + 10], ['left', bounds.minX - 10, (bounds.minZ + bounds.maxZ) / 2]]) {
      scene.camera.position.set(x, snapshot.room.height / 2, z); scene.currentCameraView = view; scene.updateCutawayWalls(true);
      const hidden = [...scene.wallHiddenState].filter(([, value]) => value).map(([id]) => id);
      const summary = roomViewSummary(snapshot, view, hidden);
      assert.deepEqual(new Set(summary.hiddenWallIds), new Set(hidden));
      assert.ok(summary.length > 0); assert.ok(summary.netArea >= 0 && summary.netArea <= summary.grossArea);
    }
  }
});

function recordingCanvas() {
  const operations = [], ctx = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'top', path: [],
    measureText: (value) => ({ width: value.length * 12 }),
    fillText(text, x, y) { operations.push({ kind: 'text', text, x, y }); },
    fillRect(x, y, width, height) { operations.push({ kind: 'fill', x, y, width, height, fill: this.fillStyle }); },
    strokeRect(x, y, width, height) { operations.push({ kind: 'border', x, y, width, height }); },
    beginPath() { this.path = []; }, moveTo(x, y) { this.path.push([x, y]); }, lineTo(x, y) { this.path.push([x, y]); },
    stroke() { operations.push({ kind: 'path', points: [...this.path], width: this.lineWidth }); }, closePath() {}, fill() {}, arc() {}, save() {}, restore() {} };
  return { getContext: () => ctx, operations };
}

test('banded multiline rows share exact borders, repeat headings and continue their stripe sequence across pages', () => {
  const doc = new ReportDocument('Pagination test', recordingCanvas);
  const rows = Array.from({ length: 43 }, (_, i) => [`Item ${i}\nSecond line ${i}`, `Long address ${i} and additional words for wrapping`]);
  doc.table('Furniture list', ['Model', 'Description'], [600, 1060], rows);
  assert.ok(doc.pages.length >= 3);
  let stripe = 0;
  for (const page of doc.pages) {
    const fills = page.operations.filter((op) => op.kind === 'fill' && op.width === 1660);
    assert.equal(fills[0].fill, '#e9e9ee');
    for (const row of fills) {
      const borders = page.operations.filter((op) => op.kind === 'border' && op.y === row.y);
      assert.equal(borders.length, 2); assert.equal(borders[0].x + borders[0].width, borders[1].x);
      assert.ok(borders.every((border) => border.height === row.height));
      assert.ok(row.y + row.height <= 1145);
      if (row.fill !== '#e9e9ee') assert.equal(row.fill, stripe++ % 2 ? '#f5f5f8' : '#ffffff');
    }
    for (const text of page.operations.filter((op) => op.kind === 'text' && /^(Item |Second line |Long address)/.test(op.text))) {
      const row = fills.find((fill) => text.y >= fill.y && text.y < fill.y + fill.height);
      assert.ok(row); assert.ok(text.y + 23 <= row.y + row.height - 10);
    }
  }
  assert.equal(stripe, 43);
  assert.deepEqual(wrapReportText({ measureText: (value) => ({ width: value.length }) }, 'word one two', 8), ['word one', 'two']);
  assert.deepEqual(wrapReportText({ measureText: (value) => ({ width: value.length }) }, 'abcdefghij', 4), ['abcd', 'efgh', 'ij']);
});

test('plan diagram highlighted paths are drawn from exactly the measured boundary runs', () => {
  const snapshot = emptyRoomSnapshot('recess'), walls = getRoomWalls(snapshot.room);
  const summary = roomViewSummary(snapshot, 'front', [walls[0].id, walls[3].id]);
  const canvas = recordingCanvas(); drawReportPlanKey(canvas.getContext(), snapshot.room.vertices, summary, 0, 0, 340, 300);
  const highlights = canvas.operations.filter((op) => op.kind === 'path' && op.width === 6);
  assert.equal(highlights.length, summary.boundaries.length);
  highlights.forEach((line, i) => assert.equal(line.points.length, summary.boundaries[i].walls.length + 1));
});

test('a failed PDF capture restores camera, render size, helper visibility and controls', async () => {
  const snapshot = emptyRoomSnapshot(), camera = new THREE.PerspectiveCamera(37, 4 / 3, 0.2, 150);
  camera.position.set(4, 6, 7); camera.layers.enable(1);
  const renderer = { ratio: 2, size: [800, 600], getPixelRatio() { return this.ratio; }, setPixelRatio(value) { this.ratio = value; },
    getSize(target) { return target.set(...this.size); }, setSize(x, y) { this.size = [x, y]; }, render() { throw new Error('GPU capture failed'); } };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { floorTextureReady: Promise.resolve(), spaceFloorReady: [], productModelRequests: new Map(), productModelErrors: new Map(),
    disposed: false, bridge: { getSnapshot: () => snapshot }, sceneSnapshot: () => snapshot, renderer, camera,
    controls: { target: new THREE.Vector3(2, 1, 3), maxDistance: 30, enableDamping: true, enabled: true, update() {} },
    helperGroup: { visible: true }, currentCameraView: 'free', scene: {}, updateCameraClipping() {}, updateCeilingVisibility() {}, updateCutawayWalls() {}, requestRender() {},
    setCameraView(view) { this.currentCameraView = view; this.camera.position.set(0, 30, 3); this.controls.target.set(2, 1, 2); } });
  const before = { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), layers: camera.layers.mask, target: scene.controls.target.toArray() };
  await assert.rejects(scene.exportPDF('Test room'), /GPU capture failed/);
  assert.deepEqual(camera.position.toArray(), before.position); assert.deepEqual(camera.quaternion.toArray(), before.quaternion);
  assert.equal(camera.layers.mask, before.layers); assert.equal(camera.aspect, 4 / 3); assert.equal(camera.fov, 37);
  assert.deepEqual(scene.controls.target.toArray(), before.target); assert.equal(scene.controls.enabled, true);
  assert.equal(scene.controls.enableDamping, true); assert.equal(scene.helperGroup.visible, true); assert.equal(scene.currentCameraView, 'free');
  assert.deepEqual(renderer.size, [800, 600]); assert.equal(renderer.ratio, 2);
});
