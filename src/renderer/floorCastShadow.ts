import * as THREE from 'three';
import { createFloorSurfaceGeometry } from './floorGeometry';
import type { Vec2 } from '../core/types';

/** Keep cast-shadow contrast independent of the floor's bounced/environment
 * light. This samples the existing key-light map, requiring no extra shadow map. */
export function createFloorCastShadow(perimeter: Vec2[], light: THREE.DirectionalLight) {
  const mask = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const intermediate = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const vertexShader = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  const decode = new THREE.ShaderMaterial({
    uniforms: {
      castMap: { value: null }, castMatrix: { value: light.shadow.matrix },
      inverseCastMatrix: { value: new THREE.Matrix4() }, castBias: { value: light.shadow.bias }
    },
    vertexShader,
    fragmentShader: `
      #include <common>
      #include <packing>
      uniform sampler2D castMap;
      uniform mat4 castMatrix;
      uniform mat4 inverseCastMatrix;
      uniform float castBias;
      varying vec2 vUv;
      void main() {
        vec4 nearPoint = inverseCastMatrix * vec4(vUv, 0.0, 1.0);
        vec4 farPoint = inverseCastMatrix * vec4(vUv, 1.0, 1.0);
        vec3 a = nearPoint.xyz / nearPoint.w, b = farPoint.xyz / farPoint.w;
        float t = (0.005 - a.y) / (b.y - a.y);
        vec4 floorCoord = castMatrix * vec4(mix(a, b, t), 1.0);
        float depth = unpackRGBAToDepth(texture2D(castMap, vUv));
        float shadow = 1.0 - step(floorCoord.z / floorCoord.w + castBias, depth);
        gl_FragColor = vec4(vec3(shadow), 1.0);
      }
    `,
    depthTest: false, depthWrite: false
  });
  const blur = new THREE.ShaderMaterial({
    uniforms: { source: { value: mask.texture }, blurStep: { value: new THREE.Vector2() } },
    vertexShader,
    fragmentShader: `
      uniform sampler2D source;
      uniform vec2 blurStep;
      varying vec2 vUv;
      void main() {
        float shadow = 0.0, weights = 0.0;
        for (int i = -8; i <= 8; i++) {
          float offset = float(i);
          float weight = exp(-0.5 * offset * offset / 9.0);
          shadow += texture2D(source, vUv + offset * blurStep).r * weight;
          weights += weight;
        }
        gl_FragColor = vec4(vec3(shadow / weights), 1.0);
      }
    `,
    depthTest: false, depthWrite: false
  });
  const quad = new THREE.Mesh(quadGeometry, decode);
  quad.frustumCulled = false;
  const filterScene = new THREE.Scene();
  filterScene.add(quad);
  const filterCamera = new THREE.Camera();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      castMap: { value: mask.texture }, castMatrix: { value: light.shadow.matrix },
      opacity: { value: 0.34 }, ready: { value: 0 }
    },
    vertexShader: `
      uniform mat4 castMatrix;
      varying vec4 vCastCoord;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vCastCoord = castMatrix * worldPosition;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D castMap;
      uniform float opacity;
      uniform float ready;
      varying vec4 vCastCoord;
      void main() {
        vec3 coord = vCastCoord.xyz / vCastCoord.w;
        if (ready < 0.5 || coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 || coord.z > 1.0) discard;
        float alpha = opacity * texture2D(castMap, coord.xy).r;
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(0.025, 0.025, 0.025, alpha);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(createFloorSurfaceGeometry(perimeter, perimeter, 0), material);
  mesh.position.y = 0.005;
  mesh.renderOrder = 2;
  mesh.userData.floorCastShadow = true;
  mesh.onBeforeRender = (renderer) => {
    const map = light.shadow.map;
    material.uniforms.ready.value = 0;
    if (!map) return;
    mask.setSize(map.width, map.height);
    intermediate.setSize(map.width, map.height);
    decode.uniforms.castMap.value = map.texture;
    decode.uniforms.castBias.value = light.shadow.bias;
    decode.uniforms.inverseCastMatrix.value.copy(light.shadow.matrix).invert();
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousShadow = renderer.shadowMap.enabled;
    try {
      renderer.autoClear = false;
      renderer.shadowMap.enabled = false;
      quad.material = decode;
      renderer.setRenderTarget(mask);
      renderer.render(filterScene, filterCamera);
      // Blur the visibility mask, not the packed depth. Linear filtering and
      // separable Gaussian passes remove the repeated silhouettes of sparse PCF.
      const radius = 6;
      quad.material = blur;
      blur.uniforms.source.value = mask.texture;
      blur.uniforms.blurStep.value.set(radius / (8 * map.width), 0);
      renderer.setRenderTarget(intermediate);
      renderer.render(filterScene, filterCamera);
      blur.uniforms.source.value = intermediate.texture;
      blur.uniforms.blurStep.value.set(0, radius / (8 * map.height));
      renderer.setRenderTarget(mask);
      renderer.render(filterScene, filterCamera);
      material.uniforms.ready.value = 1;
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
      renderer.shadowMap.enabled = previousShadow;
    }
  };
  material.addEventListener('dispose', () => {
    mask.dispose(); intermediate.dispose(); quadGeometry.dispose(); decode.dispose(); blur.dispose(); filterScene.clear();
  });
  return mesh;
}
