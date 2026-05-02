import fs from 'fs';
import path from 'path';
import { BaseBackendAdapter, type RunOneShotOptions } from '../../src/services/backends/base';
import type { BackendMetadata, SendMessageOptions, SendMessageResult, StreamEvent, Message } from '../../src/types';

/** In-memory backend adapter used by chat router and streaming tests. */
export class MockBackendAdapter extends BaseBackendAdapter {
  _lastMessage: string | null;
  _lastOptions: SendMessageOptions | null;
  _mockEvents: StreamEvent[];
  _sendInputCalls: string[];
  _mockTitle?: string;
  _streamDelayMs: number = 0;
  _mockMemoryDir: string | null = null;
  _oneShotImpl: ((prompt: string, opts?: RunOneShotOptions) => Promise<string>) | null = null;
  _oneShotCalls: Array<{ prompt: string; options?: RunOneShotOptions }> = [];

  constructor() {
    super({ workingDir: '/tmp' });
    this._lastMessage = null;
    this._lastOptions = null;
    this._mockEvents = [];
    this._sendInputCalls = [];
  }

  get metadata(): BackendMetadata {
    return {
      id: 'claude-code',
      label: 'Claude Code',
      icon: null,
      capabilities: { thinking: true, planMode: true, agents: true, toolActivity: true, userQuestions: true, stdinInput: true },
      resumeCapabilities: {
        activeTurnResume: 'unsupported',
        activeTurnResumeReason: 'Mock backend does not model reattaching to an in-flight turn.',
        sessionResume: 'supported',
        sessionResumeReason: 'Mock backend can reuse the cockpit session id for follow-up test turns.',
      },
      models: [
        { id: 'opus', label: 'Opus', family: 'opus', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
        { id: 'sonnet', label: 'Sonnet', family: 'sonnet', default: true, supportedEffortLevels: ['low', 'medium', 'high'] },
        { id: 'haiku', label: 'Haiku', family: 'haiku' },
      ],
    };
  }

  setMockEvents(events: StreamEvent[]) {
    this._mockEvents = events;
  }

  /** Configure a delay (in ms) inserted before each event yielded by the stream.
      Used by tests that need the watcher to stay alive long enough to detect a
      file change in the mock memory dir. */
  setStreamDelayMs(ms: number) {
    this._streamDelayMs = ms;
  }

  /** Point the adapter at a real directory acting as the backend's native
      memory dir. Both `getMemoryDir` and `extractMemory` honor this. */
  setMockMemoryDir(dir: string | null) {
    this._mockMemoryDir = dir;
  }

  getMemoryDir(_workspacePath: string): string | null {
    return this._mockMemoryDir;
  }

  async extractMemory(_workspacePath: string) {
    if (!this._mockMemoryDir || !fs.existsSync(this._mockMemoryDir)) return null;
    const filenames = fs.readdirSync(this._mockMemoryDir).filter((f) => f.endsWith('.md'));
    return {
      capturedAt: new Date().toISOString(),
      sourceBackend: 'claude-code',
      sourcePath: this._mockMemoryDir,
      index: '',
      files: filenames.map((f) => ({
        filename: f,
        name: null,
        description: null,
        type: 'unknown' as const,
        content: fs.readFileSync(path.join(this._mockMemoryDir!, f), 'utf8'),
      })),
    };
  }

  sendMessage(message: string, options?: SendMessageOptions): SendMessageResult {
    this._lastMessage = message;
    this._lastOptions = options || null;
    const events = this._mockEvents.slice();
    const delayMs = this._streamDelayMs;
    const self = this;

    async function* createStream() {
      for (const event of events) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        yield event;
      }
    }

    return {
      stream: createStream(),
      abort: () => {},
      sendInput: (text: string) => { self._sendInputCalls.push(text); },
    };
  }

  async generateSummary(messages: Pick<Message, 'role' | 'content'>[], fallback: string) {
    return fallback || `Session (${messages.length} messages)`;
  }

  async generateTitle(userMessage: string, fallback: string) {
    return this._mockTitle || fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
  }

  /** Inject a runOneShot handler. The default (null) makes runOneShot throw,
      matching BaseBackendAdapter behavior so callers see a clean failure. */
  setOneShotImpl(impl: ((prompt: string, opts?: RunOneShotOptions) => Promise<string>) | null) {
    this._oneShotImpl = impl;
  }

  async runOneShot(prompt: string, options?: RunOneShotOptions): Promise<string> {
    this._oneShotCalls.push({ prompt, options });
    if (!this._oneShotImpl) {
      throw new Error('MockBackendAdapter.runOneShot: no impl set');
    }
    return this._oneShotImpl(prompt, options);
  }
}
