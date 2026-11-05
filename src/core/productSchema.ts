import schema from '../../blender_addon/catalogue_schema.json';
import type { ProductDefinition } from './types';

/** Shared by the server, catalogue UI and packaged Blender add-on. */
export const PRODUCT_CATEGORIES = schema.categories;
export const PRODUCT_METADATA_VERSION = schema.version;
export function normalizeProductCategory(category: string): string | null {
  if (PRODUCT_CATEGORIES.includes(category)) return category;
  const aliases = schema.legacyCategoryAliases as Record<string, string>;
  return Object.hasOwn(aliases, category) ? aliases[category] : null;
}

export function productDimensionSourceLabel(product?: ProductDefinition): string {
  if (!product) return 'Unavailable';
  if (product.displayDimensions?.source === 'source-model') return 'Source model';
  if (product.displayDimensions) return 'Entered dimensions';
  return product.model ? 'Model geometry' : 'Sample catalogue';
}
