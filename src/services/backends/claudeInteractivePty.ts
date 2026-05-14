import type { IPty } from 'node-pty';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';
import type { ToolQuestionOption } from '../../types';
import { collectClaudeTerminalResponses } from './claudeInteractiveTerminal';

export interface ClaudeInteractivePtySpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  name: string;
}

export interface ClaudeInteractivePtyProcess {
  readonly pid: number;
  write(data: string | Buffer): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export type ClaudeInteractivePtyFactory = (
  command: string,
  args: string[],
  options: ClaudeInteractivePtySpawnOptions,
) => ClaudeInteractivePtyProcess;

export interface PendingClaudeQuestion {
  id?: string | null;
  options?: Array<string | ToolQuestionOption>;
}

export interface ClaudeInteractivePtyControllerOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  factory?: ClaudeInteractivePtyFactory;
}

const log = logger.child({ module: 'claude-interactive-pty' });
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const TRUST_PROMPT_WRITE_INTERVAL_MS = 2_000;
const TERMINAL_TEXT_BUFFER_LIMIT = 8_000;
const DEFAULT_PROMPT_ENTER_DELAY_MS = 120;
const DEFAULT_QUESTION_OPTION_ENTER_DELAY_MS = 120;
const DEFAULT_QUESTION_OPTION_READY_DELAY_MS = 300;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export class ClaudeInteractivePtyController {
  private readonly _command: string;
  private readonly _args: string[];
  private readonly _cwd?: string;
  private readonly _env: NodeJS.ProcessEnv;
  private readonly _factory: ClaudeInteractivePtyFactory;
  private _pty: ClaudeInteractivePtyProcess | null = null;
  private _dataDisposable: { dispose(): void } | null = null;
  private _exitDisposable: { dispose(): void } | null = null;
  private _lastTrustWriteAt = 0;
  private _terminalText = '';
  private _pendingControlWrites: Array<string | Buffer> = [];
  private _flushControlWritesScheduled = false;
  private _closed = false;
  private _exited = false;
  private _exitEvent: { exitCode: number; signal?: number } | null = null;
  private _exitPromise: Promise<{ exitCode: number; signal?: number }>;
  private _resolveExit!: (event: { exitCode: number; signal?: number }) => void;

  constructor(options: ClaudeInteractivePtyControllerOptions) {
    this._command = options.command;
    this._args = options.args;
    this._cwd = options.cwd;
    this._env = options.env;
    this._factory = options.factory || defaultClaudeInteractivePtyFactory;
    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });
  }

  get pid(): number | null {
    return this._pty?.pid ?? null;
  }

  get exited(): boolean {
    return this._exited;
  }

  get exitEvent(): { exitCode: number; signal?: number } | null {
    return this._exitEvent;
  }

  get exitPromise(): Promise<{ exitCode: number; signal?: number }> {
    return this._exitPromise;
  }

  start(): void {
    if (this._pty) return;
    this._pty = this._factory(this._command, this._args, {
      cwd: this._cwd,
      env: this._env,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      name: 'xterm-256color',
    });
    this._dataDisposable = this._pty.onData((data) => this._handleData(data));
    this._exitDisposable = this._pty.onExit((event) => {
      this._exited = true;
      this._exitEvent = event;
      this._resolveExit(event);
    });
  }

  sendPrompt(prompt: string, options: { enterDelayMs?: number } = {}): void {
    this.write(formatBracketedPaste(prompt));
    const timer = setTimeout(() => this.write('\r'), options.enterDelayMs ?? DEFAULT_PROMPT_ENTER_DELAY_MS);
    timer.unref?.();
  }

  sendInput(text: string, pendingQuestion?: PendingClaudeQuestion | null): void {
    const trimmed = text.trim();
    const selectedIndex = findQuestionOptionIndex(trimmed, pendingQuestion?.options || []);
    if (selectedIndex !== null) {
      const readyTimer = setTimeout(() => {
        this.write('\x1b[B'.repeat(selectedIndex));
        const enterTimer = setTimeout(() => this.write('\r'), DEFAULT_QUESTION_OPTION_ENTER_DELAY_MS);
        enterTimer.unref?.();
      }, DEFAULT_QUESTION_OPTION_READY_DELAY_MS);
      readyTimer.unref?.();
      return;
    }
    this.write(`${trimmed}\r`);
  }

  stopTurn(): void {
    this.write('\x1b');
  }

  requestExit(): void {
    if (this._closed || this._exited) return;
    this.write('/exit\r');
  }

  kill(): void {
    if (this._closed) return;
    this._closed = true;
    this._dataDisposable?.dispose();
    this._exitDisposable?.dispose();
    this._dataDisposable = null;
    this._exitDisposable = null;
    if (this._pty && !this._exited) {
      try {
        this._pty.kill();
      } catch (err: unknown) {
        log.warn('Failed to kill Claude interactive PTY', { error: err });
      }
    }
  }

  private write(data: string | Buffer): void {
    if (!this._pty || this._closed || this._exited) return;
    this._pty.write(data);
  }

  private _handleData(data: string): void {
    for (const response of collectClaudeTerminalResponses(data, {
      rows: DEFAULT_ROWS,
      cols: DEFAULT_COLS,
      terminalName: 'AgentCockpit',
    })) {
      this._queueControlWrite(response);
    }

    const terminalText = this._appendTerminalText(data);
    if (!shouldAutoConfirmWorkspaceTrust(terminalText, this._cwd)) return;
    const now = Date.now();
    if (now - this._lastTrustWriteAt < TRUST_PROMPT_WRITE_INTERVAL_MS) return;
    this._lastTrustWriteAt = now;
    this._queueControlWrite('\r');
  }

  private _queueControlWrite(data: string | Buffer): void {
    if (this._closed || this._exited) return;
    this._pendingControlWrites.push(data);
    if (this._flushControlWritesScheduled) return;
    this._flushControlWritesScheduled = true;
    queueMicrotask(() => this._flushControlWrites());
  }

  private _flushControlWrites(): void {
    this._flushControlWritesScheduled = false;
    while (this._pendingControlWrites.length > 0) {
      const data = this._pendingControlWrites.shift();
      if (data !== undefined) this.write(data);
    }
  }

  private _appendTerminalText(data: string): string {
    const stripped = stripAnsi(data).toLowerCase();
    this._terminalText = `${this._terminalText}${stripped}`.replace(/\s+/g, ' ').slice(-TERMINAL_TEXT_BUFFER_LIMIT);
    return this._terminalText;
  }
}

