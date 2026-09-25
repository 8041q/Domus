import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Plan2D } from './Plan2D';
import { getRoomWalls, getWall, MIN_WALL_LENGTH, polygonArea } from './core/roomGeometry';
import { dimensionStepMetres, displayLengthValue, displayValueToMetres, formatArea, formatLength, lengthInputSuffix } from './core/units';
import type { MeasurementSystem, OpeningVariant, RoomOpening, RoomShapeKind } from './core/types';
import { getSnapshot, usePlannerStore } from './store';
import { Icon } from './ui';

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

const SHAPES: Array<{ id: Exclude<RoomShapeKind, 'custom'>; name: string; description: string }> = [
  { id: 'rectangle', name: 'Rectangle', description: 'Simple four-wall room' },
  { id: 'angled-corner', name: 'Angled corner', description: 'Five walls with one diagonal corner' },
  { id: 'l-shape', name: 'L-shape', description: 'Connected spaces or alcoves' },
  { id: 'recess', name: 'Recess', description: 'Room with a built-in notch' }
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
  const display = displayLengthValue(value, system);
  const [draft, setDraft] = useState(display.toFixed(2));
  useEffect(() => setDraft(displayLengthValue(value, system).toFixed(2)), [system, value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(displayLengthValue(value, system).toFixed(2));
      return;
    }
    const rawMetres = displayValueToMetres(parsed, system);
    const step = dimensionStepMetres(system, metricStep);
    const next = Math.max(min, Math.min(max, Math.round(rawMetres / step) * step));
    if (Math.abs(next - value) > 0.0001) {
      const accepted = onCommit(next);
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
          value={draft}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          aria-label={`${label} in ${system === 'metric' ? 'metres' : 'feet'}`}
        />
        <small>{lengthInputSuffix(system)}</small>
      </span>
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
  const [draft, setDraft] = useState(displayLengthValue(value, system).toFixed(2));

  useEffect(() => {
    setDraft(displayLengthValue(value, system).toFixed(2));
  }, [system, value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(displayLengthValue(value, system).toFixed(2));
      return;
    }

    const rawMetres = displayValueToMetres(parsed, system);
    const step = dimensionStepMetres(system, metricStep);
    const next = Math.max(min, Math.min(max, Math.round(rawMetres / step) * step));
    const accepted = Math.abs(next - value) > 0.0001 ? onCommit(next) : true;
    setDraft(displayLengthValue(accepted === false ? value : next, system).toFixed(2));
  };

  return (
    <div className="range-value-row">
      <span>{label}</span>
      <span className="range-editable-value">
        <input
          inputMode="decimal"
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          aria-label={`${label} in ${system === 'metric' ? 'metres' : 'feet'}`}
        />
        <small>{lengthInputSuffix(system)}</small>
      </span>
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
  const openings = usePlannerStore((s) => s.openings);
  const system = usePlannerStore((s) => s.measurementSystem);
  const updateOpening = usePlannerStore((s) => s.updateOpening);
  const removeOpening = usePlannerStore((s) => s.removeOpening);
  const commitSnapshot = usePlannerStore((s) => s.commitSnapshot);
  const sliderBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const sizeBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const sliderRaf = useRef<number | null>(null);
  const pendingOffset = useRef(opening.offset);
  const walls = useMemo(() => getRoomWalls(room), [room]);
  const wall = getWall(room, opening.wallId);
  const maxOffset = wall?.length ?? 1;
  const minOpeningWidth = opening.type === 'opening' ? 0.10 : 0.45;
  const minOpeningHeight = opening.type === 'opening' ? 0.10 : 0.40;

  useEffect(() => () => { if (sliderRaf.current != null) cancelAnimationFrame(sliderRaf.current); }, []);

  const previewOffset = (offset: number) => {
    pendingOffset.current = offset;
    if (sliderRaf.current != null) return;
    sliderRaf.current = requestAnimationFrame(() => {
      sliderRaf.current = null;
      updateOpening(opening.id, { offset: pendingOffset.current }, false);
    });
  };

  const finishSlider = () => {
    if (sliderRaf.current != null) {
      cancelAnimationFrame(sliderRaf.current);
      sliderRaf.current = null;
      updateOpening(opening.id, { offset: pendingOffset.current }, false);
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
          <span>{wall ? `Wall ${wall.index + 1} · ${formatLength(wall.length, system)}` : 'Selected opening'}</span>
        </div>
        <button className="text-danger" type="button" onClick={() => removeOpening(opening.id)}>Remove</button>
      </div>
      <div className="opening-type-grid">
        <label className="field-label">Kind
          <select
            value={opening.type}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => updateOpening(opening.id, { type: e.target.value as RoomOpening['type'] })}
          >
            <option value="window">Window</option>
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
      <label className="field-label">Wall
        <select
          value={opening.wallId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
            const nextWall = getWall(room, e.target.value);
            if (nextWall) updateOpening(opening.id, { wallId: nextWall.id, offset: nextWall.length / 2 });
          }}
        >
          {walls.map((segment) => (
            <option key={segment.id} value={segment.id}>Wall {segment.index + 1} · {formatLength(segment.length, system)}</option>
          ))}
        </select>
      </label>
      <label className="field-label range-field">
        <EditableRangeValue
          label="Horizontal Position"
          value={opening.offset}
          min={opening.width / 2 + 0.05}
          max={Math.max(opening.width / 2 + 0.05, maxOffset - opening.width / 2 - 0.05)}
          system={system}
          onCommit={(offset) => updateOpening(opening.id, { offset })}
        />
        <input
          className="range"
          type="range"
          min={opening.width / 2 + 0.05}
          max={Math.max(opening.width / 2 + 0.05, maxOffset - opening.width / 2 - 0.05)}
          step={system === 'metric' ? 0.01 : 0.0254}
          value={opening.offset}
          onFocus={() => { if (!sliderBefore.current) sliderBefore.current = getSnapshot(); }}
          onPointerDown={() => { if (!sliderBefore.current) sliderBefore.current = getSnapshot(); }}
          onChange={(e: ChangeEvent<HTMLInputElement>) => previewOffset(Number(e.target.value))}
          onPointerUp={finishSlider}
          onBlur={finishSlider}
        />
      </label>
      <div className="opening-size-sliders">
        <label className="field-label range-field">
          <EditableRangeValue label="Width" value={opening.width} min={minOpeningWidth} max={Math.max(minOpeningWidth, maxOffset - 0.2)} system={system} onCommit={(width) => updateOpening(opening.id, { width })} />
          <input className="range" type="range" min={minOpeningWidth} max={Math.max(minOpeningWidth, maxOffset - 0.2)} step={system === 'metric' ? 0.01 : 0.0127} value={opening.width}
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
      {opening.type !== 'door' && opening.variant !== 'full-height-window' && opening.variant !== 'sliding-window' && (
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
  const room = usePlannerStore((s) => s.room);
  const system = usePlannerStore((s) => s.measurementSystem);
  const resizeWallById = usePlannerStore((s) => s.resizeWallById);
  const commitSnapshot = usePlannerStore((s) => s.commitSnapshot);
  const sliderBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const wall = getWall(room, wallId);
  if (!wall) return null;

  const finishSlider = () => {
    if (sliderBefore.current) commitSnapshot(sliderBefore.current);
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
    </div>
  );
}

export function BuildRoom() {
  const room = usePlannerStore((s) => s.room);
  const openings = usePlannerStore((s) => s.openings);
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
  const setMode = usePlannerStore((s) => s.setMode);
  const selectedOpening = openings.find((o) => o.id === selectedOpeningId) ?? null;
  const roomArea = Math.abs(polygonArea(room.vertices));

  const changeShape = (shape: Exclude<RoomShapeKind, 'custom'>) => {
    if (shape === room.shapeKind) return;
    if (openings.length && !window.confirm('Changing the room shape will clear the current doors and windows. Continue?')) return;
    setRoomTemplate(shape);
  };

  return (
    <div className="mode-layout builder-layout">
      <aside className="tool-panel builder-panel">
        <div className="builder-scroll-content">
        <div className="panel-intro">
          <span className="eyebrow">Step 1</span>
          <h1>Build your room</h1>
          <p>Shape the walls and openings first. Finishes and furniture come together in the design step.</p>
        </div>

        <section className="tool-section">
          <div className="section-title-row">
            <div><span className="section-step">1</span><h2>Room shape</h2></div>
            {room.shapeKind === 'custom' && <span className="quiet-pill">Custom</span>}
          </div>
          <div className="shape-options">
            {SHAPES.map((shape) => (
              <button key={shape.id} type="button" className={room.shapeKind === shape.id ? 'selected' : ''} onClick={() => changeShape(shape.id)}>
                <span className={`shape-glyph shape-${shape.id}`} aria-hidden="true" />
                <span><strong>{shape.name}</strong><small>{shape.description}</small></span>
              </button>
            ))}
          </div>
          <p className="hint">Choose a starting shape, then drag any wall or corner. Corners move freely, so adjacent walls can become angled.</p>
        </section>

        <section className="tool-section">
          <div className="section-title-row">
            <div><span className="section-step">2</span><h2>Dimensions</h2></div>
            <div className="dimension-tools">
              <div className="unit-toggle" role="group" aria-label="Measurement units">
                <button type="button" className={system === 'metric' ? 'active' : ''} onClick={() => setMeasurementSystem('metric')}>Metric</button>
                <button type="button" className={system === 'imperial' ? 'active' : ''} onClick={() => setMeasurementSystem('imperial')}>Imperial</button>
              </div>
              <span className="quiet-pill">{room.vertices.length} walls</span>
            </div>
          </div>
          <div className="dimension-grid">
            <DimensionField label="Room height" value={room.height} min={1} max={3.3} system={system} metricStep={0.01} onCommit={(height) => updateRoom({ height })} />
          </div>
        </section>

        <section className="tool-section opening-section">
          <div className="section-title-row"><div><span className="section-step">3</span><h2>Doors, windows & openings</h2></div></div>
          <div className="opening-quick-add" aria-label="Add an opening">
            <button type="button" onClick={() => addOpening('door')}><span className="opening-add-mark" aria-hidden="true">+</span><span>Door</span></button>
            <button type="button" onClick={() => addOpening('window')}><span className="opening-add-mark" aria-hidden="true">+</span><span>Window</span></button>
            <button type="button" onClick={() => addOpening('opening')}><span className="opening-add-mark" aria-hidden="true">+</span><span>Opening</span></button>
          </div>
          <p className="hint compact-hint">Select a wall first to place the opening there.</p>
          {!!openings.length && (
            <label className="opening-selector">
              <span>Selected opening</span>
              <select
                value={selectedOpeningId ?? ''}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => selectOpening(e.target.value || null)}
                aria-label="Selected opening"
              >
                <option value="">Choose an opening…</option>
                {openings.map((opening) => {
                  const openingWall = getWall(room, opening.wallId);
                  return (
                    <option key={opening.id} value={opening.id}>
                      {openingDisplayName(opening, openings)}{openingWall ? ` — Wall ${openingWall.index + 1}` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
        </section>
        </div>

        <div className="builder-inspector-dock" aria-live="polite">
          {selectedOpening ? (
            <OpeningEditor opening={selectedOpening} />
          ) : selectedWallId ? (
            <WallEditor wallId={selectedWallId} />
          ) : (
            <div className="builder-inspector-empty">
              <span className="eyebrow">Selection settings</span>
              <strong>Select a wall, door, window or opening</strong>
            </div>
          )}
        </div>

        <div className="builder-continue">
          <button className="primary-button" type="button" onClick={() => setMode('plan')}>Continue to Plan Room <Icon name="chevronRight" /></button>
        </div>
      </aside>

      <section className="workspace-panel">
        <div className="workspace-toolbar">
          <div>
            <strong>{buildView === 'plan' ? 'Floor plan' : '3D preview'}</strong>
            <span>{buildView === 'plan' ? 'Drag corners freely for angled walls, or move labelled wall segments' : 'Orbit the room, then drag doors, windows and wall openings directly on their walls'}</span>
          </div>
          <div className="workspace-toolbar-actions">
            <span className="workspace-area-badge"><small>Room area</small><strong>{formatArea(roomArea, system)}</strong></span>
            <div className="segmented-control" role="group" aria-label="Room builder view">
              <button className={buildView === 'plan' ? 'active' : ''} onClick={() => setBuildView('plan')}>2D</button>
              <button className={buildView === '3d' ? 'active' : ''} onClick={() => setBuildView('3d')}>3D</button>
            </div>
          </div>
        </div>
        <div className="workspace-content">
          {buildView === 'plan' ? <Plan2D purpose="build" /> : (
            <Suspense fallback={<div className="viewport-loading">Loading 3D preview…</div>}>
              <Viewport3D furniture={false} interactive={false} architectureInteractive sunRays={false} />
            </Suspense>
          )}
        </div>
      </section>
    </div>
  );
}
