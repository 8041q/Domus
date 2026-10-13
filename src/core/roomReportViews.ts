import { roomBounds, wallPoint } from './roomGeometry';
import { reportFooter, reportFont, reportHeading, wrapReportText } from './reportLayout';
import { jpegBytes, type PdfSnapshot, ROOM_PDF_VIEWS } from './roomPdf';
import { reportMetres, type RoomReportData } from './roomReport';
import type { ReportViewSummary } from './roomReportGeometry';
import type { RoomVertex } from './types';

export interface ReportViewCapture { view: typeof ROOM_PDF_VIEWS[number]; image: HTMLCanvasElement; summary?: ReportViewSummary }
const colours = ['#0e7490', '#7c3aed', '#b45309', '#be185d'];

/** Draw directly from the same wall runs used for quantities. Front is diagram-top. */
export function drawReportPlanKey(ctx: CanvasRenderingContext2D, vertices: RoomVertex[], summary: ReportViewSummary, x: number, y: number, width: number, height: number) {
  const bounds = roomBounds(vertices);
  const scale = Math.min((width - 100) / bounds.width, (height - 90) / bounds.depth);
  const ox = x + (width - bounds.width * scale) / 2, oz = y + (height - bounds.depth * scale) / 2;
  const point = (p: { x: number; z: number }) => ({ x: ox + (p.x - bounds.minX) * scale, y: oz + (p.z - bounds.minZ) * scale });
  ctx.save(); reportFont(ctx, 19); ctx.fillStyle = '#71717a'; ctx.textAlign = 'center'; ctx.fillText('Front', x + width / 2, y + 5);
  ctx.beginPath(); vertices.forEach((v, i) => { const p = point(v); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
  ctx.closePath(); ctx.fillStyle = '#f4f4f6'; ctx.fill(); ctx.strokeStyle = '#a1a1aa'; ctx.lineWidth = 2; ctx.stroke();
  summary.boundaries.forEach((boundary, i) => {
    const colour = colours[i % colours.length]; ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = 6;
    ctx.beginPath(); const start = point(boundary.walls[0].start); ctx.moveTo(start.x, start.y);
    boundary.walls.forEach((wall) => { const p = point(wall.end); ctx.lineTo(p.x, p.y); }); ctx.stroke();
    ctx.beginPath(); ctx.arc(start.x, start.y, 5, 0, Math.PI * 2); ctx.fill();
    // A direction arrow follows the first segment, even for a curved run.
    const first = boundary.walls[0], arrow = point(wallPoint(first, Math.min(first.length * 0.75, 22 / scale)));
    const tx = first.tangent.x, ty = first.tangent.z;
    ctx.beginPath(); ctx.moveTo(arrow.x + tx * 6, arrow.y + ty * 6);
    ctx.lineTo(arrow.x - tx * 5 - ty * 5, arrow.y - ty * 5 + tx * 5);
    ctx.lineTo(arrow.x - tx * 5 + ty * 5, arrow.y - ty * 5 - tx * 5); ctx.closePath(); ctx.fill();
    let distance = boundary.length / 2;
    const middle = boundary.walls.find((wall) => { if (distance <= wall.length) return true; distance -= wall.length; return false; }) ?? first;
    const p = point(wallPoint(middle, distance));
    reportFont(ctx, 18, true); ctx.fillStyle = colour; ctx.textAlign = 'center';
    ctx.fillText(boundary.label, p.x + middle.inward.x * 28, p.y + middle.inward.z * 28 - 9);
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
      reportFont(ctx, 20); ctx.fillStyle = '#71717a'; ctx.fillText(label, x, y);
      reportFont(ctx, 27, true); ctx.fillText(value, x, y + 29);
    };
    if (capture.view === 'top') {
      metric('Footprint', data.footprint, 70, 148); metric('Floor area', `${reportMetres(data.area)} m²`, 690, 148);
      metric('Perimeter', `${reportMetres(data.perimeter)} m`, 1250, 148);
      ctx.drawImage(capture.image, 150, 230, 1500, 891);
    } else {
      const summary = capture.summary!;
      metric('Hidden boundary length', `${reportMetres(summary.length)} m`, 70, 148);
      metric('Horizontal view span', `${reportMetres(summary.span)} m`, 650, 148);
      metric('Wall height', `${reportMetres(summary.height)} m`, 1230, 148);
      metric('Gross wall area', `${reportMetres(summary.grossArea)} m²`, 70, 224);
      metric('Net wall area', `${reportMetres(summary.netArea)} m²`, 650, 224);
      metric('Apertures / hidden runs', `${summary.openingCount} / ${summary.boundaries.length}`, 1230, 224);
      ctx.drawImage(capture.image, 70, 325, 1280, 760);
      reportFont(ctx, 23, true); ctx.fillText('Hidden wall key', 1390, 325);
      drawReportPlanKey(ctx, data.vertices, summary, 1390, 360, 340, 300);
      reportFont(ctx, 20); let y = 680;
      for (const [i, boundary] of summary.boundaries.entries()) {
        if (y > 965) { ctx.fillText('More runs in schedule', 1390, y); break; }
        ctx.fillStyle = colours[i % colours.length]; ctx.fillText(`${boundary.label} · ${reportMetres(boundary.length)} m`, 1390, y); y += 32;
      }
      reportFont(ctx, 20); ctx.fillStyle = '#71717a';
      const text = summary.boundaries.length ? 'Dot = run start. Arrow = direction. Length follows the boundary; span follows this view. See technical schedules for opening positions.' : 'No perimeter sections are hidden in this view.';
      wrapReportText(ctx, text, 340).forEach((line) => { ctx.fillText(line, 1390, y + 12); y += 27; });
    }
    reportFooter(ctx, date, reportPages + index + 1, reportPages + captures.length);
    return { jpeg: jpegBytes(page), width: page.width, height: page.height };
  });
}
