import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { OpeningVariant } from '../core/types';

const islandsByGeometry = new WeakMap<THREE.BufferGeometry, number[][]>();
type Band = [number, number];

/** Join coincident positions too: GLBs split vertices at UV/material/normal seams. */
function connectedParts(geometry: THREE.BufferGeometry) {
  const cached = islandsByGeometry.get(geometry);
  if (cached) return cached;
  const position = geometry.getAttribute('position');
  const parents = Int32Array.from({ length: position.count }, (_, index) => index);
  const find = (vertex: number): number => {
    while (parents[vertex] !== vertex) { parents[vertex] = parents[parents[vertex]]; vertex = parents[vertex]; }
    return vertex;
  };
  const join = (a: number, b: number) => { parents[find(a)] = find(b); };
  const coincident = new Map<string, number>();
  for (let i = 0; i < position.count; i++) {
    const key = [position.getX(i), position.getY(i), position.getZ(i)].map(v => Math.round(v * 1e6)).join(',');
    const other = coincident.get(key);
    if (other != null) join(i, other); else coincident.set(key, i);
  }
  const index = geometry.index;
  for (let i = 0; i + 2 < (index?.count ?? position.count); i += 3) {
    const a = index?.getX(i) ?? i, b = index?.getX(i + 1) ?? i + 1, c = index?.getX(i + 2) ?? i + 2;
    join(a, b); join(a, c);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < position.count; i++) {
    const root = find(i), group = groups.get(root) ?? [];
    group.push(i); groups.set(root, group);
  }
  const result = [...groups.values()];
  islandsByGeometry.set(geometry, result);
  return result;
}

/** Stretch the clear spans, retaining jambs, bevels and mullion cross sections.
 * At very small sizes protected regions shrink together rather than overlap. */
