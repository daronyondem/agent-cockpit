import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { resolveClaudeProjectDirCandidates } from './claudeCode';
import type { ClaudeTranscriptEntry } from './claudeTranscriptEvents';

export interface ClaudeTranscriptTailerOptions {
  workspacePath: string;
  configDir?: string;
  sessionId: string;
  transcriptPath?: string;
  startAtEnd?: boolean;
}

const MAX_READ_BYTES = 1024 * 1024;

export class ClaudeTranscriptTailer {
  private _paths: string[];
  private readonly _sessionId: string;
  private readonly _startAtEnd: boolean;
  private readonly _workspacePath: string;
  private readonly _configDir?: string;
  private readonly _explicitTranscriptPath?: string;
  private _activePath: string | null = null;
  private _offset = 0;
  private _buffer = '';
  private _initialized = false;
  private _seenUuids = new Set<string>();
  private _hasEmittedEntries = false;

  constructor(options: ClaudeTranscriptTailerOptions) {
    this._sessionId = options.sessionId;
    this._workspacePath = options.workspacePath;
    this._configDir = options.configDir;
    this._explicitTranscriptPath = options.transcriptPath;
    this._paths = this._resolveCandidatePaths();
    this._startAtEnd = options.startAtEnd !== false && this._paths.some((candidate) => fs.existsSync(candidate));
  }

  get transcriptPath(): string | null {
    return this._activePath;
  }

  setTranscriptPath(transcriptPath: string): void {
    if (!transcriptPath) return;
    if (this._activePath === transcriptPath) return;
    if (this._activePath && this._hasEmittedEntries) return;
    this._activePath = transcriptPath;
    this._offset = 0;
    this._buffer = '';
    this._initialized = false;
    this._seenUuids = new Set();
  }

  async readAvailable(): Promise<ClaudeTranscriptEntry[]> {
    const transcriptPath = await this._resolvePath();
    if (!transcriptPath) return [];

    let stat;
    try {
      stat = await fsp.stat(transcriptPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    if (!this._initialized) {
      this._offset = this._startAtEnd ? stat.size : 0;
      this._initialized = true;
      if (this._offset === stat.size) return [];
    } else if (stat.size < this._offset) {
      this._offset = 0;
      this._buffer = '';
      this._seenUuids = new Set();
    }

    if (stat.size <= this._offset) return [];

    const bytesToRead = Math.min(stat.size - this._offset, MAX_READ_BYTES);
    const handle = await fsp.open(transcriptPath, 'r');
    try {
      const chunk = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(chunk, 0, bytesToRead, this._offset);
      this._offset += bytesRead;
      if (bytesRead === 0) return [];
      this._buffer += chunk.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }

    const lines = this._buffer.split(/\r?\n/);
    this._buffer = lines.pop() || '';

    const entries: ClaudeTranscriptEntry[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const entry = this._parseEntryLine(line);
      if (entry) entries.push(entry);
    }

    const pendingLine = this._buffer.trim();
    if (pendingLine.endsWith('}')) {
      const pendingEntry = this._parseEntryLine(pendingLine);
      if (pendingEntry) {
        entries.push(pendingEntry);
        this._buffer = '';
      }
    }
    if (entries.length > 0) this._hasEmittedEntries = true;
    return entries;
  }

  async readUntilQuiet(options: { maxAttempts: number; intervalMs: number }): Promise<ClaudeTranscriptEntry[]> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
    const intervalMs = Math.max(0, Math.floor(options.intervalMs));
    const entries: ClaudeTranscriptEntry[] = [];
    let sawEntries = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const next = await this.readAvailable();
      if (next.length > 0) {
        sawEntries = true;
        entries.push(...next);
      } else if (sawEntries) {
        break;
      }
      if (attempt < maxAttempts - 1) await sleep(intervalMs);
    }
    return entries;
  }

  async flushBufferedLine(): Promise<ClaudeTranscriptEntry[]> {
    const entries = await this.readAvailable();
    const line = this._buffer.trim();
    this._buffer = '';
    if (!line) return entries;
    const entry = this._parseEntryLine(line);
    if (entry) entries.push(entry);
    if (entries.length > 0) this._hasEmittedEntries = true;
    return entries;
  }

  private _parseEntryLine(line: string): ClaudeTranscriptEntry | null {
    let entry: ClaudeTranscriptEntry;
    try {
      entry = JSON.parse(line) as ClaudeTranscriptEntry;
    } catch {
      return null;
    }
    if (!this._matchesSession(entry)) return null;
    if (entry.uuid) {
      if (this._seenUuids.has(entry.uuid)) return null;
      this._seenUuids.add(entry.uuid);
    }
    return entry;
  }

  private async _resolvePath(): Promise<string | null> {
    if (this._activePath) return this._activePath;
    this._refreshCandidatePaths();
    for (const candidate of this._paths) {
      try {
        await fsp.access(candidate);
        this._activePath = candidate;
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
    return this._paths[0] || null;
  }

  private _resolveCandidatePaths(): string[] {
    return this._explicitTranscriptPath
      ? [this._explicitTranscriptPath]
      : resolveClaudeTranscriptPaths(this._workspacePath, this._sessionId, this._configDir);
  }

  private _refreshCandidatePaths(): void {
    if (this._explicitTranscriptPath) return;
    this._paths = uniqueStrings([...this._paths, ...this._resolveCandidatePaths()]);
  }

  private _matchesSession(entry: ClaudeTranscriptEntry): boolean {
    return !entry.sessionId || entry.sessionId === this._sessionId;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveClaudeTranscriptPaths(
  workspacePath: string,
  sessionId: string,
  configDir?: string,
): string[] {
  return resolveClaudeProjectDirCandidates(workspacePath, configDir)
    .map((projectDir) => path.join(projectDir, `${sessionId}.jsonl`));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
