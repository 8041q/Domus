import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { PRODUCTS, rotatedFootprint } from './core/products';
import { clearanceAabb, resolvePlacement } from './core/placement';
import {
  distanceToWall,
  getRoomWalls,
  getWall,
  moveCorner,
  moveWall,
  polygonArea,
  roomBounds,
  wallPoint,
  wallProjectionDistance,
  vertexInteriorAngle
} from './core/roomGeometry';
import { formatArea, formatLength } from './core/units';
import type { PlannerSnapshot, RoomOpening, SnapFeedback } from './core/types';
import { getSnapshot, usePlannerStore } from './store';

const PAD = 64;

type Purpose = 'build' | 'furnish';

type ViewTransform = { scale: number; ox: number; oz: number };

type DragState =
  | { type: 'wall'; id: string; before: PlannerSnapshot; view: ViewTransform }
  | { type: 'corner'; id: string; before: PlannerSnapshot; view: ViewTransform }
  | { type: 'object'; id: string; before: PlannerSnapshot; snap: SnapFeedback }
  | { type: 'opening'; id: string; before: PlannerSnapshot; view: ViewTransform };

type HoverTarget = { type: 'wall' | 'corner' | 'opening' | 'split'; id: string } | null;

const HOVER_CYAN = '#00e5ff';

function openingPoints(opening: RoomOpening, room: PlannerSnapshot['room']) {
  const wall = getWall(room, opening.wallId);
  if (!wall) return null;
  const half = opening.width / 2;
  return {
    wall,
    start: wallPoint(wall, opening.offset - half),
    end: wallPoint(wall, opening.offset + half),
    centre: wallPoint(wall, opening.offset)
  };
}

function pointSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

