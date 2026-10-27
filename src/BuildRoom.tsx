import { FEATURES } from './config/features';
import { activeArchitecture } from './core/activeArchitecture';
import { lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent } from 'react';
import { Plan2D } from './Plan2D';
import { getRoomWalls, getWall, MIN_WALL_LENGTH, MIN_CIRCLE_DIAMETER, moveCorner, roomBounds, openingFollowsPerimeter, perimeterLocation, polygonArea } from './core/roomGeometry';
import { deriveSpaces, getPhysicalWalls, resolveDividers } from './core/spaces';
import { dimensionStepMetres, displayLengthValue, displayValueToMetres, formatArea, formatLength, lengthInputSuffix } from './core/units';
import type { MeasurementSystem, OpeningVariant, RoomOpening, RoomShapeKind } from './core/types';
import { getSnapshot, usePlannerStore } from './store';
import { Button, Icon } from './ui';
import { openingVisibleInActiveView, openingVisibilityRevision, subscribeOpeningVisibility } from './core/openingVisibility';
import { openingSliderRange } from './core/openingSliderRange';
import { LoadingBoundary, useLoadingSurface } from './LoadingStatus';
import { MobileSheet } from './MobileSheet';
import { useCompactWorkspace, useMobileWorkspace } from './mobileWorkspace';

const Viewport3D = lazy(() => import('./Viewport3D').then((module) => ({ default: module.Viewport3D })));


const OPENING_VARIANTS: Record<RoomOpening['type'], Array<{ id: OpeningVariant; label: string }>> = {
  window: [
    { id: 'single-window', label: 'Single glass window' },
    { id: 'double-window', label: 'Double glass window' },
    { id: 'single-hung-window', label: 'Single-hung window' },
    { id: 'full-height-window', label: 'Floor-to-ceiling window' },
    { id: 'high-window', label: 'High / top window' },
    { id: 'sliding-window', label: 'Sliding glass / pathway' }
  ],
  door: [
    { id: 'single-door', label: 'Single door' },
    { id: 'double-door', label: 'Double doors' },
    { id: 'door-frame', label: 'Door frame only' },
    { id: 'glass-door', label: 'Glass door' },
    { id: 'semi-glass-door', label: 'Semi-glazed panel door' },
    { id: 'glass-double-door', label: 'Double glass doors' }
  ],
  opening: [
    { id: 'wall-opening', label: 'Custom wall opening' }
  ]
};

function openingKindLabel(type: RoomOpening['type']) {
  if (type === 'door') return 'Door';
  if (type === 'opening') return 'Opening';
  return 'Window';
}

const SHAPES: Array<{ id: Exclude<RoomShapeKind, 'custom'>; name: string; description: string; path: string }> = [
  { id: 'rectangle', name: 'Rectangle', description: 'Simple four-wall room', path: 'M4 5h16v14H4z' },
  { id: 'rounded-rectangle', name: 'Rounded rectangle', description: 'Straight sides with rounded corners', path: 'M8 5h8a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Z' },
  { id: 'circle', name: 'Circle', description: 'Round room with an adjustable diameter', path: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z' },
  { id: 'angled-corner', name: 'Angled corner', description: 'Five walls with one diagonal corner', path: 'M4 5h11l5 5v9H4z' },
  { id: 'l-shape', name: 'L-shape', description: 'Connected spaces or alcoves', path: 'M4 4h16v8h-8v8H4z' },
  { id: 'recess', name: 'Recess', description: 'Room with a built-in notch', path: 'M4 4h16v16h-5v-6H9v6H4z' }
];

function DimensionField({ label, value, min, max, system, metricStep = 0.05, onCommit }: {
  label: string;
  value: number;
  min: number;
  max: number;
  system: MeasurementSystem;
  metricStep?: number;
  onCommit: (value: number) => void | boolean;
}) {
  const compact = useCompactWorkspace();
  const display = displayLengthValue(value, system);
  const [draft, setDraft] = useState(display.toFixed(2));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(displayLengthValue(value, system).toFixed(2)); setError(''); }, [system, value]);

  const commit = () => {
    const parsed = Number(draft.trim().replace(',', '.'));
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setError('Enter a valid length.');
      setDraft(displayLengthValue(value, system).toFixed(2));
      return;
    }
    const rawMetres = displayValueToMetres(parsed, system);
    if (compact && (rawMetres < min || rawMetres > max)) {
      setError(`Enter a value from ${formatLength(min, system)} to ${formatLength(max, system)}.`);
      setDraft(displayLengthValue(value, system).toFixed(2));
      return;
    }
    setError('');
    const step = dimensionStepMetres(system, metricStep);
    const next = Math.max(min, Math.min(max, Math.round(rawMetres / step) * step));
    if (Math.abs(next - value) > 0.0001) {
      const accepted = onCommit(next);
      if (accepted === false) setError('That size does not fit the current room. The previous value has been kept.');
      setDraft(displayLengthValue(accepted === false ? value : next, system).toFixed(2));
    } else {
      setDraft(displayLengthValue(next, system).toFixed(2));
    }
  };

  return (
    <label className="dimension-field">
      <span>{label}</span>
      <span className="input-with-suffix">
        <input
          inputMode="decimal"
          aria-invalid={!!error}
          value={draft}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          aria-label={`${label} in ${system === 'metric' ? 'metres' : 'feet'}`}
        />
        <small>{lengthInputSuffix(system)}</small>
      </span>
      {error && <small className="field-error" role="alert">{error}</small>}
    </label>
  );
}

