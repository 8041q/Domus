import { lazy, Suspense, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import { PRODUCT_LIST, PRODUCTS } from './core/products';
import { clearanceIssues } from './core/placement';
import { polygonArea } from './core/roomGeometry';
import { effectiveSunAzimuth, normalizeSunAzimuth, SUN_AZIMUTH_MAX, SUN_AZIMUTH_MIN, SUN_ELEVATION_MAX, SUN_ELEVATION_MIN, SUN_SINGLE_WINDOW_LIMIT } from './core/sun';
import { formatArea, formatLength } from './core/units';
import type { CeilingLightFixtureType, PlanCameraView, ProductCategory } from './core/types';
import { FLOOR_FINISHES, WALL_FINISHES } from './core/roomFinishes';
import { getSnapshot, usePlannerStore } from './store';
import { Icon } from './ui';

const Viewport3D = lazy(() => import('./Viewport3D').then((module) => ({ default: module.Viewport3D })));

const CATEGORIES: Array<'All' | ProductCategory> = ['All', 'Seating', 'Tables', 'Storage', 'Decor'];
const VIEW_PRESETS: Array<{ id: PlanCameraView; label: string }> = [
  { id: 'perspective', label: 'Cutaway' },
  { id: 'top', label: 'Top' },
  { id: 'front', label: 'Front' },
  { id: 'right', label: 'Right' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Left' }
];
function ProductGlyph({ productId }: { productId: string }) {
  return <div className={`product-glyph glyph-${productId}`} aria-hidden="true"><span /><i /></div>;
}

function angleDegrees(rotationY: number) {
  const raw = ((rotationY * 180 / Math.PI) % 360 + 360) % 360;
  return Math.round(raw * 10) / 10;
}

function magnetizeRightAngles(degrees: number) {
  const normalized = ((degrees % 360) + 360) % 360;
  const nearest = Math.round(normalized / 90) * 90;
  const wrappedNearest = nearest === 360 ? 0 : nearest;
  const delta = Math.min(Math.abs(normalized - nearest), Math.abs(normalized - wrappedNearest), 360 - Math.abs(normalized - wrappedNearest));
  return delta <= 0.35 ? wrappedNearest : normalized;
}

function SelectionPanel() {
  const selectedId = usePlannerStore((s) => s.selectedId);
  const measurementSystem = usePlannerStore((s) => s.measurementSystem);
  const objects = usePlannerStore((s) => s.objects);
  const room = usePlannerStore((s) => s.room);
  const showClearance = usePlannerStore((s) => s.showClearance);
  const setShowClearance = usePlannerStore((s) => s.setShowClearance);
  const rotate = usePlannerStore((s) => s.rotateSelected);
  const setSelectedRotation = usePlannerStore((s) => s.setSelectedRotation);
  const commitSnapshot = usePlannerStore((s) => s.commitSnapshot);
  const duplicate = usePlannerStore((s) => s.duplicateSelected);
  const remove = usePlannerStore((s) => s.removeSelected);
  const rotationBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const selected = objects.find((o) => o.id === selectedId);
  if (!selected) return null;
  const product = PRODUCTS[selected.productId];
  const issues = clearanceIssues(selected, room, objects.filter((o) => o.id !== selected.id));
  const degrees = angleDegrees(selected.rotationY);

  const finishRotation = () => {
    if (rotationBefore.current) commitSnapshot(rotationBefore.current);
    rotationBefore.current = null;
  };

  return (
    <aside className="selection-panel">
      <div className="selection-heading">
        <div><span className="eyebrow">Selected</span><h2>{product.name}</h2></div>
        <strong>{product.priceLabel}</strong>
      </div>
      <div className="dimension-summary">
        <span>{formatLength(product.width, measurementSystem)} W</span>
        <span>{formatLength(product.depth, measurementSystem)} D</span>
        <span>{formatLength(product.height, measurementSystem)} H</span>
      </div>

      <div className="rotation-control">
        <div className="range-value-row">
          <span>Rotation</span>
          <label className="angle-input" aria-label="Exact rotation">
            <input
              type="number"
              min="0"
              max="359.9"
              step="0.1"
              value={degrees.toFixed(1)}
              onFocus={() => { if (!rotationBefore.current) rotationBefore.current = getSnapshot(); }}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value)) return;
                const normalized = ((value % 360) + 360) % 360;
                setSelectedRotation(normalized * Math.PI / 180, false);
              }}
              onBlur={finishRotation}
            />
            <span>°</span>
          </label>
        </div>
        <input
          className="range rotation-range"
          type="range"
          min="0"
          max="359.9"
          step="0.1"
          value={Math.min(359.9, degrees)}
          list="rotation-stops"
          onPointerDown={() => { if (!rotationBefore.current) rotationBefore.current = getSnapshot(); }}
          onFocus={() => { if (!rotationBefore.current) rotationBefore.current = getSnapshot(); }}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const next = magnetizeRightAngles(Number(e.target.value));
            setSelectedRotation(next * Math.PI / 180, false);
          }}
          onPointerUp={finishRotation}
          onBlur={finishRotation}
          aria-label="Furniture rotation in degrees"
        />
        <datalist id="rotation-stops"><option value="0" /><option value="90" /><option value="180" /><option value="270" /></datalist>
        <div className="rotation-ticks" aria-hidden="true"><span>0°</span><span>90°</span><span>180°</span><span>270°</span></div>
      </div>

      <div className="action-grid">
        <button type="button" onClick={() => rotate(-1)}><span><Icon name="rotateLeft" /></span>90° left</button>
        <button type="button" onClick={() => rotate(1)}><span><Icon name="rotateRight" /></span>90° right</button>
        <button type="button" onClick={duplicate}><span><Icon name="copy" /></span>Duplicate</button>
        <button type="button" className="danger-action" onClick={remove}><span><Icon name="x" /></span>Remove</button>
      </div>
      <label className="toggle-row">
        <input type="checkbox" checked={showClearance} onChange={(e: ChangeEvent<HTMLInputElement>) => setShowClearance(e.target.checked)} />
        <span><strong>Clearance guide</strong><small>Oriented front / back / side use space</small></span>
      </label>
      <div className={`design-check ${issues.length ? 'warning' : 'good'}`}>
        <span className="check-dot" />
        <div>
          <strong>{issues.length ? `${issues.length} spacing note${issues.length > 1 ? 's' : ''}` : 'Placement looks clear'}</strong>
          <p>{issues.length ? issues[0].message : 'Recommended use space is clear in its current orientation.'}</p>
        </div>
      </div>
    </aside>
  );
}

