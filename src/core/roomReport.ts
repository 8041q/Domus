import { getRoomWalls, polygonArea, roomBounds } from './roomGeometry';
import { normalizeProjectDetails, PROJECT_DETAIL_FIELDS } from './projectDetails';
import { floorFinishDefinition } from './roomFinishes';
import { getPhysicalWalls } from './spaces';
import { BASEBOARD_STYLES } from './architecturalStyles';
import { ReportDocument, reportFooter } from './reportLayout';
import { jpegBytes, ROOM_PDF_VIEWS, type PdfSnapshot } from './roomPdf';
import { roomWallMeasurements, type ReportViewSummary } from './roomReportGeometry';
import type { PlannerSnapshot, ProductDefinition } from './types';

export const reportMetres = (value: number) => value.toFixed(2);
// Preserve half-centimetre manufacturer sizes such as 99.5 cm (0.995 m).
const sizeText = (size: { width: number; depth: number; height: number }) =>
  [size.depth, size.width, size.height].map((value) => value.toFixed(3).replace(/0$/, '')).join(' × ');
export function roomReportData(snapshot: PlannerSnapshot, products: Record<string, ProductDefinition>, warnings: { name: string; message: string }[] = []) {
  const room = snapshot.room, bounds = roomBounds(room.vertices);
  const furniture = new Map<string, { productId: string; name: string; category: string; quantity: number; dimensions: string; geometryDimensions: string; dimensionSource: string; status: string }>();
  for (const [objects, status] of [[snapshot.objects, 'In room'], [snapshot.unplacedObjects, 'Not placed']] as const) {
    for (const object of objects) {
      const key = `${object.productId}:${status}`, existing = furniture.get(key);
      if (existing) { existing.quantity++; continue; }
      const product = products[object.productId];
      furniture.set(key, { productId: object.productId, name: product?.name ?? object.productId, category: product?.category ?? 'Unknown', quantity: 1,
        dimensions: product ? sizeText(product.displayDimensions ?? product) : 'Unavailable',
        geometryDimensions: product ? sizeText(product) : 'Unavailable',
        dimensionSource: product?.displayDimensions ? 'Real-life dimensions' : product?.model ? 'Real-life size not supplied' : 'Catalogue dimensions', status });
    }
  }
  const counters = { door: 0, window: 0, opening: 0 };
  const walls = getPhysicalWalls(room, snapshot.dividers);
  const wallMeasurements = roomWallMeasurements(snapshot);
  return { details: normalizeProjectDetails(room.projectDetails), vertices: room.vertices, bounds, wallMeasurements, area: Math.abs(polygonArea(room.vertices)),
    perimeter: getRoomWalls(room).reduce((sum, wall) => sum + wall.length, 0), height: room.height,
    shape: room.shapeKind.replaceAll('-', ' '),
    finishes: `${floorFinishDefinition(room.floorFinish).name} · Walls ${room.wallColor} · Ceiling ${room.ceilingColor}`,
    baseboard: `${BASEBOARD_STYLES.find((style) => style.id === room.baseboardStyle)?.name ?? room.baseboardStyle} · ${room.baseboardMaterial} · ${room.baseboardColor}`,
    openingSummary: ['door', 'window', 'opening'].map((type) => {
      const count = snapshot.openings.filter((opening) => opening.type === type).length;
      return `${count} ${type}${count === 1 ? '' : 's'}`;
    }).join(' · '),
    footprint: room.shapeKind === 'circle' ? `Diameter ${reportMetres(room.width)} m` : `${reportMetres(room.width)} × ${reportMetres(room.depth)} m`,
    dimensions: room.shapeKind === 'circle' ? `Diameter ${reportMetres(room.width)} m · Height ${reportMetres(room.height)} m` :
      `${reportMetres(room.width)} × ${reportMetres(room.depth)} m · Height ${reportMetres(room.height)} m`,
    furniture: [...furniture.values()], warnings,
    instances: snapshot.objects.map((object, i) => ({ label: `F${i + 1}`, name: products[object.productId]?.name ?? object.productId,
      productId: object.productId, x: object.x - bounds.minX, z: object.z - bounds.minZ,
      rotation: ((object.rotationY * 180 / Math.PI) % 360 + 360) % 360 })),
    openings: snapshot.openings.map((opening) => {
      const wall = walls.find((wall) => wall.id === opening.wallId), index = walls.findIndex((wall) => wall.id === opening.wallId);
      return { id: opening.id, name: `${opening.type[0].toUpperCase()}${opening.type.slice(1)} ${++counters[opening.type]}`,
        dimensions: `${reportMetres(opening.width)} × ${reportMetres(opening.height)} m`, sill: `${reportMetres(opening.sillHeight)} m`,
        location: wallMeasurements[index]?.label ?? 'Unknown wall',
        position: `${reportMetres(opening.offset)} m from segment start`, start: wall?.start };
    }) };
}

