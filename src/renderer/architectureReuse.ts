import * as THREE from 'three';

function meshKey(mesh: THREE.Mesh) {
  const geometry = mesh.geometry;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return JSON.stringify([mesh.name, mesh.userData.cutawayWallId, mesh.userData.openingId, mesh.userData.domusExportCategory,
    geometry.type, Object.entries(geometry.attributes).map(([name, attribute]) =>
      [name, attribute.count, attribute.itemSize, attribute.normalized, attribute.array.constructor.name]),
    geometry.index?.count, geometry.index?.array.constructor.name, geometry.groups,
    materials.map(material => {
      const surface = material as THREE.MeshPhysicalMaterial;
      const shader = material as THREE.ShaderMaterial;
      return [material.type, material.visible, material.transparent, material.opacity, material.side, material.depthWrite,
        material.colorWrite, material.alphaTest, material.blending, surface.color?.getHex(), surface.emissive?.getHex(),
        surface.emissiveIntensity, surface.roughness, surface.metalness, surface.transmission, surface.ior,
        surface.map?.uuid, surface.normalMap?.uuid, surface.roughnessMap?.uuid, surface.envMap?.uuid,
        shader.vertexShader, shader.fragmentShader, shader.defines, material.customProgramCacheKey()];
    })]);
}

/** Keep GPU buffers and compiled materials alive while the aperture moves.
 * Incompatible topology/materials use the freshly generated mesh instead. */
export function reuseArchitectureMeshes(parent: THREE.Group, previous: THREE.Group, unchanged: Set<THREE.Object3D>) {
  const pool = new Map<string, THREE.Mesh[]>();
  for (const node of previous.children) {
    if (!(node instanceof THREE.Mesh)) continue;
    const key = meshKey(node);
    const matches = pool.get(key) ?? [];
    matches.push(node);
    pool.set(key, matches);
  }
  for (const node of [...parent.children]) {
    if (unchanged.has(node) || !(node instanceof THREE.Mesh)) continue;
    const retained = pool.get(meshKey(node))?.shift();
    if (!retained) continue;
    for (const [name, attribute] of Object.entries(node.geometry.attributes)) {
      const target = retained.geometry.getAttribute(name) as THREE.BufferAttribute;
      if (!(attribute instanceof THREE.BufferAttribute) || !(target instanceof THREE.BufferAttribute)) continue;
      target.array.set(attribute.array);
      target.needsUpdate = true;
    }
    if (node.geometry.index && retained.geometry.index) {
      retained.geometry.index.array.set(node.geometry.index.array);
      retained.geometry.index.needsUpdate = true;
    }
    retained.geometry.boundingBox = null;
    retained.geometry.boundingSphere = null;
    if ('parameters' in node.geometry) Reflect.set(retained.geometry, 'parameters', Reflect.get(node.geometry, 'parameters'));
    retained.position.copy(node.position); retained.quaternion.copy(node.quaternion); retained.scale.copy(node.scale);
    retained.visible = node.visible; retained.userData = node.userData;
    retained.onBeforeShadow = node.onBeforeShadow; retained.onAfterShadow = node.onAfterShadow;
    const oldMaterials = Array.isArray(retained.material) ? retained.material : [retained.material];
    const newMaterials = Array.isArray(node.material) ? node.material : [node.material];
    oldMaterials.forEach((material, index) => {
      const updated = newMaterials[index];
      if (material instanceof THREE.ShaderMaterial && updated instanceof THREE.ShaderMaterial) {
        for (const [name, uniform] of Object.entries(updated.uniforms)) material.uniforms[name].value = uniform.value;
      }
    });
    parent.remove(node);
    parent.add(retained);
    node.geometry.dispose();
    for (const material of newMaterials) material.dispose();
  }
  // A sun-mask material can be shared by retained and replaced pieces. Leave
  // referenced resources with the live meshes when the caller disposes leftovers.
  const liveMaterials = new Set<THREE.Material>();
  const liveGeometries = new Set<THREE.BufferGeometry>();
  for (const node of parent.children) if (node instanceof THREE.Mesh) {
    liveGeometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) liveMaterials.add(material);
  }
  let disposableMaterial: THREE.MeshBasicMaterial | undefined;
  let disposableGeometry: THREE.BufferGeometry | undefined;
  for (const node of previous.children) if (node instanceof THREE.Mesh) {
    if (liveGeometries.has(node.geometry)) node.geometry = disposableGeometry ??= new THREE.BufferGeometry();
    const detach = (material: THREE.Material) => liveMaterials.has(material) ? disposableMaterial ??= new THREE.MeshBasicMaterial() : material;
    node.material = Array.isArray(node.material) ? node.material.map(detach) : detach(node.material);
  }
}
