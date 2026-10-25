import { FEATURES } from './config/features';
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ChangeEvent } from 'react';
import { PRODUCT_LIST, PRODUCTS, displayProductDimensions, getProductCatalogueIssues, getProductCatalogueVersion, subscribeProductCatalogue } from './core/products';
import { PRODUCT_CATEGORIES } from './core/productSchema';
import { clearanceIssues } from './core/placement';
import { polygonArea } from './core/roomGeometry';
import { architectureRoom } from './core/spaces';
import { effectiveSunAzimuth, normalizeSunAzimuth, SUN_AZIMUTH_MAX, SUN_AZIMUTH_MIN, SUN_ELEVATION_MAX, SUN_ELEVATION_MIN, SUN_SINGLE_WINDOW_LIMIT } from './core/sun';
import { formatArea, formatLength } from './core/units';
import type { PlanCameraView, ProductCategory, SunStylePreset } from './core/types';
import { FLOOR_FINISHES, ROOM_COLOR_PRESETS } from './core/roomFinishes';
import { BASEBOARD_STYLES, isSunGlazedOpening } from './core/architecturalStyles';
import type { BaseboardMaterial, BaseboardStyle } from './core/types';
import { getSnapshot, usePlannerStore } from './store';
import { Icon } from './ui';
import { FloatingPanel } from './FloatingPanel';
import { EditingSpaceSelector } from './EditingSpaceSelector';
import { LoadingBoundary, useLoadingSurface } from './LoadingStatus';
import { AssistantOpening } from './ai/AssistantWaiting';

const Viewport3D = lazy(() => import('./Viewport3D').then((module) => ({ default: module.Viewport3D })));
const AIExperimentPanel = lazy(() => import('./ai/AIExperimentPanel').then((module) => ({ default: module.AIExperimentPanel })));

