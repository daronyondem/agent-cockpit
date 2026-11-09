import type { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { cortexRecord } from './cortexProtocol';
import { CortexInputError } from './cortexErrors';
import { cortexRestrictedPrompt } from './cortexRestrictedPolicy';

/** CoCo's native headless JSONL protocol; never ACP or a permission broker. */
export class CortexRestrictedStream {
  readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private pending?: { resolve: (value: string) => void; reject: (error: Error) => void };
  private sessionId?: string;
  private failure?: Error;
  private closing?: Promise<void>;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private results = new Set<string>();

  constructor(private child: ChildProcess, private stop: () => Promise<void>) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => {});
    child.stdout?.on('data', (data: Buffer) => this.read(data));
    child.stdout?.on('end', () => { void this.close(new CortexInputError('Cortex restricted output ended before shutdown.')); });
    child.on('error', () => { void this.close(new CortexInputError('Cortex restricted process failed.')); });
    child.on('exit', () => { void this.close(new CortexInputError('Cortex restricted process exited.')); });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => { void this.close(new CortexInputError('Cortex restricted pipe failed.')); });
    }
    // Drain diagnostic bytes without exposing native account/auth/error text.
    child.stderr?.resume();
  }

  async request(text: string): Promise<string> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending) throw new CortexInputError('Cortex restricted prompt is already active.');
    const result = new Promise<string>((resolve, reject) => { this.pending = { resolve, reject }; });
    try {
      if (!this.child.stdin?.writable) throw new Error();
      this.child.stdin.write(JSON.stringify({ type: 'user', session_id: this.sessionId,
        message: { role: 'user', content: [{ type: 'text', text: cortexRestrictedPrompt(text) }] } }) + '\n', error => {
        if (error) void this.close(new CortexInputError('Cortex restricted input failed.'));
      });
    } catch { void this.close(new CortexInputError('Cortex restricted input failed.')); }
    const output = await result;
    if (this.failure) throw this.failure;
    return output;
  }

  close(error = new CortexInputError('Cortex restricted process stopped.')): Promise<void> {
    if (this.closing) return this.closing;
    this.failure = error;
    this.readyReject(error); this.pending?.reject(error); this.pending = undefined;
    this.buffer = '';
    this.closing = Promise.resolve().then(this.stop);
    void this.closing.catch(() => {});
    return this.closing;
  }

  private read(data: Buffer): void {
    if (this.failure) return;
    this.buffer += this.decoder.write(data);
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw new Error();
        this.frame(cortexRecord(JSON.parse(line)));
      } catch { void this.close(new CortexInputError('Cortex restricted output violated its tool-free protocol.')); return; }
      if (this.failure) return;
    }
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) void this.close(new CortexInputError('Cortex restricted frame exceeded its limit.'));
  }

  private frame(row: Record<string, unknown>): void {
    if (row.type === 'system' && row.subtype === 'init') {
      if (this.sessionId || typeof row.session_id !== 'string' || !row.session_id) throw new Error();
      for (const key of ['tools', 'skills', 'plugins', 'mcp_servers', 'slash_commands']) {
        if (!Array.isArray(row[key]) || row[key].length) throw new Error();
      }
      this.sessionId = row.session_id; this.readyResolve(); return;
    }
    if (!this.sessionId || row.session_id !== this.sessionId || !this.pending) throw new Error();
    if (row.type === 'system' && row.subtype === 'context_usage') return;
    if (row.type === 'assistant') {
      const content = cortexRecord(row.message).content;
      if (!Array.isArray(content) || content.some(block => !['text', 'thinking'].includes(String(cortexRecord(block).type)))) throw new Error();
      return;
    }
    if (row.type !== 'result' || row.subtype !== 'success' || row.is_error !== false || row.num_turns !== 1
      || typeof row.uuid !== 'string' || !row.uuid || this.results.has(row.uuid)
      || typeof row.result !== 'string' || !Array.isArray(row.permission_denials) || row.permission_denials.length) throw new Error();
    const usage = cortexRecord(row.usage);
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      if (typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || usage[key] < 0) throw new Error();
    }
    this.results.add(row.uuid);
    const pending = this.pending; this.pending = undefined; pending.resolve(row.result.trim());
  }
}
