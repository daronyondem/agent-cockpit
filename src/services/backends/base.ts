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
}
