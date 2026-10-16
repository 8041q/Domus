import * as THREE from 'three';

/** Repairs for the supplied architectural exports, isolated from furniture.
 * Several Blender procedural shaders exported as the glTF default: opaque,
 * fully metallic, roughness 1. These are glass/coated frames, not raw metal. */
export function prepareOpeningAsset(scene: THREE.Group, url: string) {
  if (!url.startsWith('/internal/architecture/openings/')) return;
  const file = url.split('/').pop()?.split('?')[0];
  const replacements = new Map<THREE.Material, THREE.Material>();
  scene.traverse(node => {
    node.userData.architecturalModel = true;
    if (!(node instanceof THREE.Mesh)) return;
    const repair = (source: THREE.Material) => {
      const existing = replacements.get(source);
      if (existing) return existing;
      let material = source;
      if (source instanceof THREE.MeshStandardMaterial) {
        // The solid black single door's leaf is named "...dark glass" in the
        // export. It is intentionally excluded from the glazing repair.
        if (file !== 'single_door.glb' && /glass/i.test(source.name) && !/rim|rubber/i.test(source.name)) {
          const glass = new THREE.MeshPhysicalMaterial();
          THREE.MeshStandardMaterial.prototype.copy.call(glass, source);
          glass.color.set('#c5d8dc');
          glass.map = null;
          glass.metalnessMap = null;
          glass.roughnessMap = null;
          glass.metalness = 0;
          glass.roughness = /frosted/i.test(source.name) ? 0.65 : 0.3;
          glass.specularIntensity = 0.3;
          // Opacity supplies the transparent pane. Refraction would redraw the
          // room into another target and can expose the pane's hidden boundary.
          glass.transmission = 0;
          glass.ior = 1.5;
          glass.transparent = true;
          glass.opacity = /frosted/i.test(source.name) ? 0.55 : 0.28;
          glass.side = THREE.DoubleSide;
          glass.depthWrite = false;
          glass.forceSinglePass = true;
          glass.userData.openingGlazing = true;
          material = glass;
        } else if (file === 'single_door.glb') {
          if (source.name === 'Black door with dark glass') source.color.setRGB(0.022, 0.022, 0.022);
        }
        if (!material.userData.openingGlazing && material instanceof THREE.MeshStandardMaterial) {
          const hardware = /silver|copper|^metal black$|^metal$/i.test(source.name);
          // The exports carry polished clearcoat and roughness textures even
          // on painted PVC/steel. Use a consistent restrained satin finish.
          material.roughnessMap = null;
          material.metalnessMap = null;
          material.roughness = hardware ? 0.65 : 0.8;
          material.metalness = hardware ? 0.25 : 0.04;
          if (material.normalMap) material.normalScale.multiplyScalar(0.35);
          if (material instanceof THREE.MeshPhysicalMaterial) {
            material.clearcoat = 0;
            material.clearcoatRoughness = 0.75;
            material.specularIntensity = 0.3;
          }
        }
        material.needsUpdate = true;
      }
      replacements.set(source, material);
      return material;
    };
    node.material = Array.isArray(node.material) ? node.material.map(repair) : repair(node.material);
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    node.userData.openingGlazing = materials.every(material => material.userData.openingGlazing);
  });
  // Textures are retained by the replacement and remain library-owned.
  for (const [source, replacement] of replacements) if (source !== replacement) source.dispose();
}
