import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { BackendRegistry } from '../backends/registry';
import type { RunOneShotOptions } from '../backends/base';
import type { CliProfileRuntime } from '../cliProfiles';
import type { KbState, Settings } from '../../types';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { logger } from '../../utils/logger';
import {
  extractRoutineProposalMarkers,
  sanitizeWorkspaceRoutineSettings,
  validateRoutineManifest,
  workspaceRoutineSettingsResponse,
  type RoutineListItem,
  type RoutineManifest,
  type RoutineRunRecord,
  type RoutineRunSource,
  type RoutineRuntimeState,
  type RoutineSettingsEnvelope,
  type RoutineTelegramDestinationConnectPollResponse,
  type RoutineTelegramDestinationConnectStartResponse,
  type TelegramDestinationSummary,
  type WorkspaceRoutineSettings,
  type WorkspaceRoutineSettingsResponse,
} from '../../contracts/routines';

const log = logger.child({ module: 'routines-service' });

const ROUTINES_DIRNAME = 'routines';
const ROUTINE_AUTHORING_FILENAME = 'ROUTINE_AUTHORING.md';
const ROUTINE_INDEX_FILENAME = 'index.json';
const ROUTINE_SETTINGS_FILENAME = 'settings.json';
const ROUTINE_STATE_FILENAME = 'state.json';
const ROUTINE_PERSISTENT_STATE_DIRNAME = 'persistent-state';
const ROUTINE_MANAGED_BLOCK_START = '<!-- AGENT_COCKPIT_ROUTINES_START -->';
const ROUTINE_MANAGED_BLOCK_END = '<!-- AGENT_COCKPIT_ROUTINES_END -->';
const ROUTINE_STATE_VERSION = 1;
const DEFAULT_RUN_TIMEOUT_MINUTES = 10;
const DEFAULT_OUTPUT_RETENTION_DAYS = 14;
const MAX_RUN_HISTORY = 50;
const TELEGRAM_SEND_TIMEOUT_MS = 10_000;
const TELEGRAM_CONNECT_TTL_MS = 10 * 60_000;
const TELEGRAM_CONNECT_POLL_TIMEOUT_MS = 10_000;
const TELEGRAM_CONNECT_MESSAGE_SKEW_MS = 30_000;

export interface RoutinesChatService {
  workspacesDir: string;
  getSettings(): Promise<Settings>;
  resolveCliProfileRuntime?(
    cliProfileId: string | undefined | null,
    fallbackBackend?: string | null,
  ): Promise<CliProfileRuntime>;
  getWorkspacePath(hash: string): Promise<string | null>;
  getWorkspaceStorageKey?(hash: string): string | null;
  getWorkspaceIdForRef?(ref: string): string | null;
  getWorkspaceContextDir(hash: string): string;
  getWorkspaceContextEnabled(hash: string): Promise<boolean>;
  getWorkspaceKbEnabled(hash: string): Promise<boolean>;
  getWorkspaceRoutinesEnabled(hash: string): Promise<boolean>;
  getKbKnowledgeDir(hash: string): string;
  getKbState?(hash: string): Promise<KbState>;
  listRoutinesEnabledWorkspaceHashes?(): Promise<string[]>;
  listWorkspaces?(opts?: { archived?: boolean; includeArchived?: boolean }): Promise<Array<{ workspaceId: string; archived?: boolean }>>;
}

export interface RoutinesServiceOptions {
  chatService: RoutinesChatService;
  backendRegistry?: BackendRegistry | null;
  now?: () => Date;
  notifier?: RoutineNotifier;
}

export interface RoutineNotifier {
  sendTelegram(settings: WorkspaceRoutineSettings, content: string): Promise<void>;
}

export interface RoutineRunOptions {
  source: RoutineRunSource;
}

export interface RoutineProposalMarkerResult {
  routineId: string;
  manifest: RoutineManifest;
  manifestPath: string;
}

interface TelegramDestinationConnectSession {
  workspaceRef: string;
  code: string;
  createdAtMs: number;
  expiresAtMs: number;
  updateOffset?: number;
}

export class RoutinesService {
  private readonly chatService: RoutinesChatService;
  private readonly backendRegistry: BackendRegistry | null;
  private readonly now: () => Date;
  private readonly notifier: RoutineNotifier;
  private readonly starting = new Set<string>();
  private readonly running = new Map<string, RoutineRunRecord>();
  private readonly telegramDestinationConnects = new Map<string, TelegramDestinationConnectSession>();

  constructor(opts: RoutinesServiceOptions) {
    this.chatService = opts.chatService;
    this.backendRegistry = opts.backendRegistry ?? null;
    this.now = opts.now ?? (() => new Date());
    this.notifier = opts.notifier ?? new TelegramRoutineNotifier();
  }

  getRoutinesDir(workspaceRef: string): string {
    const storageKey = this.chatService.getWorkspaceStorageKey?.(workspaceRef) || workspaceRef;
    return path.join(this.chatService.workspacesDir, storageKey, ROUTINES_DIRNAME);
  }

  getAuthoringPath(workspaceRef: string): string {
    return path.join(this.getRoutinesDir(workspaceRef), ROUTINE_AUTHORING_FILENAME);
  }

  getItemsDir(workspaceRef: string): string {
    return path.join(this.getRoutinesDir(workspaceRef), 'items');
  }

  getRoutineDir(workspaceRef: string, routineId: string): string {
    return path.join(this.getItemsDir(workspaceRef), normalizeRoutineIdForPath(routineId));
  }

  getRoutinePersistentStateDir(workspaceRef: string, routineId: string): string {
    return path.join(this.getRoutineDir(workspaceRef, routineId), ROUTINE_PERSISTENT_STATE_DIRNAME);
  }

  async getRoutinePersistentStateExplorerDir(workspaceRef: string, routineId: string): Promise<string | null> {
    if (!(await this.workspaceEnabled(workspaceRef))) return null;
    const manifest = await this.readManifest(workspaceRef, routineId);
    if (!manifest) return null;
    const routineDir = this.getRoutineDir(workspaceRef, manifest.id);
    const persistentStateDir = path.join(routineDir, ROUTINE_PERSISTENT_STATE_DIRNAME);
    await fsp.mkdir(persistentStateDir, { recursive: true });
    return insideRoot(persistentStateDir, routineDir) ? persistentStateDir : null;
  }

