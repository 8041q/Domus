import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTestServer as createServer } from './helpers/vite.mjs';
import * as THREE from 'three';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { emptyRoomSnapshot, parseProjectSnapshot } = await vite.ssrLoadModule('/src/store.ts');
const { roomReportData, renderRoomReport } = await vite.ssrLoadModule('/src/core/roomReport.ts');
const { roomViewSummary, coverageArea, roomWallMeasurements } = await vite.ssrLoadModule('/src/core/roomReportGeometry.ts');
const { getRoomWalls, roomBounds } = await vite.ssrLoadModule('/src/core/roomGeometry.ts');
const { normalizeProjectDetails } = await vite.ssrLoadModule('/src/core/projectDetails.ts');
const { ReportDocument, wrapReportText } = await vite.ssrLoadModule('/src/core/reportLayout.ts');
const { loadReportFonts, loadInterfaceFonts } = await vite.ssrLoadModule('/src/core/reportFonts.ts');
const { drawReportPlanKey, renderRoomViewPages } = await vite.ssrLoadModule('/src/core/roomReportViews.ts');
const { PlannerScene } = await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');

test('reports distinguish entered real-life sizes, geometry fallbacks and catalogue sizes without changing placement', () => {
  const snapshot = emptyRoomSnapshot();
  const product = { id: 'bed', name: 'Bed', category: 'Hospital Bed', width: 1, depth: 1.5, height: 0.5, displayDimensions: { width: 1.2, depth: 2.1, height: 0.9 }, model: { url: '/bed.glb' } };
  snapshot.objects = [{ id: 'a', productId: 'bed', x: 1.5, z: 2, rotationY: -Math.PI / 2 }];
  snapshot.unplacedObjects = [{ id: 'b', productId: 'bed' }, { id: 'c', productId: 'bed' }];
  const before = structuredClone(snapshot), report = roomReportData(snapshot, { bed: product });
  assert.equal(report.furniture[0].dimensions, '2.10 × 1.20 × 0.90');
  assert.equal(report.furniture[0].geometryDimensions, '1.50 × 1.00 × 0.50');
  assert.equal(report.furniture[0].dimensionSource, 'Real-life dimensions');
  assert.deepEqual(report.furniture.map((item) => [item.quantity, item.status]), [[1, 'In room'], [2, 'Not placed']]);
  assert.equal(report.instances[0].rotation, 270); assert.deepEqual(snapshot, before);
  const noEntered = { ...product, displayDimensions: undefined };
  assert.equal(roomReportData(snapshot, { bed: noEntered }).furniture[0].dimensionSource, 'Real-life size not supplied');
  assert.equal(roomReportData(snapshot, { bed: { ...noEntered, model: undefined } }).furniture[0].dimensionSource, 'Catalogue dimensions');
  assert.equal(roomReportData(snapshot, {}).furniture[0].dimensions, 'Unavailable');
});

test('wall schedules include each physical wall once for every room shape, independent of cutaways', () => {
  for (const shape of ['rectangle', 'l-shape', 'angled-corner', 'recess', 'circle']) {
    const snapshot = emptyRoomSnapshot(shape);
    const walls = getRoomWalls(snapshot.room), rows = roomWallMeasurements(snapshot);
    assert.equal(rows.length, walls.length);
    assert.deepEqual(rows.map(row => row.walls[0].id), walls.map(wall => wall.id));
    assert.deepEqual(rows.map(row => row.label), walls.map((_, i) => `Wall ${i + 1}`));
    assert.ok(rows.every(row => row.height === snapshot.room.height));
    assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.length, 0) - walls.reduce((sum, wall) => sum + wall.length, 0)) < 1e-8);
    assert.deepEqual(roomReportData(snapshot, {}).wallMeasurements, rows);
    const view = roomViewSummary(snapshot, 'front', [walls[0].id, walls[2].id]);
    assert.deepEqual(view.boundaries.map(boundary => boundary.label), view.boundaries.map((_, i) => `Side ${i + 1}`));
  }
});

