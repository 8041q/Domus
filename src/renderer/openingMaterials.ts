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
        if (file !== 'single_door.glb' && /glass/i.test(source.name)) {
          const glass = new THREE.MeshPhysicalMaterial();
          THREE.MeshStandardMaterial.prototype.copy.call(glass, source);
          glass.color.set('#c5d8dc');
          glass.map = null;
          glass.metalnessMap = null;
          glass.roughnessMap = null;
          glass.metalness = 0;
          glass.roughness = /frosted/i.test(source.name) ? 0.42 : 0.08;
          glass.transmission = 0.15;
          glass.ior = 1.5;
          glass.transparent = true;
          glass.opacity = /frosted/i.test(source.name) ? 0.55 : 0.28;
          glass.side = THREE.DoubleSide;
          glass.depthWrite = false;
          material = glass;
        } else if (file === 'single_door.glb') {
          if (source.name === 'Black door with dark glass') source.color.setRGB(0.022, 0.022, 0.022);
          if (source.name === 'Metal black') { source.metalness = 0.45; source.roughness = 0.36; }
        } else if (file === 'double_glass_window.glb' && source.name === 'steel dark used') {
          source.metalness = 0.4;
          source.roughness = 0.55;
        } else if (file === 'sliding_glass_pathway.glb' && /^(Aluminum_Frame|Window aluminum\.001)$/.test(source.name)) {
          source.metalness = 0.55;
          source.roughness = 0.42;
        } else if (file === 'semi_glass_door.glb') {
          if (source.name === 'Striped iron Metal') { source.metalness = 0.4; source.roughness = 0.5; }
          if (source.name === 'Silver Metallic') source.roughness = 0.32;
        }
        material.needsUpdate = true;
      }
      replacements.set(source, material);
      return material;
    };
    node.material = Array.isArray(node.material) ? node.material.map(repair) : repair(node.material);
  });
  // Textures are retained by the replacement and remain library-owned.
  for (const [source, replacement] of replacements) if (source !== replacement) source.dispose();
}
