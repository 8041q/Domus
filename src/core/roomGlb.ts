import { MAX_DOCUMENT_BYTES, MAX_PACKAGE_BYTES, readDocument, type RoomDocumentV2 } from './projectDocument';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_GLTF_JSON = 64 * 1024 * 1024;
function header(bytes: Uint8Array, size: number) {
  if (bytes.length < 20) throw new Error('This GLB file is incomplete.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  if (size > MAX_PACKAGE_BYTES || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== size || view.getUint32(16, true) !== 0x4e4f534a
    || length % 4 || length > MAX_GLTF_JSON || 20 + length > size) throw new Error('This GLB file is invalid or too large.');
  return length;
}
function referenceDocument(value: unknown) {
  const document = readDocument(value);
  if (document.version !== 3 || encoder.encode(JSON.stringify(document)).length > MAX_DOCUMENT_BYTES) throw new Error('The GLB must contain a reference-only Domus room.');
  return document;
}
/** Standard glTF extras carry editable data; geometry remains architecture-only. */
export function embedRoomDocumentGLB(binary: ArrayBuffer, value: RoomDocumentV2): ArrayBuffer {
  const bytes = new Uint8Array(binary), length = header(bytes, bytes.length);
  const gltf = JSON.parse(decoder.decode(bytes.subarray(20, 20 + length)));
  const document = referenceDocument(value);
  gltf.asset.extras = { ...gltf.asset.extras, domusRoom: document };
  const json = encoder.encode(JSON.stringify(gltf)), padded = Math.ceil(json.length / 4) * 4;
  const total = 20 + padded + bytes.length - 20 - length;
  if (json.length > MAX_GLTF_JSON || total > MAX_PACKAGE_BYTES) throw new Error('This room exceeds the portable-file limit.');
  const result = new Uint8Array(total); result.set(bytes.subarray(0, 20));
  const view = new DataView(result.buffer); view.setUint32(8, total, true); view.setUint32(12, padded, true);
  result.fill(32, 20, 20 + padded); result.set(json, 20); result.set(bytes.subarray(20 + length), 20 + padded);
  return result.buffer;
}
/** Read only metadata. Imported GLB geometry/URLs never reach a renderer or fetch. */
export async function readRoomGLB(file: Blob): Promise<RoomDocumentV2> {
  const length = header(new Uint8Array(await file.slice(0, 20).arrayBuffer()), file.size);
  let offset = 20 + length, chunks = 1;
  while (offset < file.size) {
    if (++chunks > 32) throw new Error('This GLB contains too many chunks.');
    const bytes = await file.slice(offset, offset + 8).arrayBuffer();
    if (bytes.byteLength !== 8) throw new Error('This GLB file is incomplete.');
    const size = new DataView(bytes).getUint32(0, true);
    if (size % 4 || offset + 8 + size > file.size) throw new Error('This GLB file is incomplete.');
    offset += 8 + size;
  }
  let gltf;
  try { gltf = JSON.parse(decoder.decode(await file.slice(20, 20 + length).arrayBuffer())); }
  catch { throw new Error('This GLB file contains invalid room metadata.'); }
  if (gltf.asset?.version !== '2.0' || !gltf.asset.extras?.domusRoom) throw new Error('This GLB has no editable room data. Choose a room GLB created with Export room in Domus. Regular 3D models are not supported.');
  return referenceDocument(gltf.asset.extras.domusRoom);
}
