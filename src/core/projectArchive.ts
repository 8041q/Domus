import { Zip, ZipPassThrough, Unzip, AsyncUnzipInflate, strToU8, strFromU8 } from 'fflate';
import { assetHash, MAX_DOCUMENT_BYTES, MAX_PACKAGE_BYTES, readDocument, validHash, type ModelAsset, type RoomDocumentV2 } from './projectDocument';

/** Verify a self-contained GLB before storing or passing it to GLTFLoader. */
export function validateModelBytes(bytes: Uint8Array) {
  if (bytes.byteLength < 28 || bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error('The model file is incomplete or too large.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length
    || view.getUint32(16, true) !== 0x4e4f534a || jsonLength > MAX_DOCUMENT_BYTES || 20 + jsonLength > bytes.length) throw new Error('The room contains an invalid GLB.');
  const gltf = JSON.parse(strFromU8(bytes.subarray(20, 20 + jsonLength)));
  if (gltf.asset?.version !== '2.0' || !Array.isArray(gltf.meshes) || !gltf.meshes.length || !Array.isArray(gltf.scenes)
    || gltf.buffers?.some((buffer: { uri?: string }) => buffer.uri)
    || gltf.images?.some((image: { uri?: string }) => image.uri && !image.uri.startsWith('data:'))) throw new Error('Room models must contain embedded geometry and textures.');
}

export async function writeRoomArchive(document: RoomDocumentV2, assets: ModelAsset[]): Promise<Blob> {
  const json = strToU8(JSON.stringify(readDocument(document)));
  if (assets.reduce((sum, asset) => sum + asset.blob.size, json.length) > MAX_PACKAGE_BYTES) throw new Error('This room exceeds the 1 GiB portable-file limit.');
  // GLBs are already compressed. Pass through chunks instead of copying every
  // model into a second, contiguous JavaScript buffer for the ZIP encoder.
  const chunks: Blob[] = []; let length = 0;
  const zipper = new Zip((error, bytes) => {
    if (error) throw error;
    length += bytes.length;
    if (length > MAX_PACKAGE_BYTES) throw new Error('This room exceeds the 1 GiB portable-file limit.');
    chunks.push(new Blob([bytes.slice().buffer]));
  });
  try {
    const manifest = new ZipPassThrough('room.json'); zipper.add(manifest); manifest.push(json, true);
    for (const asset of assets) {
      const file = new ZipPassThrough(`assets/${asset.hash}.glb`); zipper.add(file);
      const reader = asset.blob.stream().getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; file.push(value); } file.push(new Uint8Array(), true); }
      finally { reader.releaseLock(); }
    }
    zipper.end();
    return new Blob(chunks, { type: 'application/zip' });
  } catch (error) { zipper.terminate(); throw error; }
}

export async function readRoomArchive(blob: Blob): Promise<{ document: RoomDocumentV2; assets: ModelAsset[] }> {
  if (blob.size > MAX_PACKAGE_BYTES) throw new Error('This room exceeds the 1 GiB portable-file limit.');
  const entries = new Map<string, Blob>();
  let declared = 0, inflated = 0, pending = 0, finished = false;
  await new Promise<void>((resolve, reject) => {
    const complete = () => { if (finished && pending === 0) resolve(); };
    const unzip = new Unzip(file => {
      try {
        if ((file.name !== 'room.json' && !/^assets\/[a-f0-9]{64}\.glb$/.test(file.name)) || entries.has(file.name) || entries.size >= 2001) throw new Error('The room package contains invalid or duplicate paths.');
        declared += file.originalSize ?? 0;
        if (declared > MAX_PACKAGE_BYTES || (file.name === 'room.json' && (file.originalSize ?? 0) > MAX_DOCUMENT_BYTES)) throw new Error('The room package is too large.');
        entries.set(file.name, new Blob());
        const chunks: Blob[] = []; let size = 0; pending++;
        file.ondata = (error, data, final) => {
          if (error) { reject(error); return; }
          inflated += data.length; size += data.length;
          if (inflated > MAX_PACKAGE_BYTES || (file.name === 'room.json' && size > MAX_DOCUMENT_BYTES)) { file.terminate(); reject(new Error('The room package is too large.')); return; }
          chunks.push(new Blob([data.slice().buffer]));
          if (final) {
            entries.set(file.name, new Blob(chunks, { type: 'model/gltf-binary' })); chunks.length = 0; pending--; complete();
          }
        };
        file.start();
      } catch (error) { reject(error); }
    });
    unzip.register(AsyncUnzipInflate);
    void (async () => {
      const reader = blob.stream().getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; unzip.push(value); } unzip.push(new Uint8Array(), true); finished = true; complete(); }
      catch (error) { reject(error); }
      finally { reader.releaseLock(); }
    })();
  });
  const json = entries.get('room.json');
  if (!json?.size) throw new Error('This is not a Domus room package.');
  const document = readDocument(JSON.parse(await json.text()));
  const assets: ModelAsset[] = [];
  const required = new Map(document.products.filter(product => product.hash).map(product => [product.hash!, product.bytes]));
  if (entries.size !== required.size + 1) throw new Error('The package contains missing or unreferenced assets.');
  for (const [hash, size] of required) {
    const asset = entries.get(`assets/${hash}.glb`);
    if (!validHash(hash) || !asset || asset.size !== size) throw new Error('A room model is missing or damaged.');
    const bytes = new Uint8Array(await asset.arrayBuffer());
    if (await assetHash(bytes) !== hash) throw new Error('A room model is missing or damaged.');
    validateModelBytes(bytes);
    assets.push({ hash, blob: asset });
  }
  return { document, assets };
}