export function findQuestionOptionIndex(text: string, options: Array<string | ToolQuestionOption>): number | null {
  if (!text || options.length === 0) return null;
  const numeric = Number.parseInt(text, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return numeric - 1;
  }
  const normalized = normalizeOptionText(text);
  const index = options.findIndex((option) => normalizeOptionText(optionLabel(option)) === normalized);
  return index >= 0 ? index : null;
}

function optionLabel(option: string | ToolQuestionOption): string {
  return typeof option === 'string' ? option : option.label;
}

function normalizeOptionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function formatBracketedPaste(text: string): string {
  const safeText = String(text || '').replaceAll(BRACKETED_PASTE_END, '');
  return `${BRACKETED_PASTE_START}${safeText}${BRACKETED_PASTE_END}`;
}

function shouldAutoConfirmWorkspaceTrust(text: string, cwd?: string): boolean {
  if (!cwd) return false;
  const compact = text.replace(/[^a-z0-9]+/g, '');
  return compact.includes('trust')
    && (
      compact.includes('yesitrust')
      || compact.includes('doyoutrust')
      || compact.includes('trustthefiles')
      || (
        compact.includes('quicksafetycheck')
        && compact.includes('claudecodewillbeabletoreadeditandexecutefileshere')
      )
    );
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function defaultClaudeInteractivePtyFactory(
  command: string,
  args: string[],
  options: ClaudeInteractivePtySpawnOptions,
): ClaudeInteractivePtyProcess {
  ensureNodePtySpawnHelperExecutable();
  // Import lazily so unit tests can exercise the controller helpers without
  // loading the native node-pty binding.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePty = require('node-pty') as { spawn: (file: string, args: string[], options: ClaudeInteractivePtySpawnOptions) => IPty };
  try {
    return nodePty.spawn(command, args, options);
  } catch (err: unknown) {
    const message = (err as Error).message || String(err);
    if (message.includes('posix_spawnp failed')) {
      throw new Error(`Claude Code Interactive failed to start a PTY for "${command}": ${message}`);
    }
    throw err;
  }
}

export function ensureNodePtySpawnHelperExecutable(packageRoot?: string): void {
  if (process.platform === 'win32') return;
  const root = packageRoot || resolveNodePtyPackageRoot();
  const candidates = [
    path.join(root, 'build', 'Release', 'spawn-helper'),
    path.join(root, 'build', 'Debug', 'spawn-helper'),
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];

  let sawHelper = false;
  for (const helperPath of candidates) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(helperPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (!stat.isFile()) continue;
    sawHelper = true;
    if ((stat.mode & 0o111) !== 0) return;
    try {
      fs.chmodSync(helperPath, stat.mode | 0o111);
      const updated = fs.statSync(helperPath);
      if ((updated.mode & 0o111) !== 0) return;
    } catch (err: unknown) {
      throw new Error(`Claude Code Interactive cannot mark node-pty spawn-helper executable at ${helperPath}: ${(err as Error).message}`);
    }
  }

  if (sawHelper) {
    throw new Error('Claude Code Interactive could not find an executable node-pty spawn-helper');
  }
}

function resolveNodePtyPackageRoot(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const packageJson = require.resolve('node-pty/package.json');
  return path.dirname(packageJson);
}
