import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blender = process.env.DOMUS_BLENDER ?? (process.platform === 'darwin' ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender');
await access(path.join(root, 'og_models'));
const child = spawn(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.join(root, 'scripts/create-planning-proxies.py'), '--', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
child.once('error', error => { console.error(`Cannot start Blender: ${error.message}. Set DOMUS_BLENDER to its executable.`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
