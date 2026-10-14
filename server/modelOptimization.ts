import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Run expensive WASM work outside Vite's request/file-watcher thread. */
export class ModelOptimizationQueue {
  private child?: ChildProcess;
  private desired = '';
  private attempted = '';
  private disposed = false;
  private closing?: Promise<void>;
  private finishing = false;

  constructor(private root: string, private completed: () => Promise<void>, private report: (message: string) => void) {}

  request(key: string) {
    this.desired = key;
    if (this.disposed || this.child || this.finishing || key === this.attempted) return;
    this.attempted = key;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/optimize-models.mjs', import.meta.url)), '--optional'],
      { cwd: this.root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let errors = '';
    child.stderr?.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
    child.once('error', error => { errors += error.message; });
    child.once('close', () => {
      this.child = undefined;
      if (this.disposed) return;
      this.finishing = true;
      if (errors.trim()) this.report(errors.trim());
      void this.completed().catch(error => this.report(error.message)).finally(() => {
        this.finishing = false;
        this.request(this.desired);
      });
    });
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    const child = this.child;
    this.child = undefined;
    this.closing = child ? new Promise(resolve => { child.once('close', () => resolve()); child.kill(); }) : Promise.resolve();
    return this.closing;
  }
}