export function Plan2D({ purpose }: { purpose: Purpose }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const room = usePlannerStore((s) => s.room);
  const measurementSystem = usePlannerStore((s) => s.measurementSystem);
  const openings = usePlannerStore((s) => s.openings);
  const objects = usePlannerStore((s) => s.objects);
  const selectedId = usePlannerStore((s) => s.selectedId);
  const selectedOpeningId = usePlannerStore((s) => s.selectedOpeningId);
  const selectedWallId = usePlannerStore((s) => s.selectedWallId);
  const activeSnap = usePlannerStore((s) => s.activeSnap);
  const showClearance = usePlannerStore((s) => s.showClearance);
  const select = usePlannerStore((s) => s.select);
  const selectOpening = usePlannerStore((s) => s.selectOpening);
  const selectWall = usePlannerStore((s) => s.selectWall);
  const updateObject = usePlannerStore((s) => s.updateObject);
  const updateOpening = usePlannerStore((s) => s.updateOpening);
  const setRoomVertices = usePlannerStore((s) => s.setRoomVertices);
  const splitWallById = usePlannerStore((s) => s.splitWallById);
  const commitSnapshot = usePlannerStore((s) => s.commitSnapshot);
  const setFeedback = usePlannerStore((s) => s.setFeedback);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hover, setHover] = useState<HoverTarget>(null);
  const [resizeTick, setResizeTick] = useState(0);
  const viewRef = useRef<(ViewTransform & { width: number; height: number }) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      viewRef.current = null;
      setResizeTick((v) => v + 1);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const metrics = () => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    if (drag && drag.type !== 'object') return { rect, ...drag.view };

    // The drafting viewport is intentionally stable while dimensions change. Grid cells
    // represent world units, so growing a room makes it cover more cells instead of
    // auto-zooming the room back to the same apparent size.
    const cached = viewRef.current;
    if (!cached || Math.abs(cached.width - rect.width) > 1 || Math.abs(cached.height - rect.height) > 1) {
      const bounds = roomBounds(room.vertices);
      const frameW = Math.max(bounds.width, 6.4);
      const frameD = Math.max(bounds.depth, 5.0);
      const scale = Math.max(24, Math.min((rect.width - PAD * 2) / frameW, (rect.height - PAD * 2) / frameD));
      const drawingW = bounds.width * scale;
      const drawingD = bounds.depth * scale;
      const left = Math.max(PAD, (rect.width - drawingW) / 2);
      const top = Math.max(PAD, (rect.height - drawingD) / 2);
      viewRef.current = {
        scale,
        ox: left - bounds.minX * scale,
        oz: top - bounds.minZ * scale,
        width: rect.width,
        height: rect.height
      };
    }
    const view = viewRef.current!;
    return { rect, scale: view.scale, ox: view.ox, oz: view.oz };
  };

  useEffect(() => {
    if (room.shapeKind !== 'custom') {
      viewRef.current = null;
      setResizeTick((value) => value + 1);
    }
  }, [room.shapeKind]);

  const selected = useMemo(() => objects.find((o) => o.id === selectedId) ?? null, [objects, selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { rect, scale, ox, oz } = metrics();
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.fillStyle = '#f8f8f6';
    ctx.fillRect(0, 0, rect.width, rect.height);

    // World-anchored drafting grid. The room and the grid share one coordinate system:
    // dimensions therefore correspond to real grid cells and the background becomes a
    // useful sizing reference instead of a decorative checker that rescales with the room.
    const majorStep = measurementSystem === 'metric' ? 0.5 : 0.3048; // 50 cm or 1 ft
    const minorStep = measurementSystem === 'metric' ? 0.1 : 0.1524; // 10 cm or 6 in
    const minWorldX = (0 - ox) / scale;
    const maxWorldX = (rect.width - ox) / scale;
    const minWorldZ = (0 - oz) / scale;
    const maxWorldZ = (rect.height - oz) / scale;
    const minMajorX = Math.floor(minWorldX / majorStep);
    const maxMajorX = Math.ceil(maxWorldX / majorStep);
    const minMajorZ = Math.floor(minWorldZ / majorStep);
    const maxMajorZ = Math.ceil(maxWorldZ / majorStep);
    for (let row = minMajorZ; row < maxMajorZ; row += 1) {
      for (let col = minMajorX; col < maxMajorX; col += 1) {
        if ((row + col) % 2 !== 0) continue;
        ctx.fillStyle = '#f3f4f1';
        ctx.fillRect(ox + col * majorStep * scale, oz + row * majorStep * scale, majorStep * scale, majorStep * scale);
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#eceeea';
    for (let value = Math.floor(minWorldX / minorStep) * minorStep; value <= maxWorldX + minorStep; value += minorStep) {
      const x = ox + value * scale;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
    }
    for (let value = Math.floor(minWorldZ / minorStep) * minorStep; value <= maxWorldZ + minorStep; value += minorStep) {
      const y = oz + value * scale;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
    }
    ctx.strokeStyle = '#dde1dc';
    for (let value = minMajorX * majorStep; value <= maxWorldX + majorStep; value += majorStep) {
      const x = ox + value * scale;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
    }
    for (let value = minMajorZ * majorStep; value <= maxWorldZ + majorStep; value += majorStep) {
      const y = oz + value * scale;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
    }

    const toPx = (x: number, z: number) => ({ x: ox + x * scale, y: oz + z * scale });
    const roomPath = new Path2D();
    room.vertices.forEach((vertex, index) => {
      const point = toPx(vertex.x, vertex.z);
      if (index === 0) roomPath.moveTo(point.x, point.y);
      else roomPath.lineTo(point.x, point.y);
    });
    roomPath.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill(roomPath);

    if (purpose === 'furnish' && selected && showClearance) {
      const zone = clearanceAabb(selected);
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#c28c3d';
      ctx.fillStyle = 'rgba(194, 140, 61, 0.07)';
      const x = ox + zone.minX * scale;
      const y = oz + zone.minZ * scale;
      const w = (zone.maxX - zone.minX) * scale;
      const h = (zone.maxZ - zone.minZ) * scale;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    if (purpose === 'furnish') {
      for (const obj of objects) {
        const p = PRODUCTS[obj.productId];
        const size = rotatedFootprint(p, obj.rotationY);
        const x = ox + (obj.x - size.width / 2) * scale;
        const y = oz + (obj.z - size.depth / 2) * scale;
        const w = size.width * scale;
        const h = size.depth * scale;
        ctx.fillStyle = obj.id === selectedId ? '#dbe7f4' : p.swatch;
        ctx.strokeStyle = obj.id === selectedId ? '#1769aa' : '#6f746f';
        ctx.lineWidth = obj.id === selectedId ? 2.5 : 1.25;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, Math.min(7, w * 0.12, h * 0.12));
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#26302d';
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (w > 52 && h > 30) ctx.fillText(p.name, x + w / 2, y + h / 2, Math.max(24, w - 10));
      }
    }

    const walls = getRoomWalls(room);
    for (const wall of walls) {
      const a = toPx(wall.start.x, wall.start.z);
      const b = toPx(wall.end.x, wall.end.z);
      const selectedWall = purpose === 'build' && wall.id === selectedWallId;
      const hoveredWall = purpose === 'build' && hover?.type === 'wall' && hover.id === wall.id;
      const draggingWall = purpose === 'build' && drag?.type === 'wall' && drag.id === wall.id;
      ctx.strokeStyle = (hoveredWall || draggingWall) ? HOVER_CYAN : selectedWall ? '#1769aa' : '#252a28';
      ctx.lineWidth = (hoveredWall || draggingWall) ? 7.5 : selectedWall ? 7 : (purpose === 'build' ? 5 : 3);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Openings erase a clean gap in the wall and then draw their own symbol.
    for (const opening of openings) {
      const points = openingPoints(opening, room);
      if (!points) continue;
      const a = toPx(points.start.x, points.start.z);
      const b = toPx(points.end.x, points.end.z);
      const isSelected = opening.id === selectedOpeningId;
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const hoveredOpening = purpose === 'build' && hover?.type === 'opening' && hover.id === opening.id;
      const draggingOpening = purpose === 'build' && drag?.type === 'opening' && drag.id === opening.id;
      const baseOpeningColor = opening.type === 'door' ? '#2f6f5e' : opening.type === 'opening' ? '#7b817e' : '#4f8fa8';
      ctx.strokeStyle = (hoveredOpening || draggingOpening) ? HOVER_CYAN : baseOpeningColor;
      ctx.lineWidth = (hoveredOpening || draggingOpening) ? 5.8 : isSelected ? 5.5 : 3.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

      if (opening.type === 'door' && opening.variant !== 'door-frame') {
        const n = points.wall.inward;
        const open = toPx(points.start.x + n.x * opening.width, points.start.z + n.z * opening.width);
        ctx.strokeStyle = '#6d756f';
        ctx.lineWidth = 1.25;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(open.x, open.y); ctx.stroke();
        const control = { x: b.x + n.x * opening.width * scale, y: b.y + n.z * opening.width * scale };
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.quadraticCurveTo(control.x, control.y, open.x, open.y); ctx.stroke();
      }
      if (purpose === 'build' && isSelected) {
        const sameType = openings.filter((item) => item.type === opening.type);
        const openingNumber = sameType.findIndex((item) => item.id === opening.id) + 1;
        const labelWorld = { x: points.centre.x + points.wall.inward.x * 0.23, z: points.centre.z + points.wall.inward.z * 0.23 };
        const label = toPx(labelWorld.x, labelWorld.z);
        ctx.font = '500 9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#929895';
        const kind = opening.type === 'door' ? 'Door' : opening.type === 'opening' ? 'Opening' : 'Window';
        ctx.fillText(`${kind} ${openingNumber}`, label.x, label.y);
      }
      ctx.restore();
    }

    if (purpose === 'furnish' && activeSnap.kind !== 'none') {
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = '#1769aa';
      ctx.lineWidth = 1.4;
      if (activeSnap.x) {
        const x = ox + activeSnap.x.value * scale;
        ctx.beginPath(); ctx.moveTo(x, oz - 20); ctx.lineTo(x, oz + room.depth * scale + 20); ctx.stroke();
      }
      if (activeSnap.z) {
        const y = oz + activeSnap.z.value * scale;
        ctx.beginPath(); ctx.moveTo(ox - 20, y); ctx.lineTo(ox + room.width * scale + 20, y); ctx.stroke();
      }
      ctx.restore();
    }

    if (purpose === 'build') {
      // Per-wall measurements are far more useful than a single bounding dimension for custom rooms.
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const wall of walls) {
        const midX = (wall.start.x + wall.end.x) / 2;
        const midZ = (wall.start.z + wall.end.z) / 2;
        const label = toPx(midX - wall.inward.x * 0.34, midZ - wall.inward.z * 0.34);
        const text = formatLength(wall.length, measurementSystem);
        ctx.font = '600 11px system-ui, sans-serif';
        const idText = `Wall ${wall.index + 1}`;
        const lengthMetrics = ctx.measureText(text);
        ctx.font = '500 9px system-ui, sans-serif';
        const idMetrics = ctx.measureText(idText);
        const boxWidth = Math.max(lengthMetrics.width, idMetrics.width) + 12;
        ctx.fillStyle = 'rgba(248,248,246,.95)';
        ctx.fillRect(label.x - boxWidth / 2, label.y - 15, boxWidth, 30);
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillStyle = wall.id === selectedWallId ? '#1769aa' : '#555d59';
        ctx.fillText(text, label.x, label.y - 4);
        ctx.font = '500 9px system-ui, sans-serif';
        ctx.fillStyle = wall.id === selectedWallId ? '#6f93ae' : '#9a9f9c';
        ctx.fillText(idText, label.x, label.y + 8);
      }

      // Corner handles: neutral by default, electric cyan on hover/drag.
      for (const vertex of room.vertices) {
        const point = toPx(vertex.x, vertex.z);
        const active = (hover?.type === 'corner' && hover.id === vertex.id) || (drag?.type === 'corner' && drag.id === vertex.id);
        ctx.fillStyle = active ? HOVER_CYAN : '#5f6964';
        ctx.beginPath(); ctx.arc(point.x, point.y, active ? 8 : 7, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
      }

      // Mid-wall split affordances. Clicking + inserts a real editable corner.
      for (const wall of walls) {
        if (wall.length < 0.95) continue;
        const mid = toPx(
          (wall.start.x + wall.end.x) / 2 - wall.inward.x * 0.18,
          (wall.start.z + wall.end.z) / 2 - wall.inward.z * 0.18
        );
        const active = hover?.type === 'split' && hover.id === wall.id;
        ctx.save();
        ctx.fillStyle = active ? HOVER_CYAN : 'rgba(255,255,255,.96)';
        ctx.strokeStyle = active ? HOVER_CYAN : '#aeb4b0';
        ctx.lineWidth = active ? 2.2 : 1.4;
        ctx.beginPath(); ctx.arc(mid.x, mid.y, active ? 10 : 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = active ? '#06444b' : '#68706c';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(mid.x - 4, mid.y); ctx.lineTo(mid.x + 4, mid.y); ctx.moveTo(mid.x, mid.y - 4); ctx.lineTo(mid.x, mid.y + 4); ctx.stroke();
        ctx.restore();
      }

      // Interior angles are persistent drafting information, not a transient hover aid.
      const centre = room.vertices.reduce((acc, vertex) => ({ x: acc.x + vertex.x, z: acc.z + vertex.z }), { x: 0, z: 0 });
      centre.x /= room.vertices.length;
      centre.z /= room.vertices.length;
      for (const vertex of room.vertices) {
        const angle = vertexInteriorAngle(room, vertex.id);
        if (angle == null) continue;
        const point = toPx(vertex.x, vertex.z);
        const towardX = centre.x - vertex.x;
        const towardZ = centre.z - vertex.z;
        const towardLength = Math.hypot(towardX, towardZ) || 1;
        const labelX = point.x + (towardX / towardLength) * 22;
        const labelY = point.y + (towardZ / towardLength) * 22;
        const active = (hover?.type === 'corner' && hover.id === vertex.id) || (drag?.type === 'corner' && drag.id === vertex.id);
        ctx.save();
        ctx.font = active ? '700 10px system-ui, sans-serif' : '600 9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(255,255,255,.92)';
        ctx.strokeText(`${angle.toFixed(1)}°`, labelX, labelY);
        ctx.fillStyle = active ? '#008fa3' : '#8b918e';
        ctx.fillText(`${angle.toFixed(1)}°`, labelX, labelY);
        ctx.restore();
      }

      const area = Math.abs(polygonArea(room.vertices));
      ctx.fillStyle = '#6b716e';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      const bounds = roomBounds(room.vertices);
      const areaAnchor = toPx(bounds.minX, bounds.minZ);
      ctx.fillText(formatArea(area, measurementSystem), areaAnchor.x + 8, areaAnchor.y + 18);
    }
  }, [activeSnap, drag, hover, measurementSystem, objects, openings, purpose, resizeTick, room, selected, selectedId, selectedOpeningId, selectedWallId, showClearance]);

  const hitOpening = (px: number, py: number, scale: number, ox: number, oz: number) => {
    return [...openings].reverse().find((opening) => {
      const points = openingPoints(opening, room);
      if (!points) return false;
      const a = { x: ox + points.start.x * scale, y: oz + points.start.z * scale };
      const b = { x: ox + points.end.x * scale, y: oz + points.end.z * scale };
      return pointSegmentDistance(px, py, a.x, a.y, b.x, b.y) <= 13;
    });
  };

  const hitCorner = (px: number, py: number, scale: number, ox: number, oz: number) => {
    return room.vertices.find((vertex) => Math.hypot(px - (ox + vertex.x * scale), py - (oz + vertex.z * scale)) <= 15) ?? null;
  };

  const hitWall = (px: number, py: number, scale: number, ox: number, oz: number) => {
    const world = { x: (px - ox) / scale, z: (py - oz) / scale };
    return getRoomWalls(room)
      .map((wall) => ({ wall, distance: distanceToWall(wall, world) }))
      .filter(({ distance }) => distance <= 14 / scale)
      .sort((a, b) => a.distance - b.distance)[0]?.wall ?? null;
  };

  const hitSplit = (px: number, py: number, scale: number, ox: number, oz: number) => {
    return getRoomWalls(room).find((wall) => {
      if (wall.length < 0.95) return false;
      const mx = ox + (((wall.start.x + wall.end.x) / 2) - wall.inward.x * 0.18) * scale;
      const my = oz + (((wall.start.z + wall.end.z) / 2) - wall.inward.z * 0.18) * scale;
      return Math.hypot(px - mx, py - my) <= 13;
    }) ?? null;
  };

  const updateBuildHover = (canvas: HTMLCanvasElement, px: number, py: number, scale: number, ox: number, oz: number) => {
    const corner = hitCorner(px, py, scale, ox, oz);
    if (corner) {
      setHover((current) => current?.type === 'corner' && current.id === corner.id ? current : { type: 'corner', id: corner.id });
      canvas.style.cursor = 'pointer';
      return;
    }
    const opening = hitOpening(px, py, scale, ox, oz);
    if (opening) {
      setHover((current) => current?.type === 'opening' && current.id === opening.id ? current : { type: 'opening', id: opening.id });
      canvas.style.cursor = 'pointer';
      return;
    }
    const split = hitSplit(px, py, scale, ox, oz);
    if (split) {
      setHover((current) => current?.type === 'split' && current.id === split.id ? current : { type: 'split', id: split.id });
      canvas.style.cursor = 'pointer';
      return;
    }
    const wall = hitWall(px, py, scale, ox, oz);
    if (wall) {
      setHover((current) => current?.type === 'wall' && current.id === wall.id ? current : { type: 'wall', id: wall.id });
      canvas.style.cursor = 'pointer';
      return;
    }
    setHover(null);
    canvas.style.cursor = 'default';
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { rect, scale, ox, oz } = metrics();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const before = getSnapshot();
    const view = { scale, ox, oz };

    if (purpose === 'build') {
      const corner = hitCorner(px, py, scale, ox, oz);
      if (corner) {
        selectWall(null);
        setDrag({ type: 'corner', id: corner.id, before, view });
        e.currentTarget.style.cursor = 'grabbing';
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      const opening = hitOpening(px, py, scale, ox, oz);
      if (opening) {
        selectOpening(opening.id);
        setDrag({ type: 'opening', id: opening.id, before, view });
        e.currentTarget.style.cursor = 'grabbing';
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      const split = hitSplit(px, py, scale, ox, oz);
      if (split) {
        splitWallById(split.id);
        e.currentTarget.style.cursor = 'pointer';
        return;
      }
      const wall = hitWall(px, py, scale, ox, oz);
      if (wall) {
        selectWall(wall.id);
        setDrag({ type: 'wall', id: wall.id, before, view });
        e.currentTarget.style.cursor = 'grabbing';
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      selectOpening(null);
      selectWall(null);
      return;
    }

    const worldX = (px - ox) / scale;
    const worldZ = (py - oz) / scale;
    const hit = [...objects].reverse().find((obj) => {
      const size = rotatedFootprint(PRODUCTS[obj.productId], obj.rotationY);
      return worldX >= obj.x - size.width / 2 && worldX <= obj.x + size.width / 2 && worldZ >= obj.z - size.depth / 2 && worldZ <= obj.z + size.depth / 2;
    });
    if (hit) {
      select(hit.id);
      setDrag({ type: 'object', id: hit.id, before, snap: { kind: 'none' } });
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      select(null);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const { rect, scale, ox, oz } = metrics();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (!drag) {
      if (purpose === 'build') updateBuildHover(e.currentTarget, px, py, scale, ox, oz);
      return;
    }

    e.currentTarget.style.cursor = purpose === 'build' ? 'grabbing' : e.currentTarget.style.cursor;
    const world = { x: (px - ox) / scale, z: (py - oz) / scale };
    const gridStep = measurementSystem === 'metric'
      ? (e.shiftKey ? 0.01 : 0.05)
      : (e.shiftKey ? 0.0127 : 0.0508); // 1/2 inch or 2 inches
    const snappedWorld = {
      x: Math.round(world.x / gridStep) * gridStep,
      z: Math.round(world.z / gridStep) * gridStep
    };

    if (drag.type === 'corner') {
      const vertices = moveCorner(drag.before.room, drag.id, snappedWorld.x, snappedWorld.z);
      if (vertices) setRoomVertices(vertices, 'custom');
      return;
    }
    if (drag.type === 'wall') {
      const wall = getWall(drag.before.room, drag.id);
      if (!wall) return;
      const vertices = moveWall(drag.before.room, drag.id, snappedWorld);
      if (vertices) setRoomVertices(vertices, 'custom');
      return;
    }
    if (drag.type === 'opening') {
      const opening = openings.find((o) => o.id === drag.id);
      if (!opening) return;
      const wall = getWall(room, opening.wallId);
      if (!wall) return;
      const raw = wallProjectionDistance(wall, world);
      const next = Math.max(opening.width / 2 + 0.05, Math.min(raw, wall.length - opening.width / 2 - 0.05));
      updateOpening(opening.id, { offset: next }, false);
      return;
    }
    if (drag.type === 'object') {
      const obj = objects.find((o) => o.id === drag.id);
      if (!obj) return;
      const others = objects.filter((o) => o.id !== obj.id);
      const freeMove = e.shiftKey;
      const resolved = resolvePlacement(obj, world.x, world.z, room, others, {
        previousSnap: freeMove ? undefined : drag.snap,
        enterSnapDistance: freeMove ? 0 : undefined,
        exitSnapDistance: freeMove ? 0 : undefined,
        spatialWallSnap: !freeMove,
        allowOverlap: freeMove
      });
      drag.snap = resolved.snap;
      updateObject(obj.id, { x: resolved.x, z: resolved.z });
      setFeedback(resolved.snap, resolved.colliding ? obj.id : null, resolved.pushedByCollision);
    }
  };

  const onPointerUp = (e?: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    commitSnapshot(drag.before);
    setDrag(null);
    setFeedback({ kind: 'none' }, null, false);
    if (e && purpose === 'build') e.currentTarget.style.cursor = hover ? 'pointer' : 'default';
  };

  const onPointerLeave = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag) return;
    setHover(null);
    e.currentTarget.style.cursor = 'default';
  };

  return (
    <div className={`plan-stage ${purpose}`}>
      <canvas
        ref={canvasRef}
        aria-label={purpose === 'build' ? 'Editable room floor plan' : 'Furniture floor plan'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      />
      {purpose === 'build' && (
        <div className="plan-help" aria-hidden="true">
          <span><i className="help-dot corner" /> Drag a corner</span>
          <span><i className="help-line" /> Drag a wall · corners can angle</span>
          <span><i className="help-plus">+</i> Split a wall</span>
          <span>{measurementSystem === 'metric' ? '50 cm guide cells · 5 cm snap · Shift for 1 cm' : '1 ft guide cells · 2 in snap · Shift for ½ in'}</span>
        </div>
      )}
    </div>
  );
}
