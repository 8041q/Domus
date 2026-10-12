import schema from '../../blender_addon/catalogue_schema.json';

/** Shared by the server, catalogue UI and packaged Blender add-on. */
export const PRODUCT_CATEGORIES = schema.categories;
export const PRODUCT_METADATA_VERSION = schema.version;
export function normalizeProductCategory(category: string): string | null {
  if (PRODUCT_CATEGORIES.includes(category)) return category;
  const aliases = schema.legacyCategoryAliases as Record<string, string>;
  return Object.hasOwn(aliases, category) ? aliases[category] : null;
}
