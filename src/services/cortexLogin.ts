import type { IPty } from 'node-pty';
import { stripVTControlCharacters } from 'util';
import type { CortexRuntimeConfig } from '../types';
import { CortexProcessScope } from './backends/cortexProcess';
import { cortexOAuthOwner, type CortexOAuthOwner } from './cortexOAuth';

export interface CortexLoginProcess { write(text: string): void; stop(): Promise<void> }
export interface CortexLoginCallbacks {
  owner(owner: CortexOAuthOwner): void;
  received(): void;
  ready(): void;
  failed(): void;
  exit(): void;
}

/** Version-scoped terminal parsing. Raw text never leaves this controller. */
export class CortexLoginOutput {
  private raw = '';
  private seen = new Set<string>();
  constructor(private callbacks: CortexLoginCallbacks, private write: (text: string) => void, private connection: string) {}

  read(chunk: string): void {
    this.raw = (this.raw + chunk).slice(-128 * 1024);
    const text = stripVTControlCharacters(this.raw);
    // Only cosmetic/import and the native security acknowledgement are handled.
    // No arbitrary wizard choices, workspace/tool permissions or model prompts.
    for (const [key, marker, input] of [
      ['import', '[N] Skip', 'n'],
      ['theme', '1-3 select', '\r'],
      ['security', '[Y] I understand and accept', 'y'],
    ]) if (!this.seen.has(key) && text.includes(marker)) {
      this.seen.add(key); this.write(input);
    }
    if (!this.seen.has('account') && text.includes('Choose your agent account:')) {
      const table = text.slice(text.lastIndexOf('Your connections:')).split(/\r?\n/);
      const header = table.findIndex(line => /^\s*NAME\s+ACCOUNT\s+USER\s+USAGE/.test(line));
      const end = table.findIndex((line, index) => index > header && line.includes('More options...'));
      if (header >= 0 && end > header) {
        const rows = table.slice(header + 1, end).filter(line => line.trim());
        const index = rows.findIndex(line => line.replace(/^\s*>?\s*/, '').split(/\s{2,}/)[0] === this.connection);
        this.seen.add('account');
        if (index < 0) this.callbacks.failed();
        else this.write(`${'\x1b[B'.repeat(index)}\r`);
      }
    }
    for (const match of text.matchAll(/https:\/\/[^\s<>"\x1b]+(?=[\r\n\s])/g)) {
      if (!match[0].includes('/oauth/authorize?') || this.seen.has('url')) continue;
      try { const owner = cortexOAuthOwner(match[0]); this.seen.add('url'); this.callbacks.owner(owner); }
      catch { this.seen.add('url'); this.callbacks.failed(); }
    }
    if (!this.seen.has('received') && /Received [—–-] completing sign-in/.test(text)) {
      this.seen.add('received'); this.callbacks.received();
    }
    if (!this.seen.has('ready') && /All tests passed!|\? for shortcuts/.test(text)) {
      this.seen.add('ready'); this.callbacks.ready();
    }
    if (/Authentication timed out|OAuth authorization timed out|Could not reach the local callback|Timed out contacting the local callback|Declined.*exit/i.test(text)
      && !this.seen.has('failure')) { this.seen.add('failure'); this.callbacks.failed(); }
  }

  clear(): void { this.raw = ''; }
}

export function startCortexLogin(config: CortexRuntimeConfig, connection: string, callbacks: CortexLoginCallbacks): CortexLoginProcess {
  const terminal: typeof import('node-pty') = require('node-pty');
  const pty: IPty = terminal.spawn(config.command, ['--no-auto-update', '--private', '-c', connection, '-w', config.cwd,
    '--only-explicit-plugins', '--only-explicit-skills', '--only-explicit-mcp-servers'], {
    cwd: config.cwd, env: config.env, cols: 1024, rows: 40, name: 'xterm-256color',
  });
  const child = { pid: pty.pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: (signal?: NodeJS.Signals | number) => { try { pty.kill(String(signal || 'SIGTERM')); return true; } catch { return false; } } };
  const scope = new CortexProcessScope(child);
  scope.watch();
  let stopped = false;
  const parser = new CortexLoginOutput(callbacks, text => { if (!stopped) pty.write(text); }, connection);
  const data = pty.onData(text => { if (!stopped) parser.read(text); });
  const exit = pty.onExit(event => { child.exitCode = event.exitCode; parser.clear(); callbacks.exit(); });
  let stopping: Promise<void> | undefined;
  return {
    write(text) { if (stopped || child.exitCode !== null) throw new Error('Native login is no longer active.'); pty.write(text); },
    stop() {
      return stopping ||= (async () => {
        stopped = true; data.dispose(); parser.clear();
        try { await scope.stop(); } finally { exit.dispose(); }
      })();
    },
  };
}
