import { mkdir, readdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { readSafe, safePath, sha256, validateGLB, publicProduct, modelId } from './asset-safety.mjs';

const openingName = /^[a-f0-9]{64}-[a-z_]+\.glb$/;
const sourceExtensions = /\.(glb|gltf|blend\d*|fbx|obj|stl|step|stp)$/i;
export async function listFiles(root, prefix = '') {
  const entries = await readdir(prefix ? await safePath(root, prefix) : root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Release symlinks are forbidden');
    if (entry.isDirectory()) result.push(...await listFiles(root, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error('Release contains a non-regular asset');
  }
  return result;
}
function json(bytes) { return JSON.parse(bytes.toString('utf8')); }
export async function validateLibrary(root) {
  const files = await listFiles(root);
  const catalogue = json(await readSafe(root, 'catalogue.json'));
  if (!Array.isArray(catalogue.products) || !catalogue.aliases || !Array.isArray(catalogue.issues)) throw new Error('Invalid published catalogue');
  const records = new Map();
  for (const file of files) {
    if (file === 'catalogue.json' || file === 'openings.json') continue;
    if (/^model-.*\.json$/.test(file)) {
      const id = file.slice(0, -5); if (!modelId.test(id)) throw new Error('Invalid published metadata path');
      const record = json(await readSafe(root, file));
      const product = publicProduct(record.product);
      if (product.id !== id) throw new Error('Published identity mismatch');
      const bytes = await readSafe(root, `${id}.glb`);
      validateGLB(bytes);
      if (sha256(bytes) !== record.assetHash) throw new Error('Published asset checksum mismatch');
      records.set(id, { product, assetHash: record.assetHash });
    } else if (file.startsWith('openings/')) {
      const name = file.slice(9); if (!openingName.test(name)) throw new Error('Invalid opening artifact');
      const bytes = await readSafe(root, file); validateGLB(bytes);
      if (sha256(bytes) !== name.slice(0, 64)) throw new Error('Opening asset checksum mismatch');
    } else if (!(file.endsWith('.glb') && modelId.test(file.slice(0, -4)))) throw new Error('Unexpected file in published library');
  }
  for (const file of files.filter(file => file.endsWith('.glb') && !file.startsWith('openings/'))) {
    if (!records.has(file.slice(0, -4))) throw new Error('Published binary has no metadata');
  }
  const ids = new Set();
  for (const product of catalogue.products) {
    if (ids.has(product.id) || !records.has(product.id) || JSON.stringify(publicProduct(product)) !== JSON.stringify(records.get(product.id).product)) throw new Error('Catalogue product does not match its published revision');
    ids.add(product.id);
  }
  for (const [alias, id] of Object.entries(catalogue.aliases)) if (!/^[a-zA-Z0-9_-]{1,160}$/.test(alias) || !ids.has(id)) throw new Error('Invalid catalogue alias');
  const architecture = catalogue.architecture ?? {};
  for (const [file, revision] of Object.entries(architecture)) if (!/^[a-z_]+\.glb$/.test(file) || !/^[a-f0-9]{64}$/.test(revision) || !files.includes(`openings/${revision}-${file}`)) throw new Error('Missing published opening revision');
  return { catalogue: { products: catalogue.products.map(publicProduct), aliases: catalogue.aliases, issues: [], architecture }, records, files };
}
/** Build a clean allowlisted deployment; never copy a workspace recursively. */
export async function prepareRelease(workspace, destination, serverBundle) {
  if (await lstat(destination).catch(() => null)) throw new Error('Release destination already exists');
  const source = path.join(workspace, '.domus-published');
  const library = await validateLibrary(source);
  const distFiles = await listFiles(path.join(workspace, 'dist'));
  if (!distFiles.includes('index.html') || distFiles.some(file => sourceExtensions.test(file) || /(^|\/)(private|models|optimized-models|\.domus-published)(\/|$)/.test(file))) throw new Error('Public build contains source assets or lacks index.html');
  await mkdir(destination, { recursive: true });
  const put = async (file, bytes) => { await mkdir(path.dirname(path.join(destination, file)), { recursive: true }); await writeFile(path.join(destination, file), bytes); };
  for (const file of distFiles) await put(`dist/${file}`, await readSafe(path.join(workspace, 'dist'), file));
  for (const [id, record] of library.records) {
    await put(`.domus-published/${id}.json`, JSON.stringify(record));
    await put(`.domus-published/${id}.glb`, await readSafe(source, `${id}.glb`));
  }
  for (const file of library.files.filter(file => file.startsWith('openings/'))) await put(`.domus-published/${file}`, await readSafe(source, file));
  await put('.domus-published/catalogue.json', JSON.stringify(library.catalogue));
  await put('.domus-published/openings.json', JSON.stringify(library.catalogue.architecture));
  await put('server.mjs', await readSafe(path.dirname(serverBundle), path.basename(serverBundle)));
  const inventory = {};
  for (const file of await listFiles(destination)) inventory[file] = sha256(await readSafe(destination, file));
  await put('release.json', JSON.stringify({ version: 1, files: inventory }));
  // Revalidate the copied bytes, not only the source inspected before copying.
  await validateRelease(destination);
}
/** Immutable release inventory permits only files packaged by the publishing tool. */
export async function validateRelease(root) {
  const inventory = json(await readSafe(root, 'release.json'));
  if (inventory.version !== 1 || !inventory.files || Array.isArray(inventory.files)) throw new Error('Invalid release inventory');
  const expected = new Set([...Object.keys(inventory.files), 'release.json']);
  const actual = await listFiles(root);
  if (actual.some(file => file !== 'release.json' && file !== 'server.mjs' && !file.startsWith('dist/') && !file.startsWith('.domus-published/'))
    || actual.filter(file => file.startsWith('dist/')).some(file => sourceExtensions.test(file) || /(^|\/)(private|models|optimized-models|\.domus-published)(\/|$)/.test(file))) throw new Error('Release contains source or tool files');
  if (actual.length !== expected.size || actual.some(file => !expected.has(file))) throw new Error('Release contains unexpected or private files');
  const fingerprints = new Map();
  for (const [file, hash] of Object.entries(inventory.files)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || sha256(await readSafe(root, file)) !== hash) throw new Error('Release checksum mismatch');
    const info = await lstat(await safePath(root, file));
    fingerprints.set(file, [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':'));
  }
  const library = await validateLibrary(path.join(root, '.domus-published'));
  return { ...library, fingerprints };
}
