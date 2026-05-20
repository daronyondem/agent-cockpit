import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { RunOneShotOptions } from '../backends/base';
import type { BackendRegistry } from '../backends/registry';
import type { CliProfileRuntime } from '../cliProfiles';
import type {
  Conversation,
  ConversationListItem,
  EffortLevel,
  Message,
  SessionFile,
  Settings,
  WorkspaceContextRunRecord,
  WorkspaceContextRunSkippedReason,
  WorkspaceContextRunSource,
  WorkspaceContextState,
  WorkspaceContextWorkspaceSettings,
} from '../../types';
import { logger } from '../../utils/logger';
import {
  DEFAULT_WORKSPACE_CONTEXT_CLI_CONCURRENCY,
  DEFAULT_WORKSPACE_CONTEXT_MAINTENANCE_CLI_CONCURRENCY,
  DEFAULT_WORKSPACE_CONTEXT_MAINTENANCE_INTERVAL_HOURS,
  DEFAULT_WORKSPACE_CONTEXT_SCAN_INTERVAL_MINUTES,
  WORKSPACE_CONTEXT_DIRNAME,
  WORKSPACE_CONTEXT_INSTRUCTION_FILENAME,
  WORKSPACE_CONTEXT_MANAGED_BLOCK_END,
  WORKSPACE_CONTEXT_MANAGED_BLOCK_START,
} from './defaults';

const log = logger.child({ module: 'workspace-context-service' });

const STATE_VERSION = 1;
const MAX_SOURCE_PATHS = 80;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAINTENANCE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MIN_VISIBLE_NO_SOURCE_RUN_MS = 1500;
const RUN_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LATEST_RUN_REPORT_FILENAME = 'latest.md';

export interface WorkspaceContextChatService {
  workspacesDir: string;
  getSettings(): Promise<Settings>;
  resolveCliProfileRuntime?(
    cliProfileId: string | undefined | null,
    fallbackBackend?: string | null,
  ): Promise<CliProfileRuntime>;
  getWorkspacePath(hash: string): Promise<string | null>;
  getWorkspaceContextSettings(hash: string): Promise<WorkspaceContextWorkspaceSettings | null>;
  getWorkspaceContextEnabled(hash: string): Promise<boolean>;
  listConversations(opts?: { archived?: boolean }): Promise<ConversationListItem[]>;
  getConversation(id: string): Promise<Conversation | null>;
  getSessionMessages?(id: string, sessionNumber: number): Promise<Message[] | null>;
  getConversationSessionFilePath?(hash: string, conversationId: string, sessionNumber: number): string;
}

export interface WorkspaceContextProcessResult {
  workspaceHash: string;
  source: WorkspaceContextRunSource | null;
  runId: string | null;
  filesConsidered: number;
  summary: string | null;
  stopped?: boolean;
  skippedReason?: 'workspace-not-found' | 'disabled' | 'already-running' | 'no-sources' | 'processor-unavailable';
}

interface ActiveWorkspaceContextRun {
  abortController: AbortController;
  startedAt: string;
  source?: WorkspaceContextRunSource;
  runId: string;
  run?: WorkspaceContextRunRecord;
}

interface ResolvedWorkspaceContextProcessor {
  runtime: CliProfileRuntime;
  model?: string;
  effort?: EffortLevel;
}

interface WorkspaceContextProcessorAdapter {
  runOneShot(prompt: string, opts?: RunOneShotOptions): Promise<string>;
}

interface SourcePlan {
  paths: string[];
  sourceWindowLabel: string;
}

export interface WorkspaceContextServiceOptions {
  chatService: WorkspaceContextChatService;
  backendRegistry?: BackendRegistry | null;
  now?: () => Date;
  emitUpdate?: (hash: string) => void | Promise<void>;
  minVisibleNoSourceRunMs?: number;
}

export class WorkspaceContextService {
  private readonly chatService: WorkspaceContextChatService;
  private readonly backendRegistry: BackendRegistry | null;
  private readonly now: () => Date;
  private readonly emitUpdate?: (hash: string) => void | Promise<void>;
  private readonly minVisibleNoSourceRunMs: number;
  private readonly running = new Map<string, ActiveWorkspaceContextRun>();

  constructor(opts: WorkspaceContextServiceOptions) {
    this.chatService = opts.chatService;
    this.backendRegistry = opts.backendRegistry ?? null;
    this.now = opts.now ?? (() => new Date());
    this.emitUpdate = opts.emitUpdate;
    this.minVisibleNoSourceRunMs = Math.max(0, opts.minVisibleNoSourceRunMs ?? DEFAULT_MIN_VISIBLE_NO_SOURCE_RUN_MS);
  }

  isRunning(hash: string): boolean {
    return this.running.has(hash);
  }

  getRunningSource(hash: string): WorkspaceContextRunSource | null {
    return this.running.get(hash)?.source || this.running.get(hash)?.run?.source || null;
  }

  async getDisplayState(hash: string): Promise<WorkspaceContextState> {
    const state = await this.getState(hash);
    const active = this.running.get(hash);
    if (!active) return state;
    const runningRun = active.run || {
      runId: active.runId,
      source: active.source || 'manual_catchup',
      status: 'running' as const,
      startedAt: active.startedAt,
      filesConsidered: 0,
      summary: null,
    };
    const runs = sortWorkspaceContextRuns([
      runningRun,
      ...(state.runs || []).filter((run) => run.runId !== runningRun.runId),
    ]).slice(0, 25);
    return {
      ...state,
      lastRun: runs[0] || runningRun,
      runs,
    };
  }

  getWorkspaceContextDir(hash: string): string {
    return path.join(this.chatService.workspacesDir, hash, WORKSPACE_CONTEXT_DIRNAME);
  }