function EditableRangeValue({ label, value, min, max, system, metricStep = 0.01, onCommit }: {
  label: string;
  value: number;
  min: number;
  max: number;
  system: MeasurementSystem;
  metricStep?: number;
  onCommit: (value: number) => void | boolean;
}) {
  const compact = useCompactWorkspace();
  const [draft, setDraft] = useState(displayLengthValue(value, system).toFixed(2));
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(displayLengthValue(value, system).toFixed(2));
    setError('');
  }, [system, value]);

  const commit = () => {
    const parsed = Number(draft.trim().replace(',', '.'));
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setError('Enter a valid length.');
      setDraft(displayLengthValue(value, system).toFixed(2));
      return;
    }

    const rawMetres = displayValueToMetres(parsed, system);
    if (compact && (rawMetres < min || rawMetres > max)) {
      setError(`Enter a value from ${formatLength(min, system)} to ${formatLength(max, system)}.`);
      setDraft(displayLengthValue(value, system).toFixed(2));
      return;
    }
    setError('');
    const step = dimensionStepMetres(system, metricStep);
    const next = Math.max(min, Math.min(max, Math.round(rawMetres / step) * step));
    const accepted = Math.abs(next - value) > 0.0001 ? onCommit(next) : true;
    if (accepted === false) setError('That size does not fit the current room. The previous value has been kept.');
    setDraft(displayLengthValue(accepted === false ? value : next, system).toFixed(2));
  };

  return (
    <div className="range-value-row">
      <span>{label}</span>
      <span className="range-editable-value">
        <input
          inputMode="decimal"
          aria-invalid={!!error}
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          aria-label={`${label} in ${system === 'metric' ? 'metres' : 'feet'}`}
        />
        <small>{lengthInputSuffix(system)}</small>
      </span>
      {error && <small className="field-error" role="alert">{error}</small>}
    </div>
  );
}


function wallAngleLabel(start: { x: number; z: number }, end: { x: number; z: number }) {
  const degrees = Math.atan2(end.z - start.z, end.x - start.x) * 180 / Math.PI;
  const undirected = ((degrees % 180) + 180) % 180;
  const normalized = Math.abs(undirected - 180) < 0.05 ? 0 : undirected;
  return `${normalized.toFixed(1)}° wall`;
}

function openingDisplayName(opening: RoomOpening, openings: RoomOpening[]) {
  const sameType = openings.filter((item) => item.type === opening.type);
  const index = sameType.findIndex((item) => item.id === opening.id);
  return `${openingKindLabel(opening.type)} ${Math.max(0, index) + 1}`;
}

