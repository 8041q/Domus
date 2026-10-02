import * as THREE from 'three';
import { polygonArea } from '../core/roomGeometry';
import type { Vec2 } from '../core/types';

const EPS = 1e-9;
const cross = (a: Vec2, b: Vec2, p: Vec2) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);

function triangles(polygon: Vec2[]) {
  const points = polygonArea(polygon) < 0 ? [...polygon].reverse() : polygon;
  return THREE.ShapeUtils.triangulateShape(points.map((p) => new THREE.Vector2(p.x, p.z)), [])
    .map(([a, b, c]) => [points[a], points[b], points[c]]);
}

/** Convex clipping is applied to triangle pairs, so concave/disconnected results
 * never bridge a room recess or a narrow space beside an exterior wall. */
function intersectTriangles(subject: Vec2[], boundary: Vec2[]) {
  let result = subject;
  for (let i = 0; i < 3 && result.length; i++) {
    const a = boundary[i], b = boundary[(i + 1) % 3];
    const input = result;
    result = [];
    let previous = input[input.length - 1];
    let previousDistance = cross(a, b, previous);
    for (const current of input) {
      const distance = cross(a, b, current);
      const wasInside = previousDistance >= -EPS, isInside = distance >= -EPS;
      if (wasInside !== isInside) {
        const t = previousDistance / (previousDistance - distance);
        result.push({ x: previous.x + (current.x - previous.x) * t, z: previous.z + (current.z - previous.z) * t });
      }
      if (isInside) result.push(current);
      previous = current;
      previousDistance = distance;
    }
  }
  return result;
}

/** Finish surfaces stop at the slab's inner miter edge. Space outlines remain
 * on wall centre lines for areas, identity and finish ownership. */
export function createFloorSurfaceGeometry(space: Vec2[], innerPerimeter: Vec2[], subdivisionMetres = 0.08) {
  const positions: number[] = [], uvs: number[] = [];
  const push = (p: Vec2) => { positions.push(p.x, 0, p.z); uvs.push(p.x, p.z); };
  const pushTriangle = (a: Vec2, b: Vec2, c: Vec2) => {
    if (Math.abs(cross(a, b, c)) <= EPS) return;
    const longest = Math.max(Math.hypot(b.x - a.x, b.z - a.z), Math.hypot(c.x - b.x, c.z - b.z), Math.hypot(a.x - c.x, a.z - c.z));
    const segments = subdivisionMetres > 0 ? Math.max(1, Math.min(96, Math.ceil(longest / subdivisionMetres))) : 1;
    const point = (i: number, j: number) => ({ x: a.x + ((b.x - a.x) * i + (c.x - a.x) * j) / segments,
      z: a.z + ((b.z - a.z) * i + (c.z - a.z) * j) / segments });
    for (let i = 0; i < segments; i++) for (let j = 0; j < segments - i; j++) {
      // Reverse the X/Z winding to face upward in Y-up space.
      push(point(i, j)); push(point(i, j + 1)); push(point(i + 1, j));
      if (i + j < segments - 1) {
        push(point(i + 1, j)); push(point(i, j + 1)); push(point(i + 1, j + 1));
      }
    }
  };
  const boundaryTriangles = triangles(innerPerimeter);
  for (const subject of triangles(space)) for (const boundary of boundaryTriangles) {
    const polygon = intersectTriangles(subject, boundary);
    for (let i = 1; i < polygon.length - 1; i++) pushTriangle(polygon[0], polygon[i], polygon[i + 1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}
