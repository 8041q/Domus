import type { ProductDefinition, ProductKind } from './types';
import modelCatalogue from 'virtual:domus-models';
import { normalizeProductCategory } from './productSchema';

const BUILTIN_PRODUCTS: Record<ProductKind, ProductDefinition> = {
  sofa: {
    id: 'sofa', name: '3-seat sofa', category: 'Seating', width: 2.12, depth: 0.92, height: 0.84,
    // The procedural sofa is asymmetric in depth: its back sits farther behind the
    // origin than the seat projects forward. Keep the collider on the visible base
    // instead of the larger nominal dimension box so wall/object contact looks exact.
    collisionFootprint: { width: 2.12, depth: 0.7584, offsetZ: -0.0164 },
    wallAffinity: true, clearance: { front: 0.7, back: 0, sides: 0.08 }, priceLabel: '€699', swatch: '#8b969f'
  },
  armchair: {
    id: 'armchair', name: 'Armchair', category: 'Seating', width: 0.88, depth: 0.88, height: 0.9,
    collisionFootprint: { width: 0.88, depth: 0.7276, offsetZ: -0.0146 },
    clearance: { front: 0.6, back: 0.05, sides: 0.08 }, priceLabel: '€299', swatch: '#b98268'
  },
  'dining-table': {
    id: 'dining-table', name: 'Dining table', category: 'Tables', width: 1.8, depth: 0.9, height: 0.76,
    interaction: { tags: ['support-surface', 'tuckable-table'] },
    clearance: { front: 0.75, back: 0.75, sides: 0.75 }, priceLabel: '€449', swatch: '#a67952'
  },
  'coffee-table': {
    id: 'coffee-table', name: 'Coffee table', category: 'Tables', width: 1.1, depth: 0.6, height: 0.42,
    interaction: { tags: ['support-surface'] },
    clearance: { front: 0.38, back: 0.38, sides: 0.3 }, priceLabel: '€149', swatch: '#876b52'
  },
  chair: {
    id: 'chair', name: 'Dining chair', category: 'Seating', width: 0.5, depth: 0.56, height: 0.83,
    collisionFootprint: { width: 0.41, depth: 0.4451, offsetZ: 0.00465 },
    interaction: { tags: ['tuckable-seating'], allowOverlapWith: ['tuckable-table'] },
    clearance: { front: 0.55, back: 0.08, sides: 0.06 }, priceLabel: '€89', swatch: '#685b4a'
  },
  cabinet: {
    id: 'cabinet', name: 'Low cabinet', category: 'Storage', width: 1.2, depth: 0.42, height: 0.82,
    wallAffinity: true, clearance: { front: 0.8, back: 0, sides: 0.03 }, priceLabel: '€329', swatch: '#d2cbbf'
  },
  bookcase: {
    id: 'bookcase', name: 'Bookcase', category: 'Storage', width: 0.92, depth: 0.34, height: 1.92,
    wallAffinity: true, clearance: { front: 0.65, back: 0, sides: 0.03 }, priceLabel: '€199', swatch: '#d9d3c7'
  },
  rug: {
    id: 'rug', name: 'Area rug', category: 'Decor', width: 2.0, depth: 1.4, height: 0.018,
    collision: false, interaction: { tags: ['floor-covering'] },
    clearance: { front: 0, back: 0, sides: 0 }, priceLabel: '€119', swatch: '#c8b8a1'
  },
  plant: {
    id: 'plant', name: 'Floor plant', category: 'Decor', width: 0.48, depth: 0.48, height: 1.25,
    clearance: { front: 0.08, back: 0.08, sides: 0.08 }, priceLabel: '€39', swatch: '#66836a'
  }
};

