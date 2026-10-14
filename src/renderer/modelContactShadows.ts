import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Bake the nearest underside into a height-faded mask once per static asset.
 * Texture ownership stays here; individual placed shadows only borrow it. */
export class ModelContactShadows {
  private masks = new Map<THREE.Group, { target: THREE.WebGLRenderTarget; size: THREE.Vector3; centre: THREE.Vector3 }>();

  constructor(private renderer: THREE.WebGLRenderer) {}

  create(model: THREE.Group) {
    let mask = this.masks.get(model);
    if (!mask) {
      mask = this.bake(model);
      this.masks.set(model, mask);
    }
    const { target, size, centre } = mask;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        contactMask: { value: target.texture },
        blurStep: { value: new THREE.Vector2(0.012 / size.x, 0.012 / size.z) },
        opacity: { value: 0.58 }
      },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform sampler2D contactMask;
        uniform vec2 blurStep;
        uniform float opacity;
        varying vec2 vUv;
        void main() {
          float contact = 0.0;
          float weights = 0.0;
          for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) {
            vec2 offset = vec2(float(x), float(y));
            float weight = exp(-0.5 * dot(offset, offset));
            contact += texture2D(contactMask, vUv + offset * blurStep).r * weight;
            weights += weight;
          }
          float alpha = opacity * contact / weights;
          if (alpha < 0.001) discard;
          gl_FragColor = vec4(0.035, 0.035, 0.035, alpha);
        }
      `,
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.z), material);
    // Looking upward with +Z as camera up maps texture +V to model +Z.
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(centre.x, 0.007, centre.z);
    mesh.renderOrder = 3;
    const group = new THREE.Group();
    group.add(mesh);
    return group;
  }

  private bake(model: THREE.Group) {
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model, true);
    const size = bounds.getSize(new THREE.Vector3());
    size.x = Math.max(0.01, size.x) + 0.06;
    size.z = Math.max(0.01, size.z) + 0.06;
    const centre = bounds.getCenter(new THREE.Vector3());
    const longest = Math.max(size.x, size.z);
    const target = new THREE.WebGLRenderTarget(Math.max(32, Math.round(512 * size.x / longest)),
      Math.max(32, Math.round(512 * size.z / longest)));
    const camera = new THREE.OrthographicCamera(-size.x / 2, size.x / 2, size.z / 2, -size.z / 2, 0.001, 0.165);
    camera.position.set(centre.x, -0.1, centre.z);
    camera.up.set(0, 0, 1);
    camera.lookAt(centre.x, 0, centre.z);
    const scene = new THREE.Scene();
    const capture = clone(model);
    const materials = new Map<THREE.Material, THREE.MeshDepthMaterial>();
    const depthMaterial = (source: THREE.Material) => {
      let material = materials.get(source);
      if (material) return material;
      material = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
      // Floor decals and glass are not load-bearing contacts.
      material.visible = source.visible && !source.transparent
        && (!(source instanceof THREE.MeshPhysicalMaterial) || source.transmission === 0);
      if (source instanceof THREE.MeshStandardMaterial) {
        material.map = source.map;
        material.alphaMap = source.alphaMap;
        material.alphaTest = source.alphaTest;
      }
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying float contactHeight;')
          .replace('#include <project_vertex>', '#include <project_vertex>\ncontactHeight = -mvPosition.z - 0.1;');
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float contactHeight;')
          .replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', `
            if (contactHeight > 0.06) discard;
            float contact = 1.0 - smoothstep(0.0, 0.06, max(0.0, contactHeight));
            gl_FragColor = vec4(vec3(contact), 1.0);
          `);
      };
      material.customProgramCacheKey = () => 'domus-model-contact-height-v2';
      materials.set(source, material);
      return material;
    };
    capture.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.material = Array.isArray(node.material) ? node.material.map(depthMaterial) : depthMaterial(node.material);
      node.castShadow = false;
      node.receiveShadow = false;
    });
    scene.add(capture);
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousColour = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    const previousShadow = renderer.shadowMap.enabled;
    try {
      renderer.autoClear = true;
      renderer.shadowMap.enabled = false;
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
    } catch (error) {
      target.dispose();
      throw error;
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousColour, previousAlpha);
      renderer.autoClear = previousAutoClear;
      renderer.shadowMap.enabled = previousShadow;
      for (const material of materials.values()) material.dispose();
      scene.clear();
    }
    return { target, size, centre };
  }

  release(model: THREE.Group) {
    this.masks.get(model)?.target.dispose();
    this.masks.delete(model);
  }

  dispose() {
    for (const model of this.masks.keys()) this.release(model);
  }
}
