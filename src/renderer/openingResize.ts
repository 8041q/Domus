import * as THREE from 'three';
import type { OpeningVariant } from '../core/types';

type Island = { vertices: number[]; bounds: THREE.Box3 };
const islandsByGeometry = new WeakMap<THREE.BufferGeometry, number[][]>();

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
export function openingAxisMap(source: number, target: number, bands: Array<[number, number]>) {
  const merged: Array<[number, number]> = [];
  for (const [a, b] of bands.map(([a, b]) => [Math.max(0, a), Math.min(source, b)] as [number, number]).sort((a, b) => a[0] - b[0])) {
    if (b <= a) continue;
    const previous = merged[merged.length - 1];
    if (previous && a <= previous[1]) previous[1] = Math.max(previous[1], b);
    else merged.push([a, b]);
  }
  const protectedSize = merged.reduce((sum, [a, b]) => sum + b - a, 0);
  const protectedScale = Math.min(1, target * 0.8 / Math.max(protectedSize, 1e-8));
  const stretchScale = (target - protectedSize * protectedScale) / Math.max(source - protectedSize, 1e-8);
  return (coordinate: number) => {
    const protectedBefore = merged.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(coordinate, b) - a), 0);
    return protectedBefore * protectedScale + (coordinate - protectedBefore) * stretchScale;
  };
}

export function resizeOpeningGeometry(oriented: THREE.Group, bounds: THREE.Box3, variant: OpeningVariant, width: number, height: number) {
  const size = bounds.getSize(new THREE.Vector3());
  const border = variant === 'single-door' ? 0.09 : variant.includes('door') || variant === 'high-window' ? 0.13 : 0.10;
  const xBands: Array<[number, number]> = [[0, border], [size.x - border, size.x]];
  const yBands: Array<[number, number]> = [[0, border], [size.y - border, size.y]];
  if (['double-window', 'glass-double-door', 'sliding-window'].includes(variant)) xBands.push([size.x / 2 - 0.065, size.x / 2 + 0.065]);
  if (variant === 'single-hung-window') {
    for (const fraction of [1 / 3, 2 / 3]) xBands.push([size.x * fraction - 0.022, size.x * fraction + 0.022]);
    for (const fraction of [0.51, 0.76]) yBands.push([size.y * fraction - 0.065, size.y * fraction + 0.065]);
  }
  const mapX = openingAxisMap(size.x, width, xBands), mapY = openingAxisMap(size.y, height, yBands);
  const root = new THREE.Group();
  const point = new THREE.Vector3(), centre = new THREE.Vector3(), extent = new THREE.Vector3();
  oriented.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
    geometry.boundsTree = undefined;
    geometry.deleteAttribute('tangent');
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    const parts: Island[] = connectedParts(node.geometry).map(vertices => {
      const box = new THREE.Box3();
      for (const vertex of vertices) box.expandByPoint(point.fromBufferAttribute(positions, vertex));
      return { vertices, bounds: box };
    });
    for (const part of parts) {
      part.bounds.getCenter(centre); part.bounds.getSize(extent);
      const x = centre.x - bounds.min.x, y = centre.y - bounds.min.y;
      const hardware = /handle|hardware|screw|hinge/i.test(node.name)
        || (extent.x < 0.28 && extent.y < 0.35);
      // Small disconnected fittings translate intact, including handles joined
      // into the same mesh as the leaf. Their circles never become ellipses.
      const rigidX = hardware || extent.x < 0.14;
      const rigidY = hardware || extent.y < 0.14;
      let targetX = hardware && variant.includes('door') && variant !== 'glass-double-door'
        ? x < size.x / 2 ? x : width - (size.x - x) : mapX(x);
      let targetY = hardware && variant.includes('door')
        ? Math.max(extent.y / 2, Math.min(y > size.y * 0.75 ? height - (size.y - y) : y, height - extent.y / 2 - 0.04)) : mapY(y);
      if (rigidX) targetX = THREE.MathUtils.clamp(targetX, extent.x / 2, width - extent.x / 2);
      if (rigidY) targetY = THREE.MathUtils.clamp(targetY, extent.y / 2, height - extent.y / 2);
      for (const vertex of part.vertices) {
        point.fromBufferAttribute(positions, vertex);
        const px = point.x - bounds.min.x, py = point.y - bounds.min.y;
        positions.setXYZ(vertex, (rigidX ? targetX + px - x : mapX(px)) - width / 2,
          rigidY ? targetY + py - y : mapY(py), point.z - (bounds.min.z + bounds.max.z) / 2);
      }
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, node.material);
    mesh.name = node.name;
    mesh.userData = { ...node.userData, openingInstanceGeometry: true };
    mesh.castShadow = node.castShadow; mesh.receiveShadow = node.receiveShadow;
    root.add(mesh);
  });
  return root;
}
