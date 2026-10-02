import * as THREE from 'three';
import { profileHeight, type WallProfile } from '../core/interiorWallView';

/** Closed wall sections: material 0 is poché, 1/2 are the two painted sides. */
export function cutWallGeometry(start: number, end: number, bottom: number, top: number, thickness: number, profile: WallProfile) {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const half = thickness / 2;
  const quad = (points: number[][], material: number) => {
    const offset = positions.length / 3;
    for (const index of [0, 1, 2, 0, 2, 3]) positions.push(...points[index]);
    geometry.addGroup(offset, 6, material);
  };
  const breaks = [start, ...profile.filter((p) => p.x > start && p.x < end).map((p) => p.x), end];
  // Insert crossings at floor/lintel heights so a sloping reveal never bridges a door gap.
  const cuts = [...breaks];
  for (let i = 1; i < breaks.length; i++) {
    const a = breaks[i - 1], b = breaks[i], ha = profileHeight(profile, a), hb = profileHeight(profile, b);
    for (const height of [bottom, top]) if ((ha - height) * (hb - height) < 0) cuts.push(a + (b - a) * (height - ha) / (hb - ha));
  }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1], b = cuts[i];
    const ha = Math.max(bottom, Math.min(top, profileHeight(profile, a)));
    const hb = Math.max(bottom, Math.min(top, profileHeight(profile, b)));
    if (b - a < 1e-6 || Math.max(ha, hb) <= bottom + 1e-6) continue;
    quad([[a,bottom,half],[b,bottom,half],[b,hb,half],[a,ha,half]], 1);
    quad([[b,bottom,-half],[a,bottom,-half],[a,ha,-half],[b,hb,-half]], 2);
    quad([[a,ha,half],[b,hb,half],[b,hb,-half],[a,ha,-half]], 0);
    quad([[a,bottom,-half],[b,bottom,-half],[b,bottom,half],[a,bottom,half]], 0);
    if (i === 1) quad([[a,bottom,-half],[a,bottom,half],[a,ha,half],[a,ha,-half]], 0);
    if (i === cuts.length - 1) quad([[b,bottom,half],[b,bottom,-half],[b,hb,-half],[b,hb,half]], 0);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
