import type { ProductDefinition } from './types';

export function productMount(product: ProductDefinition | undefined): 'floor' | 'ceiling' {
  // Older saved rooms predate mounting metadata for this ceiling fixture.
  return product?.mount ?? (/^ainno20\b/i.test(product?.name ?? '') ? 'ceiling' : 'floor');
}

export function productElevation(product: ProductDefinition | undefined, roomHeight: number): number {
  return product && productMount(product) === 'ceiling' ? roomHeight - product.height : 0;
}