test('wall schedules include physical interior walls and deduct their openings', () => {
  const snapshot = emptyRoomSnapshot(), walls = getRoomWalls(snapshot.room);
  snapshot.dividers = [{ id: 'divider-report', kind: 'wall', start: { kind: 'perimeter', id: walls[0].id, t: .5 }, end: { kind: 'perimeter', id: walls[2].id, t: .5 } }];
  snapshot.openings = [{ id: 'interior-door', type: 'door', variant: 'single-door', wallId: 'divider-report', offset: 1, width: .9, height: 2, sillHeight: 0 }];
  const rows = roomWallMeasurements(snapshot), interior = rows.at(-1);
  assert.equal(rows.length, walls.length + 1);
  assert.equal(interior.label, 'Interior wall 1');
  assert.equal(interior.openingCount, 1);
  assert.ok(Math.abs(interior.grossArea - interior.netArea - 1.8) < 1e-8);
  assert.equal(roomReportData(snapshot, {}).openings[0].location, 'Interior wall 1');
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

test('adjacent angled walls are separate sides while collinear split walls stay together', () => {
  const snapshot = emptyRoomSnapshot('angled-corner'), walls = getRoomWalls(snapshot.room);
  for (const [view, indices] of [['front', [0, 1]], ['right', [1, 2]]]) {
    const summary = roomViewSummary(snapshot, view, indices.map(i => walls[i].id));
    assert.equal(summary.boundaries.length, 2);
    assert.deepEqual(summary.boundaries.map(side => side.walls.map(wall => wall.id)), indices.map(i => [walls[i].id]));
    assert.deepEqual(summary.boundaries.map(side => side.length), indices.map(i => walls[i].length));
    assert.ok(Math.abs(summary.length - summary.boundaries.reduce((sum, side) => sum + side.length, 0)) < 1e-8);
    assert.ok(Math.abs(summary.grossArea - summary.boundaries.reduce((sum, side) => sum + side.grossArea, 0)) < 1e-8);
  }
  const straight = emptyRoomSnapshot();
  const [a, b] = straight.room.vertices;
  straight.room.vertices.splice(1, 0, { id: 'split', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  const split = getRoomWalls(straight.room);
  const summary = roomViewSummary(straight, 'front', split.slice(0, 2).map(wall => wall.id));
  assert.equal(summary.boundaries.length, 1);
  assert.equal(summary.boundaries[0].walls.length, 2);
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
    fillText(text, x, y) { operations.push({ kind: 'text', text, x, y, fill: this.fillStyle, font: this.font }); },
    fillRect(x, y, width, height) { operations.push({ kind: 'fill', x, y, width, height, fill: this.fillStyle }); },
    strokeRect(x, y, width, height) { operations.push({ kind: 'border', x, y, width, height }); },
    beginPath() { this.path = []; }, moveTo(x, y) { this.path.push([x, y]); }, lineTo(x, y) { this.path.push([x, y]); },
    stroke() { operations.push({ kind: 'path', points: [...this.path], width: this.lineWidth, colour: this.strokeStyle }); }, closePath() {}, fill() {}, arc() {}, save() {}, restore() {} };
  return { getContext: () => ctx, operations };
}

test('short report notes stay together instead of stranding a final line on another page', () => {
  const canvases = [];
  const doc = new ReportDocument('Pagination', () => { const canvas = recordingCanvas(); canvases.push(canvas); return canvas; });
  doc.paragraph(Array(29).fill('Filler line').join('\n'));
  doc.paragraph('First closing line\nFinal closing line');
  const text = canvas => canvas.operations.filter(operation => operation.kind === 'text').map(operation => operation.text);
  assert.equal(text(canvases[0]).includes('First closing line'), false);
  assert.ok(text(canvases[1]).includes('First closing line'));
  assert.ok(text(canvases[1]).includes('Final closing line'));
});

test('report labels keep model/category together and list walls without view labels or repeated heights', () => {
  const snapshot = emptyRoomSnapshot('recess');
  snapshot.openings = [{ id: 'window', type: 'window', wallId: getRoomWalls(snapshot.room)[0].id,
    offset: 1.1, width: 1.2, height: 1.2, sillHeight: .85 }];
  snapshot.objects = [{ id: 'bed', productId: 'bed', x: 1, z: 1, rotationY: 0 }];
  const data = roomReportData(snapshot, { bed: { id: 'bed', name: 'C8c', category: 'Hospital Bed', width: .995, depth: 2.18, height: .4 } });
  assert.equal(data.furniture[0].dimensions, '2.18 × 0.995 × 0.40');
  const canvases = [], previousDocument = globalThis.document;
  globalThis.document = { createElement() { const canvas = recordingCanvas(); canvas.toDataURL = () => 'data:image/jpeg;base64,/9j/2Q=='; canvases.push(canvas); return canvas; } };
  try {
    renderRoomReport(data, 'Label regression', '2026-10-13');
    const text = canvases.flatMap(canvas => canvas.operations.filter(op => op.kind === 'text').map(op => op.text));
    assert.ok(text.includes('C8c - Hospital Bed'));
    assert.ok(text.includes('Wall Measurements'));
    const start = text.indexOf('Wall Measurements');
    const end = text.findIndex((value, i) => i > start && value.startsWith('Every perimeter'));
    const schedule = text.slice(start + 1, end);
    for (const row of data.wallMeasurements) assert.equal(schedule.filter(value => value === row.label).length, 1);
    assert.ok(text.join(' ').includes('Bottom edge above floor'));
    assert.ok(text.includes('Wall 1 · 1.10 m from segment start'));
    assert.ok(text.includes('Openings'));
    assert.equal(text.filter(value => value === 'Wall height').length, 1);
    assert.ok(!text.some(value => /Aperture|Hidden wall measurements|Front-\d|Right-\d/.test(value)));
    assert.equal(text.filter(value => value === 'Furniture list').length, 1);
    assert.ok(!text.includes('Model geometry and references'));
    assert.ok(!text.includes('Furniture placement'));
    assert.ok(!text.includes('3D handoff reference'));
  } finally {
    globalThis.document = previousDocument;
  }
});

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

test('short schedules stay together instead of splitting their last row onto another page', () => {
  const doc = new ReportDocument('Short schedule', recordingCanvas);
  doc.paragraph(Array(24).fill('Existing report content').join('\n'));
  doc.table('Openings', ['Type', 'Dimensions'], [830, 830], [['Window', '1.20 × 1.20 m'], ['Door', '.90 × 2.08 m']]);
  assert.equal(doc.pages.length, 2);
  const labels = page => page.operations.filter(op => op.kind === 'text').map(op => op.text);
  assert.ok(!labels(doc.pages[0]).includes('Window'));
  assert.ok(labels(doc.pages[1]).includes('Window') && labels(doc.pages[1]).includes('Door'));
  assert.equal(labels(doc.pages[1]).filter(text => text === 'Openings').length, 1);
});

test('plan diagram highlighted paths are drawn from exactly the measured boundary runs', () => {
  const snapshot = emptyRoomSnapshot('recess'), walls = getRoomWalls(snapshot.room);
  const summary = roomViewSummary(snapshot, 'front', [walls[0].id, walls[3].id]);
  const canvas = recordingCanvas(); drawReportPlanKey(canvas.getContext(), snapshot.room.vertices, summary, 0, 0, 340, 300);
  const highlights = canvas.operations.filter((op) => op.kind === 'path' && op.width === 6);
  assert.equal(highlights.length, summary.boundaries.length);
  highlights.forEach((line, i) => assert.equal(line.points.length, summary.boundaries[i].walls.length + 1));
  const labels = canvas.operations.filter(op => op.kind === 'text').map(op => op.text);
  assert.ok(labels.includes('Side 1') && labels.includes('Side 2'));
  assert.ok(!labels.includes('Front'));
});

test('large labels on adjacent angled sides do not overlap in the diagram', () => {
  const snapshot = emptyRoomSnapshot('angled-corner');
  snapshot.room.width = 3.2; snapshot.room.depth = 4.5;
  const { vertices } = emptyRoomSnapshot('angled-corner').room;
  snapshot.room.vertices = vertices.map(v => ({ ...v, x: v.x * 3.2 / 5.2, z: v.z * 4.5 / 3.8 }));
  const walls = getRoomWalls(snapshot.room), summary = roomViewSummary(snapshot, 'front', walls.slice(0, 2).map(wall => wall.id));
  const canvas = recordingCanvas();
  drawReportPlanKey(canvas.getContext(), snapshot.room.vertices, summary, 1390, 160, 340, 360);
  const [a, b] = canvas.operations.filter(op => op.kind === 'text' && /^Side /.test(op.text));
  assert.ok(a && b);
  const aw = canvas.getContext().measureText(a.text).width, bw = canvas.getContext().measureText(b.text).width;
  assert.ok(a.x + aw / 2 <= b.x - bw / 2 || b.x + bw / 2 <= a.x - aw / 2 || a.y + 24 <= b.y || b.y + 24 <= a.y);
  const highlights = canvas.operations.filter(op => op.kind === 'path' && op.width === 6);
  [a, b].forEach((label, i) => {
    const [start, end] = highlights[i].points, wall = summary.boundaries[i].walls[0];
    const halfWidth = canvas.getContext().measureText(label.text).width / 2;
    const distances = [label.x - halfWidth, label.x + halfWidth].flatMap(x => [label.y, label.y + 24].map(y =>
      (x - (start[0] + end[0]) / 2) * wall.inward.x + (y - (start[1] + end[1]) / 2) * wall.inward.z));
    if (Math.abs(wall.inward.x) >= Math.abs(wall.inward.z) - 1e-8) assert.ok(Math.max(...distances) <= -10 + 1e-8);
    else assert.ok(Math.min(...distances) >= 10 - 1e-8);
  });
});

test('plan labels clear every wall, other labels, the arrow and key bounds in cramped rooms', () => {
  let checked = 0;
  for (const shape of ['angled-corner', 'l-shape', 'recess', 'rounded-rectangle', 'circle']) {
    for (const aspect of [.35, .7, 1, 2.5, 5]) {
      const snapshot = emptyRoomSnapshot(shape);
      snapshot.room.vertices = snapshot.room.vertices.map(v => ({ ...v, x: v.x * aspect }));
      const walls = getRoomWalls(snapshot.room);
      const selections = shape === 'circle' || shape === 'rounded-rectangle'
        ? [walls.slice(0, Math.floor(walls.length / 2))]
        : [walls.slice(0, 2), walls.slice(1, 3), walls.filter(wall => wall.inward.z > .01), walls.filter(wall => wall.inward.z < -.01)];
      for (const selection of selections) {
        const summary = roomViewSummary(snapshot, 'front', selection.map(wall => wall.id));
        if (summary.boundaries[1]) summary.boundaries[1].label = 'Side 12';
        const canvas = recordingCanvas();
        canvas.getContext().measureText = function(text) { return { width: text.length * Number(this.font.match(/(\d+)px/)?.[1] ?? 24) / 2 }; };
        drawReportPlanKey(canvas.getContext(), snapshot.room.vertices, summary, 1390, 160, 340, 360);
        const labels = canvas.operations.filter(op => op.kind === 'text' && /^Side /.test(op.text)).map(op => ({
          left: op.x - canvas.getContext().measureText(op.text).width / 2,
          right: op.x + canvas.getContext().measureText(op.text).width / 2,
          top: op.y, bottom: op.y + Number(op.font.match(/(\d+)px/)[1])
        }));
        const context = `${shape}, aspect ${aspect}, ${selection.length} walls`;
        assert.equal(labels.length, summary.boundaries.length, context);
        const disjoint = (a, b, gap = 0) => a.right + gap <= b.left || a.left >= b.right + gap || a.bottom + gap <= b.top || a.top >= b.bottom + gap;
        const outline = canvas.operations.find(op => op.kind === 'path' && op.width === 2).points;
        labels.forEach((label, i) => {
          assert.ok(label.left >= 1394 && label.right <= 1726 && label.top >= 164 && label.bottom <= 516, context);
          assert.ok(disjoint(label, { left: 1550, right: 1570, top: 163, bottom: 188 }, 8), context);
          labels.slice(i + 1).forEach(other => assert.ok(disjoint(label, other, 8), context));
          // Sample the complete polygon, including recessed edges unrelated to
          // the named side. Checking just the side's normal missed this bug.
          outline.forEach((a, j) => {
            const b = outline[(j + 1) % outline.length], steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2);
            for (let step = 0; step <= steps; step++) {
              const x = a[0] + (b[0] - a[0]) * step / steps, y = a[1] + (b[1] - a[1]) * step / steps;
              assert.ok(x < label.left - 3.9 || x > label.right + 3.9 || y < label.top - 3.9 || y > label.bottom + 3.9, context);
            }
          });
        });
        checked++;
      }
    }
  }
  assert.equal(checked, 70);
});

test('an exceptionally crowded key keeps clear labels instead of an overlapping fallback', () => {
  const snapshot = emptyRoomSnapshot('recess');
  snapshot.room.vertices = snapshot.room.vertices.map(v => ({ ...v, x: v.x * 5 }));
  const summary = roomViewSummary(snapshot, 'front', getRoomWalls(snapshot.room).map(wall => wall.id));
  const canvas = recordingCanvas();
  canvas.getContext().measureText = function(text) { return { width: text.length * Number(this.font.match(/(\d+)px/)?.[1] ?? 24) / 2 }; };
  drawReportPlanKey(canvas.getContext(), snapshot.room.vertices, summary, 0, 0, 340, 360);
  const labels = canvas.operations.filter(op => op.kind === 'text');
  assert.ok(labels.length > 0, 'retain the labels that fit when the full set cannot fit');
  labels.forEach((a, i) => labels.slice(i + 1).forEach(b => {
    const aw = canvas.getContext().measureText(a.text).width, bw = canvas.getContext().measureText(b.text).width;
    assert.ok(a.x + aw / 2 + 8 <= b.x - bw / 2 || b.x + bw / 2 + 8 <= a.x - aw / 2 || a.y + 26 <= b.y || b.y + 26 <= a.y);
  }));
  assert.equal(canvas.operations.filter(op => op.kind === 'path' && op.width === 6).length, summary.boundaries.length);
});

test('minimap names sit close to walls, outside left/right and inside top/bottom', () => {
  const snapshot = emptyRoomSnapshot(), walls = getRoomWalls(snapshot.room);
  const summary = roomViewSummary(snapshot, 'front', walls.map(wall => wall.id));
  summary.boundaries[0].label = 'Side 12';
  const canvas = recordingCanvas();
  drawReportPlanKey(canvas.getContext(), snapshot.room.vertices, summary, 1390, 160, 340, 360);
  const highlights = canvas.operations.filter(op => op.kind === 'path' && op.width === 6);
  const labels = canvas.operations.filter(op => op.kind === 'text' && /^Side /.test(op.text));
  const points = highlights.flatMap(op => op.points), minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  assert.equal(labels.length, 4);
  labels.forEach((label, i) => {
    const [a, b] = highlights[i].points, halfWidth = canvas.getContext().measureText(label.text).width / 2;
    assert.equal(label.fill, highlights[i].colour);
    if (a[0] === b[0]) {
      if (a[0] === minX) assert.equal(label.x + halfWidth, minX - 10);
      else assert.equal(label.x - halfWidth, maxX + 10);
      assert.ok(Math.abs(label.y + 12 - (a[1] + b[1]) / 2) < 1e-8);
    } else {
      assert.equal(label.x, (a[0] + b[0]) / 2);
      assert.equal(label.y, a[1] === minY ? minY + 10 : maxY - 34);
    }
    assert.ok(label.x - halfWidth >= 1390 && label.x + halfWidth <= 1730);
  });
  assert.ok(!canvas.operations.some(op => op.kind === 'path' && op.width === 1.5));
});

test('plan keys keep the front marker fixed and match side labels to legend colours', () => {
  const snapshot = emptyRoomSnapshot('recess'), walls = getRoomWalls(snapshot.room);
  const summaries = ['front', 'right', 'back', 'left'].map(view => roomViewSummary(snapshot, view, [walls[0].id, walls[3].id]));
  summaries[0].boundaries[1].label = 'Side 12';
  const pages = [], previousDocument = globalThis.document;
  globalThis.document = { createElement() {
    const canvas = recordingCanvas(); canvas.getContext().drawImage = (...args) => canvas.operations.push({ kind: 'image', args });
    const context = canvas.getContext();
    context.measureText = value => ({ width: [...value].reduce((sum, character) => sum + (character === '1' ? 7 : 12), 0) });
    context.fill = function() { canvas.operations.push({ kind: 'filledPath', points: [...this.path], fill: this.fillStyle }); };
    canvas.toDataURL = () => 'data:image/jpeg;base64,/9j/2Q=='; pages.push(canvas); return canvas;
  } };
  try {
    renderRoomViewPages(summaries.map(summary => ({ view: summary.view, image: {}, summary })), roomReportData(snapshot, {}), 'Keys', '2026-10-13', 0);
    const arrow = pages[0].operations.find(op => op.kind === 'filledPath');
    assert.equal(arrow.fill, '#52525b');
    for (const page of pages) {
      assert.deepEqual(page.operations.find(op => op.kind === 'filledPath'), arrow);
      const text = page.operations.filter(op => op.kind === 'text');
      const sides = page === pages[0] ? ['Side 1', 'Side 12'] : ['Side 1', 'Side 2'];
      for (const side of sides) {
        const keyLabel = text.find(op => op.text === side), legendLabel = text.find(op => op.text === side && op.x === 1390);
        assert.ok(keyLabel && legendLabel); assert.equal(keyLabel.fill, legendLabel.fill);
        assert.equal(keyLabel.fill, side === 'Side 1' ? '#0e7490' : '#7c3aed');
        assert.equal(keyLabel.font, '500 24px "IBM Plex Sans", sans-serif');
        assert.equal(legendLabel.font, '500 30px "IBM Plex Sans", sans-serif');
        const separator = text.find(op => op.text === '·' && op.y === legendLabel.y);
        const length = text.find(op => /^\d+\.\d{2} m$/.test(op.text) && op.y === legendLabel.y);
        const separatorX = 1390 + Math.ceil(page.getContext().measureText('Side 99').width) + 4;
        assert.equal(separator.x, separatorX, 'label column reserves only two digits and a small gap');
        assert.equal(length.x, separatorX + Math.ceil(page.getContext().measureText('·').width) + 8, 'all measurements start in one fixed column');
        assert.equal(length.font, legendLabel.font);
        assert.ok(legendLabel.x + page.getContext().measureText(side).width < separator.x, 'label column fits two digits');
      }
      assert.ok(text.some(op => op.text.includes('Colours identify')));
      assert.ok(!text.some(op => /Hidden wall key|Dot =|Arrow =|top arrow marks/.test(op.text)));
      assert.equal(page.operations.find(op => op.kind === 'image').args[2], 160);
      assert.ok(text.find(op => op.text === 'Highlighted wall length').y >= 980);
      assert.ok(text.every(op => op.y < 1180 || op.y === 1200), 'key explanation stays above the footer');
    }
  } finally { globalThis.document = previousDocument; }
});

test('report fonts finish loading once before text can be measured or drawn', async () => {
  const previousDocument = globalThis.document, previousFontFace = globalThis.FontFace;
  const fonts = new Set(), created = [];
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  globalThis.document = { fonts };
  globalThis.FontFace = class {
    constructor(family, source, descriptors) { Object.assign(this, { family, source, weight: descriptors.weight }); created.push(this); }
    async load() { await ready; return this; }
  };
  try {
    const first = loadReportFonts(), second = loadReportFonts();
    assert.equal(first, second);
    assert.equal(fonts.size, 0);
    assert.deepEqual(created.map(face => face.weight), ['400', '500']);
    assert.ok(created.every(face => face.family === 'IBM Plex Sans' && face.source.includes('/assets/fonts/ibm-plex-sans/')));
    release(); await first;
    assert.equal(fonts.size, 2);
    await loadReportFonts(); assert.equal(created.length, 2);
  } finally { globalThis.document = previousDocument; globalThis.FontFace = previousFontFace; }
});

test('interface waits for bold labels and reuses the already loaded report faces', async () => {
  const previousDocument = globalThis.document, previousFontFace = globalThis.FontFace;
  const fonts = new Set(), created = [];
  let release;
  const boldReady = new Promise(resolve => { release = resolve; });
  globalThis.document = { fonts };
  globalThis.FontFace = class {
    constructor(_family, _source, { weight }) { this.weight = weight; created.push(this); }
    async load() { if (this.weight === '700') await boldReady; return this; }
  };
  try {
    const pending = loadInterfaceFonts();
    assert.equal(loadInterfaceFonts(), pending);
    await loadReportFonts();
    assert.equal(fonts.size, 2);
    assert.deepEqual(created.map(face => face.weight).sort(), ['400', '500', '600', '700']);
    let settled = false; pending.then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    release(); await pending;
    assert.equal(fonts.size, 4);
    await Promise.all([loadReportFonts(), loadInterfaceFonts()]); assert.equal(created.length, 4);
  } finally { globalThis.document = previousDocument; globalThis.FontFace = previousFontFace; }
});

test('a font failure blocks PDF capture and allows the next export to retry', async () => {
  const previousDocument = globalThis.document, previousFontFace = globalThis.FontFace;
  const fonts = new Set();
  let fail = true, created = 0, touchedRenderer = false;
  globalThis.document = { fonts };
  globalThis.FontFace = class {
    constructor(_family, _source, { weight }) { this.weight = weight; created++; }
    async load() { if (fail && this.weight === '500') throw new Error('Font download failed'); return this; }
  };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { floorTextureReady: Promise.resolve(), spaceFloorReady: [] });
  Object.defineProperty(scene, 'renderer', { get() { touchedRenderer = true; throw new Error('Unexpected capture'); } });
  try {
    await assert.rejects(scene.exportPDF('Font failure'), /Could not load the PDF report font/);
    assert.equal(touchedRenderer, false); assert.equal(fonts.size, 0);
    fail = false; await loadReportFonts();
    assert.equal(fonts.size, 2); assert.equal(created, 4);
  } finally { globalThis.document = previousDocument; globalThis.FontFace = previousFontFace; }
});

test('a failed PDF capture restores camera, render size, helper visibility and controls', async () => {
  const snapshot = emptyRoomSnapshot(), camera = new THREE.PerspectiveCamera(37, 4 / 3, 0.2, 150);
  camera.position.set(4, 6, 7); camera.layers.enable(1);
  const renderer = { domElement: { setAttribute() {} }, ratio: 2, size: [800, 600], getPixelRatio() { return this.ratio; }, setPixelRatio(value) { this.ratio = value; },
    getSize(target) { return target.set(...this.size); }, setSize(x, y) { this.size = [x, y]; }, render() { throw new Error('GPU capture failed'); } };
  const scene = Object.create(PlannerScene.prototype);
  Object.assign(scene, { floorTextureReady: Promise.resolve(), spaceFloorReady: [], productModelRequests: new Map(), productModelErrors: new Map(),
    disposed: false, bridge: { getSnapshot: () => snapshot }, sceneSnapshot: () => snapshot, renderer, camera,
    controls: { target: new THREE.Vector3(2, 1, 3), maxDistance: 30, enableDamping: true, enabled: true, update() {} },
    walkControls: { setEnabled() {} },
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

test('client contact lists migrate old text, validate new entries and respect explicit removals', () => {
  for (const [legacy, key] of [['Jane Smith — Project lead', 'name'], ['jane@example.test', 'email'], ['+351 210 000 000', 'phone']]) {
    const details = normalizeProjectDetails({ clientContact: legacy });
    assert.equal(details.clientContacts[0][key], legacy);
    assert.equal(details.clientContact, '');
    assert.deepEqual(normalizeProjectDetails(details), details);
  }
  assert.deepEqual(normalizeProjectDetails({ clientContact: 'Old contact', clientContacts: [] }).clientContacts, []);
  assert.deepEqual(normalizeProjectDetails({ clientContacts: [{ name: '', phone: '', email: '' }] }).clientContacts, []);
  assert.throws(() => normalizeProjectDetails({ clientContacts: [{ email: 'invalid email' }] }), /email/);
  assert.throws(() => normalizeProjectDetails({ clientContacts: Array(21).fill({ name: 'Contact' }) }), /contacts/);
  assert.throws(() => normalizeProjectDetails({ clientContacts: [null] }), /contact/);
  assert.throws(() => normalizeProjectDetails({ clientContacts: [{ phone: '1'.repeat(81) }] }), /phone/);
});

test('PDF report includes the project name, site and separate client people, phones and emails', () => {
  const snapshot = emptyRoomSnapshot();
  snapshot.room.projectDetails = normalizeProjectDetails({ reference: 'Hospital expansion', location: 'Lisbon', client: 'Example Client Ltd', clientContacts: [
    { name: 'Jane Smith', phone: '+351 210 000 000', email: 'jane@example.test' },
    { name: 'Accounts', email: 'accounts@example.test' }
  ] });
  const canvases = [], previousDocument = globalThis.document;
  globalThis.document = { createElement() { const canvas = recordingCanvas(); canvas.toDataURL = () => 'data:image/jpeg;base64,/9j/2Q=='; canvases.push(canvas); return canvas; } };
  try {
    renderRoomReport(roomReportData(snapshot, {}), 'Contact report', '2026-10-28');
    const text = canvases.flatMap(canvas => canvas.operations.filter(op => op.kind === 'text').map(op => op.text)).join('\n');
    for (const value of ['Hospital expansion', 'Site', 'Lisbon', 'Example Client Ltd', 'Client contacts', 'Jane Smith', '+351 210 000 000', 'jane@example.test', 'Accounts', 'accounts@example.test']) assert.ok(text.includes(value), value);
    assert.ok(!text.includes('Project reference')); assert.ok(!text.includes('Site / department'));
  } finally { globalThis.document = previousDocument; }
});
