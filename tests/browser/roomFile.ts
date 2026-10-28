import { readFile } from 'node:fs/promises';
export async function readExportedRoom(filename: string) {
  const bytes = await readFile(filename);
  if (bytes.subarray(0, 4).toString() !== 'glTF') return JSON.parse(bytes.toString());
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()).asset.extras.domusRoom;
}
