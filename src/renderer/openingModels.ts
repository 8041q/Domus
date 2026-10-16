import * as THREE from 'three';
import type { OpeningVariant, RoomOpening } from '../core/types';
import { ProductModelLibrary } from './productModels';
import { resizeOpeningGeometry } from './openingResize';

/** Kept outside /models so architectural inserts never enter the furniture catalogue. */
export const OPENING_MODELS: Partial<Record<OpeningVariant, { file: string; rotationY?: number }>> = {
  'single-window': { file: 'single_glass_window.glb' },
  'double-window': { file: 'double_glass_window.glb' },
  'single-hung-window': { file: 'single_hung_window.glb' },
  'high-window': { file: 'hight_top_window.glb' },
  'sliding-window': { file: 'sliding_glass_pathway.glb' },
  'single-door': { file: 'single_door.glb' },
  'glass-door': { file: 'glass_door.glb' },
  'semi-glass-door': { file: 'semi_glass_door.glb' },
  // This export's width runs along Z; the other assets face along Z already.
  'glass-double-door': { file: 'double_glass_door.glb', rotationY: Math.PI / 2 }
};

export function openingModelUrl(opening: Pick<RoomOpening, 'type' | 'variant'>) {
  const definition = OPENING_MODELS[opening.variant];
  if (opening.type === 'opening' || !definition
    || (opening.type === 'window') !== opening.variant.endsWith('window')) return undefined;
  return '/internal/architecture/openings/' + definition.file;
}

/** Resize clear spans independently; preserve frame profiles and hardware. */
export function fitOpeningModel(model: THREE.Group, variant: OpeningVariant, width: number, height: number) {
  const oriented = new THREE.Group();
  oriented.rotation.y = OPENING_MODELS[variant]?.rotationY ?? 0;
  oriented.add(model);
  oriented.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(oriented, true);
  const size = bounds.getSize(new THREE.Vector3());
  if (![width, height, size.x, size.y, size.z].every(value => Number.isFinite(value) && value > 0)) return null;
  return resizeOpeningGeometry(oriented, bounds, variant, width, height);
}

/** The shared asset library owns geometry/materials; this cache owns only state. */
export class OpeningModelLibrary {
  private templates = new Map<string, THREE.Group>();
  private pending = new Set<string>();
  private failed = new Set<string>();
  private disposed = false;

  constructor(private models: ProductModelLibrary, private ready: (url: string) => void) {}

  create(opening: RoomOpening, height = opening.height) {
    const url = openingModelUrl(opening);
    if (!url || this.disposed || this.failed.has(url)) return null;
    const template = this.templates.get(url);
    if (template) return fitOpeningModel(this.models.instantiate(template), opening.variant, opening.width, height);
    if (!this.pending.has(url)) {
      this.pending.add(url);
      void this.models.loadModel(url).then(template => {
        if (this.disposed) return;
        this.templates.set(url, template);
        this.ready(url);
      }).catch(error => {
        if (this.disposed) return;
        this.failed.add(url);
        console.warn(`Could not load architectural insert ${url}; keeping the generated fallback.`, error);
      }).finally(() => this.pending.delete(url));
    }
    return null;
  }

  dispose() {
    this.disposed = true;
    this.templates.clear();
    this.pending.clear();
    this.failed.clear();
  }
}
