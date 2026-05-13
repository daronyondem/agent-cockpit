import type {
  BackendMetadata,
  McpServerConfig,
  SendMessageOptions,
  SendMessageResult,
  Message,
  MemorySnapshot,
  EffortLevel,
  ServiceTier,
  CliProfile,
  ThreadGoal,
} from '../../types';

export interface BackendCallOptions {
  /** Full CLI profile for adapters that support profile-isolated runtimes. */
  cliProfile?: CliProfile;
}

export interface RunOneShotOptions {
  /** Optional model override; backends ignore if unsupported. */
  model?: string;
  /** Optional reasoning effort; backends ignore if unsupported. */
  effort?: EffortLevel;
  /** Optional backend service tier override; backends ignore if unsupported. */
  serviceTier?: ServiceTier;
  /** Hard timeout in ms (default: 60s). */
  timeoutMs?: number;
  /** Optional cancellation signal for caller-owned one-shot work. */
  abortSignal?: AbortSignal;
  /** Working directory for the spawned CLI. */
  workingDir?: string | null;
  /**
   * Grant the CLI unrestricted tool access (bypass permissions mode).
   * Used by the Digestion and Dreaming orchestrators so the CLI can
   * read every file under the workspace KB directory without prompting.
   * Default `false` — memory prompts continue to run in the safe
   * no-tool path. Individual backends map this to their own flag (e.g.
   * `--permission-mode bypassPermissions` for Claude Code).
   */
  allowTools?: boolean;
  /**
   * MCP servers to expose to the CLI for this one-shot call.
   * Used by the Dreaming orchestrator to provide KB search tools.
   * Backends that don't support MCP in one-shot mode ignore this.
   */
  mcpServers?: McpServerConfig[];
  /** Full CLI profile for adapters that support profile-isolated runtimes. */
  cliProfile?: CliProfile;
}

/**
 * Base adapter class for CLI backends.
 *
 * Every backend (Claude Code, Kiro, etc.) must extend this class and
 * implement the three members below.  The rest of the system interacts
 * with backends exclusively through this interface.
 */
export class BaseBackendAdapter {
  workingDir: string | null;

  constructor(options: { workingDir?: string } = {}) {
    this.workingDir = options.workingDir || null;
  }

  get metadata(): BackendMetadata {
    throw new Error('BaseBackendAdapter.metadata must be implemented by subclass');
  }

  async getMetadata(_options?: BackendCallOptions): Promise<BackendMetadata> {
    return this.metadata;
  }

  sendMessage(_message: string, _options?: SendMessageOptions): SendMessageResult {
    throw new Error('BaseBackendAdapter.sendMessage must be implemented by subclass');
  }

  async getGoal(_options: SendMessageOptions): Promise<ThreadGoal | null> {
    throw new Error(`${this.constructor.name}.getGoal is not implemented`);
  }

  setGoalObjective(_objective: string, _options?: SendMessageOptions): SendMessageResult {
    throw new Error(`${this.constructor.name}.setGoalObjective is not implemented`);
  }

  resumeGoal(_options?: SendMessageOptions): SendMessageResult {
    throw new Error(`${this.constructor.name}.resumeGoal is not implemented`);
  }

  async pauseGoal(_options: SendMessageOptions): Promise<ThreadGoal | null> {
    throw new Error(`${this.constructor.name}.pauseGoal is not implemented`);
  }

  async clearGoal(_options: SendMessageOptions): Promise<{ cleared: boolean; threadId?: string | null; sessionId?: string | null }> {
    throw new Error(`${this.constructor.name}.clearGoal is not implemented`);
  }

  async generateSummary(
    _messages: Pick<Message, 'role' | 'content'>[],
    _fallback: string,
    _options?: BackendCallOptions,
  ): Promise<string> {
    throw new Error('BaseBackendAdapter.generateSummary must be implemented by subclass');
  }

  async generateTitle(userMessage: string, fallback: string, _options?: BackendCallOptions): Promise<string> {
    return fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
  }

  /**
   * Invoke the backend CLI in one-shot mode with a single prompt, collect
   * its full text output, and return it as a plain string.  Used by the
   * Memory MCP server to run the configured Memory CLI against a prompt
   * template without going through the streaming session machinery.
   *
   * Default implementation throws.  Subclasses that can be used as a
   * Memory CLI must override this.
   */
  async runOneShot(_prompt: string, _options?: RunOneShotOptions): Promise<string> {
    throw new Error(`${this.constructor.name}.runOneShot is not implemented`);
  }

  /**
   * Invoke the backend in a short sequential one-shot session. Used by KB
   * gleaning so the second prompt can ask about missed material immediately
   * after the initial extraction. Backends that can preserve an ephemeral
   * session across prompts should override this. The base implementation
   * replays prior prompts/responses into later one-shot calls, which is more
   * expensive than a native session but keeps the feature functional for
   * one-shot-only adapters.
   */
  async runSessionShot(prompts: string[], options?: RunOneShotOptions): Promise<string[]> {
    const outputs: string[] = [];
    const transcript: string[] = [];
    for (let i = 0; i < prompts.length; i += 1) {
      const prompt = prompts[i];
      const contextualPrompt = transcript.length === 0
        ? prompt
        : `${transcript.join('\n\n')}\n\n## Next Prompt\n${prompt}`;
      const output = await this.runOneShot(contextualPrompt, options);
      outputs.push(output);
      transcript.push(`## Prompt ${i + 1}\n${prompt}\n\n## Response ${i + 1}\n${output}`);
    }
    return outputs;
  }

  /**
   * Called during server shutdown.  Subclasses that spawn long-lived
   * processes should override this to kill them.
   */
  shutdown(): void {
    // no-op by default
  }

  /**
   * Called when a user resets a session for a conversation.  Subclasses
   * that cache per-conversation state (e.g. process handles, session
   * mappings) should override this to clean up.
   */
  onSessionReset(_conversationId: string): void {
    // no-op by default
  }

  /**
   * Extract the backend's native memory for a given workspace path.
   * Returns `null` when the backend has no memory system, or when
   * no memory exists for this workspace.  Called by ChatService on
   * session reset to persist memory at the workspace level.
   */
  async extractMemory(_workspacePath: string, _options?: BackendCallOptions): Promise<MemorySnapshot | null> {
    return null;
  }

  /**
   * Resolve the absolute path to the backend's native memory directory
   * for a given workspace, without reading its contents.  Used by the
   * real-time memory watcher to know which directory to watch.
   *
   * Returns `null` when the backend has no memory system, or when no
   * memory directory exists yet for this workspace.  Subclasses that
   * implement `extractMemory` should also implement this so the watcher
   * can track their memory live.
   */
  getMemoryDir(_workspacePath: string, _options?: BackendCallOptions): string | null {
    return null;
  }
}
