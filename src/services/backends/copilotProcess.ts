import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { spawnWindowsCopilotProcess } from './copilotWindowsProcess';

const log = logger.child({ module: 'copilot-process' });
interface Identity { pid: number; parent: number; group: number; started: string }

const OWNERSHIP_ENV = 'AGENT_COCKPIT_COPILOT_SCOPE';

export function spawnCopilotProcess(command: string, args: string[], options: SpawnOptions): {
  proc: ChildProcess; scope: CopilotProcessScope;
} {
  const token = crypto.randomUUID();
  const launch = process.platform === 'win32' ? spawnWindowsCopilotProcess : spawn;
  const proc = launch(command, args, {
    ...options,
    env: { ...(options.env || process.env), [OWNERSHIP_ENV]: token },
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  return { proc, scope: new CopilotProcessScope(proc, token) };
}

export class CopilotProcessScope {
  private identities = new Map<number, Identity>();
  private scanning: Promise<Identity[]> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopping: Promise<void> | undefined;
  private closed = false;

  constructor(private child: ChildProcess, private ownershipToken?: string) {
    child.once('close', () => { this.closed = true; });
    child.once('error', () => { this.closed = true; });
    if (process.platform !== 'win32' && child.pid && child.exitCode === null) {
      void this.scan();
      this.timer = setInterval(() => { void this.scan(); }, 100);
      this.timer.unref();
    }
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      if (this.timer) clearInterval(this.timer);
      this.stopping = this.terminate().finally(() => {
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
      });
    }
    return this.stopping;
  }

  private async terminate(): Promise<void> {
    const pid = this.child.pid;
    if (!pid || this.child.exitCode === undefined) {
      if (!this.closed) this.child.kill('SIGTERM');
      return;
    }
    if (process.platform === 'win32') {
      if (this.closed) return;
      await new Promise<void>(resolve => {
        execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 2_000 }, err => {
          if (err) {
            log.warn('Copilot process-tree cleanup failed', { error: err.message });
            this.child.kill('SIGKILL');
          }
          resolve();
        });
      });
      return;
    }
    const table = await this.cleanupSnapshot();
    if (!this.signal(table, 'SIGTERM')) {
      if (!this.closed) this.child.kill('SIGTERM');
      if (this.closed) return;
    }
    await new Promise(resolve => setTimeout(resolve, 750));
    this.signal(await this.cleanupSnapshot(), 'SIGKILL');
    if (!this.closed) this.child.kill('SIGKILL');
    // Pipes can remain open in a launcher even after its native child was killed.
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  private async cleanupSnapshot(): Promise<Identity[]> {
    // A pending ancestry-only poll must not replace the ownership scan at stop.
    await this.scanning;
    const table = await this.scan(true);
    // Keep identity/group cleanup available if environment enumeration fails.
    return table.length > 0 || !this.ownershipToken ? table : this.scan();
  }

  private signal(table: Identity[], signal: NodeJS.Signals): boolean {
    const alive = table.filter(entry => this.identities.get(entry.pid)?.started === entry.started);
    const verifiedGroups = this.ownedGroups(table);
    const groups = new Set(alive.filter(entry => verifiedGroups.has(entry.group)).map(entry => entry.group));
    for (const group of groups) {
      try { process.kill(-group, signal); } catch { /* already exited */ }
    }
    for (const entry of alive) {
      try { process.kill(entry.pid, signal); } catch { /* already exited */ }
    }
    return alive.length > 0;
  }

  private ownedGroups(table: Identity[]): Set<number> {
    const groups = new Set<number>();
    for (const owner of this.identities.values()) {
      if (owner.pid !== owner.group) continue;
      const current = table.find(entry => entry.pid === owner.pid);
      if (!current || current.started === owner.started) groups.add(owner.group);
    }
    const root = table.find(entry => entry.pid === this.child.pid);
    const previous = this.identities.get(this.child.pid!);
    if (!root || (previous
      ? previous.started === root.started
      : !this.closed && this.child.exitCode === null)) groups.add(this.child.pid!);
    return groups;
  }

  private scan(includeOwnership = false): Promise<Identity[]> {
    if (this.scanning) return this.scanning;
    const inspectOwnership = includeOwnership && this.ownershipToken !== undefined;
    const args = inspectOwnership
      ? ['eww', '-U', String(process.getuid!()), '-o', 'pid=,ppid=,pgid=,lstart=,command=']
      : ['-axo', 'pid=,ppid=,pgid=,lstart='];
    this.scanning = new Promise<Identity[]>(resolve => {
      execFile('ps', args, { timeout: 500, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
        if (err) {
          log.warn('Cannot enumerate Copilot descendants', { error: err.message });
          // Each POSIX spawn owns a detached group, including npm's native child.
          if (this.stopping && !this.closed) {
            try { process.kill(-this.child.pid!, 'SIGKILL'); } catch { /* already exited */ }
          }
          resolve([]);
          return;
        }
        const table = stdout.split('\n').flatMap(line => {
          const match = line.trim().match(inspectOwnership
            ? /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})(?:\s+(.*))?$/
            : /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
          if (!match) return [];
          const entry = { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4].replace(/\s+/g, ' ') };
          // The inherited token survives orphaning and detached group-leader exit.
          // Do not retain or log command/environment text from the snapshot.
          if (inspectOwnership && match[5]?.split(/\s+/).includes(`${OWNERSHIP_ENV}=${this.ownershipToken}`)) {
            this.identities.set(entry.pid, entry);
          }
          return [entry];
        });
        const root = table.find(entry => entry.pid === this.child.pid);
        const previous = this.identities.get(this.child.pid!);
        if (root && !this.closed && this.child.exitCode === null && (!previous || previous.started === root.started)) {
          this.identities.set(root.pid, root);
        }
        // Retain every verified group, not only the launcher's, after leader exit.
        const groups = this.ownedGroups(table);
        for (const entry of table) {
          if (groups.has(entry.group)) this.identities.set(entry.pid, entry);
        }
        // A live owned child remains a discovery root after its launcher exits.
        const owned = new Set(table.filter(entry => this.identities.get(entry.pid)?.started === entry.started).map(entry => entry.pid));
        let changed = true;
        while (changed) {
          changed = false;
          for (const entry of table) {
            if (owned.has(entry.parent) && !owned.has(entry.pid)) {
              owned.add(entry.pid);
              changed = true;
            }
          }
        }
        for (const entry of table) if (owned.has(entry.pid)) this.identities.set(entry.pid, entry);
        resolve(table);
      });
    }).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
}
