import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '../../utils/logger';

export type ClaudeInteractiveHookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'unknown';

export interface ClaudeInteractiveHookEvent {
  event: ClaudeInteractiveHookEventName;
  payload: Record<string, unknown>;
  rawPayload: string;
}

export interface ClaudeInteractiveHookHarness {
  readonly settingsJson: string;
  readonly env: NodeJS.ProcessEnv;
  readonly events: AsyncIterable<ClaudeInteractiveHookEvent>;
  waitForSessionStart(timeoutMs: number): Promise<ClaudeInteractiveHookEvent>;
  waitForStop(timeoutMs: number): Promise<ClaudeInteractiveHookEvent>;
  close(): Promise<void>;
}

export interface ClaudeInteractiveHookHarnessOptions {
  diagnosticEvents?: boolean;
}

interface PendingWaiter {
  event: ClaudeInteractiveHookEventName | null;
  resolve(event: ClaudeInteractiveHookEvent): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface PendingAnyWaiter {
  resolve(event: ClaudeInteractiveHookEvent | null): void;
  timer: NodeJS.Timeout;
}

const log = logger.child({ module: 'claude-interactive-hooks' });
const HOOK_SINK_ENV = 'AGENT_COCKPIT_CLAUDE_HOOK_SINK';
const POLL_INTERVAL_MS = 25;

export function isClaudeInteractiveHookSupported(): boolean {
  return process.platform !== 'win32';
}

export async function createClaudeInteractiveHookHarness(
  options: ClaudeInteractiveHookHarnessOptions = {},
): Promise<ClaudeInteractiveHookHarness> {
  if (!isClaudeInteractiveHookSupported()) {
    throw new Error('Claude Code Interactive hooks are not supported on Windows');
  }
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-claude-hooks-'));
  const sinkPath = path.join(tmpDir, 'events.log');
  const scriptPath = path.join(tmpDir, 'hook.sh');
  await fsp.writeFile(sinkPath, '');
  await fsp.writeFile(scriptPath, hookScript(), { mode: 0o700 });
  await fsp.chmod(scriptPath, 0o700);
  return new FileClaudeInteractiveHookHarness(tmpDir, sinkPath, scriptPath, options);
}

export function parseClaudeInteractiveHookLine(raw: string): ClaudeInteractiveHookEvent | null {
  const line = raw.replace(/[\r\n]+$/, '');
  const tab = line.indexOf('\t');
  if (tab <= 0) return null;
  const eventName = normalizeHookEventName(line.slice(0, tab));
  const rawPayload = line.slice(tab + 1);
  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  return {
    event: eventName,
    payload: payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {},
    rawPayload,
  };
}

export function hookPayloadString(event: ClaudeInteractiveHookEvent | null | undefined, key: string): string | null {
  const value = event?.payload?.[key];
  return typeof value === 'string' && value ? value : null;
}

export function buildClaudeInteractiveHookSettings(
  scriptPath: string,
  options: ClaudeInteractiveHookHarnessOptions = {},
): string {
  const commandPath = shellQuote(scriptPath);
  const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string }> }>> = {
    SessionStart: [{
      matcher: '*',
      hooks: [{ type: 'command', command: `${commandPath} SessionStart` }],
    }],
    PreToolUse: [{
      matcher: options.diagnosticEvents ? '*' : 'AskUserQuestion',
      hooks: [{ type: 'command', command: `${commandPath} PreToolUse` }],
    }],
    Stop: [{
      matcher: '*',
      hooks: [{ type: 'command', command: `${commandPath} Stop` }],
    }],
  };

  if (options.diagnosticEvents) {
    hooks.SessionEnd = [{
      matcher: '*',
      hooks: [{ type: 'command', command: `${commandPath} SessionEnd` }],
    }];
    hooks.PostToolUse = [{
      matcher: '*',
      hooks: [{ type: 'command', command: `${commandPath} PostToolUse` }],
    }];
    hooks.PostToolUseFailure = [{
      matcher: '*',
      hooks: [{ type: 'command', command: `${commandPath} PostToolUseFailure` }],
    }];
    hooks.PermissionRequest = [{
      matcher: '*',
      hooks: [{ type: 'command', command: `${commandPath} PermissionRequest` }],
    }];
    hooks.PermissionDenied = [{
      matcher: '*',
      hooks: [{ type: 'command', command: `${commandPath} PermissionDenied` }],
    }];
    hooks.SubagentStart = [{
      matcher: '*',
      hooks: [{ type: 'command', command: `${commandPath} SubagentStart` }],
    }];
    hooks.SubagentStop = [{
      matcher: '*',
      hooks: [{ type: 'command', command: `${commandPath} SubagentStop` }],
    }];
  }

  return JSON.stringify({
    hooks,
  });
}