const CATEGORIES: Array<'All' | ProductCategory> = ['All', ...PRODUCT_CATEGORIES];
const VIEW_PRESETS: Array<{ id: PlanCameraView; label: string }> = [
  { id: 'free', label: 'Free cam' },
  { id: 'walk', label: 'Walk' },
  { id: 'top', label: 'Top' },
  { id: 'front', label: 'Front' },
  { id: 'right', label: 'Right' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Left' }
];
function ProductGlyph({ productId }: { productId: string }) {
  if (PRODUCTS[productId as keyof typeof PRODUCTS]?.model) return <Icon name="cube" className="product-model-glyph" />;
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
  useSyncExternalStore(subscribeProductCatalogue, getProductCatalogueVersion, getProductCatalogueVersion);
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
  const displaySize = displayProductDimensions(product);
  const issues = clearanceIssues(selected, architectureRoom(getSnapshot()), objects.filter((o) => o.id !== selected.id));
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
        <span>{formatLength(displaySize.width, measurementSystem)} W</span>
        <span>{formatLength(displaySize.depth, measurementSystem)} D</span>
        <span>{formatLength(displaySize.height, measurementSystem)} H</span>
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

function FinishColorPicker({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  const isCustom = !ROOM_COLOR_PRESETS.some((preset) => preset.value.toLowerCase() === value.toLowerCase());
  return (
    <div className="swatch-row" role="group" aria-label={`${label} colour`}>
      {ROOM_COLOR_PRESETS.map((swatch) => (
        <button key={swatch.value} type="button" className={`swatch ${value.toLowerCase() === swatch.value ? 'selected' : ''}`}
          style={{ '--swatch': swatch.value } as CSSProperties} title={swatch.name}
          aria-label={`${label}: ${swatch.name}`} aria-pressed={value.toLowerCase() === swatch.value}
          onClick={() => onChange(swatch.value)} />
      ))}
      <label className={`finish-custom-color ${isCustom ? 'selected' : ''}`}
        style={isCustom ? { '--custom-color': value } as CSSProperties : undefined} title={`Custom ${label.toLowerCase()} colour`}>
        <Icon name="palette" />
        <input type="color" aria-label={`Custom ${label.toLowerCase()} colour`} value={value}
          onChange={(event) => onChange(event.target.value)} />
      </label>
    </div>
  );
}

function FinishesPanel({ onClose }: { onClose: () => void }) {
  const room = usePlannerStore((s) => s.room);
  const spaces = usePlannerStore((s) => s.spaces);
  const selectedSpaceId = usePlannerStore((s) => s.selectedSpaceId);
  const updateSpace = usePlannerStore((s) => s.updateSpace);
  const updateRoom = usePlannerStore((s) => s.updateRoom);
  const space = FEATURES.interiorWalls ? spaces.find((item) => item.id === selectedSpaceId) ?? spaces[0] : undefined;
  return (
    <FloatingPanel id="finishes" title="Room finishes" className="finish-panel" onClose={onClose}>
      {FEATURES.interiorWalls && <div className="finish-fields">
        <label className="finish-space-name">Space name
          <input className="finish-style-select" value={space?.name ?? ''}
            onChange={(event) => space && updateSpace(space.id, { name: event.target.value })} />
        </label>
      </div>}
      <div className="finish-colour-row"><span>Wall colour</span>
        <FinishColorPicker label="Wall" value={space?.wallColor ?? room.wallColor} onChange={(wallColor) => space ? updateSpace(space.id, { wallColor }) : updateRoom({ wallColor })} />
      </div>
      <section className="finish-floor-section" aria-label="Floor finish">
        <h3>Floor</h3>
        <div className="floor-options">
          {FLOOR_FINISHES.map((floor) => (
            <button key={floor.id} type="button" className={`floor-option ${(space?.floorFinish ?? room.floorFinish) === floor.id ? 'selected' : ''}`}
              aria-pressed={(space?.floorFinish ?? room.floorFinish) === floor.id} title={floor.source}
              onClick={() => space ? updateSpace(space.id, { floorFinish: floor.id }) : updateRoom({ floorFinish: floor.id })}>
              <span style={{ backgroundImage: `url(${floor.previewUrl})`, backgroundColor: floor.fallbackColor }} />{floor.name}
            </button>
          ))}
        </div>
      </section>
      <section className="finish-shared-section" aria-label="Shared room finishes">
        <h3>{FEATURES.interiorWalls ? 'Shared room finishes' : 'Room finishes'}</h3>
        <div className="finish-colour-row"><span>Ceiling colour</span>
          <FinishColorPicker label="Ceiling" value={room.ceilingColor} onChange={(ceilingColor) => updateRoom({ ceilingColor })} />
        </div>
        <div className="finish-fields">
          <label>Baseboard style
            <select className="finish-style-select" value={room.baseboardStyle}
              onChange={(event) => updateRoom({ baseboardStyle: event.target.value as BaseboardStyle })}>
              {BASEBOARD_STYLES.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
            </select>
          </label>
          <label>Baseboard material
            <select className="finish-style-select" value={room.baseboardMaterial}
              onChange={(event) => updateRoom({ baseboardMaterial: event.target.value as BaseboardMaterial })}>
              <option value="paint">Painted</option><option value="materials">Materials</option>
            </select>
          </label>
        </div>
        {room.baseboardMaterial === 'paint' && <div className="finish-colour-row"><span>Baseboard colour</span>
          <FinishColorPicker label="Baseboard" value={room.baseboardColor} onChange={(baseboardColor) => updateRoom({ baseboardColor })} />
        </div>}
      </section>
    </FloatingPanel>
  );
}

function DesignPanel({ onClose }: { onClose: () => void }) {
  const showRoomDimensions = usePlannerStore((s) => s.showRoomDimensions);
  const showProductDimensions = usePlannerStore((s) => s.showProductDimensions);
  const showSpacingDimensions = usePlannerStore((s) => s.showSpacingDimensions);
  const setShowRoomDimensions = usePlannerStore((s) => s.setShowRoomDimensions);
  const setShowProductDimensions = usePlannerStore((s) => s.setShowProductDimensions);
  const setShowSpacingDimensions = usePlannerStore((s) => s.setShowSpacingDimensions);
  const lighting = usePlannerStore((s) => s.room.lighting);
  const windowCount = usePlannerStore((s) => s.openings.filter((opening) => !opening.wallId.startsWith('divider-') && isSunGlazedOpening(opening)).length);
  const setRoomLighting = usePlannerStore((s) => s.setRoomLighting);
  const commitSnapshot = usePlannerStore((s) => s.commitSnapshot);
  const sunAngleBefore = useRef<ReturnType<typeof getSnapshot> | null>(null);
  const hasWindow = windowCount > 0;
  const horizontalAngle = effectiveSunAzimuth(lighting.sunAzimuth, windowCount);

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
    <FloatingPanel id="design" title="Design" side="right" className="design-panel" onClose={onClose}>
    <div className="view-options-content">
      <strong>Annotations</strong>
      <label><input type="checkbox" checked={showRoomDimensions} onChange={(e) => setShowRoomDimensions(e.target.checked)} /><span>Room dimensions</span></label>
      <label><input type="checkbox" checked={showProductDimensions} onChange={(e) => setShowProductDimensions(e.target.checked)} /><span>Product dimensions</span></label>
      <label><input type="checkbox" checked={showSpacingDimensions} onChange={(e) => setShowSpacingDimensions(e.target.checked)} /><span>Item spacing</span></label>
      <div className="view-options-section">
        <strong>Ceiling lighting</strong>
        <label><input type="checkbox" checked={lighting.enabled} onChange={(e) => setRoomLighting({ enabled: e.target.checked })} /><span>Room lights</span></label>
      </div>
      {hasWindow && <div className="view-options-section sun-angle-section">
        <strong>Window and door sun</strong>
        <label><input type="checkbox" checked={lighting.sunRaysEnabled} onChange={(e) => setRoomLighting({ sunRaysEnabled: e.target.checked })} /><span>Sun Light</span></label>
        <label>
          <span>Sun style</span>
          <select value={lighting.sunStylePreset} disabled={!lighting.sunRaysEnabled} onChange={(e) => setRoomLighting({ sunStylePreset: e.target.value as SunStylePreset })}>
            <option value="cinematic-shadows">Cinematic shadows</option>
            <option value="paired-suns">Paired suns</option>
          </select>
        </label>
        <div className="sun-angle-control">
          <div><span>Horizontal</span><output>{horizontalAngle}°</output></div>
          <input type="range" min={windowCount === 1 ? -SUN_SINGLE_WINDOW_LIMIT : SUN_AZIMUTH_MIN} max={windowCount === 1 ? SUN_SINGLE_WINDOW_LIMIT : SUN_AZIMUTH_MAX} step="1" value={horizontalAngle} aria-label="Sun horizontal angle" disabled={!lighting.sunRaysEnabled} {...sunAngleEvents}
            onChange={(e) => setRoomLighting({ sunAzimuth: normalizeSunAzimuth(e.target.value) }, false)} />
        </div>
        <div className="sun-angle-control">
          <div><span>Height</span><output>{lighting.sunElevation}°</output></div>
          <input type="range" min={SUN_ELEVATION_MIN} max={SUN_ELEVATION_MAX} step="1" value={lighting.sunElevation} aria-label="Sun height angle" disabled={!lighting.sunRaysEnabled} {...sunAngleEvents}
            onChange={(e) => setRoomLighting({ sunElevation: Number(e.target.value) }, false)} />
        </div>
        <small>{windowCount === 1 ? '0° faces the glazed opening; the slider stops at its horizon.' : '0° faces the first glazed opening. Rotate through 360° to reach the others.'}</small>
      </div>}
    </div>
    </FloatingPanel>
  );
}

function InteractionStatus() {
  const walking = usePlannerStore((s) => s.planView === 'walk');
  const activeSnap = usePlannerStore((s) => s.activeSnap);
  const collisionId = usePlannerStore((s) => s.collisionId);
  const collisionPush = usePlannerStore((s) => s.collisionPush);

  if (walking) return (
    <div className="interaction-status free">
      <span className="status-indicator" />
      Walk mode · movement stays inside the room · Esc to exit
    </div>
  );

  return (
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
  );
}

const ProductCatalog = memo(function ProductCatalog() {
  const catalogueVersion = useSyncExternalStore(subscribeProductCatalogue, getProductCatalogueVersion, getProductCatalogueVersion);
  const catalogueIssues = getProductCatalogueIssues();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'All' | ProductCategory>('All');
  const objects = usePlannerStore((s) => s.objects);
  const unplacedObjects = usePlannerStore((s) => s.unplacedObjects);
  const addObject = usePlannerStore((s) => s.addObject);
  const placeUnplacedObject = usePlannerStore((s) => s.placeUnplacedObject);
  const removeFurniture = usePlannerStore((s) => s.removeFurniture);
  const select = usePlannerStore((s) => s.select);
  const selectedId = usePlannerStore((s) => s.selectedId);
  const setMode = usePlannerStore((s) => s.setMode);
  const usedFurniture = [
    ...objects.map((object) => ({ ...object, placed: true })),
    ...unplacedObjects.map((object) => ({ ...object, placed: false }))
  ];

  const filtered = useMemo(() => PRODUCT_LIST.filter((p) => {
    const matchesCategory = category === 'All' || p.category === category;
    const matchesSearch = p.name.toLowerCase().includes(search.trim().toLowerCase());
    return matchesCategory && matchesSearch;
  }), [category, search, catalogueVersion]);

  return (
    <aside className="catalog-panel">
      <div className="catalog-heading">
        <h1>Furniture</h1>
        <button type="button" className="edit-room-link" onClick={() => setMode('build')}><Icon name="arrowLeft" />Edit room</button>
      </div>
      <section className="used-furniture" aria-labelledby="used-furniture-heading">
        <div className="used-furniture-heading">
          <h2 id="used-furniture-heading">Room items</h2>
          <span>{usedFurniture.length}</span>
        </div>
        {usedFurniture.length ? (
          <ul className="used-furniture-list">
            {usedFurniture.map((item) => {
              const details = <span className="used-furniture-details">
                <strong>{PRODUCTS[item.productId].name}</strong>
                {PRODUCTS[item.productId].available === false ? <small>Model unavailable</small> : !item.placed && <small>Not placed</small>}
              </span>;
              return (
              <li key={item.id} className={`used-furniture-item ${selectedId === item.id ? 'is-selected' : ''}`}>
                {item.placed ? <button type="button" className="used-furniture-select" aria-label={`Select ${PRODUCTS[item.productId].name}`}
                  aria-pressed={selectedId === item.id} onClick={() => select(item.id)}>{details}</button>
                  : <div className="used-furniture-label">{details}</div>}
                {!item.placed && <button type="button" className="used-furniture-row-action" aria-label={`Place ${PRODUCTS[item.productId].name}`}
                  onClick={() => placeUnplacedObject(item.id)}>Place</button>}
                <button type="button" className="used-furniture-remove" aria-label={`Remove ${PRODUCTS[item.productId].name} from used furniture`} title="Remove furniture" onClick={() => removeFurniture(item.id)}><Icon name="x" /></button>
              </li>
              );
            })}
          </ul>
        ) : <p className="used-furniture-empty">Furniture you add will appear here.</p>}
        {unplacedObjects.length > 0 && <p className="used-furniture-empty">Choose a space, then place the remaining items.</p>}
      </section>
      <div className="catalog-section-heading"><h2>Catalogue</h2><span>{filtered.length}</span></div>
      <div className="catalog-filters">
      <label className="search-box">
        <span><Icon name="search" /></span>
        <input aria-label="Search furniture" value={search} onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)} placeholder="Search furniture" />
      </label>
      <label className="catalog-category">
        <select aria-label="Product category" value={category} onChange={(event) => setCategory(event.target.value)}>
          {CATEGORIES.map((item) => <option key={item} value={item}>{item === 'All' ? 'All categories' : item}</option>)}
        </select>
      </label>
      </div>
      {catalogueIssues.length > 0 && <div className="catalog-import-issues" role="alert">
        <strong>Some models could not be imported</strong>
        {catalogueIssues.map((issue) => <p key={issue.file}>{issue.file}: {issue.message}</p>)}
      </div>}
      <div className="product-grid">
        {filtered.map((product) => (
          <button className="product-card" key={product.id} type="button" onClick={() => addObject(product.id)}>
            <div className="product-visual"><ProductGlyph productId={product.id} /></div>
            <strong>{product.name}</strong>
            <small>{Math.round(displayProductDimensions(product).width * 100)} × {Math.round(displayProductDimensions(product).depth * 100)} cm</small>
            <span>{product.priceLabel}</span>
          </button>
        ))}
      </div>
      {!filtered.length && <p className="empty-state">No products match that search.</p>}
    </aside>
  );
});

export function PlanRoom({ onExportReady, onPdfExportReady }: {
  onExportReady?: (handler: (() => Promise<void>) | null) => void;
  onPdfExportReady?: (handler: (() => Promise<void>) | null) => void;
}) {
  const loadingSurface = useLoadingSurface();
  const [resetViewRequest, setResetViewRequest] = useState(0);
  const [showFinishes, setShowFinishes] = useState(false);
  const [showViewOptions, setShowViewOptions] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const objectCount = usePlannerStore((s) => s.objects.length);
  const roomVertices = usePlannerStore((s) => s.room.vertices);
  const selectedId = usePlannerStore((s) => s.selectedId);
  const selectedSpaceId = usePlannerStore((s) => s.selectedSpaceId);
  const spaces = usePlannerStore((s) => s.spaces);
  const selectSpace = usePlannerStore((s) => s.selectSpace);
  const measurementSystem = usePlannerStore((s) => s.measurementSystem);
  const sunRaysEnabled = usePlannerStore((s) => s.room.lighting.sunRaysEnabled);
  const planView = usePlannerStore((s) => s.planView);
  const setPlanView = usePlannerStore((s) => s.setPlanView);
  const interiorWallView = usePlannerStore((s) => s.interiorWallView);
  const setInteriorWallView = usePlannerStore((s) => s.setInteriorWallView);
  const walking = planView === 'walk';

  useEffect(() => {
    if (FEATURES.interiorWalls && spaces.length && !spaces.some((space) => space.id === selectedSpaceId)) selectSpace(spaces[0].id);
  }, [spaces, selectedSpaceId, selectSpace]);

  useEffect(() => {
    if (!showFinishes && !showViewOptions) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowFinishes(false);
      setShowViewOptions(false);
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showFinishes, showViewOptions]);

  return (
    <div className="mode-layout plan-room-layout">
      <ProductCatalog />

      <section className="designer-canvas">
        <div className="designer-stage" ref={loadingSurface}>
          {FEATURES.interiorWalls && <EditingSpaceSelector spaces={spaces} value={selectedSpaceId ?? spaces[0]?.id ?? ''} onChange={selectSpace} />}
          <div className={`designer-topbar ${FEATURES.interiorWalls ? '' : 'without-space-selector'}`} aria-label="Room view controls">
            <div className="view-preset-bar" role="group" aria-label="3D room view">
              {FEATURES.interiorWalls && <><button type="button" disabled={walking} title={walking ? 'Walk uses full-height walls' : undefined} className={walking || interiorWallView === 'up' ? 'active' : ''} aria-pressed={walking || interiorWallView === 'up'} onClick={() => setInteriorWallView('up')}>Walls up</button>
              <button type="button" disabled={walking} title={walking ? 'Walk uses full-height walls' : undefined} className={!walking && interiorWallView === 'down' ? 'active' : ''} aria-pressed={!walking && interiorWallView === 'down'} onClick={() => setInteriorWallView('down')}>Walls down</button>
              <span className="view-control-divider" aria-hidden="true" /></>}
              {VIEW_PRESETS.map((view) => <button key={view.id} type="button" className={planView === view.id ? 'active' : ''} aria-pressed={planView === view.id} onClick={() => setPlanView(view.id)}>{view.label}</button>)}
            </div>
            <div className="designer-meta">
              <div className="room-count">{objectCount} item{objectCount === 1 ? '' : 's'} · {formatArea(Math.abs(polygonArea(roomVertices)), measurementSystem)} · {roomVertices.length} walls</div>
              {FEATURES.aiExperiment && <button
                type="button"
                className={`ai-experiment-toggle ${showAi ? 'active' : ''}`}
                onClick={() => { setShowFinishes(false); setShowViewOptions(false); setShowAi((value) => !value); }}
                aria-label="Experimental AI room assistant"
                title="Room assistant · Experimental"
                aria-expanded={showAi}
              ><span>Assistant</span></button>}
              <div className="view-options-wrap">
                <button
                  type="button"
                  className={`finish-toggle designer-icon-button ${showViewOptions ? 'active' : ''}`}
                  onClick={() => setShowViewOptions((value) => !value)}
                  aria-label="Design"
                  title="Design"
                  aria-expanded={showViewOptions}
                ><Icon name="eye" /></button>
              </div>
              <button
                type="button"
                className={`finish-toggle designer-icon-button ${showFinishes ? 'active' : ''}`}
                onClick={() => setShowFinishes((value) => !value)}
                aria-label="Room finishes"
                title="Room finishes"
                aria-expanded={showFinishes}
              ><Icon name="palette" /></button>
              <button className="designer-reset-view" type="button" onClick={() => setResetViewRequest((value) => value + 1)}><Icon name="rotateLeft" />Reset view</button>
            </div>
          </div>

          <LoadingBoundary label="Preparing your room…" detail="Opening the 3D view">
            <Viewport3D furniture interactive sunRays={sunRaysEnabled} view={planView} resetViewRequest={resetViewRequest} onExportReady={onExportReady} onPdfExportReady={onPdfExportReady} />
          </LoadingBoundary>
          {FEATURES.aiExperiment && showAi && <Suspense fallback={<AssistantOpening onClose={() => setShowAi(false)} />}><AIExperimentPanel onClose={() => setShowAi(false)} /></Suspense>}
          {showFinishes && <FinishesPanel onClose={() => setShowFinishes(false)} />}
          {showViewOptions && <DesignPanel onClose={() => setShowViewOptions(false)} />}
          {selectedId && !walking && !(FEATURES.aiExperiment && showAi) && <SelectionPanel />}
        </div>

        <InteractionStatus />
      </section>
    </div>
  );
}