function OpeningEditor({ opening }: { opening: RoomOpening }) {
  const room = usePlannerStore((s) => s.room);
  const dividers = usePlannerStore((s) => s.dividers);
  const savedOpenings = usePlannerStore((s) => s.openings);
  const openings = useMemo(() => FEATURES.interiorWalls ? savedOpenings : savedOpenings.filter((opening) => !opening.wallId.startsWith('divider-')), [savedOpenings]);
  const system = usePlannerStore((s) => s.measurementSystem);
  const updateOpeningState = usePlannerStore((s) => s.updateOpening);
  const buildView = usePlannerStore((s) => s.buildView);
  const visibilityRevision = useSyncExternalStore(subscribeOpeningVisibility, openingVisibilityRevision);
  const interiorWallView = usePlannerStore((s) => s.interiorWallView);
  const [fitWarning, setFitWarning] = useState('');
  const updateOpening = (id: string, patch: Partial<RoomOpening>, recordHistory = true) => {
    const accepted = updateOpeningState(id, patch, recordHistory, buildView === '3d' ? openingVisibleInActiveView : undefined);
    setFitWarning(accepted ? '' : 'This change needs enough clear, visible wall space. Choose another position or a smaller size.');
    return accepted;
  };
  const removeOpening = usePlannerStore((s) => s.removeOpening);
  const commitSnapshot = usePlannerStore((s) => s.commitSnapshot);
  const sliderBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const sizeBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const sliderRaf = useRef<number | null>(null);
  const pendingOffset = useRef(opening.offset);
  const walls = useMemo(() => getPhysicalWalls(room, FEATURES.interiorWalls ? dividers : []).filter((segment) => opening.type !== 'window' || !!getWall(room, segment.id)), [room, dividers, opening.type]);
  const wall = walls.find((candidate) => candidate.id === opening.wallId);
  const maxOffset = wall?.length ?? 1;
  const curved = openingFollowsPerimeter(room, opening);
  const perimeterWalls = getRoomWalls(room);
  const perimeter = perimeterWalls.reduce((sum, wall) => sum + wall.length, 0);
  const position = curved ? perimeterWalls.slice(0, wall?.index ?? 0).reduce((sum, wall) => sum + wall.length, 0) + opening.offset : opening.offset;
  const positionPatch = (offset: number): Partial<RoomOpening> => {
    if (!curved) return { offset };
    return perimeterLocation(room, offset);
  };
  const baseMinOffset = curved ? 0 : opening.width / 2 + 0.05;
  const baseEndOffset = curved ? perimeter : Math.max(baseMinOffset, maxOffset - opening.width / 2 - 0.05);
  const { min: minOffset, max: endOffset } = useMemo(() => buildView === '3d'
    ? openingSliderRange(room, opening, baseMinOffset, baseEndOffset, openingVisibleInActiveView, FEATURES.interiorWalls ? dividers : [])
    : { min: baseMinOffset, max: baseEndOffset }, [room, opening, buildView, baseMinOffset, baseEndOffset, visibilityRevision, dividers, interiorWallView]);
  const maxWidth = curved ? (opening.type === 'opening' ? perimeter : perimeter / 4) - 0.2 : maxOffset - 0.2;
  const minOpeningWidth = opening.type === 'opening' ? 0.10 : 0.45;
  const minOpeningHeight = opening.type === 'opening' ? 0.10 : 0.40;

  useEffect(() => () => { if (sliderRaf.current != null) cancelAnimationFrame(sliderRaf.current); }, []);

  const previewOffset = (offset: number) => {
    pendingOffset.current = offset;
    if (sliderRaf.current != null) return;
    sliderRaf.current = requestAnimationFrame(() => {
      sliderRaf.current = null;
      updateOpening(opening.id, positionPatch(pendingOffset.current), false);
    });
  };

  const finishSlider = () => {
    if (sliderRaf.current != null) {
      cancelAnimationFrame(sliderRaf.current);
      sliderRaf.current = null;
      updateOpening(opening.id, positionPatch(pendingOffset.current), false);
    }
    if (sliderBefore.current) commitSnapshot(sliderBefore.current);
    sliderBefore.current = null;
  };

  const beginSize = () => { if (!sizeBefore.current) sizeBefore.current = getSnapshot(); };
  const finishSize = () => {
    if (sizeBefore.current) commitSnapshot(sizeBefore.current);
    sizeBefore.current = null;
  };

  return (
    <div className="opening-editor">
      <div className="opening-editor-title">
        <div>
          <strong>{openingDisplayName(opening, openings)}</strong>
          <span>{curved ? `Room perimeter · ${formatLength(perimeter, system)}` : wall ? `${wall.id.startsWith('divider-') ? 'Interior wall' : `Wall ${wall.index + 1}`} · ${formatLength(wall.length, system)}` : 'Selected opening'}</span>
        </div>
        <div className="opening-editor-actions">
          {opening.type === 'door' && opening.variant !== 'door-frame' && <button type="button" className="small-button"
            aria-label="Flip door direction" title="Flip door direction" aria-pressed={!!opening.doorFlipped}
            onClick={() => updateOpening(opening.id, { doorFlipped: !opening.doorFlipped })}>↔ Flip</button>}
          <button className="text-danger" type="button" onClick={() => removeOpening(opening.id)}>Remove</button>
        </div>
      </div>
      {fitWarning && <p className="hint" role="alert">{fitWarning}</p>}
      <div className="opening-type-grid">
        <label className="field-label">Kind
          <select
            value={opening.type}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => updateOpening(opening.id, { type: e.target.value as RoomOpening['type'] })}
          >
            {room.shapeKind !== 'circle' && <option value="window" disabled={opening.wallId.startsWith('divider-')}>Window</option>}
            <option value="door">Door</option>
            <option value="opening">Wall opening</option>
          </select>
        </label>
        <label className="field-label">Style
          <select
            value={opening.variant}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => updateOpening(opening.id, { variant: e.target.value as OpeningVariant })}
          >
            {OPENING_VARIANTS[opening.type].map((variant) => <option key={variant.id} value={variant.id}>{variant.label}</option>)}
          </select>
        </label>
      </div>
      {!curved && <label className="field-label">Wall
        <select
          value={opening.wallId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
            const nextWall = walls.find((candidate) => candidate.id === e.target.value);
            if (nextWall) updateOpening(opening.id, { wallId: nextWall.id, offset: nextWall.length / 2 });
          }}
        >
          {walls.map((segment) => (
            <option key={segment.id} value={segment.id}>{segment.id.startsWith('divider-') ? 'Interior wall' : `Wall ${segment.index + 1}`} · {formatLength(segment.length, system)}</option>
          ))}
        </select>
      </label>}
      <label className="field-label range-field">
        <EditableRangeValue
          label={curved ? 'Position around room' : 'Horizontal Position'}
          value={position}
          min={minOffset}
          max={endOffset}
          system={system}
          onCommit={(offset) => updateOpening(opening.id, positionPatch(offset))}
        />
        <input
          className="range"
          type="range"
          disabled={endOffset - minOffset < 0.0001}
          min={minOffset}
          max={endOffset}
          step={system === 'metric' ? 0.01 : 0.0254}
          value={position}
          onFocus={() => { if (!sliderBefore.current) sliderBefore.current = getSnapshot(); }}
          onPointerDown={() => { if (!sliderBefore.current) sliderBefore.current = getSnapshot(); }}
          onChange={(e: ChangeEvent<HTMLInputElement>) => previewOffset(Number(e.target.value))}
          onPointerUp={finishSlider}
          onBlur={finishSlider}
        />
      </label>
      <div className="opening-size-sliders">
        <label className="field-label range-field">
          <EditableRangeValue label="Width" value={opening.width} min={minOpeningWidth} max={Math.max(minOpeningWidth, maxWidth)} system={system} onCommit={(width) => updateOpening(opening.id, { width })} />
          <input className="range" type="range" min={minOpeningWidth} max={Math.max(minOpeningWidth, maxWidth)} step={system === 'metric' ? 0.01 : 0.0127} value={opening.width}
            onPointerDown={beginSize} onFocus={beginSize}
            onChange={(e) => updateOpening(opening.id, { width: Number(e.target.value) }, false)}
            onPointerUp={finishSize} onBlur={finishSize} />
        </label>
        <label className="field-label range-field">
          <EditableRangeValue label="Height" value={opening.height} min={minOpeningHeight} max={Math.max(minOpeningHeight, room.height - opening.sillHeight)} system={system} onCommit={(height) => updateOpening(opening.id, { height })} />
          <input className="range" type="range" min={minOpeningHeight} max={Math.max(minOpeningHeight, room.height - opening.sillHeight)} step={system === 'metric' ? 0.01 : 0.0127} value={opening.height}
            onPointerDown={beginSize} onFocus={beginSize}
            onChange={(e) => updateOpening(opening.id, { height: Number(e.target.value) }, false)}
            onPointerUp={finishSize} onBlur={finishSize} />
        </label>
      </div>
      {opening.type !== 'door' && !(opening.type === 'opening' && opening.wallId.startsWith('divider-'))
        && opening.variant !== 'full-height-window' && opening.variant !== 'sliding-window' && (
        <label className="field-label range-field vertical-position-slider">
          <EditableRangeValue label="Vertical Position" value={opening.sillHeight} min={0} max={Math.max(0, room.height - opening.height)} system={system} onCommit={(sillHeight) => updateOpening(opening.id, { sillHeight })} />
          <input
            className="range"
            type="range"
            min={0}
            max={Math.max(0, room.height - opening.height)}
            step={system === 'metric' ? 0.01 : 0.0127}
            value={opening.sillHeight}
            onPointerDown={beginSize}
            onFocus={beginSize}
            onChange={(e) => updateOpening(opening.id, { sillHeight: Number(e.target.value) }, false)}
            onPointerUp={finishSize}
            onBlur={finishSize}
          />
        </label>
      )}
    </div>
  );
}

