import { execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { setTimeout as delay } from 'timers/promises';
import { logger } from '../../utils/logger';
import type { CortexProcessIdentity } from '../../types';

const exec = promisify(execFile);

export function parseCortexProcessTable(text: string): CortexProcessIdentity[] {
  return text.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: +match[1], parent: +match[2], group: +match[3], started: match[4] }] : [];
  });
}

/** POSIX ownership tracker; detached native shells may outlive the CLI root. */
export class CortexProcessScope {
  private identities = new Map<number, CortexProcessIdentity>();
  private timer?: NodeJS.Timeout;
  private scanning: Promise<CortexProcessIdentity[]> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private child: ChildProcess) {}

  watch(): void {
    if (this.timer || this.stopping || !this.child.pid) return;
    void this.scan();
    this.timer = setInterval(() => { void this.scan(); }, 250);
    this.timer.unref();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    clearInterval(this.timer);
    this.stopping = this.terminate();
    return this.stopping;
  }

  private async terminate(): Promise<void> {
    if (!this.child.pid) return;
    let table = await this.scan();
    this.signal(table, 'SIGTERM');
    const deadline = Date.now() + 2_000;
    while (this.owned(table).length && Date.now() < deadline) {
      await delay(100);
      table = await this.scan();
    }
    this.signal(table, 'SIGKILL');
    const killedDeadline = Date.now() + 1_000;
    while (this.owned(table).length && Date.now() < killedDeadline) {
      await delay(100);
      table = await this.scan();
    }
    const survivors = this.owned(table).length;
    if (survivors) logger.warn('Cortex process cleanup has surviving owned processes', { survivors });
  }

  private owned(table: CortexProcessIdentity[]): CortexProcessIdentity[] {
    return table.filter(item => this.identities.get(item.pid)?.started === item.started);
  }

  private signal(table: CortexProcessIdentity[], signal: NodeJS.Signals): void {
    const alive = this.owned(table);
    // Only signal a whole group when its current leader is verified as ours.
    const groups = new Set(alive.filter(item => alive.some(owner => owner.pid === item.group)).map(item => item.group));
    for (const group of groups) { try { process.kill(-group, signal); } catch { /* already exited */ } }
    for (const item of alive) { try { process.kill(item.pid, signal); } catch { /* already exited */ } }
  }

  private scan(): Promise<CortexProcessIdentity[]> {
    if (this.scanning) return this.scanning;
    this.scanning = exec('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { timeout: 750, maxBuffer: 8 * 1024 * 1024 })
      .then(({ stdout }) => {
        const table = parseCortexProcessTable(stdout);
        const root = table.find(item => item.pid === this.child.pid);
        if (root && this.child.exitCode === null && this.child.signalCode === null && !this.identities.has(root.pid)) this.identities.set(root.pid, root);
        const owned = new Set(this.owned(table).map(item => item.pid));
        let changed = true;
        while (changed) {
          changed = false;
          for (const item of table) if (owned.has(item.parent) && !owned.has(item.pid)) {
            owned.add(item.pid); this.identities.set(item.pid, item); changed = true;
          }
        }
        return table;
      }).catch(() => {
        // Enumeration failure cannot authorize signals to remembered/reused PIDs.
        if (this.stopping && this.child.exitCode === null && this.child.signalCode === null && this.child.pid) {
          try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
        }
        logger.warn('Cortex process enumeration failed');
        return [];
      }).finally(() => { this.scanning = null; });
    return this.scanning;
  }
}
