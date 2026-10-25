import { open, readFile, unlink } from 'node:fs/promises';

/** Serialize registry writers across processes, including separate dev servers. */
export async function withFileLock(filename, action, waitMs = 30_000) {
  const lock = `${filename}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(lock, 'wx');
      try { await handle.writeFile(String(process.pid)); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A terminated writer cannot leave the catalogue permanently locked.
      try {
        const owner = Number(await readFile(lock, 'utf8'));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (failure) { if (failure.code === 'ESRCH') { await unlink(lock).catch(() => {}); continue; } }
        }
      } catch { /* Another writer may just have released the lock. */ }
      if (Date.now() > deadline) throw new Error('The model catalogue is busy. Try again in a moment.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally { await unlink(lock); }
}
