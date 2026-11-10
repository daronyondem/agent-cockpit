import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import type { CortexRpcMessage } from '../../src/types';
import { CortexAcpClient, cortexRecord } from '../../src/services/backends/cortexProtocol';
import { CortexRuntime } from '../../src/services/backends/cortexRuntime';

export function cortexWire(name: string): CortexRpcMessage[] {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/cortex/1.2.35', `${name}.json`), 'utf8')).frames
    .filter((item: { direction: string }) => item.direction === 'in').map((item: { frame: CortexRpcMessage }) => item.frame);
}

export function cortexFixture(cwd = process.cwd()) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const client = new CortexAcpClient(child as unknown as ChildProcess, async () => {});
  const runtime = new CortexRuntime(client, '1.2.35', { agentCapabilities: { promptCapabilities: { image: true } } },
    { command: 'fixture', args: [], env: {}, cwd, fingerprint: 'fixture' });
  runtime.sessionId = 'fixture-session';
  runtime.configOptions = structuredClone(cortexRecord(cortexWire('session-config')[1].result).configOptions) as unknown[];
  const writes: CortexRpcMessage[] = [];
  const send = (frame: CortexRpcMessage) => child.stdout.write(`${JSON.stringify(frame)}\n`);
  const notification = (update: object, sessionId = runtime.sessionId) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  let handler: ((message: CortexRpcMessage) => void) | undefined;
  child.stdin.on('data', chunk => {
    const message = JSON.parse(chunk.toString()) as CortexRpcMessage;
    writes.push(message);
    if (message.method === 'session/set_config_option') {
      const configOptions = runtime.configOptions.map(item => {
        const row = cortexRecord(item);
        return row.id === message.params?.configId ? { ...row, currentValue: message.params?.value } : row;
      });
      send({ jsonrpc: '2.0', id: message.id, result: { configOptions } });
    } else handler?.(message);
  });
  return { child, client, runtime, writes, send, notification, onRequest: (callback: typeof handler) => { handler = callback; } };
}
