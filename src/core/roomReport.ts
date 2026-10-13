import { polygonArea } from './roomGeometry';
import { normalizeProjectDetails, PROJECT_DETAIL_FIELDS } from './projectDetails';
import { jpegBytes, type PdfSnapshot } from './roomPdf';
import type { PlannerSnapshot, ProductDefinition } from './types';

const metres = (value: number) => value.toFixed(2);
export function roomReportData(snapshot: PlannerSnapshot, products: Record<string, ProductDefinition>) {
  const room = snapshot.room;
  const furniture = new Map<string, { name: string; category: string; quantity: number; dimensions: string; status: string }>();
  for (const [objects, status] of [[snapshot.objects, 'In room'], [snapshot.unplacedObjects, 'Not placed']] as const) {
    for (const object of objects) {
      const key = `${object.productId}:${status}`, existing = furniture.get(key);
      if (existing) { existing.quantity++; continue; }
      const product = products[object.productId];
      furniture.set(key, { name: product?.name ?? object.productId, category: product?.category ?? 'Unknown', quantity: 1,
        dimensions: product ? `${metres(product.width)} × ${metres(product.depth)} × ${metres(product.height)}` : 'Unavailable', status });
    }
  }
  return { details: normalizeProjectDetails(room.projectDetails), area: Math.abs(polygonArea(room.vertices)),
    shape: room.shapeKind.replaceAll('-', ' '),
    openingSummary: ['door', 'window', 'opening'].map((type) => {
      const count = snapshot.openings.filter((opening) => opening.type === type).length;
      return `${count} ${type}${count === 1 ? '' : 's'}`;
    }).join(' · '),
    dimensions: room.shapeKind === 'circle' ? `Diameter ${metres(room.width)} m · Height ${metres(room.height)} m` :
      `${metres(room.width)} × ${metres(room.depth)} m · Height ${metres(room.height)} m`,
    furniture: [...furniture.values()], openings: snapshot.openings.map((opening, index) => ({
      name: `${opening.type[0].toUpperCase()}${opening.type.slice(1)} ${index + 1}`,
      dimensions: `${metres(opening.width)} × ${metres(opening.height)} m`, sill: `${metres(opening.sillHeight)} m`
    })) };
}

export type RoomReportData = ReturnType<typeof roomReportData>;
/** Paginate measured text and table rows before adding the five large room views. */
export function renderRoomReport(data: RoomReportData, roomName: string, date: string): PdfSnapshot[] {
  const canvases: HTMLCanvasElement[] = [];
  let ctx!: CanvasRenderingContext2D, y = 0;
  const bottom = 1150;
  const font = (size = 25, bold = false) => { ctx.font = `${bold ? '600' : '400'} ${size}px system-ui`; ctx.fillStyle = '#27272a'; };
  const wrap = (text: string, width: number) => {
    const result: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      // Character wrapping also handles long identifiers and contact addresses.
      for (const character of paragraph) {
        if (line && ctx.measureText(line + character).width > width) { result.push(line.trimEnd()); line = ''; }
        line += character;
      }
      result.push(line.trimEnd());
    }
    return result;
  };
  const page = () => {
    const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1273;
    ctx = canvas.getContext('2d')!; canvases.push(canvas);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1800, 1273);
    font(34, true);
    const title = wrap(roomName, 1660); ctx.fillText(title[0] + (title.length > 1 ? '…' : ''), 70, 70);
    font(24); ctx.fillStyle = '#71717a'; ctx.fillText(canvases.length === 1 ? 'Room summary' : 'Room details · continued', 70, 115);
    y = 175;
  };
  const space = (height: number) => { if (y + height > bottom) page(); };
  const section = (title: string, firstRow = 65) => {
    space(65 + firstRow); font(28, true); ctx.fillText(title, 70, y); y += 45;
  };
  const field = (label: string, value: string) => {
    font(); const lines = wrap(value, 1180); space(lines.length * 34 + 20);
    font(24, true); ctx.fillText(label, 70, y);
    font(); for (const line of lines) { ctx.fillText(line, 480, y); y += 34; } y += 16;
  };
  const table = (headers: string[], widths: number[], rows: string[][]) => {
    const header = () => {
      ctx.fillStyle = '#f4f4f5'; ctx.fillRect(70, y - 27, 1660, 48); font(23, true);
      let x = 85; headers.forEach((title, i) => { ctx.fillText(title, x, y); x += widths[i]; }); y += 50;
    };
    space(110); header();
    for (const cells of rows) {
      font(23); const lines = cells.map((cell, i) => wrap(cell, widths[i] - 30));
      const height = Math.max(...lines.map((cell) => cell.length)) * 32 + 24;
      if (y + height > bottom) { page(); header(); font(23); }
      let x = 85; lines.forEach((cell, i) => { cell.forEach((line, j) => ctx.fillText(line, x, y + j * 32)); x += widths[i]; });
      y += height; ctx.strokeStyle = '#e4e4e7'; ctx.beginPath(); ctx.moveTo(70, y - 18); ctx.lineTo(1730, y - 18); ctx.stroke();
    }
    y += 20;
  };
  page();
  const populated = PROJECT_DETAIL_FIELDS.filter((field) => field.key !== 'notes' && data.details[field.key]);
  if (populated.length) { section('Project'); for (const entry of populated) field(entry.label, data.details[entry.key]); }
  section('Room'); field('Shape', data.shape); field('Dimensions', data.dimensions); field('Floor area', `${metres(data.area)} m²`);
  field('Furniture', `${data.furniture.filter((item) => item.status === 'In room').reduce((sum, item) => sum + item.quantity, 0)} in room · ${data.furniture.filter((item) => item.status === 'Not placed').reduce((sum, item) => sum + item.quantity, 0)} not placed`);
  field('Apertures', data.openingSummary);
  section('Furniture list', 150);
  if (!data.furniture.length) field('Furniture', 'No furniture in this draft.');
  else table(['Model', 'Category', 'Qty', 'W × D × H (m)', 'Placement'], [540, 300, 100, 440, 280],
    data.furniture.map((item) => [item.name, item.category, String(item.quantity), item.dimensions, item.status]));
  field('Dimensions', 'Measured model size, in metres. Not placed items are excluded from the room views.');
  section('Doors, windows and openings', 150);
  if (!data.openings.length) field('Apertures', 'No doors, windows or openings.');
  else table(['Type', 'Width × height', 'Height above floor'], [660, 500, 500], data.openings.map((opening) => [opening.name, opening.dimensions, opening.sill]));
  if (data.details.notes) {
    section('Notes'); font();
    for (const line of wrap(data.details.notes, 1660)) { space(34); font(); ctx.fillText(line, 70, y); y += 34; }
  }
  return canvases.map((canvas, index) => {
    ctx = canvas.getContext('2d')!; font(20); ctx.fillStyle = '#71717a';
    ctx.fillText(`Domus · Exported ${date}`, 70, 1210); ctx.textAlign = 'right';
    ctx.fillText(`${index + 1} / ${canvases.length + 5}`, 1730, 1210);
    return { jpeg: jpegBytes(canvas), width: canvas.width, height: canvas.height };
  });
}
