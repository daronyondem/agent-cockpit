import { spawn, type ChildProcess } from 'child_process';
import type { CliProfile, McpServerConfig, ServiceTier } from '../../types';
import { logger } from '../../utils/logger';
import { buildCliCommandInvocation } from '../cliCommandResolver';
import { CodexAppServerClient } from './codexProtocol';
import {
  CODEX_APP_SERVER_ARGS,
  CODEX_CLIENT_CAPABILITIES,
  CODEX_IDLE_TIMEOUT_MS,
  buildCodexConfigArgs,
  buildCodexServiceTierArgs,
  codexServiceTierKey,
  hashMcpServers,
  resolveCodexCliRuntime,
} from './codexRuntime';

export interface CodexProcessEntry {
  proc: ChildProcess;
  client: CodexAppServerClient;
  initialized: boolean;
  threadId: string | null;
  idleTimer: NodeJS.Timeout | null;
  /** Hash of the mcpServers list this process was spawned with, or '' if none. */
  mcpHash: string;
  /** Hash of the Codex command/config/env profile used to spawn this process. */
  profileKey: string;
  /** Service tier override used to spawn this process, or '' for profile default. */
  serviceTierKey: string;
  /**
   * Last `total.totalTokens` we emitted a usage event for. Codex re-emits a
   * `thread/tokenUsage/updated` notification at every turn boundary that
   * mirrors the prior turn's final state - `last_token_usage` and
   * `total_token_usage` are byte-for-byte identical to the previous event.
   * Without filtering, the cockpit's `+=` aggregator double-counts one turn's
   * worth of tokens at every transition. Tracking the last emitted total per
   * app-server process (which is per-conversation) lets us drop these
   * duplicates while preserving genuine per-API-call updates within a turn.
   */
  lastTotalTokens: number;
}

const codexProcessLog = logger.child({ module: 'codex-process' });

export class CodexAppServerProcessManager {
  private processes: Map<string, CodexProcessEntry> = new Map();

  entry(conversationId: string): CodexProcessEntry | undefined {
    return this.processes.get(conversationId);
  }

  shutdown(): void {
    for (const [, entry] of this.processes) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.proc.kill('SIGTERM');
    }
    this.processes.clear();
  }

  killConversation(conversationId: string): void {
    const entry = this.processes.get(conversationId);
    if (entry) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.proc.kill('SIGTERM');
      this.processes.delete(conversationId);
    }
  }

  resetIdle(conversationId: string): void {
    const entry = this.processes.get(conversationId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      codexProcessLog.info('Idle timeout for conversation, killing app-server', { conversationId });
      entry.proc.kill('SIGTERM');
      this.processes.delete(conversationId);
    }, CODEX_IDLE_TIMEOUT_MS);
  }

  async getOrSpawn(
    conversationId: string,
    mcpServers: McpServerConfig[] = [],
    profile?: CliProfile,
    options: { reuseExistingMcp?: boolean; serviceTier?: ServiceTier } = {},
  ): Promise<CodexAppServerClient> {
    const runtime = resolveCodexCliRuntime(profile);
    const mcpHash = hashMcpServers(mcpServers);
    const serviceTierKey = codexServiceTierKey(options.serviceTier);
    const existing = this.processes.get(conversationId);
    if (
      existing
      && !existing.proc.killed
      && existing.proc.exitCode === null
      && (options.reuseExistingMcp || existing.mcpHash === mcpHash)
      && existing.profileKey === runtime.profileKey
      && existing.serviceTierKey === serviceTierKey
    ) {
      this.resetIdle(conversationId);
      return existing.client;
    }

    if (existing) {
      if (existing.mcpHash !== mcpHash) {
        codexProcessLog.info('MCP set changed, respawning app-server', { conversationId });
      }
      if (existing.profileKey !== runtime.profileKey) {
        codexProcessLog.info('CLI profile changed, respawning app-server', { conversationId });
      }
      if (existing.serviceTierKey !== serviceTierKey) {
        codexProcessLog.info('Service tier changed, respawning app-server', { conversationId });
      }
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.proc.kill('SIGTERM');
      this.processes.delete(conversationId);
    }

    const configArgs = await buildCodexConfigArgs(mcpServers, runtime);
    const serviceTierArgs = buildCodexServiceTierArgs(options.serviceTier);
    if (serviceTierArgs.length > 0) {
      codexProcessLog.info('Forcing Fast mode for conversation', { conversationId });
    }
    if (configArgs.length > 0) {
      codexProcessLog.info('Injecting MCP servers via config args for conversation', {
        conversationId,
        count: mcpServers.length,
      });
    }

    codexProcessLog.info('Spawning codex app-server for conversation', { conversationId });
    const invocation = buildCliCommandInvocation(runtime, [...CODEX_APP_SERVER_ARGS, ...serviceTierArgs, ...configArgs]);
    const proc = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: runtime.env,
    });

    proc.on('error', (err) => {
      codexProcessLog.error('Codex app-server process spawn error', {
        conversationId,
        error: err.message,
      });
    });
    proc.on('close', (code, signal) => {
      codexProcessLog.info('Codex app-server process closed', {
        conversationId,
        code,
        signal,
      });
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      codexProcessLog.error('Codex app-server stderr', {
        conversationId,
        stderr: chunk.toString().substring(0, 500),
      });
    });

    const client = new CodexAppServerClient(proc);

    await client.request('initialize', {
      clientInfo: { name: 'agent-cockpit', title: null, version: '1.0.0' },
      capabilities: CODEX_CLIENT_CAPABILITIES,
    });
    codexProcessLog.info('Codex app-server initialized for conversation', { conversationId });

    this.processes.set(conversationId, {
      proc,
      client,
      initialized: true,
      threadId: null,
      idleTimer: null,
      mcpHash,
      profileKey: runtime.profileKey,
      serviceTierKey,
      lastTotalTokens: 0,
    });
    this.resetIdle(conversationId);

    return client;
  }
}
