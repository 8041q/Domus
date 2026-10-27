import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { optimizeModels } from './optimize-models.mjs';
const root = process.cwd();
// One-time source relocation. Never delete an existing destination or overwrite a master.
for (const [oldPath, newPath] of [['public/models', 'private/models'], ['public/internal/architecture/openings', 'private/openings']]) {
  if (await stat(path.join(root, oldPath)).catch(() => null)) {
    if (await stat(path.join(root, newPath)).catch(() => null)) throw new Error(`Both ${oldPath} and ${newPath} exist. Consolidate the master library before publishing.`);
    await mkdir(path.dirname(path.join(root, newPath)), { recursive: true });
    await rename(path.join(root, oldPath), path.join(root, newPath));
  }
}
await optimizeModels(root);
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const files = await readdir(path.join(root, 'private/openings')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
await mkdir(path.join(root, '.domus-published/openings'), { recursive: true });
const revisions = {};
for (const file of files.filter(file => /^[a-z_]+\.glb$/.test(file))) {
  const document = await io.read(path.join(root, 'private/openings', file));
  // Opening deformation depends on authored hierarchy and part roles; preserve them.
  // Material names also drive glass/frame repairs; do not deduplicate materials
  // whose exported shader values match but whose architectural roles differ.
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const bytes = await io.writeBinary(document), hash = createHash('sha256').update(bytes).digest('hex');
  revisions[file] = hash;
  const output = path.join(root, '.domus-published/openings', `${hash}-${file}`);
  await writeFile(output + '.tmp', bytes); await rename(output + '.tmp', output);
}

await writeFile(path.join(root, '.domus-published/openings.json.tmp'), JSON.stringify(revisions));
await rename(path.join(root, '.domus-published/openings.json.tmp'), path.join(root, '.domus-published/openings.json'));
