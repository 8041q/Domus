import * as THREE from 'three';
import type { Vec2 } from '../core/types';

interface PerimeterShadeOptions {
  height: number;
  width: number;
  cornerRadius: number;
  contactWidth: number;
  edgeOpacity: number;
  cornerOpacity: number;
  contactOpacity: number;
  color: THREE.ColorRepresentation;
}

/** One polygon receives one shade sample. Wide offset rings can fold or overlap
 * at acute corners and narrow recesses, so falloff uses actual segment distances. */
export function createPerimeterShade(perimeter: Vec2[], corners: number[], options: PerimeterShadeOptions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(
    perimeter.flatMap((point) => [point.x, options.height, point.z]), 3
  ));
  geometry.setIndex(THREE.ShapeUtils.triangulateShape(
    perimeter.map((point) => new THREE.Vector2(point.x, point.z)), []
  ).flat());

  const count = Math.max(1, perimeter.length);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      perimeter: { value: perimeter.map((point) => new THREE.Vector2(point.x, point.z)) },
      corners: { value: perimeter.map((_, index) => corners[index] ?? 0) },
      width: { value: options.width },
      cornerRadius: { value: options.cornerRadius },
      contactWidth: { value: options.contactWidth },
      edgeOpacity: { value: options.edgeOpacity },
      cornerOpacity: { value: options.cornerOpacity },
      contactOpacity: { value: options.contactOpacity },
      shadeColor: { value: new THREE.Color(options.color) }
    },
    vertexShader: `
      varying vec2 vRoomPosition;
      void main() {
        vRoomPosition = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec2 perimeter[${count}];
      uniform float corners[${count}];
      uniform float width;
      uniform float cornerRadius;
      uniform float contactWidth;
      uniform float edgeOpacity;
      uniform float cornerOpacity;
      uniform float contactOpacity;
      uniform vec3 shadeColor;
      varying vec2 vRoomPosition;
      void main() {
        float wallDistance = 1.0e20;
        float nearCorner = 0.0;
        for (int i = 0; i < ${count}; i++) {
          vec2 a = perimeter[i];
          vec2 b = perimeter[(i + 1) % ${count}];
          vec2 segment = b - a;
          float t = clamp(dot(vRoomPosition - a, segment) / max(dot(segment, segment), 1.0e-12), 0.0, 1.0);
          wallDistance = min(wallDistance, length(vRoomPosition - a - t * segment));
          nearCorner = max(nearCorner, corners[i] * (1.0 - smoothstep(0.0, cornerRadius, distance(vRoomPosition, a))));
        }
        float fromWall = 1.0 - smoothstep(0.0, width, wallDistance);
        float contact = 1.0 - smoothstep(0.0, contactWidth, wallDistance);
        float opacity = fromWall * (edgeOpacity + cornerOpacity * nearCorner) + contactOpacity * contact;
        gl_FragColor = vec4(shadeColor, opacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const shade = new THREE.Mesh(geometry, material);
  shade.renderOrder = 1;
  return shade;
}
