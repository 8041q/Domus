import type { FloorFinish } from './types';

export interface FloorFinishDefinition {
  id: FloorFinish;
  name: string;
  source: string;
  sourceUrl: string;
  fallbackColor: string;
  /** Width of one texture tile in real-world metres. */
  textureWidthMetres: number;
  normalScale: number;
  /** Matte fallback used before the PBR maps are ready or when a request fails. */
  fallbackRoughness: number;
  /** Planner-only reflection strength. Lower values keep broad studio reflections from reading as gloss. */
  envMapIntensity: number;
  /** Optional treatment applied to the CC0 base-colour map after it loads. */
  colorTreatment?: 'dark-grey-carpet';
  previewUrl: string;
  maps: {
    color: string;
    normal: string;
    roughness: string;
  };
}

/**
 * Finish ids are persisted in room snapshots, so keep the ids stable even when
 * the displayed material name or renderer treatment evolves.
 *
 * The PBR maps are CC0 assets. 1K maps are used in the planner to keep the UI
 * responsive; GLTFExporter can embed the loaded maps into the exported GLB.
 */
export const FLOOR_FINISHES: FloorFinishDefinition[] = [
  {
    id: 'light-oak',
    name: 'Wood floor',
    source: 'Poly Haven · Wood Floor (CC0)',
    sourceUrl: 'https://polyhaven.com/a/wood_floor',
    fallbackColor: '#9d7855',
    textureWidthMetres: 1.7,
    normalScale: 0.72,
    fallbackRoughness: 0.92,
    envMapIntensity: 0.46,
    previewUrl: 'https://cdn.polyhaven.com/asset_img/map_previews/wood_floor/wood_floor_diff_1k.jpg?width=192&height=128&quality=90',
    maps: {
      color: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/wood_floor/wood_floor_diff_1k.jpg',
      normal: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/wood_floor/wood_floor_nor_gl_1k.jpg',
      roughness: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/wood_floor/wood_floor_rough_1k.jpg'
    }
  },
  {
    id: 'warm-oak',
    name: 'Floating floor',
    source: 'Poly Haven · Laminate Floor 03 (CC0)',
    sourceUrl: 'https://polyhaven.com/a/laminate_floor_03',
    fallbackColor: '#a57a52',
    textureWidthMetres: 2.1,
    normalScale: 0.58,
    fallbackRoughness: 0.9,
    envMapIntensity: 0.42,
    previewUrl: 'https://cdn.polyhaven.com/asset_img/map_previews/laminate_floor_03/laminate_floor_03_diff_1k.jpg?width=192&height=128&quality=90',
    maps: {
      color: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/laminate_floor_03/laminate_floor_03_diff_1k.jpg',
      normal: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/laminate_floor_03/laminate_floor_03_nor_gl_1k.jpg',
      roughness: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/laminate_floor_03/laminate_floor_03_rough_1k.jpg'
    }
  },
  {
    id: 'stone',
    name: 'Dark grey carpet',
    source: 'ambientCG · Carpet 011 (CC0), neutral dark-grey grade',
    sourceUrl: 'https://ambientcg.com/view?id=Carpet011',
    fallbackColor: '#4d5153',
    // ambientCG's legacy Carpet011 does not publish a physical scan width.
    // Treating the seamless tile as 1 m keeps the pile detail at a useful room scale.
    textureWidthMetres: 1,
    normalScale: 1.05,
    fallbackRoughness: 1,
    envMapIntensity: 0.16,
    colorTreatment: 'dark-grey-carpet',
    previewUrl: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Carpet011%20PREVIEW.jpg?width=192',
    maps: {
      color: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Carpet011%208K%20Color.png?width=1024',
      normal: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Carpet011%208K%20NormalGL.png?width=1024',
      roughness: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Carpet011%208K%20Roughness.png?width=1024'
    }
  },
  {
    id: 'concrete',
    name: 'Vinyl',
    source: 'Poly Haven · Old Linoleum Flooring 01 (CC0)',
    sourceUrl: 'https://polyhaven.com/a/old_linoleum_flooring_01',
    fallbackColor: '#b59d78',
    textureWidthMetres: 2,
    normalScale: 0.46,
    fallbackRoughness: 0.94,
    envMapIntensity: 0.34,
    previewUrl: 'https://cdn.polyhaven.com/asset_img/map_previews/old_linoleum_flooring_01/old_linoleum_flooring_01_diff_1k.jpg?width=192&height=128&quality=90',
    maps: {
      color: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/old_linoleum_flooring_01/old_linoleum_flooring_01_diff_1k.jpg',
      normal: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/old_linoleum_flooring_01/old_linoleum_flooring_01_nor_gl_1k.jpg',
      roughness: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/old_linoleum_flooring_01/old_linoleum_flooring_01_rough_1k.jpg'
    }
  }
];

export const WALL_FINISHES = [
  { name: 'Warm white', value: '#eeeae1' },
  { name: 'Soft ivory', value: '#f4f1e9' },
  { name: 'Light greige', value: '#d9d2c8' },
  { name: 'Warm beige', value: '#d6c4ad' },
  { name: 'Soft grey', value: '#d4d5d0' },
  { name: 'Muted sage', value: '#c2c8ba' }
] as const;

export function floorFinishDefinition(id: FloorFinish) {
  return FLOOR_FINISHES.find((finish) => finish.id === id) ?? FLOOR_FINISHES[0];
}