function WallEditor({ wallId }: { wallId: string }) {
  const compact = useCompactWorkspace();
  const room = usePlannerStore((s) => s.room);
  const system = usePlannerStore((s) => s.measurementSystem);
  const resizeWallById = usePlannerStore((s) => s.resizeWallById);
  const syncSpaces = usePlannerStore((s) => s.syncSpaces);
  const splitWallById = usePlannerStore((s) => s.splitWallById);
  const sliderBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const wall = getWall(room, wallId);
  if (!wall) return null;

  const finishSlider = () => {
    if (sliderBefore.current) syncSpaces(sliderBefore.current);
    sliderBefore.current = null;
  };

  return (
    <div className="wall-editor">
      <div className="opening-editor-title">
        <div>
          <strong>Wall {wall.index + 1}</strong>
          <span>{wallAngleLabel(wall.start, wall.end)}</span>
        </div>
      </div>
      <label className="field-label wall-length-slider">
        <EditableRangeValue label="Adjust length" value={wall.length} min={MIN_WALL_LENGTH} max={20} system={system} metricStep={0.05} onCommit={(length) => resizeWallById(wall.id, length)} />
        <input
          className="range"
          type="range"
          min={MIN_WALL_LENGTH}
          max={20}
          step={system === 'metric' ? 0.05 : 0.0254}
          value={wall.length}
          onPointerDown={() => { if (!sliderBefore.current) sliderBefore.current = getSnapshot(); }}
          onFocus={() => { if (!sliderBefore.current) sliderBefore.current = getSnapshot(); }}
          onChange={(e) => resizeWallById(wall.id, Number(e.target.value), false)}
          onPointerUp={finishSlider}
          onBlur={finishSlider}
        />
      </label>
      <p className="hint">Drag the highlighted wall in the plan, or use the slider for symmetric resizing.</p>
      {compact && <button type="button" className="secondary-button" onClick={() => splitWallById(wallId)}>Split wall</button>}
    </div>
  );
}

