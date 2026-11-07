import { BoxGeometry } from 'three';

// Complete synthetic products; source assets belonging to the user are never required.
export function modelBytes(options = {}) {
  let positions = new Float32Array([-.5,0,-1, .5,0,-1, .5,.8,1, -.5,0,-1, .5,.8,1, -.5,.8,1]);
  if (options.dense) {
    const indexed = new BoxGeometry(1, .8, 2, 32, 32, 32), geometry = indexed.toNonIndexed();
    positions = geometry.getAttribute('position').array;
    indexed.dispose(); geometry.dispose();
  }
  for (let i = 0; i < positions.length; i += 3) positions[i] *= options.widthScale ?? 1;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { const axis = i % 3; min[axis] = Math.min(min[axis], positions[i]); max[axis] = Math.max(max[axis], positions[i]); }
  const binary = Buffer.from(positions.buffer);
  const json = JSON.stringify({ asset: { version: '2.0' }, ...(options.imageUri ? { images: [{ uri: options.imageUri }] } : {}), scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }], buffers: [{ byteLength: binary.length }] });
  const padded = Buffer.from(json + ' '.repeat((4 - Buffer.byteLength(json) % 4) % 4));
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2,4); header.writeUInt32LE(28 + padded.length + binary.length,8);
  header.writeUInt32LE(padded.length,12); header.writeUInt32LE(0x4e4f534a,16);
  binHeader.writeUInt32LE(binary.length,0); binHeader.writeUInt32LE(0x004e4942,4);
  return new Uint8Array(Buffer.concat([header,padded,binHeader,binary]));
}