function mergeBands(source: number, bands: Band[]) {
  const merged: Band[] = [];
  for (const [a, b] of bands.map(([a, b]) => [Math.max(0, a), Math.min(source, b)] as [number, number]).sort((a, b) => a[0] - b[0])) {
    if (b <= a) continue;
    const previous = merged[merged.length - 1];
    if (previous && a <= previous[1]) previous[1] = Math.max(previous[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Interior fittings follow their original fractional position; their size stays
 * fixed. Boundary profiles remain flush with the aperture. Every mesh uses the
 * SAME map, including the panel around a handle hole and the glazing in a leaf. */
export function openingAxisMap(source: number, target: number, bands: Band[], anchors: number[] = []) {
  const merged = mergeBands(source, bands);
  const regions = merged.map(([a, b]) => {
    const point = a <= 1e-6 ? 0 : b >= source - 1e-6 ? source : anchors.find(value => value >= a && value <= b) ?? (a + b) / 2;
    return { a, b, anchor: point / source, left: point - a };
  });
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === source) return Object.assign((value: number) => value * target / source, { slope: (_value: number) => target / source });
  const protectedSize = merged.reduce((sum, [a, b]) => sum + b - a, 0);
  const scale = Math.min(1, (target - Math.min(.02, target * .05)) / Math.max(protectedSize, 1e-8));
  const gap = Math.max(0, target - protectedSize * scale) * .02 / (regions.length + 1);
  const knots: Array<[number, number]> = [[0, 0]];
  let previousEnd = 0;
  for (const [i, region] of regions.entries()) {
    const length = (region.b - region.a) * scale;
    const remaining = regions.slice(i + 1).reduce((sum, next) => sum + (next.b - next.a) * scale, 0);
    const start = region.a <= 1e-6 ? 0 : region.b >= source - 1e-6 ? target - length
      : THREE.MathUtils.clamp(region.anchor * target - region.left * scale, previousEnd + gap, target - length - remaining - gap * (regions.length - i - 1));
    knots.push([region.a, start], [region.b, start + length]);
    previousEnd = start + length;
  }
  knots.push([source, target]);
  const segments = knots.slice(1).flatMap(([b, end], i) => {
    const [a, start] = knots[i];
    return b > a + 1e-8 ? [{ a, b, start, slope: (end - start) / (b - a) }] : [];
  });
  const segmentAt = (value: number) => {
    let low = 0, high = segments.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (value <= segments[mid].b + 1e-7) high = mid; else low = mid + 1;
    }
    return segments[low];
  };
  return Object.assign((value: number) => {
    const segment = segmentAt(value);
    return segment.start + (value - segment.a) * segment.slope;
  }, { slope: (value: number) => segmentAt(value).slope });
}

type ResizePart = { geometry: THREE.BufferGeometry; name: string; material: THREE.Material | THREE.Material[]; userData: THREE.Object3D['userData']; receiveShadow: boolean };
type ResizePlan = { parts: ResizePart[]; xBands: Band[]; yBands: Band[]; yAnchors: number[] };
const plans = new WeakMap<THREE.BufferGeometry, Map<string, ResizePlan>>();

/** Split triangles at deformation boundaries BEFORE moving vertices. A long
 * diagonal across a panel otherwise takes a different path from a neighbouring
 * cutout or bevel, even with an identical vertex map. Cached once per asset. */
function splitAtBands(geometry: THREE.BufferGeometry, xBands: Band[], yBands: Band[]) {
  const attributes = Object.entries(geometry.attributes).filter(([name]) => name !== 'tangent');
  const offset = new Map<string, number>();
  let stride = 0;
  for (const [name, attribute] of attributes) { offset.set(name, stride); stride += attribute.itemSize; }
  const positionOffset = offset.get('position')!;
  const output: number[][] = attributes.map(() => []);
  const planes = [...new Set(xBands.flat())].map(value => ({ axis: positionOffset, value }))
    .concat([...new Set(yBands.flat())].map(value => ({ axis: positionOffset + 1, value })));
  const read = (index: number) => attributes.flatMap(([, attribute]) => Array.from({ length: attribute.itemSize }, (_, c) => attribute.getComponent(index, c)));
  const index = geometry.index;
  const groups: THREE.BufferGeometry['groups'] = [];
  for (const group of geometry.groups.length ? geometry.groups : [{ start: 0, count: index?.count ?? geometry.attributes.position.count, materialIndex: 0 }]) {
    const start = output[0].length / attributes[0][1].itemSize;
    for (let i = group.start; i + 2 < group.start + group.count; i += 3) {
      let polygons = [[read(index?.getX(i) ?? i), read(index?.getX(i + 1) ?? i + 1), read(index?.getX(i + 2) ?? i + 2)]];
      for (const { axis, value } of planes) {
        const next: number[][][] = [];
        for (const polygon of polygons) {
          if (!polygon.some(v => v[axis] < value - 1e-7) || !polygon.some(v => v[axis] > value + 1e-7)) { next.push(polygon); continue; }
          const halves: number[][][] = [[], []];
          for (let j = 0; j < polygon.length; j++) {
            const a = polygon[j], b = polygon[(j + 1) % polygon.length];
            if (a[axis] <= value) halves[0].push(a);
            if (a[axis] >= value) halves[1].push(a);
            if ((a[axis] < value && b[axis] > value) || (a[axis] > value && b[axis] < value)) {
              const fraction = (value - a[axis]) / (b[axis] - a[axis]);
              const cut = a.map((component, c) => component + (b[c] - component) * fraction);
              cut[axis] = value;
              halves[0].push(cut); halves[1].push(cut);
            }
          }
          next.push(...halves.filter(half => half.length >= 3));
        }
        polygons = next;
      }
      for (const polygon of polygons) for (let j = 1; j + 1 < polygon.length; j++) {
        for (const vertex of [polygon[0], polygon[j], polygon[j + 1]]) for (const [a, [name, attribute]] of attributes.entries()) {
          const begin = offset.get(name)!;
          for (let c = 0; c < attribute.itemSize; c++) output[a].push(vertex[begin + c]);
        }
      }
    }
    groups.push({ start, count: output[0].length / attributes[0][1].itemSize - start, materialIndex: group.materialIndex });
  }
  const split = new THREE.BufferGeometry();
  for (const [a, [name, attribute]] of attributes.entries()) split.setAttribute(name, new THREE.Float32BufferAttribute(output[a], attribute.itemSize));
  split.groups = groups;
  return mergeVertices(split, 1e-6);
}

function resizePlan(oriented: THREE.Group, bounds: THREE.Box3, variant: OpeningVariant): ResizePlan {
  const meshes: THREE.Mesh[] = [];
  oriented.traverse(node => { if (node instanceof THREE.Mesh) meshes.push(node); });
  const key = variant + meshes.map(mesh => mesh.geometry.uuid + ':' + mesh.matrixWorld.elements.join(',')).join(';');
  let cache = plans.get(meshes[0].geometry);
  if (!cache) { cache = new Map(); plans.set(meshes[0].geometry, cache); }
  const cached = cache.get(key);
  if (cached) return cached;
  const size = bounds.getSize(new THREE.Vector3());
  // Protect the complete nested reveal of the high window, including the lip
  // beyond its glass bounding box, rather than only the outer 130 mm casing.
  const border = variant === 'high-window' ? .17 : variant === 'single-door' ? .09 : variant.includes('door') ? .13 : .10;
  const xBands: Band[] = [[0, border], [size.x - border, size.x]], yBands: Band[] = [[0, border], [size.y - border, size.y]];
  const yAnchors: number[] = [];
  if (['double-window', 'glass-double-door', 'sliding-window'].includes(variant)) xBands.push([size.x / 2 - .065, size.x / 2 + .065]);
  if (variant === 'single-hung-window') {
    for (const fraction of [1 / 3, 2 / 3]) xBands.push([size.x * fraction - .022, size.x * fraction + .022]);
    for (const fraction of [.51, .76]) yBands.push([size.y * fraction - .065, size.y * fraction + .065]);
  }
  const normalized = meshes.map(node => {
    const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld).translate(-bounds.min.x, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
    const position = geometry.attributes.position, point = new THREE.Vector3(), extent = new THREE.Vector3();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const glazing = materials.every(material => /glass/i.test(material.name) && !/rim|rubber|black door/i.test(material.name));
    const handle = /handle|hardware/i.test(node.name)
      || (variant === 'single-door' && materials.some(material => material.name === 'Metal black'))
      || (variant === 'glass-door' && node.name.startsWith('Plane'))
      || (variant === 'semi-glass-door' && /^Cylinder\.?001$/.test(node.name));
    if (handle) {
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      xBands.push([box.min.x, box.max.x]); yBands.push([box.min.y, box.max.y]);
      yAnchors.push((box.min.y + box.max.y) / 2);
      if (variant.includes('door') && variant !== 'glass-double-door') {
        // Preserve the whole latch-side assembly, including its cutouts/lock.
        // A floating interior band would move the handle towards the centre of
        // a widened leaf. Height still follows the authored fractional anchor.
        if ((box.min.x + box.max.x) / 2 < size.x / 2) xBands.push([0, box.max.x + .025]);
        else xBands.push([box.min.x - .025, size.x]);
      }
    }
    if (!glazing) for (const vertices of connectedParts(node.geometry)) {
      const box = new THREE.Box3();
      for (const vertex of vertices) box.expandByPoint(point.fromBufferAttribute(position, vertex));
      box.getSize(extent);
      const hardware = /handle|hardware|screw|hinge/i.test(node.name) || (extent.x < .28 && extent.y < .35);
      if (hardware || extent.x < .14) xBands.push([box.min.x, box.max.x]);
      if (hardware || extent.y < .14) yBands.push([box.min.y, box.max.y]);
    }
    return geometry;
  });
  const mergedX = mergeBands(size.x, xBands), mergedY = mergeBands(size.y, yBands);
  const parts = meshes.map((node, i) => ({ geometry: splitAtBands(normalized[i], mergedX, mergedY), name: node.name,
    material: node.material, userData: { ...node.userData }, receiveShadow: node.receiveShadow }));
  const plan = { parts, xBands: mergedX, yBands: mergedY, yAnchors };
  cache.set(key, plan);
  return plan;
}

export function resizeOpeningGeometry(oriented: THREE.Group, bounds: THREE.Box3, variant: OpeningVariant, width: number, height: number) {
  const size = bounds.getSize(new THREE.Vector3()), plan = resizePlan(oriented, bounds, variant);
  const mapX = openingAxisMap(size.x, width, plan.xBands), mapY = openingAxisMap(size.y, height, plan.yBands, plan.yAnchors);
  const root = new THREE.Group();
  const normal = new THREE.Vector3();
  // All surfaces, cutouts and fittings share one continuous deformation.
  for (const part of plan.parts) {
    const geometry = part.geometry.clone();
    const positions = geometry.attributes.position, normals = geometry.attributes.normal;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i);
      positions.setXYZ(i, mapX(x) - width / 2, mapY(y), positions.getZ(i));
      if (normals && Math.abs(normals.getX(i)) + Math.abs(normals.getY(i)) + Math.abs(normals.getZ(i)) > 1.00001) {
        normal.set(normals.getX(i) / Math.max(mapX.slope(x), 1e-8), normals.getY(i) / Math.max(mapY.slope(y), 1e-8), normals.getZ(i)).normalize();
        normals.setXYZ(i, normal.x, normal.y, normal.z);
      }
    }
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, part.material);
    mesh.name = part.name;
    mesh.userData = { ...part.userData, openingInstanceGeometry: true };
    mesh.receiveShadow = part.receiveShadow;
    root.add(mesh);
  }
  return root;
}
