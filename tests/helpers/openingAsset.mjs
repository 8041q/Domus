import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as THREE from 'three';

// Geometry-only fixtures: no browser, image decoder or network required. This
// reads the user's local GLBs; tests skip them when those ignored assets are absent.
export async function readOpeningAsset(file) {
  const document = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
  const root = new THREE.Group();
  for (const node of document.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    for (const primitive of node.getMesh().listPrimitives()) {
      const geometry = new THREE.BufferGeometry();
      for (const [semantic, name] of [['POSITION', 'position'], ['NORMAL', 'normal'], ['TEXCOORD_0', 'uv']]) {
        const attribute = primitive.getAttribute(semantic);
        if (attribute) geometry.setAttribute(name, new THREE.BufferAttribute(attribute.getArray().slice(), attribute.getElementSize(), attribute.getNormalized()));
      }
      const indices = primitive.getIndices();
      if (indices) geometry.setIndex(new THREE.BufferAttribute(indices.getArray().slice(), 1));
      geometry.applyMatrix4(new THREE.Matrix4().fromArray(node.getWorldMatrix()));
      const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
      material.name = primitive.getMaterial()?.getName() ?? '';
      const mesh = new THREE.Mesh(geometry, material);
      // Match GLTFLoader's animation-safe runtime names (e.g. Cylinder.001
      // becomes Cylinder001), not just the names stored in the source file.
      mesh.name = THREE.PropertyBinding.sanitizeNodeName(node.getName());
      root.add(mesh);
    }
  }
  return root;
}