  getInstructionPath(hash: string): string {
    return path.join(this.getWorkspaceContextDir(hash), WORKSPACE_CONTEXT_INSTRUCTION_FILENAME);
  }

  getContextFilesDir(hash: string): string {
    return path.join(this.getWorkspaceContextDir(hash), 'context');
  }

  async ensureWorkspace(hash: string): Promise<WorkspaceContextState | null> {
    const workspacePath = await this.chatService.getWorkspacePath(hash);
    if (!workspacePath) return null;
    await this.ensureContextFiles(hash, workspacePath);
    await this.installWorkspaceInstructions(hash, workspacePath);
    return this.getState(hash);
  }

  async getState(hash: string): Promise<WorkspaceContextState> {
    const statePath = this.statePath(hash);
    try {
      const raw = JSON.parse(await fsp.readFile(statePath, 'utf8')) as Partial<WorkspaceContextState>;
      return normalizeState(raw, this.getWorkspaceContextDir(hash));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Failed to read Workspace Context state', { workspaceHash: hash, error: err });
      }
      return emptyState(this.getWorkspaceContextDir(hash));
    }
  }

  async listFiles(hash: string): Promise<Array<{ path: string; name: string; size: number; updatedAt: string }>> {
    const root = this.getContextFilesDir(hash);
    const files: Array<{ path: string; name: string; size: number; updatedAt: string }> = [];
    await walkMarkdown(root, root, files);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(hash: string, relPath: string): Promise<{ path: string; content: string } | null> {
    const safeRel = normalizeRelativeMarkdownPath(relPath);
    if (!safeRel) return null;
    const root = this.getContextFilesDir(hash);
    const abs = path.resolve(root, safeRel);
    if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) return null;
    try {
      return { path: safeRel, content: await fsp.readFile(abs, 'utf8') };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async clearWorkspace(hash: string): Promise<void> {
    await fsp.rm(this.getWorkspaceContextDir(hash), { recursive: true, force: true });
    const workspacePath = await this.chatService.getWorkspacePath(hash);
    if (workspacePath) await this.ensureContextFiles(hash, workspacePath);
  }

  async repairInstructions(hash: string): Promise<WorkspaceContextState | null> {
    const workspacePath = await this.chatService.getWorkspacePath(hash);
    if (!workspacePath) return null;
    await this.ensureContextFiles(hash, workspacePath);
    await this.installWorkspaceInstructions(hash, workspacePath);
    return this.getState(hash);
  }

  async uninstallWorkspaceInstructions(hash: string): Promise<void> {
    const workspacePath = await this.chatService.getWorkspacePath(hash);
    if (!workspacePath) return;
    const agentsPath = path.join(workspacePath, 'AGENTS.md');
    try {
      const current = await fsp.readFile(agentsPath, 'utf8');
      const next = removeManagedBlock(current).trimEnd();
      if (next.trim()) {
        await fsp.writeFile(agentsPath, next + '\n', 'utf8');
      } else {
        await fsp.rm(agentsPath, { force: true });
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async stopWorkspace(hash: string): Promise<boolean> {
    const active = this.running.get(hash);
    if (!active) return false;
    active.abortController.abort();
    if (active.run) {
      const state = await this.getState(hash);
      await this.recordRun(hash, {
        ...active.run,
        status: 'stopped',
        completedAt: this.now().toISOString(),
        summary: 'Stopped by user.',
      }, state);
    }
    await this.emit(hash);
    return true;
  }

  async recordSkippedRun(
    hash: string,
    source: WorkspaceContextRunSource,
    reason: WorkspaceContextRunSkippedReason,
  ): Promise<WorkspaceContextRunRecord> {
    const startedAt = this.now().toISOString();
    const run: WorkspaceContextRunRecord = {
      runId: `wc-run-skip-${crypto.randomUUID()}`,
      source,
      status: 'skipped',
      startedAt,
      completedAt: startedAt,
      filesConsidered: 0,
      summary: skippedRunSummary(reason),
      skippedReason: reason,
    };
    await this.recordRun(hash, run, await this.getState(hash));
    await this.writeRunReport(hash, run, run.summary || 'Skipped.', []);
    await this.emit(hash);
    return run;
  }

  async processWorkspace(
    hash: string,
    opts: {
      source?: WorkspaceContextRunSource;
      conversationScope?: { conversationId: string; sessionNumber: number };
      forceAll?: boolean;
    } = {},
  ): Promise<WorkspaceContextProcessResult> {
    if (this.running.has(hash)) {
      return emptyResult(hash, opts.source ?? null, 'already-running');
    }
    const active: ActiveWorkspaceContextRun = {
      abortController: new AbortController(),
      source: opts.source,
      runId: `wc-run-${crypto.randomUUID()}`,
      startedAt: this.now().toISOString(),
    };
    this.running.set(hash, active);
    await this.emit(hash);
    try {
      const enabled = await this.chatService.getWorkspaceContextEnabled(hash);
      if (!enabled) return emptyResult(hash, opts.source ?? null, 'disabled');
      return await this.processWorkspaceInternal(hash, opts, active);
    } finally {
      this.running.delete(hash);
      await this.emit(hash);
    }
  }

  async processConversationSession(
    hash: string,
    conversationId: string,
    sessionNumber: number,
    opts: { source: Extract<WorkspaceContextRunSource, 'session_reset' | 'archive'> },
  ): Promise<WorkspaceContextProcessResult> {
    return this.processWorkspace(hash, {
      source: opts.source,
      conversationScope: { conversationId, sessionNumber },
      forceAll: true,
    });
  }

  private async processWorkspaceInternal(
    hash: string,
    opts: {
      source?: WorkspaceContextRunSource;
      conversationScope?: { conversationId: string; sessionNumber: number };
      forceAll?: boolean;
    },
    active: ActiveWorkspaceContextRun,
  ): Promise<WorkspaceContextProcessResult> {
    const workspacePath = await this.chatService.getWorkspacePath(hash);
    if (!workspacePath) return emptyResult(hash, opts.source ?? null, 'workspace-not-found');
    await this.ensureContextFiles(hash, workspacePath);
    await this.installWorkspaceInstructions(hash, workspacePath);

    const state = await this.getState(hash);
    const source = opts.source ?? (state.lastScanCompletedAt || hasCompletedScanRun(state) ? 'scheduled' : 'initial_scan');
    active.source = source;
    let runningRun: WorkspaceContextRunRecord = {
      runId: active.runId,
      source,
      status: 'running',
      startedAt: active.startedAt,
      filesConsidered: 0,
      summary: 'Checking source files for Workspace Context updates.',
    };
    await this.updateActiveRun(hash, active, runningRun, state);
    if (source === 'maintenance') {
      runningRun = {
        ...runningRun,
        summary: 'Pruning Workspace Context run logs older than 7 days.',
      };
      await this.updateActiveRun(hash, active, runningRun, await this.getState(hash));
      await this.pruneOldRunLogs(hash);
    }

    const plan = await this.planSources(hash, source, state, opts);
    runningRun = {
      ...runningRun,
      filesConsidered: plan.paths.length,
      summary: plan.paths.length > 0
        ? `Processing ${plan.paths.length} source file${plan.paths.length === 1 ? '' : 's'} for Workspace Context updates.`
        : 'No source changes found; completing this scan.',
    };
    await this.updateActiveRun(hash, active, runningRun, await this.getState(hash));
    if (plan.paths.length === 0) {
      await this.waitForMinimumVisibleRun(active);
      return this.recordNoSourceRun(hash, source, active, await this.getState(hash));
    }

    const processor = await this.resolveProcessor(hash);
    const adapter = this.backendRegistry?.get(processor.runtime.backendId) as WorkspaceContextProcessorAdapter | null | undefined;
    if (!adapter || typeof adapter.runOneShot !== 'function') {
      const completedAt = this.now().toISOString();
      const failedRun: WorkspaceContextRunRecord = {
        ...runningRun,
        status: 'failed',
        completedAt,
        summary: 'Workspace Context processor is unavailable.',
        errorMessage: 'Workspace Context processor is unavailable.',
      };
      active.run = failedRun;
      await this.recordRun(hash, failedRun, await this.getState(hash));
      return emptyResult(hash, source, 'processor-unavailable');
    }

    runningRun = {
      ...runningRun,
      summary: 'Workspace Context processor is reading sources and updating markdown.',
    };
    await this.updateActiveRun(hash, active, runningRun, await this.getState(hash));

    try {
      throwIfStopped(active.abortController.signal);
      const prompt = source === 'maintenance'
        ? this.buildMaintenancePrompt(hash, workspacePath, plan)
        : this.buildCatchupPrompt(hash, workspacePath, source, plan);
      const output = await adapter.runOneShot(prompt, {
        model: processor.model,
        effort: processor.effort,
        timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
        abortSignal: active.abortController.signal,
        workingDir: workspacePath,
        allowTools: true,
        cliProfile: processor.runtime.profile,
      });
      throwIfStopped(active.abortController.signal);
      const completedAt = this.now().toISOString();
      const summary = summarizeProcessorOutput(output);
      const completedRun: WorkspaceContextRunRecord = {
        ...runningRun,
        status: 'completed',
        completedAt,
        summary,
      };
      await this.writeRunReport(hash, completedRun, output, plan.paths);
      await this.recordRun(hash, completedRun, await this.getState(hash));
      return {
        workspaceHash: hash,
        source,
        runId: active.runId,
        filesConsidered: plan.paths.length,
        summary,
      };
    } catch (err: unknown) {
      const stopped = active.abortController.signal.aborted;
      const completedAt = this.now().toISOString();
      const failedRun: WorkspaceContextRunRecord = {
        ...runningRun,
        status: stopped ? 'stopped' : 'failed',
        completedAt,
        summary: stopped ? 'Stopped by user.' : (err as Error).message,
        errorMessage: stopped ? undefined : (err as Error).message,
      };
      await this.recordRun(hash, failedRun, await this.getState(hash));
      if (stopped) {
        return {
          workspaceHash: hash,
          source,
          runId: active.runId,
          filesConsidered: plan.paths.length,
          summary: failedRun.summary,
          stopped: true,
        };
      }
      throw err;
    }
  }

  private async ensureContextFiles(hash: string, workspacePath: string): Promise<void> {
    const root = this.getWorkspaceContextDir(hash);
    const contextDir = this.getContextFilesDir(hash);
    await fsp.mkdir(contextDir, { recursive: true });
    await fsp.mkdir(path.join(root, 'runs'), { recursive: true });
    const instructionPath = this.getInstructionPath(hash);
    await fsp.writeFile(instructionPath, buildWorkspaceContextInstruction({
      workspacePath,
      instructionPath,
      contextDir,
      now: this.now().toISOString(),
    }), 'utf8');
    const overviewPath = path.join(contextDir, 'overview.md');
    try {
      await fsp.access(overviewPath);
    } catch {
      await fsp.writeFile(overviewPath, [
        '# Workspace Overview',
        '',
        'This file is the starting point for durable workspace context. The CLI may reorganize or expand these notes as it learns from conversations, files, and source material.',
        '',
      ].join('\n'), 'utf8');
    }
    const statePath = this.statePath(hash);
    try {
      await fsp.access(statePath);
    } catch {
      await this.writeState(hash, emptyState(root));
    }
  }

  private async installWorkspaceInstructions(hash: string, workspacePath: string): Promise<void> {
    const instructionPath = this.getInstructionPath(hash);
    const contextDir = this.getContextFilesDir(hash);
    const agentsPath = path.join(workspacePath, 'AGENTS.md');
    const block = [
      WORKSPACE_CONTEXT_MANAGED_BLOCK_START,
      '## Workspace Context',
      '',
      'This workspace uses Agent Cockpit Workspace Context.',
      `Read and follow: \`${instructionPath}\``,
      `Durable context markdown lives in: \`${contextDir}\``,
      '',
      'Use those instructions and markdown files as the workspace operating memory. Create, reorganize, and update the context markdown files directly when durable context changes.',
      WORKSPACE_CONTEXT_MANAGED_BLOCK_END,
    ].join('\n');
    let current = '';
    try {
      current = await fsp.readFile(agentsPath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const withoutManaged = removeManagedBlock(current).trimEnd();
    const next = withoutManaged ? `${withoutManaged}\n\n${block}\n` : `# AGENTS.md\n\n${block}\n`;
    if (next !== current) await fsp.writeFile(agentsPath, next, 'utf8');
  }

  private async planSources(
    hash: string,
    source: WorkspaceContextRunSource,
    state: WorkspaceContextState,
    opts: { conversationScope?: { conversationId: string; sessionNumber: number }; forceAll?: boolean },
  ): Promise<SourcePlan> {
    if (source === 'maintenance') {
      const contextDir = this.getContextFilesDir(hash);
      const files = await this.listFiles(hash);
      return {
        paths: files.map((file) => path.join(contextDir, file.path)).slice(0, MAX_SOURCE_PATHS),
        sourceWindowLabel: 'current Workspace Context markdown files',
      };
    }

    if (opts.conversationScope) {
      const sessionPath = this.chatService.getConversationSessionFilePath
        ? this.chatService.getConversationSessionFilePath(hash, opts.conversationScope.conversationId, opts.conversationScope.sessionNumber)
        : path.join(this.chatService.workspacesDir, hash, opts.conversationScope.conversationId, `session-${opts.conversationScope.sessionNumber}.json`);
      return { paths: await this.expandSessionSourcePaths(sessionPath), sourceWindowLabel: `${source} session ${opts.conversationScope.sessionNumber}` };
    }

    const conversations = (await this.chatService.listConversations({ archived: false }))
      .filter((conv) => conv.workspaceHash === hash && !conv.archived);
    const since = opts.forceAll ? 0 : source === 'initial_scan' ? 0 : Date.parse(state.lastScanCompletedAt || state.lastCompletedAt || '') || 0;
    const paths: string[] = [];
    for (const ref of conversations) {
      const updatedAt = Date.parse(ref.updatedAt || '');
      if (!opts.forceAll && since > 0 && Number.isFinite(updatedAt) && updatedAt <= since) continue;
      const conv = await this.chatService.getConversation(ref.id);
      if (!conv || conv.workspaceHash !== hash) continue;
      const sessions = conv.messages.length > 0
        ? [conv.sessionNumber]
        : [];
      for (const sessionNumber of sessions) {
        const sessionPath = this.chatService.getConversationSessionFilePath
          ? this.chatService.getConversationSessionFilePath(hash, conv.id, sessionNumber)
          : path.join(this.chatService.workspacesDir, hash, conv.id, `session-${sessionNumber}.json`);
        paths.push(...await this.expandSessionSourcePaths(sessionPath));
      }
    }
    return {
      paths: Array.from(new Set(paths)).slice(0, MAX_SOURCE_PATHS),
      sourceWindowLabel: since > 0 ? `sources changed after ${new Date(since).toISOString()}` : 'all active workspace conversation sources',
    };
  }

  private async expandSessionSourcePaths(sessionPath: string): Promise<string[]> {
    const paths = [sessionPath];
    let session: SessionFile | null = null;
    try {
      session = JSON.parse(await fsp.readFile(sessionPath, 'utf8')) as SessionFile;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const message of session?.messages || []) {
      for (const attachmentPath of extractUploadedFilePaths(message.content)) {
        paths.push(attachmentPath);
      }
    }
    return Array.from(new Set(paths));
  }

  private async resolveProcessor(hash: string): Promise<ResolvedWorkspaceContextProcessor> {
    const settings = await this.chatService.getSettings();
    const workspaceSettings = await this.chatService.getWorkspaceContextSettings(hash);
    const global = settings.workspaceContext || {};
    const useOverride = workspaceSettings?.processorMode === 'override';
    const profileId = useOverride ? workspaceSettings?.cliProfileId : global.cliProfileId;
    const fallbackBackend = useOverride ? workspaceSettings?.cliBackend : global.cliBackend;
    const runtime = this.chatService.resolveCliProfileRuntime
      ? await this.chatService.resolveCliProfileRuntime(profileId, fallbackBackend)
      : {
          backendId: fallbackBackend || settings.defaultBackend || 'claude-code',
          cliProfileId: profileId || null,
          profile: undefined,
        } as CliProfileRuntime;
    return {
      runtime,
      model: (useOverride ? workspaceSettings?.cliModel : global.cliModel) || undefined,
      effort: (useOverride ? workspaceSettings?.cliEffort : global.cliEffort) || undefined,
    };
  }

  private buildCatchupPrompt(hash: string, workspacePath: string, source: WorkspaceContextRunSource, plan: SourcePlan): string {
    const instructionPath = this.getInstructionPath(hash);
    const contextDir = this.getContextFilesDir(hash);
    return [
      '# Workspace Context Catch-Up',
      '',
      `Current time: ${this.now().toISOString()}`,
      `Workspace path: ${workspacePath}`,
      `Workspace Context instructions: ${instructionPath}`,
      `Workspace Context markdown folder: ${contextDir}`,
      `Run source: ${source}`,
      `Source window: ${plan.sourceWindowLabel}`,
      '',
      '## Task',
      'Read the Workspace Context instructions first. Then review the source files listed below and create, reorganize, or update the context markdown files in the Workspace Context folder directly.',
      'If a source file is a conversation/session export, inspect its messages for uploaded-file paths or other user-mentioned local file paths. Read those referenced files too when they are relevant to durable context.',
      '',
      'This is autonomous learning. Do not ask for approval. Do not produce JSON. Do not hide, filter, or refuse user-provided workspace material. Preserve temporal perspective: respect source dates, the current date, recency, status changes, and superseded information. Use "as of YYYY-MM-DD" for status-like claims, retain exact event dates/times when timing matters, distinguish source time from ingestion time when useful, and update older notes when newer information supersedes them.',
      '',
      'At the end, reply with a concise markdown summary of what context files you created, reorganized, or updated, or why no update was needed.',
      '',
      '## Source Files',
      ...plan.paths.map((sourcePath) => `- ${sourcePath}`),
      '',
    ].join('\n');
  }

  private buildMaintenancePrompt(hash: string, workspacePath: string, plan: SourcePlan): string {
    const instructionPath = this.getInstructionPath(hash);
    const contextDir = this.getContextFilesDir(hash);
    return [
      '# Workspace Context Maintenance',
      '',
      `Current time: ${this.now().toISOString()}`,
      `Workspace path: ${workspacePath}`,
      `Workspace Context instructions: ${instructionPath}`,
      `Workspace Context markdown folder: ${contextDir}`,
      'Run source: maintenance',
      `Source window: ${plan.sourceWindowLabel}`,
      '',
      '## Task',
      'Read the Workspace Context instructions first. Then review the context markdown files listed below and improve the context set itself.',
      '',
      'This is a maintenance pass, not a new source-ingestion pass. Do not scan conversations, external source files, or workspace files unless they are explicitly listed below. Focus on making the existing Workspace Context markdown easier for future CLI sessions to use.',
      '',
      'Create, reorganize, or update the context markdown files directly where useful:',
      '- Merge duplicate notes.',
      '- Split oversized files into focused files when that improves discoverability.',
      '- Add useful headings, cross-references, current reads, strategic reads, how-to-engage notes, open threads, decisions, projects, people, and temporal status where the existing context supports them.',
      '- Remove or rewrite stale duplication instead of keeping conflicting claims side by side.',
      '- Preserve source dates, as-of dates, superseded status, and exact event dates/times already present in the markdown.',
      '- Keep concise human-readable markdown that another CLI can scan quickly.',
      '',
      'Do not ask for approval. Do not produce JSON. Do not hide, filter, or refuse user-provided workspace material already present in the context files.',
      '',
      'At the end, reply with a concise markdown summary of what context files you created, reorganized, or updated, or why no maintenance was needed.',
      '',
      '## Context Files',
      ...plan.paths.map((sourcePath) => `- ${sourcePath}`),
      '',
    ].join('\n');
  }

  private statePath(hash: string): string {
    return path.join(this.getWorkspaceContextDir(hash), 'state.json');
  }

  private async recordRun(hash: string, run: WorkspaceContextRunRecord, state: WorkspaceContextState): Promise<void> {
    const runs = sortWorkspaceContextRuns([run, ...(state.runs || []).filter((existing) => existing.runId !== run.runId)]).slice(0, 25);
    const next: WorkspaceContextState = {
      ...state,
      version: STATE_VERSION,
      contextDir: this.getWorkspaceContextDir(hash),
      lastRun: run,
      lastCompletedAt: run.status === 'completed' ? run.completedAt || this.now().toISOString() : state.lastCompletedAt,
      lastScanCompletedAt: run.status === 'completed' && isScanRunSource(run.source)
        ? run.completedAt || this.now().toISOString()
        : state.lastScanCompletedAt,
      lastMaintenanceCompletedAt: run.status === 'completed' && run.source === 'maintenance'
        ? run.completedAt || this.now().toISOString()
        : state.lastMaintenanceCompletedAt,
      runs,
    };
    await this.writeState(hash, next);
  }

  private async updateActiveRun(
    hash: string,
    active: ActiveWorkspaceContextRun,
    run: WorkspaceContextRunRecord,
    state: WorkspaceContextState,
  ): Promise<void> {
    active.run = run;
    await this.recordRun(hash, run, state);
    await this.emit(hash);
  }

  private async pruneOldRunLogs(hash: string): Promise<void> {
    const cutoffMs = this.now().getTime() - RUN_LOG_RETENTION_MS;
    const state = await this.getState(hash);
    const retainedRuns = (state.runs || []).filter((run) => {
      if (run.status === 'running') return true;
      const timestamp = workspaceContextRunRetentionTimestamp(run);
      return !Number.isFinite(timestamp) || timestamp >= cutoffMs;
    });
    const removedStateRuns = retainedRuns.length !== (state.runs || []).length;
    if (removedStateRuns) {
      const lastRun = state.lastRun && retainedRuns.some((run) => run.runId === state.lastRun?.runId)
        ? state.lastRun
        : retainedRuns[0];
      await this.writeState(hash, {
        ...state,
        lastRun,
        runs: retainedRuns,
      });
    }
    await this.pruneOldRunReportFiles(hash, cutoffMs);
  }

  private async pruneOldRunReportFiles(hash: string, cutoffMs: number): Promise<void> {
    const runsDir = path.join(this.getWorkspaceContextDir(hash), 'runs');
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(runsDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === LATEST_RUN_REPORT_FILENAME || !entry.name.toLowerCase().endsWith('.md')) continue;
      const abs = path.join(runsDir, entry.name);
      const filenameTime = parseRunReportFilenameTimestamp(entry.name);
      let timestamp = filenameTime;
      if (!Number.isFinite(timestamp)) {
        try {
          timestamp = (await fsp.stat(abs)).mtimeMs;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
      }
      if (Number.isFinite(timestamp) && timestamp < cutoffMs) await fsp.rm(abs, { force: true });
    }
  }

  private async waitForMinimumVisibleRun(active: ActiveWorkspaceContextRun): Promise<void> {
    if (this.minVisibleNoSourceRunMs <= 0) return;
    const startedAt = Date.parse(active.startedAt);
    if (!Number.isFinite(startedAt)) return;
    const remaining = this.minVisibleNoSourceRunMs - (Date.now() - startedAt);
    if (remaining <= 0) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, remaining);
      active.abortController.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(undefined);
      }, { once: true });
    });
    throwIfStopped(active.abortController.signal);
  }

  private async recordNoSourceRun(
    hash: string,
    source: WorkspaceContextRunSource,
    active: ActiveWorkspaceContextRun,
    state: WorkspaceContextState,
  ): Promise<WorkspaceContextProcessResult> {
    const completedAt = this.now().toISOString();
    const summary = source === 'maintenance'
      ? 'No Workspace Context markdown files were available for maintenance.'
      : 'No source changes were found for this scan.';
    const run: WorkspaceContextRunRecord = {
      runId: active.runId,
      source,
      status: 'completed',
      startedAt: active.startedAt,
      completedAt,
      filesConsidered: 0,
      summary,
    };
    active.run = run;
    await this.writeRunReport(hash, run, summary, []);
    await this.recordRun(hash, run, state);
    return {
      workspaceHash: hash,
      source,
      runId: run.runId,
      filesConsidered: 0,
      summary,
    };
  }

  private async writeState(hash: string, state: WorkspaceContextState): Promise<void> {
    await fsp.mkdir(this.getWorkspaceContextDir(hash), { recursive: true });
    await fsp.writeFile(this.statePath(hash), JSON.stringify(state, null, 2), 'utf8');
  }

  private async writeRunReport(hash: string, run: WorkspaceContextRunRecord, output: string, sourcePaths: string[]): Promise<void> {
    const runsDir = path.join(this.getWorkspaceContextDir(hash), 'runs');
    await fsp.mkdir(runsDir, { recursive: true });
    const filename = `${run.startedAt.replace(/[:.]/g, '-')}-${run.source}.md`;
    const body = [
      `# Workspace Context Run ${run.runId}`,
      '',
      `- Source: ${run.source}`,
      `- Status: ${run.status}`,
      `- Started: ${run.startedAt}`,
      `- Completed: ${run.completedAt || ''}`,
      `- Files considered: ${run.filesConsidered}`,
      '',
      '## Source Files',
      ...sourcePaths.map((sourcePath) => `- ${sourcePath}`),
      '',
      '## Processor Summary',
      '',
      output.trim() || '(No output)',
      '',
    ].join('\n');
    await fsp.writeFile(path.join(runsDir, filename), body, 'utf8');
    await fsp.writeFile(path.join(runsDir, 'latest.md'), body, 'utf8');
  }

  private async emit(hash: string): Promise<void> {
    if (!this.emitUpdate) return;
    try {
      await this.emitUpdate(hash);
    } catch (err: unknown) {
      log.warn('Failed to emit Workspace Context update', { workspaceHash: hash, error: err });
    }
  }
}

export interface WorkspaceContextSchedulerOptions {
  chatService: WorkspaceContextChatService & {
    listWorkspaceContextEnabledWorkspaceHashes(): Promise<string[]>;
  };
  processor: WorkspaceContextService;
  now?: () => Date;
  logger?: Pick<typeof log, 'warn'>;
}

export class WorkspaceContextScheduler {
  private readonly chatService: WorkspaceContextSchedulerOptions['chatService'];
  private readonly processor: WorkspaceContextService;
  private readonly now: () => Date;
  private readonly logger: Pick<typeof log, 'warn'>;
  private timer: NodeJS.Timeout | null = null;
  private lastMaintenanceCheckAt = 0;

  constructor(opts: WorkspaceContextSchedulerOptions) {
    this.chatService = opts.chatService;
    this.processor = opts.processor;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? log;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.logger.warn('Workspace Context scheduler tick failed', { error: err });
      });
    }, 60_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    await this.tickScans();
    const nowMs = this.now().getTime();
    if (nowMs - this.lastMaintenanceCheckAt >= MAINTENANCE_CHECK_INTERVAL_MS) {
      this.lastMaintenanceCheckAt = nowMs;
      await this.tickMaintenance();
    }
  }

  private async tickScans(): Promise<void> {
    const settings = await this.chatService.getSettings();
    const globalInterval = normalizedScanInterval(settings.workspaceContext?.scanIntervalMinutes);
    const concurrency = normalizedConcurrency(settings.workspaceContext?.cliConcurrency);
    const hashes = await this.chatService.listWorkspaceContextEnabledWorkspaceHashes();
    let started = 0;
    for (const hash of hashes) {
      if (started >= concurrency) break;
      const state = await this.processor.getState(hash);
      const workspaceSettings = await this.chatService.getWorkspaceContextSettings(hash);
      const interval = normalizedScanInterval(workspaceSettings?.scanIntervalMinutes ?? globalInterval);
      const source: WorkspaceContextRunSource = state.lastScanCompletedAt || hasCompletedScanRun(state) ? 'scheduled' : 'initial_scan';
      const last = Date.parse(state.lastScanCompletedAt || state.lastCompletedAt || '');
      if (Number.isFinite(last) && this.now().getTime() - last < interval * 60_000) continue;
      if (this.processor.isRunning(hash)) {
        await this.processor.recordSkippedRun(hash, source, runningSourceToSkippedReason(this.processor.getRunningSource(hash)));
        continue;
      }
      started += 1;
      void this.processor.processWorkspace(hash, { source }).catch((err: unknown) => {
        this.logger.warn('Workspace Context scheduled run failed', { workspaceHash: hash, error: err });
      });
    }
  }

  private async tickMaintenance(): Promise<void> {
    const settings = await this.chatService.getSettings();
    const globalInterval = normalizedMaintenanceInterval(settings.workspaceContext?.maintenanceIntervalHours);
    const concurrency = normalizedConcurrency(settings.workspaceContext?.maintenanceCliConcurrency, DEFAULT_WORKSPACE_CONTEXT_MAINTENANCE_CLI_CONCURRENCY);
    const hashes = await this.chatService.listWorkspaceContextEnabledWorkspaceHashes();
    let started = 0;
    for (const hash of hashes) {
      if (started >= concurrency) break;
      const state = await this.processor.getState(hash);
      const workspaceSettings = await this.chatService.getWorkspaceContextSettings(hash);
      const interval = normalizedMaintenanceInterval(workspaceSettings?.maintenanceIntervalHours ?? globalInterval);
      const last = Date.parse(state.lastMaintenanceCompletedAt || state.lastScanCompletedAt || state.lastCompletedAt || '');
      if (!Number.isFinite(last) || this.now().getTime() - last < interval * 60 * 60_000) continue;
      if (this.processor.isRunning(hash)) {
        await this.processor.recordSkippedRun(hash, 'maintenance', runningSourceToSkippedReason(this.processor.getRunningSource(hash)));
        continue;
      }
      started += 1;
      void this.processor.processWorkspace(hash, { source: 'maintenance', forceAll: true }).catch((err: unknown) => {
        this.logger.warn('Workspace Context maintenance run failed', { workspaceHash: hash, error: err });
      });
    }
  }
}

