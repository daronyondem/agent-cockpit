import type { ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import type { CortexRecord, CortexRpcId, CortexRpcMessage } from '../../types';
export type { CortexRecord, CortexRpcId, CortexRpcMessage } from '../../types';

export function cortexRecord(value: unknown): CortexRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CortexRecord : {};
}

export class CortexRpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) { super(message); }
}

function validMessage(value: unknown): value is CortexRpcMessage {
  const frame = cortexRecord(value);
  if (frame.jsonrpc !== '2.0') return false;
  const hasId = Object.hasOwn(frame, 'id');
  if (hasId && !(typeof frame.id === 'string' || typeof frame.id === 'number' && Number.isFinite(frame.id))) return false;
  const result = Object.hasOwn(frame, 'result');
  const error = Object.hasOwn(frame, 'error');
  if (Object.hasOwn(frame, 'method')) {
    return typeof frame.method === 'string' && frame.method.length > 0 && !result && !error
      && (frame.params === undefined || frame.params === cortexRecord(frame.params));
  }
  if (!hasId || result === error) return false;
  if (error) {
    const detail = cortexRecord(frame.error);
    return Number.isInteger(detail.code) && typeof detail.message === 'string';
  }
  return true;
}

/** Dedicated CoCo JSONL transport. No diagnostic text or malformed frame is echoed. */
export class CortexAcpClient {
  readonly closed: Promise<Error>;
  private finishClosed!: (error: Error) => void;
  private failure: Error | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  private reverse = new Set<CortexRpcId>();
  private listeners = new Set<(message: CortexRpcMessage) => boolean | void>();
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private stderrTail = '';
  private stderrBytes = 0;
  private loginPromptSeen = false;

  constructor(readonly process: ChildProcess, private cleanup: () => Promise<void>, private maxFrameBytes = 32 * 1024 * 1024) {
    this.closed = new Promise(resolve => { this.finishClosed = resolve; });
    process.stdout?.on('data', (chunk: Buffer) => this.read(chunk));
    process.stdout?.on('end', () => {
      if (this.failure) return;
      this.buffer += this.decoder.end();
      void this.close(new Error(this.buffer.trim() ? 'Truncated Cortex ACP frame' : 'Cortex ACP stdout ended'));
    });
    process.stdout?.on('close', () => { void this.close(new Error('Cortex ACP stdout closed')); });
    process.stderr?.on('data', (chunk: Buffer) => {
      if (this.failure) return;
      this.stderrBytes += chunk.length;
      const text = this.stderrTail + chunk.toString('utf8');
      if (/https?:\/\/\S+\/(?:oauth|authorize)|paste.*redirect|open.*browser/i.test(text)) this.loginPromptSeen = true;
      this.stderrTail = text.slice(-2048);
    });
    for (const stream of [process.stdin, process.stdout, process.stderr]) {
      stream?.on('error', () => { void this.close(new Error('Cortex ACP pipe failed')); });
    }
    process.on('error', () => { void this.close(new Error('Cortex ACP process failed')); });
    // Do not wait for close: detached children can keep the inherited pipes open.
    process.on('exit', () => { void this.close(new Error('Cortex ACP process exited')); });
  }

  get isClosed(): boolean { return this.failure !== null; }
  get diagnostics(): { stderrBytes: number; loginPromptSeen: boolean } { return { stderrBytes: this.stderrBytes, loginPromptSeen: this.loginPromptSeen }; }

  /** Return true to claim a reverse request, then respond/reject it exactly once. */
  subscribe(listener: (message: CortexRpcMessage) => boolean | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** `timeoutMs` 0 disables the deadline; the caller then owns cancellation. */
  request(method: string, params: CortexRecord = {}, timeoutMs = 45_000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        // A timed-out operation may still be executing tools. Never reuse/retry it.
        void this.close(new Error('Cortex ACP request timed out'));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: CortexRecord): void { this.write({ jsonrpc: '2.0', method, params }); }

  respond(id: CortexRpcId, result: unknown): boolean {
    if (!this.reverse.delete(id) || this.failure) return false;
    this.write({ jsonrpc: '2.0', id, result });
    return true;
  }

  reject(id: CortexRpcId, message = 'No active Cortex interaction'): boolean {
    if (!this.reverse.delete(id) || this.failure) return false;
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message } });
    return true;
  }

  close(error = new Error('Cortex ACP runtime stopped')): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.failure = error;
    this.finishClosed(error);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.reverse.clear();
    this.listeners.clear();
    this.buffer = '';
    this.stderrTail = '';
    this.cleanupPromise = Promise.resolve().then(this.cleanup);
    // Cleanup must be safe even when failure originated in an event callback.
    void this.cleanupPromise.catch(() => {});
    return this.cleanupPromise;
  }

  private write(message: CortexRpcMessage): void {
    if (this.failure) return;
    try {
      if (!this.process.stdin?.writable) throw new Error('Closed input');
      this.process.stdin.write(`${JSON.stringify(message)}\n`, error => {
        if (error) void this.close(new Error('Cortex ACP write failed'));
      });
    } catch { void this.close(new Error('Cortex ACP write failed')); }
  }

  private read(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxFrameBytes) { void this.close(new Error('Cortex ACP frame too large')); return; }
      if (!line.trim()) continue;
      let message: CortexRpcMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!validMessage(parsed)) throw new Error('Invalid envelope');
        message = parsed;
      } catch { void this.close(new Error('Malformed Cortex ACP frame')); return; }
      if (message.method) {
        if (message.id !== undefined) {
          if (this.reverse.has(message.id)) { void this.close(new Error('Duplicate Cortex ACP request ID')); return; }
          this.reverse.add(message.id);
        }
        try {
          let claimed = false;
          for (const listener of this.listeners) {
            if (listener(message) === true && message.id !== undefined) { claimed = true; break; }
          }
          if (message.id !== undefined && !claimed) this.reject(message.id);
        } catch { void this.close(new Error('Cortex ACP listener failed')); return; }
      } else if (typeof message.id === 'number') {
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new CortexRpcError(message.error.message, message.error.code, message.error.data));
        else entry.resolve(message.result);
      }
      if (this.failure) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) void this.close(new Error('Cortex ACP frame too large'));
  }
}
