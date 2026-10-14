import { MeshBVH } from 'three-mesh-bvh';
import { createPickingGeometry, type PickingGeometryData } from './modelPicking';

self.onmessage = ({ data }: MessageEvent<PickingGeometryData & { id: number }>) => {
  const geometry = createPickingGeometry(data);
  try {
    const bvh = new MeshBVH(geometry, { indirect: true, targetLeafSize: 16 });
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const transfer = [...serialized.roots];
    if (serialized.index) transfer.push(serialized.index.buffer as ArrayBuffer);
    if (serialized.indirectBuffer) transfer.push(serialized.indirectBuffer.buffer as ArrayBuffer);
    self.postMessage({ id: data.id, serialized }, { transfer });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : 'Could not prepare model picking.' });
  } finally { geometry.dispose(); }
};
