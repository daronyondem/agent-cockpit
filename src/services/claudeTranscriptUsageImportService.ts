import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import type { Usage } from '../types';
import { atomicWriteFile } from '../utils/atomicWrite';
import { emptyUsage, type UsageLedgerStore } from './chat/usageLedgerStore';

interface ClaudeTranscriptUsageImportState {
  imported: Record<string, string>;
  updatedAt?: string;
}

interface ClaudeTranscriptUsageImportOptions {
  configRoots?: string[];
  ownedSessionIds?: Set<string>;
}

export interface ClaudeTranscriptUsageImportResult {
  scannedFiles: number;
  skippedOwnedFiles: number;
  importedEntries: number;
}

interface ParsedUsageEntry {
  sourceId: string;
  date: string;
  model: string;
  usage: Usage;
}

export class ClaudeTranscriptUsageImportService {
  constructor(
    private readonly stateFile: string,
    private readonly usageLedgerStore: UsageLedgerStore,
  ) {}

  async importExternalUsage(options: ClaudeTranscriptUsageImportOptions = {}): Promise<ClaudeTranscriptUsageImportResult> {
    const state = await this._readState();
    const defaultRoots = process.env.NODE_ENV === 'test' ? [] : [path.join(homedir(), '.claude')];
    const roots = uniqueStrings([...defaultRoots, ...(options.configRoots || [])].filter(Boolean));
    const ownedSessionIds = options.ownedSessionIds || new Set<string>();
    const result: ClaudeTranscriptUsageImportResult = {
      scannedFiles: 0,
      skippedOwnedFiles: 0,
      importedEntries: 0,
    };
    let changed = false;

    for (const transcriptPath of await findTranscriptFiles(roots)) {
      result.scannedFiles += 1;
      const sessionId = path.basename(transcriptPath, '.jsonl');
      if (ownedSessionIds.has(sessionId)) {
        result.skippedOwnedFiles += 1;
        continue;
      }

      const entries = await parseTranscriptUsageEntries(transcriptPath, state, sessionId);
      for (const entry of entries) {
        await this.usageLedgerStore.recordForDate(entry.date, 'claude-code', entry.model, entry.usage);
        state.imported[entry.sourceId] = new Date().toISOString();
        result.importedEntries += 1;
        changed = true;
      }
    }

    if (changed) {
      state.updatedAt = new Date().toISOString();
      await this._writeState(state);
    }

    return result;
  }

  private async _readState(): Promise<ClaudeTranscriptUsageImportState> {
    try {
      const raw = await fsp.readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ClaudeTranscriptUsageImportState>;
      return {
        imported: parsed.imported && typeof parsed.imported === 'object' && !Array.isArray(parsed.imported)
          ? Object.fromEntries(Object.entries(parsed.imported).filter(([, value]) => typeof value === 'string'))
          : {},
        ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { imported: {} };
      throw err;
    }
  }

  private async _writeState(state: ClaudeTranscriptUsageImportState): Promise<void> {
    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
    await atomicWriteFile(this.stateFile, JSON.stringify(state, null, 2));
  }
}

async function findTranscriptFiles(configRoots: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of configRoots) {
    const projectsDir = path.join(root, 'projects');
    let projects;
    try {
      projects = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(projectsDir, project.name);
      let entries;
      try {
        entries = await fsp.readdir(projectDir, { withFileTypes: true });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(path.join(projectDir, entry.name));
        }
      }
    }
  }
  return uniqueStrings(files);
}

async function parseTranscriptUsageEntries(
  transcriptPath: string,
  state: ClaudeTranscriptUsageImportState,
  sessionId: string,
): Promise<ParsedUsageEntry[]> {
  let raw;
  try {
    raw = await fsp.readFile(transcriptPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: ParsedUsageEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sourceId = sourceIdForLine(sessionId, trimmed);
    if (state.imported[sourceId]) continue;

    const entry = parseUsageLine(trimmed, sourceId);
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseUsageLine(line: string, sourceId: string): ParsedUsageEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entry = parsed as Record<string, unknown>;
  const message = entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message)
    ? entry.message as Record<string, unknown>
    : {};
  if (message.model === '<synthetic>') return null;
  const rawUsage = message.usage && typeof message.usage === 'object' && !Array.isArray(message.usage)
    ? message.usage as Record<string, unknown>
    : (entry.usage && typeof entry.usage === 'object' && !Array.isArray(entry.usage) ? entry.usage as Record<string, unknown> : null);
  const costUsd = typeof entry.cost_usd === 'number'
    ? entry.cost_usd
    : (typeof entry.costUSD === 'number' ? entry.costUSD : 0);
  if (!rawUsage && costUsd <= 0) return null;

  const usage: Usage = {
    ...emptyUsage(),
    inputTokens: numberField(rawUsage, 'input_tokens'),
    outputTokens: numberField(rawUsage, 'output_tokens'),
    cacheReadTokens: numberField(rawUsage, 'cache_read_input_tokens'),
    cacheWriteTokens: numberField(rawUsage, 'cache_creation_input_tokens'),
    costUsd,
  };
  if (
    usage.inputTokens <= 0
    && usage.outputTokens <= 0
    && usage.cacheReadTokens <= 0
    && usage.cacheWriteTokens <= 0
    && usage.costUsd <= 0
  ) {
    return null;
  }

  const date = dateFromTimestamp(typeof entry.timestamp === 'string' ? entry.timestamp : null);
  if (!date) return null;
  return {
    sourceId,
    date,
    model: typeof message.model === 'string' && message.model ? message.model : 'unknown',
    usage,
  };
}

function sourceIdForLine(sessionId: string, line: string): string {
  try {
    const parsed = JSON.parse(line) as { uuid?: unknown };
    if (typeof parsed.uuid === 'string' && parsed.uuid) return `${sessionId}:${parsed.uuid}`;
  } catch {
    // Fall through to a stable line hash.
  }
  return `${sessionId}:${crypto.createHash('sha1').update(line).digest('hex')}`;
}

function numberField(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function dateFromTimestamp(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
