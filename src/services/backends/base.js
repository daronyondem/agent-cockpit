/**
 * Base adapter class for CLI backends.
 *
 * Every backend (Claude Code, Kiro, etc.) must extend this class and
 * implement the three members below.  The rest of the system interacts
 * with backends exclusively through this interface.
 */
class BaseBackendAdapter {
  constructor(options = {}) {
    this.workingDir = options.workingDir || null;
  }

  /**
   * Static metadata about this backend.
   * @returns {{ id: string, label: string, icon: string|null, capabilities: object }}
   *
   * capabilities shape:
   *   thinking      – extended thinking / reasoning blocks
   *   planMode      – interactive plan mode with approval
   *   agents        – sub-agent spawning
   *   toolActivity  – tool-use reporting in the stream
   *   userQuestions  – interactive questions during execution
   *   stdinInput    – backend accepts stdin input mid-stream
   */
  get metadata() {
    throw new Error('BaseBackendAdapter.metadata must be implemented by subclass');
  }

  /**
   * Send a message and return a streaming response.
   *
   * @param {string} message  – The user message
   * @param {object} options  – { sessionId, isNewSession, workingDir, systemPrompt }
   * @returns {{ stream: AsyncGenerator, abort: Function, sendInput: Function }}
   *
   * The async generator must yield normalised events:
   *   { type: 'text',          content, streaming? }
   *   { type: 'thinking',      content, streaming? }
   *   { type: 'tool_activity', tool, description, id?, ...flags }
   *   { type: 'turn_boundary' }
   *   { type: 'result',        content }
   *   { type: 'error',         error }
   *   { type: 'done' }
   */
  sendMessage(/* message, options */) {
    throw new Error('BaseBackendAdapter.sendMessage must be implemented by subclass');
  }

  /**
   * Generate a one-line summary for a list of session messages.
   *
   * @param {Array} messages  – Array of { role, content } objects
   * @param {string} fallback – Fallback text if generation fails
   * @returns {Promise<string>}
   */
  async generateSummary(/* messages, fallback */) {
    throw new Error('BaseBackendAdapter.generateSummary must be implemented by subclass');
  }

  /**
   * Generate a short conversation title from the first user message of a new session.
   *
   * @param {string} userMessage – The first user message in the session
   * @param {string} fallback    – Fallback title if generation fails
   * @returns {Promise<string>}
   */
  async generateTitle(userMessage, fallback) {
    return fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
  }
}

module.exports = { BaseBackendAdapter };