function FinishesPanel({ onClose }: { onClose: () => void }) {
  const room = usePlannerStore((s) => s.room);
  const updateRoom = usePlannerStore((s) => s.updateRoom);
  return (
    <aside className="finish-panel">
      <div className="finish-panel-heading"><div><span className="eyebrow">Room</span><h2>Finishes</h2></div><button type="button" onClick={onClose} aria-label="Close finishes"><Icon name="x" /></button></div>
      <span className="sub-label">Wall colour</span>
      <div className="swatch-row">
        {WALL_FINISHES.map((swatch) => (
          <button
            key={swatch.value}
            type="button"
            className={`swatch ${room.wallColor === swatch.value ? 'selected' : ''}`}
            style={{ '--swatch': swatch.value } as CSSProperties}
            title={swatch.name}
            aria-label={swatch.name}
            onClick={() => updateRoom({ wallColor: swatch.value })}
          />
        ))}
      </div>
      <span className="sub-label floor-label">Floor</span>
      <div className="floor-options">
        {FLOOR_FINISHES.map((floor) => (
          <button
            key={floor.id}
            type="button"
            className={`floor-option ${room.floorFinish === floor.id ? 'selected' : ''}`}
            title={floor.source}
            onClick={() => updateRoom({ floorFinish: floor.id })}
          >
            <span style={{
              backgroundImage: `url(${floor.previewUrl})`,
              backgroundColor: floor.fallbackColor
            }} />{floor.name}
          </button>
        ))}
      </div>
    </aside>
  );
}