function buildWorkspaceContextInstruction(opts: {
  workspacePath: string;
  instructionPath: string;
  contextDir: string;
  now: string;
}): string {
  return [
    '# Workspace Context',
    '',
    'Workspace Context is this workspace\'s durable operating memory. The canonical data is the markdown in the `context/` folder next to this file.',
    '',
    `Workspace path: ${opts.workspacePath}`,
    `Instruction file: ${opts.instructionPath}`,
    `Context folder: ${opts.contextDir}`,
    `Last generated: ${opts.now}`,
    '',
    '## Operating Directive',
    '',
    '- Before answering on a topic that may depend on prior workspace knowledge, inspect the relevant markdown files in the context folder.',
    '- When durable information appears in chat, attached files, transcripts, emails, Slack exports, project documents, or workspace files, create, reorganize, or update the relevant context markdown file directly.',
    '- Create a new focused markdown file when no existing file is the right home.',
    '- Prefer useful human-readable structure over rigid schemas. Sections like current read, strategic read, how to engage, open threads, decisions, people, projects, and cross-references are encouraged when they make the context more useful.',
    '- Connect the dots across people, projects, decisions, commitments, themes, and source material.',
    '- Keep temporal perspective. Use "as of YYYY-MM-DD" for status-like claims. Use exact event dates/times when the source provides them and timing matters. Distinguish source time from ingestion time when useful. When newer information changes older information, update the older note instead of leaving conflicting claims side by side. Prefer phrases like "formerly", "superseded by", "current as of", "awaiting response since", and "closed on" where appropriate.',
    '- Do not ask the user to review or approve learning before updating context. The user can correct context later by saying so in chat.',
    '- Do not hide, filter, or refuse user-provided workspace material. The user provided the data and is the person accessing it.',
    '- Do not store source transcripts verbatim unless the user explicitly asks for raw transcript retention. Extract and maintain durable operating context.',
    '',
    '## File Practices',
    '',
    '- Keep files focused and discoverable.',
    '- Use markdown headings and bullet lists that another CLI can scan quickly.',
    '- Preserve important cross-references with relative links where useful.',
    '- Remove stale duplication when you update a file.',
    '- If a source contains no durable learning, leave the context unchanged and say so in the run summary.',
    '',
  ].join('\n');
}