type CatalogState = { products: Record<string, ProductDefinition>; list: ProductDefinition[]; issues: typeof modelCatalogue.issues; version: number; listeners: Set<() => void>; beforeListeners: Set<() => void> };
const state: CatalogState = import.meta.hot?.data.catalogue ?? {
  products: { ...BUILTIN_PRODUCTS }, list: [], issues: [], version: 0, listeners: new Set(), beforeListeners: new Set()
};
state.beforeListeners ??= new Set();
for (const product of Object.values(BUILTIN_PRODUCTS)) product.category = normalizeProductCategory(product.category) ?? 'Others';
/** Stable objects shared by placement, room loading, AI, 2D and 3D. */
export const PRODUCTS = state.products;
export const PRODUCT_LIST = state.list;
export const getProductCatalogueVersion = () => state.version;
export const getProductCatalogueIssues = () => state.issues;
export const subscribeProductCatalogue = (listener: () => void, beforeViews = false) => {
  const listeners = beforeViews ? state.beforeListeners : state.listeners;
  listeners.add(listener); return () => { listeners.delete(listener); };
};
export const displayProductDimensions = (product: ProductDefinition) => product.displayDimensions ?? product;

let catalogueSignature = '';
function updateCatalogue(data: typeof modelCatalogue) {
  const signature = JSON.stringify(data);
  if (signature === catalogueSignature) return;
  catalogueSignature = signature;
  Object.assign(PRODUCTS, BUILTIN_PRODUCTS);
  const currentIds = new Set(data.products.map((product) => product.id));
  for (const [id, product] of Object.entries(PRODUCTS)) {
    if (product.model && !currentIds.has(id)) delete PRODUCTS[id];
  }
  for (const product of data.products) PRODUCTS[product.id] = product;
  for (const [alias, id] of Object.entries(data.aliases)) if (PRODUCTS[id] && !BUILTIN_PRODUCTS[alias]) PRODUCTS[alias] = PRODUCTS[id];
  PRODUCT_LIST.splice(0, PRODUCT_LIST.length, ...Object.values(BUILTIN_PRODUCTS), ...data.products.filter((product) => product.available !== false));
  state.issues = data.issues;
  state.version++;
  state.beforeListeners.forEach((listener) => listener());
  state.listeners.forEach((listener) => listener());
}
updateCatalogue(modelCatalogue);

/** Fetch before restoring rooms: preview may have products added after the build. */
let supportsRuntimeCatalogue: boolean | undefined;
export async function initializeProductCatalogue() {
  try {
    const response = await fetch('/api/model-catalogue', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    // A static host has no API; use the catalogue bundled at build time there.
    if (!response.headers.get('content-type')?.includes('application/json')) { supportsRuntimeCatalogue = false; return; }
    supportsRuntimeCatalogue = true;
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.products) || !Array.isArray(data.issues) || !data.aliases) throw new Error(data.error ?? 'The model catalogue could not be refreshed.');
    updateCatalogue(data);
  } catch (error) {
    state.issues = [{ file: 'Model catalogue', message: error instanceof Error ? error.message : 'Could not refresh the catalogue.' }];
    state.version++; state.listeners.forEach((listener) => listener());
  }
}

export function startProductCatalogueUpdates() {
  // Development receives file-watcher events; preview refreshes via its server.
  if (import.meta.hot || supportsRuntimeCatalogue === false) return () => {};
  let refreshing = false;
  const timer = setInterval(() => {
    if (document.visibilityState !== 'visible' || refreshing) return;
    refreshing = true;
    void initializeProductCatalogue().finally(() => { refreshing = false; });
  }, 2000);
  return () => clearInterval(timer);
}
if (import.meta.hot) {
  import.meta.hot.on('domus:catalogue', updateCatalogue);
  import.meta.hot.dispose((data) => { data.catalogue = state; import.meta.hot?.off('domus:catalogue', updateCatalogue); });
}

/** Runtime derivatives retain the source URL for catalogue identity and dimensions. */
export function productModelUrl(product: ProductDefinition) {
  return product.model?.runtimeUrl ?? product.model?.url;
}

export function rotatedFootprint(product: ProductDefinition, rotationY: number) {
  const c = Math.abs(Math.cos(rotationY));
  const s = Math.abs(Math.sin(rotationY));
  return {
    width: product.width * c + product.depth * s,
    depth: product.width * s + product.depth * c
  };
}