  async getRoutineRunOutputDir(workspaceRef: string, routineId: string, runId: string): Promise<string | null> {
    if (!(await this.workspaceEnabled(workspaceRef))) return null;
    const manifest = await this.readManifest(workspaceRef, routineId);
    if (!manifest) return null;
    const runtime = await this.readRuntimeState(workspaceRef, manifest.id);
    const runs = [
      ...(runtime.lastRun ? [runtime.lastRun] : []),
      ...runtime.runs,
    ];
    const run = runs.find((candidate) => candidate.runId === runId && candidate.routineId === manifest.id);
    if (!run) return null;
    const runsRoot = path.join(this.getRoutineDir(workspaceRef, manifest.id), 'runs');
    const outputDir = path.join(runsRoot, run.runId, 'output');
    return insideRoot(outputDir, runsRoot) ? outputDir : null;
  }

  async getRoutineOutputsDir(workspaceRef: string, routineId: string): Promise<string | null> {
    if (!(await this.workspaceEnabled(workspaceRef))) return null;
    const manifest = await this.readManifest(workspaceRef, routineId);
    if (!manifest) return null;
    const routineDir = this.getRoutineDir(workspaceRef, manifest.id);
    const runsRoot = path.join(routineDir, 'runs');
    await fsp.mkdir(runsRoot, { recursive: true });
    return insideRoot(runsRoot, routineDir) ? runsRoot : null;
  }

  isRunning(workspaceRef: string, routineId: string): boolean {
    const key = this.runningKey(workspaceRef, routineId);
    return this.starting.has(key) || this.running.has(key);
  }

  async ensureWorkspace(workspaceRef: string): Promise<void> {
    const workspacePath = await this.chatService.getWorkspacePath(workspaceRef);
    if (!workspacePath) throw new Error('Workspace not found');
    const root = this.getRoutinesDir(workspaceRef);
    await fsp.mkdir(path.join(root, 'items'), { recursive: true });
    await this.writeAuthoringContract(workspaceRef, workspacePath);
    await this.installWorkspaceInstructions(workspaceRef, workspacePath);
    await this.refreshIndex(workspaceRef);
  }