function removeManagedBlock(content: string): string {
  const start = content.indexOf(WORKSPACE_CONTEXT_MANAGED_BLOCK_START);
  const end = content.indexOf(WORKSPACE_CONTEXT_MANAGED_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return content;
  return `${content.slice(0, start)}${content.slice(end + WORKSPACE_CONTEXT_MANAGED_BLOCK_END.length)}`;
}

async function walkMarkdown(
  root: string,
  current: string,
  files: Array<{ path: string; name: string; size: number; updatedAt: string }>,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(root, abs, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const stat = await fsp.stat(abs);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      files.push({ path: rel, name: entry.name, size: stat.size, updatedAt: stat.mtime.toISOString() });
    }
  }
}

function normalizeRelativeMarkdownPath(value: string): string | null {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..') || !rel.toLowerCase().endsWith('.md')) return null;
  return rel;
}

function emptyState(contextDir: string): WorkspaceContextState {
  return {
    version: STATE_VERSION,
    contextDir,
    runs: [],
  };
}

function normalizeState(raw: Partial<WorkspaceContextState>, contextDir: string): WorkspaceContextState {
  const normalizedLastRun = normalizeRun(raw.lastRun);
  const rawRuns = Array.isArray(raw.runs) ? raw.runs.map(normalizeRun).filter((run): run is WorkspaceContextRunRecord => !!run) : [];
  const runs = sortWorkspaceContextRuns([
    ...(normalizedLastRun ? [normalizedLastRun] : []),
    ...rawRuns.filter((run) => !normalizedLastRun || run.runId !== normalizedLastRun.runId),
  ]).slice(0, 25);
  const legacyLastCompletedAt = typeof raw.lastCompletedAt === 'string' ? raw.lastCompletedAt : undefined;
  return {
    version: STATE_VERSION,
    contextDir,
    lastRun: normalizedLastRun || runs[0],
    lastCompletedAt: legacyLastCompletedAt,
    lastScanCompletedAt: typeof raw.lastScanCompletedAt === 'string'
      ? raw.lastScanCompletedAt
      : newestCompletedRunTime(runs, isScanRunSource) || legacyLastCompletedAt,
    lastMaintenanceCompletedAt: typeof raw.lastMaintenanceCompletedAt === 'string'
      ? raw.lastMaintenanceCompletedAt
      : newestCompletedRunTime(runs, (source) => source === 'maintenance'),
    runs,
  };
}

