import type {
  BackendMetadata,
  SendMessageOptions,
  SendMessageResult,
  Message,
} from '../../types';

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

  sendMessage(_message: string, _options?: SendMessageOptions): SendMessageResult {
    throw new Error('BaseBackendAdapter.sendMessage must be implemented by subclass');
  }

  async generateSummary(
    _messages: Pick<Message, 'role' | 'content'>[],
    _fallback: string,
  ): Promise<string> {
    throw new Error('BaseBackendAdapter.generateSummary must be implemented by subclass');
  }

  async generateTitle(userMessage: string, fallback: string): Promise<string> {
    return fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
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
}