  async uninstallWorkspaceInstructions(workspaceRef: string): Promise<void> {
    const workspacePath = await this.chatService.getWorkspacePath(workspaceRef);
    if (!workspacePath) throw new Error('Workspace not found');
    const agentsPath = path.join(workspacePath, 'AGENTS.md');
    let current = '';
    try {
      current = await fsp.readFile(agentsPath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const withoutManaged = removeManagedBlock(current).trimEnd();
    const next = withoutManaged ? `${withoutManaged}\n` : '';
    if (next !== current) await atomicWriteFile(agentsPath, next, 'utf8');
  }

  async getSettingsResponse(workspaceRef: string): Promise<RoutineSettingsEnvelope> {
    const settings = await this.readWorkspaceSettings(workspaceRef);
    const globalSettings = await this.chatService.getSettings();
    return {
      enabled: await this.workspaceEnabled(workspaceRef),
      routinesDir: this.getRoutinesDir(workspaceRef),
      authoringPath: this.getAuthoringPath(workspaceRef),
      notification: workspaceRoutineSettingsResponse(settings, globalSettings),
    };
  }

  async updateWorkspaceSettings(workspaceRef: string, settings: WorkspaceRoutineSettings): Promise<WorkspaceRoutineSettingsResponse> {
    const current = await this.readWorkspaceSettings(workspaceRef);
    const next: WorkspaceRoutineSettings = {
      ...current,
      ...sanitizeWorkspaceRoutineSettings(settings),
    };
    if (settings.telegram) {
      next.telegram = {
        ...(current.telegram || {}),
        ...sanitizeWorkspaceRoutineSettings({ telegram: settings.telegram }).telegram,
      };
      if (settings.telegram.botToken === '') delete next.telegram.botToken;
      if (settings.telegram.chatId === '') {
        delete next.telegram.chatId;
        delete next.telegram.chatTitle;
        delete next.telegram.chatType;
      } else if (
        settings.telegram.chatId !== undefined
        && settings.telegram.chatId !== current.telegram?.chatId
        && !settings.telegram.chatTitle
        && !settings.telegram.chatType
      ) {
        delete next.telegram.chatTitle;
        delete next.telegram.chatType;
      }
      if (settings.telegram.chatTitle === '') delete next.telegram.chatTitle;
      if (settings.telegram.chatType === '') delete next.telegram.chatType;
    }
    await this.writeWorkspaceSettings(workspaceRef, next);
    return workspaceRoutineSettingsResponse(next, await this.chatService.getSettings());
  }

  async startTelegramDestinationConnect(workspaceRef: string): Promise<RoutineTelegramDestinationConnectStartResponse> {
    const botToken = await this.getTelegramBotTokenForWorkspace(workspaceRef);
    if (!botToken) return { status: 'missing_bot' };
    const code = `AC-${crypto.randomInt(100000, 1000000)}`;
    const createdAtMs = this.now().getTime();
    const expiresAtMs = createdAtMs + TELEGRAM_CONNECT_TTL_MS;
    this.telegramDestinationConnects.set(this.telegramConnectKey(workspaceRef), {
      workspaceRef,
      code,
      createdAtMs,
      expiresAtMs,
    });
    return {
      status: 'pending',
      code,
      expiresAt: new Date(expiresAtMs).toISOString(),
      instruction: `/connect ${code}`,
    };
  }

  async pollTelegramDestinationConnect(workspaceRef: string): Promise<RoutineTelegramDestinationConnectPollResponse> {
    const key = this.telegramConnectKey(workspaceRef);
    const session = this.telegramDestinationConnects.get(key);
    if (!session || this.now().getTime() > session.expiresAtMs) {
      if (session) this.telegramDestinationConnects.delete(key);
      return { status: 'expired' };
    }
    const botToken = await this.getTelegramBotTokenForWorkspace(session.workspaceRef);
    if (!botToken) return { status: 'missing_bot' };
    const updates = await fetchTelegramUpdates(botToken, session.updateOffset);
    let maxUpdateId = session.updateOffset ? session.updateOffset - 1 : -1;
    for (const update of updates) {
      if (typeof update.update_id === 'number') maxUpdateId = Math.max(maxUpdateId, update.update_id);
      const destination = telegramDestinationFromUpdate(update, session.code, session.createdAtMs);
      if (!destination) continue;
      await this.updateWorkspaceSettings(session.workspaceRef, {
        telegram: {
          enabled: true,
          chatId: destination.chatId,
          ...(destination.chatTitle ? { chatTitle: destination.chatTitle } : {}),
          ...(destination.chatType ? { chatType: destination.chatType } : {}),
        },
      });
      this.telegramDestinationConnects.delete(key);
      return {
        status: 'connected',
        destination,
        settings: await this.getSettingsResponse(session.workspaceRef),
      };
    }
    if (maxUpdateId >= 0) session.updateOffset = maxUpdateId + 1;
    return {
      status: 'pending',
      code: session.code,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    };
  }

  async listRoutines(workspaceRef: string): Promise<RoutineListItem[]> {
    if (!(await this.workspaceEnabled(workspaceRef))) return [];
    await this.ensureWorkspace(workspaceRef);
    const itemsDir = this.getItemsDir(workspaceRef);
    let dirs: string[];
    try {
      dirs = await fsp.readdir(itemsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const routines: RoutineListItem[] = [];
    for (const dirName of dirs) {
      if (dirName.startsWith('.')) continue;
      const routineDir = path.join(itemsDir, dirName);
      const manifest = await this.readManifestFromDir(routineDir).catch((err: unknown) => {
        log.warn('Skipping invalid routine manifest', { workspaceRef, routineDir, error: err });
        return null;
      });
      if (!manifest) continue;
      const runtime = await this.readRuntimeState(workspaceRef, manifest.id);
      routines.push({
        manifest,
        state: manifest.state,
        routinePath: path.join(routineDir, manifest.routineFile),
        routineDir,
        lastRun: runtime.lastRun,
        running: this.isRunning(workspaceRef, manifest.id),
      });
    }
    routines.sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));
    await this.writeIndex(workspaceRef, routines);
    return routines;
  }

  async getRoutine(workspaceRef: string, routineId: string): Promise<(RoutineListItem & { routineContent: string; runs: RoutineRunRecord[] }) | null> {
    if (!(await this.workspaceEnabled(workspaceRef))) return null;
    await this.ensureWorkspace(workspaceRef);
    const manifest = await this.readManifest(workspaceRef, routineId);
    if (!manifest) return null;
    const routineDir = this.getRoutineDir(workspaceRef, manifest.id);
    const routinePath = path.join(routineDir, manifest.routineFile);
    const runtime = await this.readRuntimeState(workspaceRef, manifest.id);
    let routineContent = '';
    try {
      routineContent = await fsp.readFile(routinePath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return {
      manifest,
      state: manifest.state,
      routinePath,
      routineDir,
      lastRun: runtime.lastRun,
      running: this.isRunning(workspaceRef, manifest.id),
      routineContent,
      runs: runtime.runs,
    };
  }

  async installRoutine(workspaceRef: string, routineId: string, state: 'enabled' | 'disabled'): Promise<RoutineListItem | null> {
    if (!(await this.workspaceEnabled(workspaceRef))) return null;
    const manifest = await this.readManifest(workspaceRef, routineId);
    if (!manifest) return null;
    const next = { ...manifest, state };
    await this.writeManifest(workspaceRef, next);
    await this.refreshIndex(workspaceRef);
    return (await this.getRoutine(workspaceRef, routineId));
  }

  async updateRoutine(
    workspaceRef: string,
    routineId: string,
    patch: { manifest?: Partial<RoutineManifest>; routineContent?: string },
  ): Promise<RoutineListItem | null> {
    if (!(await this.workspaceEnabled(workspaceRef))) return null;
    const current = await this.readManifest(workspaceRef, routineId);
    if (!current) return null;
    const next = validateRoutineManifest({
      ...current,
      ...(patch.manifest || {}),
      id: current.id,
      kind: 'agent-cockpit.routine',
      schemaVersion: 1,
      routineFile: current.routineFile,
    });
    await this.writeManifest(workspaceRef, next);
    if (patch.routineContent !== undefined) {
      await this.writeRoutineContent(workspaceRef, current.id, current.routineFile, patch.routineContent);
    }
    await this.refreshIndex(workspaceRef);
    return (await this.getRoutine(workspaceRef, routineId));
  }

  async deleteRoutine(workspaceRef: string, routineId: string): Promise<boolean> {
    if (!(await this.workspaceEnabled(workspaceRef))) return false;
    const manifest = await this.readManifest(workspaceRef, routineId);
    if (!manifest) return false;
    if (this.isRunning(workspaceRef, manifest.id)) {
      throw new Error('Routine run is running. Stop or wait before deleting this routine.');
    }
    await fsp.rm(this.getRoutineDir(workspaceRef, manifest.id), { recursive: true, force: true });
    await this.refreshIndex(workspaceRef);
    return true;
  }

  async validateProposalMarker(workspaceRef: string, marker: string): Promise<RoutineProposalMarkerResult | null> {
    if (!(await this.workspaceEnabled(workspaceRef))) return null;
    await this.ensureWorkspace(workspaceRef);
    if (!path.isAbsolute(marker)) return null;
    const markerPath = path.resolve(marker);
    const root = path.resolve(this.getItemsDir(workspaceRef));
    if (!insideRoot(markerPath, root) || path.basename(markerPath) !== 'manifest.json') return null;
    const manifest = await this.readManifestPath(markerPath).catch((err: unknown) => {
      log.warn('Invalid routine proposal manifest', { workspaceRef, markerPath, error: err });
      return null;
    });
    if (!manifest) return null;
    const routineDir = path.dirname(markerPath);
    const routinePath = path.resolve(routineDir, manifest.routineFile);
    if (!insideRoot(routinePath, routineDir)) throw new Error('Routine file escapes routine folder');
    await fsp.access(routinePath);
    await this.refreshIndex(workspaceRef);
    return { routineId: manifest.id, manifest, manifestPath: markerPath };
  }

  async validateProposalMarkers(workspaceRef: string, content: unknown): Promise<RoutineProposalMarkerResult[]> {
    const markers = extractRoutineProposalMarkers(content);
    const out: RoutineProposalMarkerResult[] = [];
    for (const marker of markers) {
      const result = await this.validateProposalMarker(workspaceRef, marker).catch((err: unknown) => {
        log.warn('Invalid routine proposal marker', { workspaceRef, marker, error: err });
        return null;
      });
      if (result) out.push(result);
    }
    return out;
  }

  async runRoutine(workspaceRef: string, routineId: string, opts: RoutineRunOptions): Promise<RoutineRunRecord | null> {
    if (!(await this.workspaceEnabled(workspaceRef))) return null;
    const key = this.runningKey(workspaceRef, routineId);
    if (this.starting.has(key) || this.running.has(key)) {
      throw new Error('Routine run already running');
    }
    this.starting.add(key);
    let manifest: RoutineManifest | null = null;
    let run: RoutineRunRecord | null = null;
    try {
      await this.ensureWorkspace(workspaceRef);
      manifest = await this.readManifest(workspaceRef, routineId);
      if (!manifest) return null;
      if (manifest.state === 'proposed') return null;
      if (manifest.state !== 'enabled' && opts.source === 'scheduled') return null;

      const workspacePath = await this.chatService.getWorkspacePath(workspaceRef);
      if (!workspacePath) throw new Error('Workspace not found');
      const runId = newRunId(this.now());
      const routineDir = this.getRoutineDir(workspaceRef, manifest.id);
      const runDir = path.join(routineDir, 'runs', runId);
      const outputDir = path.join(runDir, 'output');
      const tmpDir = path.join(runDir, 'tmp');
      const persistentStateDir = this.getRoutinePersistentStateDir(workspaceRef, manifest.id);
      await fsp.mkdir(outputDir, { recursive: true });
      await fsp.mkdir(tmpDir, { recursive: true });
      await fsp.mkdir(persistentStateDir, { recursive: true });

      const startedAt = this.now().toISOString();
      run = {
        runId,
        routineId: manifest.id,
        source: opts.source,
        status: 'running',
        startedAt,
        inputPath: path.join(runDir, 'input.md'),
        outputDir,
        tmpDir,
      };
      this.running.set(key, run);
      this.starting.delete(key);
      await this.pushRun(workspaceRef, manifest.id, run);
      const routinePath = path.join(routineDir, manifest.routineFile);
      const input = await this.buildRunEnvelope(workspaceRef, manifest, {
        workspacePath,
        routineDir,
        routinePath,
        runDir,
        outputDir,
        tmpDir,
        persistentStateDir,
      });
      await fsp.writeFile(run.inputPath, input, 'utf8');
      const runtime = await this.resolveRuntime(manifest);
      const adapter = this.backendRegistry?.get(runtime.backendId);
      if (!adapter) throw new Error(`Unknown backend: ${runtime.backendId}`);
      const timeoutMs = Math.max(1, manifest.timeoutMinutes || DEFAULT_RUN_TIMEOUT_MINUTES) * 60_000;
      const runOptions: RunOneShotOptions = {
        model: manifest.harness?.model,
        effort: manifest.harness?.effort,
        timeoutMs,
        workingDir: workspacePath,
        allowTools: true,
        cliProfile: runtime.profile,
      };
      const output = await adapter.runOneShot(input, runOptions);
      run.completedAt = this.now().toISOString();
      run.status = 'completed';
      run.finalPath = path.join(runDir, 'final.md');
      await fsp.writeFile(run.finalPath, String(output || '').trim() + '\n', 'utf8');
      await this.maybeSendNotification(workspaceRef, manifest, run, runDir);
      await this.pushRun(workspaceRef, manifest.id, run);
      await this.pruneRuns(workspaceRef, manifest);
      return run;
    } catch (err: unknown) {
      if (run && manifest) {
        run.completedAt = this.now().toISOString();
        run.status = 'failed';
        run.errorMessage = (err as Error).message || String(err);
        await this.pushRun(workspaceRef, manifest.id, run);
      }
      throw err;
    } finally {
      this.starting.delete(key);
      this.running.delete(key);
    }
  }

  async runDueScheduledRoutines(workspaceRefs?: string[]): Promise<number> {
    const refs = workspaceRefs || await this.listWorkspaceRefsForScheduler();
    let started = 0;
    for (const ref of refs) {
      const routines = await this.listRoutines(ref).catch((err: unknown) => {
        log.warn('Routine scheduler failed to list workspace routines', { workspaceRef: ref, error: err });
        return [];
      });
      for (const item of routines) {
        if (item.manifest.state !== 'enabled') continue;
        if (item.manifest.trigger.type !== 'schedule') continue;
        if (!this.isScheduleDue(item.manifest, item.lastRun)) continue;
        started += 1;
        void this.runRoutine(ref, item.manifest.id, { source: 'scheduled' }).catch((err: unknown) => {
          log.warn('Scheduled routine run failed', { workspaceRef: ref, routineId: item.manifest.id, error: err });
        });
      }
    }
    return started;
  }

  private async resolveRuntime(manifest: RoutineManifest): Promise<CliProfileRuntime> {
    if (!this.chatService.resolveCliProfileRuntime) throw new Error('CLI profile runtime resolution is unavailable');
    return this.chatService.resolveCliProfileRuntime(manifest.harness?.cliProfileId || null, null);
  }

  private async workspaceEnabled(workspaceRef: string): Promise<boolean> {
    return this.chatService.getWorkspaceRoutinesEnabled(workspaceRef);
  }

  private async buildRunEnvelope(
    workspaceRef: string,
    manifest: RoutineManifest,
    paths: {
      workspacePath: string;
      routineDir: string;
      routinePath: string;
      runDir: string;
      outputDir: string;
      tmpDir: string;
      persistentStateDir: string;
    },
  ): Promise<string> {
    const contextEnabled = await this.chatService.getWorkspaceContextEnabled(workspaceRef);
    const kbEnabled = await this.chatService.getWorkspaceKbEnabled(workspaceRef);
    const contextDir = this.chatService.getWorkspaceContextDir(workspaceRef);
    const kbDir = this.chatService.getKbKnowledgeDir(workspaceRef);
    return [
      '# Agent Cockpit Routine Execution',
      '',
      `Routine: ${manifest.title}`,
      `Routine ID: ${manifest.id}`,
      `Routine file: ${paths.routinePath}`,
      `Workspace path: ${paths.workspacePath}`,
      `Run folder: ${paths.runDir}`,
      `Output folder: ${paths.outputDir}`,
      `Temporary folder: ${paths.tmpDir}`,
      `Persistent state folder: ${paths.persistentStateDir}`,
      `Previous runs folder: ${path.join(paths.routineDir, 'runs')}`,
      `Notification file: ${path.join(paths.runDir, 'notify.md')}`,
      '',
      '## Workspace Resources',
      '',
      contextEnabled
        ? `- Workspace Context instruction: ${path.join(contextDir, 'WORKSPACE_CONTEXT.md')}`
        : '- Workspace Context: disabled',
      kbEnabled
        ? `- Knowledge Base folder: ${kbDir}`
        : '- Knowledge Base: disabled',
      '',
      '## Execution Contract',
      '',
      '- Read the routine markdown file before doing the work.',
      '- Use the output folder for durable artifacts from this run.',
      '- Use the temporary folder for scratch files that can be pruned.',
      '- Use the persistent state folder for cross-run routine state.',
      '- If the user should be notified, write a concise Markdown message to notify.md in the run folder.',
      '- If no user notification is needed, do not create notify.md.',
      '- Do not create `.agent-cockpit` or other hidden Agent Cockpit metadata folders in the workspace unless the user explicitly asks for workspace-visible output.',
      '- Do not enable, disable, delete, or reschedule routines from inside a run.',
      '',
      '## Routine Markdown',
      '',
      await fsp.readFile(paths.routinePath, 'utf8'),
      '',
    ].join('\n');
  }

  private async maybeSendNotification(
    workspaceRef: string,
    manifest: RoutineManifest,
    run: RoutineRunRecord,
    runDir: string,
  ): Promise<void> {
    if ((manifest.notification?.mode || 'workspaceDefault') === 'off') return;
    const notifyPath = path.join(runDir, 'notify.md');
    let content = '';
    try {
      content = (await fsp.readFile(notifyPath, 'utf8')).trim();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (!content) return;
    run.notifyPath = notifyPath;
    const settings = await this.readWorkspaceSettings(workspaceRef);
    const globalSettings = await this.chatService.getSettings();
    const globalBotToken = globalSettings.integrations?.telegram?.botToken;
    const telegramSettings: WorkspaceRoutineSettings = {
      ...settings,
      telegram: settings.telegram
        ? {
            ...settings.telegram,
            botToken: settings.telegram.botToken || globalBotToken,
          }
        : undefined,
    };
    if (!telegramSettings.telegram?.enabled || !telegramSettings.telegram.botToken || !telegramSettings.telegram.chatId) return;
    try {
      await this.notifier.sendTelegram(telegramSettings, content);
      run.notificationSentAt = this.now().toISOString();
    } catch (err: unknown) {
      run.notificationError = (err as Error).message || String(err);
      log.warn('Routine Telegram notification failed', { workspaceRef, routineId: manifest.id, runId: run.runId, error: err });
    }
  }

  private isScheduleDue(manifest: RoutineManifest, lastRun?: RoutineRunRecord): boolean {
    if (manifest.trigger.type !== 'schedule') return false;
    if (!isNowInScheduleWindow(this.now(), manifest.trigger)) return false;
    const last = Date.parse(lastRun?.startedAt || '');
    if (!Number.isFinite(last)) return true;
    return this.now().getTime() - last >= manifest.trigger.intervalMinutes * 60_000;
  }

  private async readManifest(workspaceRef: string, routineId: string): Promise<RoutineManifest | null> {
    const manifestPath = path.join(this.getRoutineDir(workspaceRef, routineId), 'manifest.json');
    try {
      return await this.readManifestPath(manifestPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async readManifestFromDir(routineDir: string): Promise<RoutineManifest> {
    return this.readManifestPath(path.join(routineDir, 'manifest.json'));
  }

  private async readManifestPath(manifestPath: string): Promise<RoutineManifest> {
    const routineDir = path.dirname(manifestPath);
    const routineDirStat = await fsp.lstat(routineDir);
    if (!routineDirStat.isDirectory() || routineDirStat.isSymbolicLink()) {
      throw new Error('Routine manifest folder must be a real directory');
    }
    const manifest = validateRoutineManifest(JSON.parse(await fsp.readFile(manifestPath, 'utf8')));
    if (path.basename(routineDir) !== manifest.id) {
      throw new Error('Routine manifest id must match its folder name');
    }
    return manifest;
  }

  private async writeManifest(workspaceRef: string, manifest: RoutineManifest): Promise<void> {
    const routineDir = this.getRoutineDir(workspaceRef, manifest.id);
    await fsp.mkdir(routineDir, { recursive: true });
    await atomicWriteFile(path.join(routineDir, 'manifest.json'), JSON.stringify(validateRoutineManifest(manifest), null, 2) + '\n');
  }

  private async writeRoutineContent(workspaceRef: string, routineId: string, routineFile: string, content: string): Promise<void> {
    const routineDir = this.getRoutineDir(workspaceRef, routineId);
    const target = path.resolve(routineDir, routineFile);
    if (!insideRoot(target, path.resolve(routineDir))) throw new Error('Routine file escapes routine folder');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteFile(target, content || '', 'utf8');
  }

  private async readRuntimeState(workspaceRef: string, routineId: string): Promise<RoutineRuntimeState> {
    const statePath = path.join(this.getRoutineDir(workspaceRef, routineId), ROUTINE_STATE_FILENAME);
    try {
      const raw = JSON.parse(await fsp.readFile(statePath, 'utf8')) as Partial<RoutineRuntimeState>;
      const runs = Array.isArray(raw.runs) ? raw.runs.map(normalizeRun).filter((run): run is RoutineRunRecord => !!run) : [];
      const lastRun = normalizeRun(raw.lastRun) || runs[0];
      return { version: ROUTINE_STATE_VERSION, ...(lastRun ? { lastRun } : {}), runs };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Failed to read routine state', { workspaceRef, routineId, error: err });
      }
      return { version: ROUTINE_STATE_VERSION, runs: [] };
    }
  }

  private async pushRun(workspaceRef: string, routineId: string, run: RoutineRunRecord): Promise<void> {
    const state = await this.readRuntimeState(workspaceRef, routineId);
    const runs = [run, ...state.runs.filter((existing) => existing.runId !== run.runId)]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, MAX_RUN_HISTORY);
    await atomicWriteFile(
      path.join(this.getRoutineDir(workspaceRef, routineId), ROUTINE_STATE_FILENAME),
      JSON.stringify({ version: ROUTINE_STATE_VERSION, lastRun: runs[0], runs }, null, 2) + '\n',
    );
  }

  private async pruneRuns(workspaceRef: string, manifest: RoutineManifest): Promise<void> {
    const retentionMs = (manifest.outputRetentionDays || DEFAULT_OUTPUT_RETENTION_DAYS) * 24 * 60 * 60_000;
    const runsRoot = path.join(this.getRoutineDir(workspaceRef, manifest.id), 'runs');
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(runsRoot, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const cutoff = this.now().getTime() - retentionMs;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stat = await fsp.stat(path.join(runsRoot, entry.name));
      if (stat.mtimeMs < cutoff) {
        await fsp.rm(path.join(runsRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  private async refreshIndex(workspaceRef: string): Promise<void> {
    const items = await this.listRoutinesWithoutIndexWrite(workspaceRef);
    await this.writeIndex(workspaceRef, items);
  }

  private async listRoutinesWithoutIndexWrite(workspaceRef: string): Promise<RoutineListItem[]> {
    const itemsDir = this.getItemsDir(workspaceRef);
    let dirs: string[];
    try {
      dirs = await fsp.readdir(itemsDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const routines: RoutineListItem[] = [];
    for (const dirName of dirs) {
      const routineDir = path.join(itemsDir, dirName);
      let manifest: RoutineManifest | null = null;
      try {
        const stat = await fsp.stat(routineDir);
        if (!stat.isDirectory()) continue;
        manifest = await this.readManifestFromDir(routineDir);
      } catch {
        continue;
      }
      const runtime = await this.readRuntimeState(workspaceRef, manifest.id);
      routines.push({
          manifest,
          state: manifest.state,
          routinePath: path.join(routineDir, manifest.routineFile),
          routineDir,
          lastRun: runtime.lastRun,
          running: this.isRunning(workspaceRef, manifest.id),
        });
    }
    return routines.sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));
  }

  private async writeIndex(workspaceRef: string, items: RoutineListItem[]): Promise<void> {
    const payload = {
      schemaVersion: 1,
      updatedAt: this.now().toISOString(),
      routines: items.map((item) => ({
        id: item.manifest.id,
        title: item.manifest.title,
        description: item.manifest.description || '',
        state: item.manifest.state,
        trigger: item.manifest.trigger,
        routineDir: item.routineDir,
        manifestPath: path.join(item.routineDir, 'manifest.json'),
        routinePath: item.routinePath,
        lastRun: item.lastRun || null,
      })),
    };
    await fsp.mkdir(this.getRoutinesDir(workspaceRef), { recursive: true });
    await atomicWriteFile(path.join(this.getRoutinesDir(workspaceRef), ROUTINE_INDEX_FILENAME), JSON.stringify(payload, null, 2) + '\n');
  }

  private async readWorkspaceSettings(workspaceRef: string): Promise<WorkspaceRoutineSettings> {
    try {
      return sanitizeWorkspaceRoutineSettings(JSON.parse(await fsp.readFile(path.join(this.getRoutinesDir(workspaceRef), ROUTINE_SETTINGS_FILENAME), 'utf8')));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Failed to read routine settings', { workspaceRef, error: err });
      }
      return {};
    }
  }

  private async writeWorkspaceSettings(workspaceRef: string, settings: WorkspaceRoutineSettings): Promise<void> {
    await fsp.mkdir(this.getRoutinesDir(workspaceRef), { recursive: true });
    await atomicWriteFile(path.join(this.getRoutinesDir(workspaceRef), ROUTINE_SETTINGS_FILENAME), JSON.stringify(sanitizeWorkspaceRoutineSettings(settings), null, 2) + '\n');
  }

  private async writeAuthoringContract(workspaceRef: string, workspacePath: string): Promise<void> {
    const root = this.getRoutinesDir(workspaceRef);
    await fsp.mkdir(root, { recursive: true });
    await writeFileIfChanged(this.getAuthoringPath(workspaceRef), buildRoutineAuthoringContract({
      workspacePath,
      routinesDir: root,
      itemsDir: this.getItemsDir(workspaceRef),
      authoringPath: this.getAuthoringPath(workspaceRef),
    }));
  }

  private async installWorkspaceInstructions(workspaceRef: string, workspacePath: string): Promise<void> {
    const agentsPath = path.join(workspacePath, 'AGENTS.md');
    const block = [
      ROUTINE_MANAGED_BLOCK_START,
      '## Agent Cockpit Routines',
      '',
      'This workspace can define Agent Cockpit Routines: workspace-owned markdown workflows that Agent Cockpit can run manually or on a schedule through the selected CLI harness.',
      `Routine authoring contract: \`${this.getAuthoringPath(workspaceRef)}\``,
      `Routine index: \`${path.join(this.getRoutinesDir(workspaceRef), ROUTINE_INDEX_FILENAME)}\``,
      `Routine items folder: \`${this.getItemsDir(workspaceRef)}\``,
      '',
      'When the user explicitly asks to create or edit an Agent Cockpit routine, read the authoring contract first, then create or update the routine files in the routines folder. Do not enable, disable, schedule, or delete routines yourself.',
      ROUTINE_MANAGED_BLOCK_END,
    ].join('\n');
    let current = '';
    try {
      current = await fsp.readFile(agentsPath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const withoutManaged = removeManagedBlock(current).trimEnd();
    const next = withoutManaged ? `${withoutManaged}\n\n${block}\n` : `# AGENTS.md\n\n${block}\n`;
    if (next !== current) await atomicWriteFile(agentsPath, next, 'utf8');
  }

  private async listWorkspaceRefsForScheduler(): Promise<string[]> {
    if (this.chatService.listRoutinesEnabledWorkspaceHashes) {
      return this.chatService.listRoutinesEnabledWorkspaceHashes();
    }
    if (this.chatService.listWorkspaces) {
      const workspaces = await this.chatService.listWorkspaces({ includeArchived: false });
      return workspaces.filter((workspace) => !workspace.archived).map((workspace) => workspace.workspaceId);
    }
    let dirs: string[];
    try {
      dirs = await fsp.readdir(this.chatService.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return dirs.filter((dir) => !dir.startsWith('.'));
  }

  private runningKey(workspaceRef: string, routineId: string): string {
    return `${this.chatService.getWorkspaceIdForRef?.(workspaceRef) || workspaceRef}:${normalizeRoutineIdForPath(routineId)}`;
  }

  private telegramConnectKey(workspaceRef: string): string {
    return this.chatService.getWorkspaceIdForRef?.(workspaceRef) || workspaceRef;
  }

  private async getGlobalTelegramBotToken(): Promise<string> {
    return (await this.chatService.getSettings()).integrations?.telegram?.botToken?.trim() || '';
  }

  private async getTelegramBotTokenForWorkspace(workspaceRef: string): Promise<string> {
    const settings = await this.readWorkspaceSettings(workspaceRef);
    return settings.telegram?.botToken?.trim() || (await this.getGlobalTelegramBotToken());
  }
}

export interface RoutinesSchedulerOptions {
  service: RoutinesService;
  intervalMs?: number;
  logger?: Pick<typeof log, 'warn'>;
}

export class RoutinesScheduler {
  private readonly service: RoutinesService;
  private readonly intervalMs: number;
  private readonly logger: Pick<typeof log, 'warn'>;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: RoutinesSchedulerOptions) {
    this.service = opts.service;
    this.intervalMs = Math.max(1000, opts.intervalMs || 60_000);
    this.logger = opts.logger || log;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.logger.warn('Routines scheduler tick failed', { error: err });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    return this.service.runDueScheduledRoutines();
  }
}

export class TelegramRoutineNotifier implements RoutineNotifier {
  async sendTelegram(settings: WorkspaceRoutineSettings, content: string): Promise<void> {
    const token = settings.telegram?.botToken;
    const chatId = settings.telegram?.chatId;
    if (!token || !chatId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEGRAM_SEND_TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          chat_id: chatId,
          text: content.slice(0, 3900),
          disable_web_page_preview: false,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram send failed (${res.status}): ${body.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

interface TelegramUpdateRecord {
  update_id?: unknown;
  message?: unknown;
  channel_post?: unknown;
}

async function fetchTelegramUpdates(token: string, offset?: number): Promise<TelegramUpdateRecord[]> {
  const params = new URLSearchParams({
    timeout: '0',
    allowed_updates: JSON.stringify(['message', 'channel_post']),
  });
  if (offset !== undefined) params.set('offset', String(offset));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_CONNECT_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?${params.toString()}`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram destination lookup failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const body = await res.json().catch(() => null) as { ok?: unknown; result?: unknown; description?: unknown } | null;
    if (!body || body.ok !== true) {
      const description = typeof body?.description === 'string' ? body.description : 'unknown response';
      throw new Error(`Telegram destination lookup failed: ${description}`);
    }
    return Array.isArray(body.result) ? body.result.filter(isRecord) : [];
  } finally {
    clearTimeout(timer);
  }
}

function telegramDestinationFromUpdate(update: TelegramUpdateRecord, code: string, createdAtMs: number): TelegramDestinationSummary | null {
  const message = isRecord(update.message) ? update.message : isRecord(update.channel_post) ? update.channel_post : null;
  if (!message) return null;
  const text = typeof message.text === 'string'
    ? message.text
    : typeof message.caption === 'string'
      ? message.caption
      : '';
  if (!text.toUpperCase().includes(code.toUpperCase())) return null;
  const dateMs = typeof message.date === 'number' ? message.date * 1000 : 0;
  if (dateMs && dateMs < createdAtMs - TELEGRAM_CONNECT_MESSAGE_SKEW_MS) return null;
  const chat = isRecord(message.chat) ? message.chat : null;
  if (!chat) return null;
  const chatId = typeof chat.id === 'number' || typeof chat.id === 'string' ? String(chat.id) : '';
  if (!chatId) return null;
  const chatTitle = telegramChatTitle(chat);
  const chatType = typeof chat.type === 'string' ? chat.type : '';
  return {
    chatId,
    ...(chatTitle ? { chatTitle } : {}),
    ...(chatType ? { chatType } : {}),
  };
}

function telegramChatTitle(chat: Record<string, unknown>): string {
  if (typeof chat.title === 'string' && chat.title.trim()) return chat.title.trim();
  if (typeof chat.username === 'string' && chat.username.trim()) return `@${chat.username.trim().replace(/^@/, '')}`;
  const first = typeof chat.first_name === 'string' ? chat.first_name.trim() : '';
  const last = typeof chat.last_name === 'string' ? chat.last_name.trim() : '';
  return [first, last].filter(Boolean).join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildRoutineAuthoringContract(opts: {
  workspacePath: string;
  routinesDir: string;
  itemsDir: string;
  authoringPath: string;
}): string {
  return [
    '# Agent Cockpit Routine Authoring',
    '',
    'A Routine is a workspace-owned markdown workflow that Agent Cockpit can run through a selected CLI harness manually or on a schedule.',
    '',
    `Workspace path: ${opts.workspacePath}`,
    `Routines folder: ${opts.routinesDir}`,
    `Routine items folder: ${opts.itemsDir}`,
    `Authoring contract: ${opts.authoringPath}`,
    '',
    '## When To Create Or Edit',
    '',
    '- Create or edit a routine only when the user explicitly asks for an Agent Cockpit routine.',
    '- Routines belong to the workspace, not to the current conversation.',
    '- Do not enable, disable, delete, or schedule routines yourself. Agent Cockpit handles those actions through the UI.',
    '- Do not create `.agent-cockpit` or other hidden Agent Cockpit metadata folders in the workspace unless the user explicitly asks for workspace-visible output.',
    '- Do not hardcode persistent output paths under the workspace. Routine runs receive output, temporary, and persistent state folders in the execution prompt.',
    '',
    '## New Routine Proposal',
    '',
    'Create a folder under `items/` using a stable lowercase id:',
    '',
    '```text',
    'items/<routine-id>/',
    '  manifest.json',
    '  routine.md',
    '```',
    '',
    'The manifest must match this shape:',
    '',
    '```json',
    JSON.stringify({
      schemaVersion: 1,
      kind: 'agent-cockpit.routine',
      id: 'example-routine',
      title: 'Example Routine',
      description: 'What this routine does.',
      routineFile: 'routine.md',
      state: 'proposed',
      trigger: {
        type: 'schedule',
        timezone: 'America/Los_Angeles',
        weekdaysOnly: true,
        windowStart: '06:30',
        windowEnd: '18:30',
        intervalMinutes: 30,
      },
      harness: {
        cliProfileId: null,
        model: null,
        effort: null,
      },
      notification: {
        mode: 'workspaceDefault',
      },
      outputRetentionDays: 14,
      timeoutMinutes: 10,
    }, null, 2),
    '```',
    '',
    'After creating the files, end your final answer with this marker on its own line:',
    '',
    '```md',
    '<!-- AGENT_COCKPIT_ROUTINE_PROPOSAL:v1:/absolute/path/to/items/<routine-id>/manifest.json -->',
    '```',
    '',
    '## Runtime Storage',
    '',
    'Each routine execution prompt provides:',
    '',
    '- the workspace path for reading or editing user-requested workspace files;',
    '- a per-run output folder for artifacts from that run;',
    '- a per-run temporary folder for scratch files;',
    '- a persistent state folder under Agent Cockpit data for cross-run routine state;',
    '- a notification file path for user-facing routine notifications.',
    '',
    'If the routine needs durable state between runs, write it under the persistent state folder provided at run time. Do not create `.agent-cockpit`, `.routine-state`, or similar metadata folders inside the workspace root unless the user explicitly asks for files to appear in the workspace.',
    '',
    '## Routine Markdown',
    '',
    'The `routine.md` file is the workflow intelligence. Write clear task instructions, gates, output requirements, and safety boundaries. Refer to the runtime-provided output, temporary, persistent state, and notification paths by purpose rather than hardcoding workspace metadata paths. Agent Cockpit does not parse domain-specific logic from this file; the harness does.',
    '',
  ].join('\n');
}

function normalizeRun(value: unknown): RoutineRunRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<RoutineRunRecord>;
  if (!record.runId || !record.routineId || !record.startedAt || !record.status || !record.source) return null;
  if (record.status !== 'running' && record.status !== 'completed' && record.status !== 'failed' && record.status !== 'stopped') return null;
  if (record.source !== 'manual' && record.source !== 'scheduled') return null;
  return {
    runId: String(record.runId),
    routineId: String(record.routineId),
    source: record.source,
    status: record.status,
    startedAt: String(record.startedAt),
    inputPath: String(record.inputPath || ''),
    outputDir: String(record.outputDir || ''),
    tmpDir: String(record.tmpDir || ''),
    ...(record.completedAt ? { completedAt: String(record.completedAt) } : {}),
    ...(record.finalPath ? { finalPath: String(record.finalPath) } : {}),
    ...(record.notifyPath ? { notifyPath: String(record.notifyPath) } : {}),
    ...(record.errorMessage ? { errorMessage: String(record.errorMessage) } : {}),
    ...(record.notificationSentAt ? { notificationSentAt: String(record.notificationSentAt) } : {}),
    ...(record.notificationError ? { notificationError: String(record.notificationError) } : {}),
  };
}

function newRunId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeRoutineIdForPath(value: string): string {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!normalized) throw new Error('Routine id is required');
  return normalized;
}

function insideRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function removeManagedBlock(content: string): string {
  const start = content.indexOf(ROUTINE_MANAGED_BLOCK_START);
  const end = content.indexOf(ROUTINE_MANAGED_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return content;
  return `${content.slice(0, start)}${content.slice(end + ROUTINE_MANAGED_BLOCK_END.length)}`;
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if (await fsp.readFile(filePath, 'utf8') === content) return;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await atomicWriteFile(filePath, content, 'utf8');
}

function isNowInScheduleWindow(now: Date, trigger: Exclude<RoutineManifest['trigger'], { type: 'manual' }>): boolean {
  const parts = localParts(now, trigger.timezone);
  if (trigger.weekdaysOnly && (parts.weekday === 6 || parts.weekday === 7)) return false;
  if (!trigger.windowStart || !trigger.windowEnd) return true;
  const current = parts.hour * 60 + parts.minute;
  const start = minutesOfDay(trigger.windowStart);
  const end = minutesOfDay(trigger.windowEnd);
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function localParts(now: Date, timezone?: string): { weekday: number; hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
    const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return {
      weekday: weekdayMap[get('weekday')] || now.getDay() || 7,
      hour: Number(get('hour')) % 24,
      minute: Number(get('minute')) || 0,
    };
  } catch {
    const day = now.getDay();
    return { weekday: day === 0 ? 7 : day, hour: now.getHours(), minute: now.getMinutes() };
  }
}

function minutesOfDay(value: string): number {
  const [hour, minute] = value.split(':').map((part) => Number(part));
  return hour * 60 + minute;
}