function sortWorkspaceContextRuns(runs: WorkspaceContextRunRecord[]): WorkspaceContextRunRecord[] {
  return [...runs].sort((a, b) => workspaceContextRunTimestamp(b) - workspaceContextRunTimestamp(a));
}

function workspaceContextRunTimestamp(run: WorkspaceContextRunRecord): number {
  const timestamp = Date.parse(run.startedAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function workspaceContextRunRetentionTimestamp(run: WorkspaceContextRunRecord): number {
  const timestamp = Date.parse(run.completedAt || run.startedAt || '');
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function parseRunReportFilenameTimestamp(filename: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(filename);
  if (!match) return NaN;
  const [, date, hour, minute, second, millisecond] = match;
  const timestamp = Date.parse(`${date}T${hour}:${minute}:${second}.${millisecond}Z`);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function normalizeRun(run: unknown): WorkspaceContextRunRecord | undefined {
  if (!run || typeof run !== 'object') return undefined;
  const record = run as Record<string, unknown>;
  if (typeof record.runId !== 'string' || typeof record.startedAt !== 'string') return undefined;
  return {
    runId: record.runId,
    source: normalizeRunSource(record.source),
    status: normalizeRunStatus(record.status),
    startedAt: record.startedAt,
    completedAt: typeof record.completedAt === 'string' ? record.completedAt : undefined,
    filesConsidered: typeof record.filesConsidered === 'number' ? record.filesConsidered : 0,
    summary: typeof record.summary === 'string' ? record.summary : null,
    errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : undefined,
    skippedReason: normalizeSkippedReason(record.skippedReason),
  };
}

function normalizeRunSource(value: unknown): WorkspaceContextRunSource {
  if (value === 'initial_scan' || value === 'scheduled' || value === 'session_reset' || value === 'archive' || value === 'manual_catchup' || value === 'maintenance') return value;
  return 'manual_catchup';
}

function normalizeRunStatus(value: unknown): WorkspaceContextRunRecord['status'] {
  if (value === 'running' || value === 'completed' || value === 'failed' || value === 'stopped' || value === 'skipped') return value;
  return 'failed';
}

function normalizedScanInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WORKSPACE_CONTEXT_SCAN_INTERVAL_MINUTES;
  return Math.max(1, Math.min(1440, Math.round(value)));
}

function normalizedConcurrency(value: unknown, defaultValue = DEFAULT_WORKSPACE_CONTEXT_CLI_CONCURRENCY): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue;
  return Math.max(1, Math.min(10, Math.round(value)));
}

function normalizedMaintenanceInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WORKSPACE_CONTEXT_MAINTENANCE_INTERVAL_HOURS;
  return Math.max(1, Math.min(8760, Math.round(value)));
}

function isScanRunSource(source: WorkspaceContextRunSource): boolean {
  return source !== 'maintenance';
}

function hasCompletedScanRun(state: WorkspaceContextState): boolean {
  return (state.runs || []).some((run) => run.status === 'completed' && isScanRunSource(run.source));
}

function newestCompletedRunTime(
  runs: WorkspaceContextRunRecord[],
  predicate: (source: WorkspaceContextRunSource) => boolean,
): string | undefined {
  return runs.find((run) => run.status === 'completed' && predicate(run.source) && run.completedAt)?.completedAt;
}

function normalizeSkippedReason(value: unknown): WorkspaceContextRunSkippedReason | undefined {
  if (value === 'scan-running' || value === 'maintenance-running' || value === 'already-running') return value;
  return undefined;
}

function runningSourceToSkippedReason(source: WorkspaceContextRunSource | null): WorkspaceContextRunSkippedReason {
  if (source === 'maintenance') return 'maintenance-running';
  if (source) return 'scan-running';
  return 'already-running';
}

function skippedRunSummary(reason: WorkspaceContextRunSkippedReason): string {
  if (reason === 'maintenance-running') return 'Skipped because maintenance was already running for this workspace.';
  if (reason === 'scan-running') return 'Skipped because a scan was already running for this workspace.';
  return 'Skipped because another Workspace Context run was already running for this workspace.';
}

function summarizeProcessorOutput(output: string): string {
  const text = output.trim();
  if (!text) return 'Workspace Context run completed.';
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

function extractUploadedFilePaths(content: string): string[] {
  const match = String(content || '').match(/\n*\[Uploaded files: ([^\]]+)\]\s*$/);
  if (!match) return [];
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
}

function emptyResult(
  workspaceHash: string,
  source: WorkspaceContextRunSource | null,
  skippedReason: WorkspaceContextProcessResult['skippedReason'],
): WorkspaceContextProcessResult {
  return {
    workspaceHash,
    source,
    runId: null,
    filesConsidered: 0,
    summary: null,
    skippedReason,
  };
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Workspace Context run stopped');
}