export type RoomReportData = ReturnType<typeof roomReportData>;
/** One furniture inventory, followed by architectural measurements and recommendations. */
export function renderRoomReport(data: RoomReportData, roomName: string, date: string, _views: ReportViewSummary[] = []): PdfSnapshot[] {
  const doc = new ReportDocument(roomName);
  const populated = PROJECT_DETAIL_FIELDS.filter((field) => field.key !== 'notes' && data.details[field.key]);
  if (populated.length) { doc.section('Project', 150); for (const entry of populated) doc.field(entry.label, data.details[entry.key]!); }
  doc.section('Room'); doc.field('Shape and size', `${data.shape} · ${data.dimensions}`);
  doc.field('Floor area / perimeter', `${reportMetres(data.area)} m² · ${reportMetres(data.perimeter)} m`);
  doc.field('Finishes', data.finishes); doc.field('Baseboard', data.baseboard);
  doc.field('Furniture', `${data.furniture.filter((item) => item.status === 'In room').reduce((sum, item) => sum + item.quantity, 0)} in room · ${data.furniture.filter((item) => item.status === 'Not placed').reduce((sum, item) => sum + item.quantity, 0)} not placed`);
  doc.field('Openings', data.openingSummary);
  if (!data.furniture.length) { doc.section('Furniture list'); doc.paragraph('No furniture in this draft.'); }
  else doc.table('Furniture list', ['Model / category', 'Qty', 'Real-life L × W × H (m)', 'Size source', 'Placement'], [490, 90, 430, 360, 290],
    data.furniture.map((item) => [`${item.name} - ${item.category}`, String(item.quantity), item.dimensions, item.dimensionSource, item.status]));
  doc.paragraph('Real-life sizes use entered product metadata; catalogue sizes are used for built-in furniture. Where no real-life size was supplied, the model geometry is shown. Not placed items are excluded from the room views.');
  if (data.details.notes) { doc.section('Client requirements and notes', 32); doc.paragraph(data.details.notes); }
  if (data.openings.length) doc.table('Doors, windows and openings', ['Type', 'Width × height', 'Bottom edge above floor', 'Location / centre'], [290, 350, 390, 630],
    data.openings.map((opening) => [opening.name, opening.dimensions, opening.sill, `${opening.location} · ${opening.position}`]));
  else { doc.section('Doors, windows and openings'); doc.paragraph('No doors, windows or openings.'); }
  doc.paragraph('Bottom edge above floor is the distance from the floor to the bottom of the opening, not its height. Opening centres are measured from the start of their wall.');
  const boundaries = data.wallMeasurements;
  if (boundaries.length) {
    doc.field('Wall height', `${reportMetres(data.height)} m - shared by all walls`);
    doc.table('Wall Measurements', ['Wall', 'Length (m)', 'Gross / net area (m²)', 'Openings'], [400, 360, 550, 350],
      boundaries.map((boundary) => [boundary.label, reportMetres(boundary.length),
        `${reportMetres(boundary.grossArea)} / ${reportMetres(boundary.netArea)}`, String(boundary.openingCount)]));
    doc.paragraph('Every perimeter wall and physical interior wall is listed once, in wall order. Length follows the wall geometry. Gross area is length × room height; net area deducts openings without double-counting overlaps.');
    const coverage = boundaries.flatMap((boundary) => boundary.openings.map((opening) => [boundary.label, opening.name,
      `${reportMetres(opening.start)}-${reportMetres(opening.end)} m`, `${reportMetres(opening.bottom)}-${reportMetres(opening.top)} m`]));
    if (coverage.length) doc.table('Openings by wall', ['Wall', 'Opening', 'Start-end along wall', 'Bottom-top above floor'], [340, 380, 470, 470], coverage);
    doc.paragraph('Opening positions follow each wall from its start to its end. An opening crossing several wall segments is listed for its covered portion on each segment.');
  }
  if (data.warnings.length) doc.table('Clearance recommendations', ['Furniture', 'Existing planner recommendation'], [490, 1170], data.warnings.map((warning) => [warning.name, warning.message]));
  else { doc.section('Clearance recommendations', 32); doc.paragraph('No clearance warnings from the current planner rules.'); }
  doc.paragraph('These recommendations use the model geometry and existing use-space settings. They do not assess regulatory compliance. Real-life/model size differences can affect the result.');
  return doc.pages.map((canvas, index) => {
    reportFooter(canvas.getContext('2d')!, date, index + 1, doc.pages.length + ROOM_PDF_VIEWS.length);
    return { jpeg: jpegBytes(canvas), width: canvas.width, height: canvas.height };
  });
}
