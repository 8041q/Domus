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

  /** Height-map displacement strength in metres on the architectural floor surface. */
  heightScale: number;

  /** Disable the normal map for finishes that should render without micro-normal detail. */
  useNormalMap?: boolean;

  /** Disable vertex displacement for finishes such as carpet. */
  useHeightMap?: boolean;

  /** Disable the roughness texture and use fallbackRoughness as a constant. */
  useRoughnessMap?: boolean;

  /** Apply stochastic colour anti-tiling. Intended for visually random carpets only. */
  antiTile?: boolean;

  /** Texture wrapping strategy. Keep directional materials on ordinary repeat wrapping. */
  wrapMode?: 'repeat' | 'mirror';

  /** Maximum anisotropy requested for this finish. */
  anisotropy?: number;

  /** Matte fallback used before the PBR maps are ready or when a request fails. */
  fallbackRoughness: number;

  /** Planner-only reflection strength. Lower values keep broad studio reflections from reading as gloss. */
  envMapIntensity: number;

  previewUrl: string;
  maps: {
    color: string;
    normal: string;
    height: string;
    roughness: string;
  };
}

/**
 * Floor finishes are local ambientCG 1K PNG assets supplied with the project.
 * Their authored base-colour maps are used directly: there is no floor colour tint
 * or recolouring option layered over the material.
 */
