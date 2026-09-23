import type { ProductDefinition, ProductKind } from './types';

export const PRODUCTS: Record<ProductKind, ProductDefinition> = {
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

export const PRODUCT_LIST = Object.values(PRODUCTS);

export function rotatedFootprint(product: ProductDefinition, rotationY: number) {
  const c = Math.abs(Math.cos(rotationY));
  const s = Math.abs(Math.sin(rotationY));
  return {
    width: product.width * c + product.depth * s,
    depth: product.width * s + product.depth * c
  };
}