function CornerEditor({ cornerId }: { cornerId: string }) {
  const room = usePlannerStore((s) => s.room);
  const system = usePlannerStore((s) => s.measurementSystem);
  const corner = room.vertices.find((vertex) => vertex.id === cornerId);
  if (!corner) return null;
  const update = (axis: 'x' | 'z', value: number) => {
    const before = getSnapshot();
    const vertices = moveCorner(before.room, cornerId, axis === 'x' ? value : corner.x, axis === 'z' ? value : corner.z);
    if (!vertices) return false;
    const bounds = roomBounds(vertices);
    if (bounds.width > 20 || bounds.depth > 20 || getRoomWalls({ ...before.room, vertices }).some((wall) => wall.length > 20)) return false;
    const state = usePlannerStore.getState();
    state.setRoomVertices(vertices, 'custom');
    if (state.room === usePlannerStore.getState().room) return false;
    state.syncSpaces(before);
    return true;
  };
  return <div className="wall-editor">
    <div className="opening-editor-title"><strong>Corner {room.vertices.indexOf(corner) + 1}</strong></div>
    <DimensionField label="Corner X" value={corner.x} min={corner.x - 20} max={corner.x + 20} system={system} metricStep={0.01} onCommit={(value) => update('x', value)} />
    <DimensionField label="Corner Z" value={corner.z} min={corner.z - 20} max={corner.z + 20} system={system} metricStep={0.01} onCommit={(value) => update('z', value)} />
    <p className="hint">Set the corner position or drag its selected handle in the plan.</p>
  </div>;
}

