import { architecturalRevision, OPENING_MODELS } from '../core/architecturalRevisions';
import * as THREE from 'three';
import type { OpeningVariant, RoomOpening } from '../core/types';
import { ProductModelLibrary } from './productModels';
import { resizeOpeningGeometry } from './openingResize';

export { OPENING_MODELS } from '../core/architecturalRevisions';

export function openingModelUrl(opening: Pick<RoomOpening, 'type' | 'variant' | 'modelRevision'>) {
  const definition = OPENING_MODELS[opening.variant];
  if (opening.type === 'opening' || !definition
    || (opening.type === 'window') !== opening.variant.endsWith('window')) return undefined;
  const revision = opening.modelRevision ?? architecturalRevision(definition.file);
  return revision ? '/internal/architecture/openings/' + definition.file + '?v=' + revision : undefined;
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

  /** Imported frames fit INSIDE the aperture; generated casings straddle it. */
  frameOverhang(opening: RoomOpening) {
    const url = openingModelUrl(opening);
    if (url && !this.disposed && this.templates.has(url) && !this.failed.has(url)) return 0;
    return opening.type === 'window' ? .02 : opening.type === 'door' ? .0375 : 0;
  }

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
