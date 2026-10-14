import * as THREE from 'three';
import { MeshBVH, type SerializedBVH } from 'three-mesh-bvh';

export interface PickingGeometryData {
  position: Float32Array;
  index: Uint32Array | null;
  groups: THREE.BufferGeometry['groups'];
}

/** Copy only picking data; rendering buffers never leave the main thread. */
export function pickingGeometryData(geometry: THREE.BufferGeometry): PickingGeometryData {
  const attribute = geometry.getAttribute('position');
  const position = new Float32Array(attribute.count * 3);
  for (let i = 0; i < attribute.count; i++) {
    position[i * 3] = attribute.getX(i);
    position[i * 3 + 1] = attribute.getY(i);
    position[i * 3 + 2] = attribute.getZ(i);
  }
  return { position, index: geometry.index ? new Uint32Array(geometry.index.array) : null, groups: geometry.groups.map(group => ({ ...group })) };
}

export function createPickingGeometry(data: PickingGeometryData) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  if (data.index) geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  geometry.groups = data.groups;
  return geometry;
}

/** A reusable worker keeps detailed models from blocking camera/input while loading. */
export class ModelPicking {
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: SerializedBVH) => void; reject: (error: Error) => void }>();
  private disposed = false;

  async build(geometry: THREE.BufferGeometry): Promise<MeshBVH> {
    if (this.disposed) throw new Error('Model picking was disposed.');
    if (typeof Worker === 'undefined') return new MeshBVH(geometry, { indirect: true, targetLeafSize: 16 });
    if (!this.worker) {
      this.worker = new Worker(new URL('./modelPicking.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<{ id: number; serialized?: SerializedBVH; error?: string }>) => {
        const task = this.pending.get(data.id);
        if (!task) return;
        this.pending.delete(data.id);
        if (data.serialized) task.resolve(data.serialized);
        else task.reject(new Error(data.error ?? 'Could not prepare model picking.'));
      };
      this.worker.onerror = () => {
        for (const task of this.pending.values()) task.reject(new Error('Could not prepare model picking.'));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = undefined;
      };
    }
    const id = this.nextId++;
    const data = pickingGeometryData(geometry);
    const serialized = await new Promise<SerializedBVH>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker!.postMessage({ id, ...data }, [data.position.buffer, ...(data.index ? [data.index.buffer] : [])]);
      } catch (error) { this.pending.delete(id); reject(error); }
    });
    if (this.disposed) throw new Error('Model picking was disposed.');
    return MeshBVH.deserialize(serialized, geometry, { setIndex: false });
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
    for (const task of this.pending.values()) task.reject(new Error('Model picking was disposed.'));
    this.pending.clear();
  }
}