export function BuildRoom() {
  const compact = useCompactWorkspace();
  const cornerId = useMobileWorkspace((s) => s.cornerId);
  const fineSnap = useMobileWorkspace((s) => s.fineSnap);
  const setFineSnap = useMobileWorkspace((s) => s.setFineSnap);
  const openSheet = useMobileWorkspace((s) => s.openSheet);
  const loadingSurface = useLoadingSurface();
  const [resetViewRequest, setResetViewRequest] = useState(0);
  const [dividerTool, setDividerTool] = useState<'wall' | 'open' | null>(null);
  const [openingWarning, setOpeningWarning] = useState('');
  const [radiusWarning, setRadiusWarning] = useState('');
  const diameterBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const radiusBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const beginRadius = () => { if (!radiusBefore.current) radiusBefore.current = getSnapshot(); };
  const finishRadius = () => {
    if (radiusBefore.current) usePlannerStore.getState().commitSnapshot(radiusBefore.current);
    radiusBefore.current = null;
  };
  const beginDiameter = () => { if (!diameterBefore.current) diameterBefore.current = getSnapshot(); };
  const finishDiameter = () => {
    if (diameterBefore.current) usePlannerStore.getState().commitSnapshot(diameterBefore.current);
    diameterBefore.current = null;
  };
  const room = usePlannerStore((s) => s.room);
  const savedOpenings = usePlannerStore((s) => s.openings);
  const openings = useMemo(() => FEATURES.interiorWalls ? savedOpenings : savedOpenings.filter((opening) => !opening.wallId.startsWith('divider-')), [savedOpenings]);
  const dividers = usePlannerStore((s) => s.dividers);
  const selectedDividerId = usePlannerStore((s) => s.selectedDividerId);
  const spaces = usePlannerStore((s) => s.spaces);
  const selectedSpaceId = usePlannerStore((s) => s.selectedSpaceId);
  const placedFurnitureCount = usePlannerStore((s) => s.objects.length);
  const system = usePlannerStore((s) => s.measurementSystem);
  const selectedOpeningId = usePlannerStore((s) => s.selectedOpeningId);
  const selectedWallId = usePlannerStore((s) => s.selectedWallId);
  const buildView = usePlannerStore((s) => s.buildView);
  const setBuildView = usePlannerStore((s) => s.setBuildView);
  const setMeasurementSystem = usePlannerStore((s) => s.setMeasurementSystem);
  const updateRoom = usePlannerStore((s) => s.updateRoom);
  const setRoomTemplate = usePlannerStore((s) => s.setRoomTemplate);
  const addOpening = usePlannerStore((s) => s.addOpening);
  const selectOpening = usePlannerStore((s) => s.selectOpening);
  const selectSpace = usePlannerStore((s) => s.selectSpace);
  const updateDivider = usePlannerStore((s) => s.updateDivider);
  const removeDivider = usePlannerStore((s) => s.removeDivider);
  const setMode = usePlannerStore((s) => s.setMode);
  const selectedOpening = openings.find((o) => o.id === selectedOpeningId) ?? null;
  const roomArea = Math.abs(polygonArea(room.vertices));
  const derivedSpaces = useMemo(() => deriveSpaces(activeArchitecture(usePlannerStore.getState())), [room, dividers, spaces]);
  const selectedSpace = FEATURES.interiorWalls ? derivedSpaces.find((space) => space.id === selectedSpaceId) ?? null : null;
  const selectedDivider = FEATURES.interiorWalls ? resolveDividers(room, dividers).find((divider) => divider.id === selectedDividerId) ?? null : null;
  const insertOpening = (type: RoomOpening['type']) => {
    const accepted = addOpening(type);
    setOpeningWarning(accepted ? '' : 'No free gap on this wall. Choose another wall or move an existing opening.');
    if (compact && accepted) useMobileWorkspace.getState().setCornerId(null);
  };
  useEffect(() => { setOpeningWarning(''); }, [selectedWallId, selectedDividerId, savedOpenings]);

  const changeShape = (shape: Exclude<RoomShapeKind, 'custom'>) => {
    if (shape === room.shapeKind) return;
    if (openings.length || placedFurnitureCount || dividers.length) {
      const effects = [
        openings.length ? `replace the current openings with a preset door and ${shape === 'circle' ? 'opening' : 'window'}` : '',
        placedFurnitureCount ? 'remove placed furniture from the room (it will remain in Used furniture)' : '',
        dividers.length ? 'remove interior divisions and their named spaces' : ''
      ].filter(Boolean).join(' and ');
      if (!window.confirm(`Changing the room shape will ${effects}. Continue?`)) return;
    }
    setRoomTemplate(shape);
    if (compact) useMobileWorkspace.getState().setCornerId(null);
  };

  const tools = <>
        <div className="builder-scroll-content">
        <div className="panel-intro">
          <h1>Room builder</h1>
          <p>{buildView === 'plan' ? (FEATURES.interiorWalls ? 'Arrange outer walls and interior divisions in 2D.' : 'Arrange outer walls in 2D.') : room.shapeKind === 'circle' ? 'Add and adjust doors and openings in 3D.' : 'Add and adjust doors, windows and openings in 3D.'}</p>
        </div>
        {compact && <label className="toggle-row"><input type="checkbox" checked={fineSnap} onChange={(event) => setFineSnap(event.target.checked)} /><span><strong>Fine snap</strong><small>Use smaller steps for precise wall and corner adjustments.</small></span></label>}

        {buildView === 'plan' && <><section className="tool-section">
          <div className="section-title-row">
            <div><h2 id="room-shape-heading">Room shape</h2></div>
            {room.shapeKind === 'custom' && <span className="quiet-pill">Custom</span>}
          </div>
          <div className="shape-options" role="group" aria-labelledby="room-shape-heading" aria-describedby="room-shape-hint">
            {SHAPES.map((shape) => (
              <button key={shape.id} type="button" title={shape.description} aria-pressed={room.shapeKind === shape.id} className={room.shapeKind === shape.id ? 'selected' : ''} onClick={() => changeShape(shape.id)}>
                <svg className="shape-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={shape.path} />
                </svg>
                <span>{shape.name}</span>
              </button>
            ))}
          </div>
          <p className="hint" id="room-shape-hint">Start with a shape. Drag walls or corners to adjust it, or use + to split a wall.{room.shapeKind === 'circle' && ' Use Diameter to resize the whole circle. Editing a dot creates a custom shape.'}</p>
          {room.shapeKind === 'rounded-rectangle' && <div className="rounded-corner-control">
            <EditableRangeValue label="Corner radius" value={room.cornerRadius ?? Math.min(room.width, room.depth) * 0.25}
              min={0} max={(Math.min(room.width, room.depth) - 0.2) / 2} system={system}
              onCommit={(cornerRadius) => {
                const accepted = updateRoom({ cornerRadius });
                setRadiusWarning(accepted ? '' : 'More rounding would leave too little wall space for the current doors or windows. Move or resize them first.');
                return accepted && Math.abs((usePlannerStore.getState().room.cornerRadius ?? 0) - cornerRadius) < 1e-6;
              }} />
            <input aria-label="Corner roundness" className="range" type="range" min={0} max={(Math.min(room.width, room.depth) - 0.2) / 2}
              step={0.05} value={room.cornerRadius ?? Math.min(room.width, room.depth) * 0.25}
              onPointerDown={beginRadius} onFocus={beginRadius}
              onChange={(event) => {
                beginRadius();
                const accepted = updateRoom({ cornerRadius: Number(event.target.value) }, false);
                setRadiusWarning(accepted ? '' : 'More rounding would leave too little wall space for the current doors or windows. Move or resize them first.');
              }}
              onPointerUp={finishRadius} onPointerCancel={finishRadius} onBlur={finishRadius} onKeyUp={finishRadius} />
            <p className="hint">Square to rounded corners. Sections adjust automatically; doors and windows keep their size.</p>
            {radiusWarning && <p className="hint" role="alert">{radiusWarning}</p>}
          </div>}
        </section>

        {FEATURES.interiorWalls && <section className="tool-section">
          <div className="section-title-row"><div><h2>Interior divisions</h2></div></div>
          <div className="opening-quick-add" aria-label="Draw a division">
            <button type="button" className={dividerTool === 'wall' ? 'selected' : ''} onClick={() => setDividerTool(dividerTool === 'wall' ? null : 'wall')}>Wall</button>
            <button type="button" className={dividerTool === 'open' ? 'selected' : ''} onClick={() => setDividerTool(dividerTool === 'open' ? null : 'open')}>Open boundary</button>
          </div>
          <p className="hint compact-hint">{dividerTool ? 'Click two existing boundaries in the 2D plan to connect them.' : 'Draw a wall or an invisible boundary to create a named space.'}</p>
          <div className="space-list">
            {derivedSpaces.map((space) => <button key={space.id} type="button" className={selectedSpaceId === space.id ? 'selected' : ''} onClick={() => selectSpace(space.id)}>{space.name} · {formatArea(space.area, system)}</button>)}
          </div>
        </section>}

        </>}

        <section className="tool-section opening-section">
          <div className="section-title-row"><div><h2>{room.shapeKind === 'circle' ? 'Doors & openings' : 'Doors, windows & openings'}</h2></div></div>
          <div className={`opening-quick-add ${room.shapeKind === 'circle' ? 'circle-openings' : ''}`} aria-label="Add an opening">
            <button type="button" disabled={selectedDivider?.kind === 'open'} onClick={() => insertOpening('door')}><span className="opening-add-mark" aria-hidden="true">+</span><span>Door</span></button>
            {room.shapeKind !== 'circle' && <button type="button" disabled={!!selectedDivider} title={selectedDivider ? 'Windows belong on exterior walls' : undefined}
              onClick={() => insertOpening('window')}><span className="opening-add-mark" aria-hidden="true">+</span><span>Window</span></button>}
            <button type="button" disabled={selectedDivider?.kind === 'open'} onClick={() => insertOpening('opening')}><span className="opening-add-mark" aria-hidden="true">+</span><span>Opening</span></button>
          </div>
          <p className="hint compact-hint">Select a wall first to place the opening there.</p>
          {openingWarning && <p className="hint compact-hint" role="alert">{openingWarning}</p>}
          {!!openings.length && (
            <label className="opening-selector">
              <span>Selected opening</span>
              <select
                value={selectedOpeningId ?? ''}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => { selectOpening(e.target.value || null); if (compact) useMobileWorkspace.getState().setCornerId(null); }}
                aria-label="Selected opening"
              >
                <option value="">Choose an opening…</option>
                {openings.map((opening) => {
                  const openingWall = getWall(room, opening.wallId);
                  return (
                    <option key={opening.id} value={opening.id}>
                      {openingDisplayName(opening, openings)}{openingWall ? room.shapeKind === 'circle' ? ' — Circular wall' : ` — Wall ${openingWall.index + 1}` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
        </section>

        {buildView === 'plan' && <section className="tool-section">
          <div className="section-title-row">
            <div><h2>Dimensions</h2></div>
            <div className="dimension-tools">
              <div className="unit-toggle" role="group" aria-label="Measurement units">
                <button type="button" className={system === 'metric' ? 'active' : ''} onClick={() => setMeasurementSystem('metric')}>Metric</button>
                <button type="button" className={system === 'imperial' ? 'active' : ''} onClick={() => setMeasurementSystem('imperial')}>Imperial</button>
              </div>
              <span className="quiet-pill">{room.shapeKind === 'circle' ? 'Circular' : `${room.vertices.length} walls`}</span>
            </div>
          </div>
          <div className="dimension-grid">
            <DimensionField label="Room height" value={room.height} min={1} max={3.3} system={system} metricStep={0.01} onCommit={(height) => updateRoom({ height })} />
          </div>
        </section>}

        {buildView === 'plan' && <p className="hint">Drag a door, window or opening along the walls to move it. Select it to change its size or style.</p>}
        </div>

        <div className="builder-inspector-dock" aria-live="polite">
          {compact && cornerId ? <CornerEditor cornerId={cornerId} /> : selectedOpening ? (
            <OpeningEditor key={selectedOpening.id} opening={selectedOpening} />
          ) : room.shapeKind === 'circle' && buildView === 'plan' && !selectedDivider && !selectedWallId ? (
            <div className="wall-editor">
              <div className="opening-editor-title"><strong>Circular room size</strong></div>
              <div className="circle-diameter-control">
                <DimensionField label="Diameter" value={room.width} min={MIN_CIRCLE_DIAMETER} max={20} system={system} onCommit={(width) => updateRoom({ width })} />
                <input aria-label="Room diameter" className="range" type="range" min={MIN_CIRCLE_DIAMETER} max={20} step={0.1} value={room.width}
                  title="Resize the whole circular room while keeping it round" aria-valuetext={formatLength(room.width, system)}
                  onPointerDown={beginDiameter} onFocus={beginDiameter}
                  onChange={(event) => { beginDiameter(); updateRoom({ width: Number(event.target.value) }, false); }}
                  onPointerUp={finishDiameter} onPointerCancel={finishDiameter} onBlur={finishDiameter} onKeyUp={finishDiameter} />
              </div>
              <p className="hint">Change the diameter to enlarge or shrink the circle. Doors and openings keep their size.</p>
            </div>
          ) : selectedDivider && buildView === 'plan' ? (
            <div className="wall-editor">
              <div className="opening-editor-title"><strong>{selectedDivider.kind === 'wall' ? 'Interior wall' : 'Open boundary'}</strong><button className="text-danger" type="button" onClick={() => removeDivider(selectedDivider.id)}>Remove</button></div>
              <span>{formatLength(selectedDivider.length, system)}</span>
              <label className="field-label">Division type
                <select value={selectedDivider.kind} onChange={(event) => updateDivider(selectedDivider.id, { kind: event.target.value as 'wall' | 'open' })}>
                  <option value="wall">Physical wall</option><option value="open" disabled={openings.some((opening) => opening.wallId === selectedDivider.id)}>Open boundary</option>
                </select>
              </label>
              {openings.some((opening) => opening.wallId === selectedDivider.id) && <p className="hint">Remove this wall’s doors and openings before changing it to an open boundary.</p>}
              <p className="hint">Drag an endpoint in the plan to move its connection.</p>
            </div>
          ) : selectedSpace && !(compact && selectedWallId) ? (
            <div className="wall-editor">
              <div className="opening-editor-title"><strong>{selectedSpace.name}</strong><span>{formatArea(selectedSpace.area, system)}</span></div>
              <p className="hint">Edit this space’s name and finishes in Plan Room.</p>
            </div>
          ) : buildView === '3d' && (selectedWallId || selectedDivider) ? (
            <div className="builder-inspector-empty">
              <span className="eyebrow">{selectedDivider ? 'Interior wall' : 'Exterior wall'}</span>
              <strong>Add an opening to this wall</strong>
              <p>{selectedDivider?.kind === 'open' ? 'This is an invisible boundary. Change it to a physical wall in 2D to add a door.'
                : room.shapeKind === 'circle' ? 'Use Door or Opening above.' : selectedDivider ? 'Use Door or Opening above. Windows belong on exterior walls.' : 'Use Door, Window or Opening above.'}</p>
            </div>
          ) : selectedWallId ? (
            <WallEditor wallId={selectedWallId} />
          ) : (
            <div className="builder-inspector-empty">
              <span className="eyebrow">Selection settings</span>
              <strong>{buildView === 'plan' ? (FEATURES.interiorWalls ? 'Select a wall, corner or division' : 'Select a wall or corner') : room.shapeKind === 'circle' ? 'Select a wall, door or opening' : 'Select a wall, door, window or opening'}</strong>
            </div>
          )}
        </div>

        <div className="builder-continue">
          <button className="primary-button" type="button" onClick={() => compact ? useMobileWorkspace.getState().setTask('furniture') : setMode('plan')}>Continue to Plan Room <Icon name="chevronRight" /></button>
        </div>
      </>;

  return (
    <div className="mode-layout builder-layout">
      {compact ? <MobileSheet id="room" title={cornerId ? 'Corner settings' : selectedOpening ? openingDisplayName(selectedOpening, openings) : selectedWallId ? 'Wall settings' : 'Room'}><div className="mobile-room-tools">{tools}</div></MobileSheet>
        : <aside className="tool-panel builder-panel">{tools}</aside>}

      <section className="workspace-panel">
        <div className="workspace-content" ref={loadingSurface}>
          <div className="workspace-toolbar" aria-label="Room builder view controls">
            <div className="workspace-toolbar-actions">
              {compact && <Button variant="outline" style={{ minHeight: 44 }} onClick={() => openSheet('room')}>Room tools</Button>}
              <span className="workspace-area-badge" title="Room area"><small>Room area</small><strong>{formatArea(roomArea, system)}</strong></span>
              <div className="segmented-control" role="group" aria-label="Room builder view">
                <button type="button" className={buildView === 'plan' ? 'active' : ''} onClick={() => { selectOpening(null); setBuildView('plan'); }} aria-pressed={buildView === 'plan'}>2D</button>
                <button type="button" className={buildView === '3d' ? 'active' : ''} onClick={() => { setDividerTool(null); setBuildView('3d'); }} aria-pressed={buildView === '3d'}>3D</button>
              </div>
            </div>
          </div>
          {buildView === '3d' && <button className="floating-reset-view" type="button" onClick={() => setResetViewRequest((value) => value + 1)}><Icon name="rotateLeft" />Reset view</button>}

          {buildView === 'plan' ? <Plan2D purpose="build" dividerTool={FEATURES.interiorWalls ? dividerTool : null} onDividerAdded={() => setDividerTool(null)} /> : (
            <div className="builder-3d-selection-surface">
              <LoadingBoundary label="Preparing 3D preview…" detail="Building your room view">
                <Viewport3D furniture={false} interactive={false} architectureInteractive sunRays={false} resetViewRequest={resetViewRequest} />
              </LoadingBoundary>
            </div>
          )}
        </div>
      </section>

    </div>
  );
}