function normalizeHookEventName(value: string): ClaudeInteractiveHookEventName {
  if (
    value === 'SessionStart'
    || value === 'SessionEnd'
    || value === 'Stop'
    || value === 'PreToolUse'
    || value === 'PostToolUse'
    || value === 'PostToolUseFailure'
    || value === 'PermissionRequest'
    || value === 'PermissionDenied'
    || value === 'SubagentStart'
    || value === 'SubagentStop'
  ) return value;
  return 'unknown';
}

function hookScript(): string {
  return `#!/bin/sh
set -eu
event="\${1:-unknown}"
sink="\${${HOOK_SINK_ENV}:?missing ${HOOK_SINK_ENV}}"
payload="$(cat)"
printf '%s\\t%s\\n' "$event" "$payload" >> "$sink"
exit 0
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class FileClaudeInteractiveHookHarness implements ClaudeInteractiveHookHarness {
  readonly settingsJson: string;
  readonly env: NodeJS.ProcessEnv;
  readonly events: AsyncIterable<ClaudeInteractiveHookEvent>;
  private readonly _tmpDir: string;
  private readonly _sinkPath: string;
  private readonly _scriptPath: string;
  private readonly _events: ClaudeInteractiveHookEvent[] = [];
  private readonly _waiters: PendingWaiter[] = [];
  private readonly _anyWaiters: PendingAnyWaiter[] = [];
  private _offset = 0;
  private _buffer = '';
  private _closed = false;
  private _polling = false;
  private _pollTimer: NodeJS.Timeout;

  constructor(
    tmpDir: string,
    sinkPath: string,
    scriptPath: string,
    options: ClaudeInteractiveHookHarnessOptions = {},
  ) {
    this._tmpDir = tmpDir;
    this._sinkPath = sinkPath;
    this._scriptPath = scriptPath;
    this.settingsJson = buildClaudeInteractiveHookSettings(scriptPath, options);
    this.env = { [HOOK_SINK_ENV]: sinkPath };
    this.events = this._eventIterable();
    this._pollTimer = setInterval(() => {
      void this._poll();
    }, POLL_INTERVAL_MS);
    this._pollTimer.unref?.();
  }

  waitForSessionStart(timeoutMs: number): Promise<ClaudeInteractiveHookEvent> {
    return this._waitFor('SessionStart', timeoutMs);
  }

  waitForStop(timeoutMs: number): Promise<ClaudeInteractiveHookEvent> {
    return this._waitFor('Stop', timeoutMs);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._pollTimer);
    const err = new Error('Claude Code Interactive hook harness closed');
    for (const waiter of this._waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    for (const waiter of this._anyWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    await fsp.rm(this._tmpDir, { recursive: true, force: true });
  }

  private _waitFor(event: ClaudeInteractiveHookEventName, timeoutMs: number): Promise<ClaudeInteractiveHookEvent> {
    const existing = this._events.find(candidate => candidate.event === event);
    if (existing) return Promise.resolve(existing);
    if (this._closed) return Promise.reject(new Error('Claude Code Interactive hook harness is closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this._waiters.findIndex(waiter => waiter.resolve === resolve);
        if (index >= 0) this._waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for Claude ${event} hook`));
      }, Math.max(0, timeoutMs));
      timer.unref?.();
      this._waiters.push({ event, resolve, reject, timer });
    });
  }

  private async *_eventIterable(): AsyncIterable<ClaudeInteractiveHookEvent> {
    let index = 0;
    while (!this._closed || index < this._events.length) {
      if (index < this._events.length) {
        yield this._events[index];
        index += 1;
        continue;
      }
      try {
        await this._waitForAny(1_000);
      } catch {
        // Loop until close.
      }
    }
  }

  private _waitForAny(timeoutMs: number): Promise<ClaudeInteractiveHookEvent | null> {
    if (this._closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this._anyWaiters.findIndex(waiter => waiter.resolve === resolve);
        if (index >= 0) this._anyWaiters.splice(index, 1);
        resolve(null);
      }, Math.max(0, timeoutMs));
      timer.unref?.();
      this._anyWaiters.push({ resolve, timer });
    });
  }

  private async _poll(): Promise<void> {
    if (this._closed || this._polling) return;
    this._polling = true;
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(this._sinkPath);
      if (stat.size <= this._offset) return;
      const handle = await fsp.open(this._sinkPath, 'r');
      try {
        const chunk = Buffer.alloc(stat.size - this._offset);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, this._offset);
        this._offset += bytesRead;
        if (bytesRead > 0) this._buffer += chunk.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (err: unknown) {
      if (!this._closed) log.warn('Failed to poll Claude hook events', { error: err });
      return;
    } finally {
      this._polling = false;
    }

    const lines = this._buffer.split(/\r?\n/);
    this._buffer = lines.pop() || '';
    for (const raw of lines) {
      const event = parseClaudeInteractiveHookLine(raw);
      if (event) this._record(event);
    }
  }

  private _record(event: ClaudeInteractiveHookEvent): void {
    this._events.push(event);
    for (let i = this._waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this._waiters[i];
      if (waiter.event !== null && waiter.event !== event.event) continue;
      this._waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
    for (const waiter of this._anyWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }
}