export const FLOOR_FINISHES: FloorFinishDefinition[] = [
  {
    id: 'wood-floor-057',
    name: 'Wood Floor 057',
    source: 'ambientCG · WoodFloor057 (CC0)',
    sourceUrl: 'https://ambientcg.com/view?id=WoodFloor057',
    fallbackColor: '#9b7654',
    textureWidthMetres: 3.2,
    normalScale: 0.82,
    heightScale: 0.0018,
    useNormalMap: true,
    useHeightMap: true,
    wrapMode: 'repeat',
    anisotropy: 8,
    fallbackRoughness: 0.72,
    envMapIntensity: 0.42,
    previewUrl: '/materials/floors/wood-floor-057/color.png',
    maps: {
      color: '/materials/floors/wood-floor-057/color.png',
      normal: '/materials/floors/wood-floor-057/normalgl.png',
      height: '/materials/floors/wood-floor-057/displacement.png',
      roughness: '/materials/floors/wood-floor-057/roughness.png'
    }
  },
  {
    id: 'carpet-011',
    name: 'Carpet 011',
    source: 'ambientCG · Carpet011 (CC0)',
    sourceUrl: 'https://ambientcg.com/view?id=Carpet011',
    fallbackColor: '#736f5f',
    textureWidthMetres: 1,
    normalScale: 0,
    heightScale: 0,
    useNormalMap: false,
    useHeightMap: false,
    useRoughnessMap: false,
    antiTile: true,
    wrapMode: 'repeat',
    anisotropy: 8,
    fallbackRoughness: 0.96,
    envMapIntensity: 0.12,
    previewUrl: '/materials/floors/carpet-011/color.png',
    maps: {
      color: '/materials/floors/carpet-011/color.png',
      normal: '/materials/floors/carpet-011/normalgl.png',
      height: '/materials/floors/carpet-011/displacement.png',
      roughness: '/materials/floors/carpet-011/roughness.png'
    }
  },
  {
    id: 'wood-floor-035',
    name: 'Wood Floor 035',
    source: 'ambientCG · WoodFloor035 (CC0)',
    sourceUrl: 'https://ambientcg.com/view?id=WoodFloor035',
    fallbackColor: '#9c7652',
    textureWidthMetres: 1.9,
    normalScale: 0.82,
    heightScale: 0.0018,
    useNormalMap: true,
    useHeightMap: true,
    wrapMode: 'repeat',
    anisotropy: 8,
    fallbackRoughness: 0.74,
    envMapIntensity: 0.4,
    previewUrl: '/materials/floors/wood-floor-035/color.png',
    maps: {
      color: '/materials/floors/wood-floor-035/color.png',
      normal: '/materials/floors/wood-floor-035/normalgl.png',
      height: '/materials/floors/wood-floor-035/displacement.png',
      roughness: '/materials/floors/wood-floor-035/roughness.png'
    }
  },
  {
    id: 'wood-floor-020',
    name: 'Wood Floor 020',
    source: 'ambientCG · WoodFloor020 (CC0)',
    sourceUrl: 'https://ambientcg.com/view?id=WoodFloor020',
    fallbackColor: '#a7815e',
    textureWidthMetres: 1,
    normalScale: 0.78,
    heightScale: 0.0015,
    useNormalMap: true,
    useHeightMap: true,
    wrapMode: 'repeat',
    anisotropy: 8,
    fallbackRoughness: 0.76,
    envMapIntensity: 0.4,
    previewUrl: '/materials/floors/wood-floor-020/color.png',
    maps: {
      color: '/materials/floors/wood-floor-020/color.png',
      normal: '/materials/floors/wood-floor-020/normalgl.png',
      height: '/materials/floors/wood-floor-020/displacement.png',
      roughness: '/materials/floors/wood-floor-020/roughness.png'
    }
  },
  {
    id: 'terrazzo-005',
    name: 'Terrazzo 005',
    source: 'ambientCG · Terrazzo005 (CC0)',
    sourceUrl: 'https://ambientcg.com/view?id=Terrazzo005',
    fallbackColor: '#b7b1a8',
    textureWidthMetres: 1,
    normalScale: 0.65,
    heightScale: 0.0008,
    useNormalMap: true,
    useHeightMap: true,
    wrapMode: 'repeat',
    anisotropy: 8,
    fallbackRoughness: 0.82,
    envMapIntensity: 0.34,
    previewUrl: '/materials/floors/terrazzo-005/color.png',
    maps: {
      color: '/materials/floors/terrazzo-005/color.png',
      normal: '/materials/floors/terrazzo-005/normalgl.png',
      height: '/materials/floors/terrazzo-005/displacement.png',
      roughness: '/materials/floors/terrazzo-005/roughness.png'
    }
  },
  {
    id: 'terrazzo-007',
    name: 'Terrazzo 007',
    source: 'ambientCG · Terrazzo007 (CC0)',
    sourceUrl: 'https://ambientcg.com/view?id=Terrazzo007',
    fallbackColor: '#aaa49d',
    textureWidthMetres: 1,
    normalScale: 0.65,
    heightScale: 0.0008,
    useNormalMap: true,
    useHeightMap: true,
    wrapMode: 'repeat',
    anisotropy: 8,
    fallbackRoughness: 0.82,
    envMapIntensity: 0.34,
    previewUrl: '/materials/floors/terrazzo-007/color.png',
    maps: {
      color: '/materials/floors/terrazzo-007/color.png',
      normal: '/materials/floors/terrazzo-007/normalgl.png',
      height: '/materials/floors/terrazzo-007/displacement.png',
      roughness: '/materials/floors/terrazzo-007/roughness.png'
    }
  },
  {
    id: 'carpet-012',
    name: 'Carpet 012',
    source: 'ambientCG · Carpet012 (CC0)',
    sourceUrl: 'https://ambientcg.com/view?id=Carpet012',
    fallbackColor: '#77736d',
    textureWidthMetres: 1,
    normalScale: 0,
    heightScale: 0,
    useNormalMap: false,
    useHeightMap: false,
    useRoughnessMap: false,
    antiTile: true,
    wrapMode: 'repeat',
    anisotropy: 8,
    fallbackRoughness: 0.96,
    envMapIntensity: 0.12,
    previewUrl: '/materials/floors/carpet-012/color.png',
    maps: {
      color: '/materials/floors/carpet-012/color.png',
      normal: '/materials/floors/carpet-012/normalgl.png',
      height: '/materials/floors/carpet-012/displacement.png',
      roughness: '/materials/floors/carpet-012/roughness.png'
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

export function normalizeFloorFinish(id: unknown): FloorFinish {
  return FLOOR_FINISHES.find((finish) => finish.id === id)?.id ?? FLOOR_FINISHES[0].id;
}
