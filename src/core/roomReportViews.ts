import { roomBounds } from './roomGeometry';
import { layoutReportPlanLabels } from './roomReportPlanLabels';
import { reportFooter, reportFont, reportHeading, wrapReportText } from './reportLayout';
import { jpegBytes, type PdfSnapshot, ROOM_PDF_VIEWS } from './roomPdf';
import { reportMetres, type RoomReportData } from './roomReport';
import type { ReportViewSummary } from './roomReportGeometry';
import type { RoomVertex } from './types';

export interface ReportViewCapture { view: typeof ROOM_PDF_VIEWS[number]; image: HTMLCanvasElement; summary?: ReportViewSummary }
const colours = ['#0e7490', '#7c3aed', '#b45309', '#be185d'];

/** Draw the measured sections with a fixed upward marker for the room's front. */
export function drawReportPlanKey(ctx: CanvasRenderingContext2D, vertices: RoomVertex[], summary: ReportViewSummary, x: number, y: number, width: number, height: number) {
  ctx.save(); reportFont(ctx, 24, true);
  const bounds = roomBounds(vertices);
  // Reserve space on both sides for outside labels, including two-digit numbers.
  const labelWidth = Math.max(ctx.measureText('Side 99').width, ...summary.boundaries.map(boundary => ctx.measureText(boundary.label).width));
  const gap = 10;
  const scale = Math.min((width - 2 * (labelWidth + gap + 4)) / bounds.width, (height - 90) / bounds.depth);
  const ox = x + (width - bounds.width * scale) / 2, oz = y + (height - bounds.depth * scale) / 2;
  const point = (p: { x: number; z: number }) => ({ x: ox + (p.x - bounds.minX) * scale, y: oz + (p.z - bounds.minZ) * scale });
  // A compact forward arrow replaces the word "Front". It always points to
  // diagram-top, independent of the 3D camera and highlighted sections.
  const frontX = x + width / 2;
  ctx.fillStyle = '#52525b';
  ctx.beginPath(); ctx.moveTo(frontX, y + 3);
  ctx.lineTo(frontX + 10, y + 18); ctx.lineTo(frontX + 3, y + 15);
  ctx.lineTo(frontX + 3, y + 28); ctx.lineTo(frontX - 3, y + 28);
  ctx.lineTo(frontX - 3, y + 15); ctx.lineTo(frontX - 10, y + 18);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); vertices.forEach((v, i) => { const p = point(v); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
  ctx.closePath(); ctx.fillStyle = '#f4f4f6'; ctx.fill(); ctx.strokeStyle = '#a1a1aa'; ctx.lineWidth = 2; ctx.stroke();
  const polygon = vertices.map(point);
  const inputs = summary.boundaries.map(boundary => ({
    width: ctx.measureText(boundary.label).width,
    walls: boundary.walls.map(wall => ({ start: point(wall.start), end: point(wall.end), inward: { x: wall.inward.x, y: wall.inward.z }, length: wall.length }))
  }));
  const area = { left: x, top: y, right: x + width, bottom: y + height };
  const arrow = { left: frontX - 10, top: y + 3, right: frontX + 10, bottom: y + 28 };
  let fontSize = 24;
  let labels = layoutReportPlanLabels(inputs, polygon, area, arrow);
  // Keep the usual large text, but allow a modest reduction for crowded custom
  // outlines. The wall schedule remains the complete reference if no space fits.
  for (const size of [22, 20, 18]) {
    if (labels) break;
    fontSize = size; reportFont(ctx, size, true);
    labels = layoutReportPlanLabels(inputs.map((input, i) => ({ ...input, width: ctx.measureText(summary.boundaries[i].label).width })), polygon, area, arrow, size);
  }
  if (!labels) labels = layoutReportPlanLabels(inputs.map((input, i) => ({ ...input, width: ctx.measureText(summary.boundaries[i].label).width })), polygon, area, arrow, fontSize, true);
  summary.boundaries.forEach((boundary, i) => {
    ctx.strokeStyle = colours[i % colours.length]; ctx.lineWidth = 6;
    ctx.beginPath(); const start = point(boundary.walls[0].start); ctx.moveTo(start.x, start.y);
    boundary.walls.forEach(wall => { const p = point(wall.end); ctx.lineTo(p.x, p.y); }); ctx.stroke();
  });
  labels?.forEach((label, i) => {
    if (!label?.callout) return;
    ctx.strokeStyle = colours[i % colours.length]; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(label.anchor.x, label.anchor.y);
    ctx.lineTo(Math.max(label.left, Math.min(label.right, label.anchor.x)), Math.max(label.top, Math.min(label.bottom, label.anchor.y))); ctx.stroke();
  });
  labels?.forEach((label, i) => {
    if (!label) return;
    reportFont(ctx, fontSize, true); ctx.fillStyle = colours[i % colours.length]; ctx.textAlign = 'center';
    ctx.fillText(summary.boundaries[i].label, label.x, label.y);
  });
  ctx.restore();
}

export function renderRoomViewPages(captures: ReportViewCapture[], data: RoomReportData, roomName: string, date: string, reportPages: number): PdfSnapshot[] {
  return captures.map((capture, index) => {
    const page = document.createElement('canvas'); page.width = 1800; page.height = 1273;
    const ctx = page.getContext('2d')!;
    const title = capture.view[0].toUpperCase() + capture.view.slice(1);
    reportHeading(ctx, roomName, `${title} view`);
    const metric = (label: string, value: string, x: number, y: number) => {
      reportFont(ctx, 22); ctx.fillStyle = '#71717a'; ctx.fillText(label, x, y);
      reportFont(ctx, 31, true); ctx.fillText(value, x, y + 32);
    };
    if (capture.view === 'top') {
      metric('Footprint', data.footprint, 70, 148); metric('Floor area', `${reportMetres(data.area)} m²`, 690, 148);
      metric('Perimeter', `${reportMetres(data.perimeter)} m`, 1250, 148);
      ctx.drawImage(capture.image, 150, 230, 1500, 891);
    } else {
      const summary = capture.summary!;
      ctx.drawImage(capture.image, 70, 160, 1280, 760);
      drawReportPlanKey(ctx, data.vertices, summary, 1390, 160, 340, 360);
      // Separate important lengths from the diagram and give them generous spacing.
      const text = summary.boundaries.length
        ? 'Colours identify the walls removed from this view. Lengths are measured along each side.'
        : 'All perimeter walls remain visible in this view.';
      reportFont(ctx, 22);
      const note = wrapReportText(ctx, text, 340);
      const roomy = summary.boundaries.length <= 3;
      const rowHeight = roomy ? 52 : 42;
      reportFont(ctx, roomy ? 30 : 24, true);
      const separatorX = 1390 + Math.ceil(ctx.measureText('Side 99').width) + 4;
      const measurementX = separatorX + Math.ceil(ctx.measureText('·').width) + 8;
      let y = 550;
      const legendBottom = 935 - note.length * 29 - 20;
      for (const [i, boundary] of summary.boundaries.entries()) {
        if (y + rowHeight > legendBottom) {
          reportFont(ctx, 20); ctx.fillText('More lengths in Wall Measurements.', 1390, y); y += 30; break;
        }
        reportFont(ctx, roomy ? 30 : 24, true); ctx.fillStyle = colours[i % colours.length];
        // Fixed columns keep lengths aligned regardless of proportional digits
        // in Side 1, Side 2 or a two-digit label such as Side 12.
        ctx.fillText(boundary.label, 1390, y);
        ctx.fillText('·', separatorX, y);
        ctx.fillText(`${reportMetres(boundary.length)} m`, measurementX, y);
        y += rowHeight;
      }
      reportFont(ctx, 22); ctx.fillStyle = '#71717a';
      note.forEach((line, i) => ctx.fillText(line, 1390, y + 14 + i * 29));
      // The summary fills the lower portion of the page instead of crowding the header.
      metric('Highlighted wall length', `${reportMetres(summary.length)} m`, 70, 980);
      metric('View width', `${reportMetres(summary.span)} m`, 650, 980);
      metric('Wall height', `${reportMetres(summary.height)} m`, 1230, 980);
      metric('Gross wall area', `${reportMetres(summary.grossArea)} m²`, 70, 1075);
      metric('Net wall area', `${reportMetres(summary.netArea)} m²`, 650, 1075);
      metric('Openings / sides', `${summary.openingCount} / ${summary.boundaries.length}`, 1230, 1075);
    }
    reportFooter(ctx, date, reportPages + index + 1, reportPages + captures.length);
    return { jpeg: jpegBytes(page), width: page.width, height: page.height };
  });
}