export function PlanRoom() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'All' | ProductCategory>('All');
  const [showFinishes, setShowFinishes] = useState(false);
  const [showViewOptions, setShowViewOptions] = useState(false);
  const objects = usePlannerStore((s) => s.objects);
  const room = usePlannerStore((s) => s.room);
  const selectedId = usePlannerStore((s) => s.selectedId);
  const measurementSystem = usePlannerStore((s) => s.measurementSystem);
  const activeSnap = usePlannerStore((s) => s.activeSnap);
  const collisionId = usePlannerStore((s) => s.collisionId);
  const collisionPush = usePlannerStore((s) => s.collisionPush);
  const showRoomDimensions = usePlannerStore((s) => s.showRoomDimensions);
  const showProductDimensions = usePlannerStore((s) => s.showProductDimensions);
  const showSpacingDimensions = usePlannerStore((s) => s.showSpacingDimensions);
  const setShowRoomDimensions = usePlannerStore((s) => s.setShowRoomDimensions);
  const setShowProductDimensions = usePlannerStore((s) => s.setShowProductDimensions);
  const setShowSpacingDimensions = usePlannerStore((s) => s.setShowSpacingDimensions);
  const lighting = usePlannerStore((s) => s.room.lighting);
  const windowCount = usePlannerStore((s) => s.openings.filter((opening) => opening.type === 'window').length);
  const hasWindow = windowCount > 0;
  const horizontalAngle = effectiveSunAzimuth(lighting.sunAzimuth, windowCount);
  const setRoomLighting = usePlannerStore((s) => s.setRoomLighting);
  const commitSnapshot = usePlannerStore((s) => s.commitSnapshot);
  const sunAngleBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const planView = usePlannerStore((s) => s.planView);
  const setPlanView = usePlannerStore((s) => s.setPlanView);
  const addObject = usePlannerStore((s) => s.addObject);
  const setMode = usePlannerStore((s) => s.setMode);

  const filtered = useMemo(() => PRODUCT_LIST.filter((p) => {
    const matchesCategory = category === 'All' || p.category === category;
    const matchesSearch = p.name.toLowerCase().includes(search.trim().toLowerCase());
    return matchesCategory && matchesSearch;
  }), [category, search]);

  const finishSunAngle = () => {
    if (sunAngleBefore.current) commitSnapshot(sunAngleBefore.current);
    sunAngleBefore.current = null;
  };

  const sunAngleEvents = {
    onFocus: () => { if (!sunAngleBefore.current) sunAngleBefore.current = getSnapshot(); },
    onPointerDown: () => { if (!sunAngleBefore.current) sunAngleBefore.current = getSnapshot(); },
    onPointerUp: finishSunAngle,
    onBlur: finishSunAngle
  };

  return (
    <div className="mode-layout plan-room-layout">
      <aside className="catalog-panel">
        <div className="catalog-heading">
          <div><span className="eyebrow">Step 2</span><h1>Plan your room</h1></div>
          <button type="button" className="edit-room-link" onClick={() => setMode('build')}><Icon name="arrowLeft" />Edit room</button>
        </div>
        <label className="search-box">
          <span><Icon name="search" /></span>
          <input value={search} onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)} placeholder="Search furniture" />
        </label>
        <div className="category-tabs" role="tablist" aria-label="Product categories">
          {CATEGORIES.map((item) => <button key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}
        </div>
        <div className="product-grid">
          {filtered.map((product) => (
            <button className="product-card" key={product.id} type="button" onClick={() => addObject(product.id)}>
              <div className="product-visual"><ProductGlyph productId={product.id} /></div>
              <strong>{product.name}</strong>
              <small>{Math.round(product.width * 100)} × {Math.round(product.depth * 100)} cm</small>
              <span>{product.priceLabel}</span>
            </button>
          ))}
        </div>
        {!filtered.length && <p className="empty-state">No placeholder products match that search.</p>}
      </aside>

      <section className="designer-canvas">
        <div className="designer-topbar">
          <div className="view-preset-bar" role="group" aria-label="3D room view">
            {VIEW_PRESETS.map((view) => <button key={view.id} type="button" className={planView === view.id ? 'active' : ''} onClick={() => setPlanView(view.id)}>{view.label}</button>)}
          </div>
          <div className="designer-meta">
            <div className="room-count">{objects.length} item{objects.length === 1 ? '' : 's'} · {formatArea(Math.abs(polygonArea(room.vertices)), measurementSystem)} · {room.vertices.length} walls</div>
            <div className="view-options-wrap">
              <button type="button" className={`finish-toggle ${showViewOptions ? 'active' : ''}`} onClick={() => setShowViewOptions((value) => !value)}><Icon name="eye" />View options</button>
              {showViewOptions && (
                <div className="view-options-popover">
                  <strong>Annotations</strong>
                  <label><input type="checkbox" checked={showRoomDimensions} onChange={(e) => setShowRoomDimensions(e.target.checked)} /><span>Room dimensions<small>Perimeter measurements</small></span></label>
                  <label><input type="checkbox" checked={showProductDimensions} onChange={(e) => setShowProductDimensions(e.target.checked)} /><span>Product dimensions<small>Bounding-box width, depth and height</small></span></label>
                  <label><input type="checkbox" checked={showSpacingDimensions} onChange={(e) => setShowSpacingDimensions(e.target.checked)} /><span>Item spacing<small>Nearest free-space measurements</small></span></label>
                  <div className="view-options-section">
                    <strong>Ceiling lighting</strong>
                    <label><input type="checkbox" checked={lighting.enabled} onChange={(e) => setRoomLighting({ enabled: e.target.checked })} /><span>Enable room lights<small>Add ceiling fixtures and balanced interior lighting</small></span></label>
                    <label>
                      <span>Fixture type<small>Choose the ceiling light family</small></span>
                      <select value={lighting.fixtureType} onChange={(e) => setRoomLighting({ fixtureType: e.target.value as CeilingLightFixtureType })}>
                        <option value="surface-mounted">Surface-mounted / Slim wafers</option>
                        <option value="recessed">Recessed downlights / Cans</option>
                      </select>
                    </label>
                    <label><input type="checkbox" checked={lighting.showWithoutCeiling} onChange={(e) => setRoomLighting({ showWithoutCeiling: e.target.checked })} /><span>Show fixtures without ceiling<small>Keep fixtures visible when the ceiling is hidden</small></span></label>
                  </div>
                  {hasWindow && <div className="view-options-section sun-angle-section">
                    <strong>Window sun</strong>
                    <div className="sun-angle-control">
                      <div><span>Horizontal</span><output>{horizontalAngle}°</output></div>
                      <input type="range" min={windowCount === 1 ? -SUN_SINGLE_WINDOW_LIMIT : SUN_AZIMUTH_MIN} max={windowCount === 1 ? SUN_SINGLE_WINDOW_LIMIT : SUN_AZIMUTH_MAX} step="1" value={horizontalAngle} aria-label="Sun horizontal angle" {...sunAngleEvents}
                        onChange={(e) => setRoomLighting({ sunAzimuth: normalizeSunAzimuth(e.target.value) }, false)} />
                    </div>
                    <div className="sun-angle-control">
                      <div><span>Height</span><output>{lighting.sunElevation}°</output></div>
                      <input type="range" min={SUN_ELEVATION_MIN} max={SUN_ELEVATION_MAX} step="1" value={lighting.sunElevation} aria-label="Sun height angle" {...sunAngleEvents}
                        onChange={(e) => setRoomLighting({ sunElevation: Number(e.target.value) }, false)} />
                    </div>
                    <small>{windowCount === 1 ? '0° faces the window; the slider stops at its horizon.' : '0° faces the first window. Rotate through 360° to reach other windows.'}</small>
                  </div>}
                </div>
              )}
            </div>
            <button type="button" className={`finish-toggle ${showFinishes ? 'active' : ''}`} onClick={() => setShowFinishes((value) => !value)}><Icon name="palette" />Room finishes</button>
          </div>
        </div>

        <div className="designer-stage">
          <Suspense fallback={<div className="viewport-loading">Loading 3D room…</div>}>
            <Viewport3D furniture interactive view={planView} exportable />
          </Suspense>
          {showFinishes && <FinishesPanel onClose={() => setShowFinishes(false)} />}
          {selectedId && <SelectionPanel />}
        </div>

        <div className={`interaction-status ${collisionId ? 'error' : collisionPush ? 'contact' : activeSnap.label === 'Free move' ? 'free' : activeSnap.kind !== 'none' ? 'snap' : ''}`}>
          <span className="status-indicator" />
          {collisionId
            ? 'This item cannot fit at the current position.'
            : collisionPush
              ? 'Object contact - placement was nudged to the nearest free edge.'
              : activeSnap.label === 'Free move'
                ? 'Free move · snapping is off while Shift is held during an item drag.'
                : activeSnap.kind !== 'none'
                  ? `Alignment assist · ${activeSnap.label ?? 'guide'}`
                  : 'Drag an item to move · hold Shift while dragging for free move / overlap · Shift + drag empty space to orbit without clearing selection'}
        </div>
      </section>
    </div>
  );
}
