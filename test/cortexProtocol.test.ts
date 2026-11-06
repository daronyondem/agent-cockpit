import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { CortexAcpClient, CortexRpcError, type CortexRpcMessage } from '../src/services/backends/cortexProtocol';

function fixture(maxBytes?: number) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const cleanup = jest.fn(async () => {});
  const client = new CortexAcpClient(child as unknown as ChildProcess, cleanup, maxBytes);
  const writes: CortexRpcMessage[] = [];
  child.stdin.on('data', chunk => writes.push(JSON.parse(chunk.toString())));
  const send = (frame: object) => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  return { child, client, cleanup, writes, send };
}

test('split UTF-8, blank lines, CRLF and multiple large frames decode correctly', async () => {
  const f = fixture();
  const seen: CortexRpcMessage[] = [];
  f.client.subscribe(frame => { seen.push(frame); });
  const text = '🌨️'.repeat(50_000);
  const bytes = Buffer.from('\n' + JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { text } }) + '\r\n'
    + JSON.stringify({ jsonrpc: '2.0', method: 'other' }) + '\n');
  for (let i = 0; i < bytes.length; i += 137) f.child.stdout.write(bytes.subarray(i, i + 137));
  expect(seen).toHaveLength(2);
  expect(seen[0].params?.text).toBe(text);
  await f.client.close();
});

test.each([0, 1, '1', 'native-question'])('reverse ID %p has independent correlation and exactly one owner', async id => {
  const f = fixture();
  const result = f.client.request('session/prompt');
  f.client.subscribe(frame => {
    expect(frame.id).toBe(id);
    expect(f.client.respond(id, { outcome: 'cancelled' })).toBe(true);
    expect(f.client.respond(id, {})).toBe(false);
    return true;
  });
  const other = jest.fn();
  f.client.subscribe(other);
  f.send({ id, method: 'session/request_permission' });
  f.send({ id: '1', result: 'wrong namespace' });
  f.send({ id: 1, result: 'correct' });
  expect(await result).toBe('correct');
  expect(other).not.toHaveBeenCalled();
  expect(f.writes[1]).toEqual({ jsonrpc: '2.0', id, result: { outcome: 'cancelled' } });
  await f.client.close();
});

test('unclaimed reverse requests are rejected even with a notification subscriber', async () => {
  const f = fixture();
  const unsubscribe = f.client.subscribe(() => {});
  f.send({ id: 0, method: 'terminal/create' });
  expect(f.writes[0]).toMatchObject({ id: 0, error: { code: -32601 } });
  unsubscribe();
  f.send({ id: 'next', method: 'fs/read_text_file' });
  expect(f.writes[1]).toMatchObject({ id: 'next', error: { code: -32601 } });
  await f.client.close();
});

test.each(['secret-non-json', '[]', '{}', '{"jsonrpc":"1.0","method":"x"}',
  '{"jsonrpc":"2.0","id":null,"result":0}', '{"jsonrpc":"2.0","id":1,"result":0,"error":{}}',
  '{"jsonrpc":"2.0","method":"x","params":[]}', '{"jsonrpc":"2.0","id":1,"error":{"code":"bad","message":"private"}}',
])('invalid envelope fails closed without echoing input (%#)', async line => {
  const f = fixture();
  const result = f.client.request('session/prompt');
  f.child.stdout.write(line + '\n');
  await expect(result).rejects.toThrow('Malformed Cortex ACP frame');
  await f.client.close();
  expect(f.cleanup).toHaveBeenCalledTimes(1);
});

test.each([true, false])('oversized frame fails closed (terminated=%p)', async terminated => {
  const f = fixture(128);
  f.child.stdout.write('x'.repeat(129) + (terminated ? '\n' : ''));
  expect((await f.client.closed).message).toBe('Cortex ACP frame too large');
  await f.client.close();
});

test('RPC errors preserve code and data for later narrow recovery', async () => {
  const f = fixture();
  const result = f.client.request('session/load');
  f.send({ id: 1, error: { code: -32603, message: 'missing', data: { code: 'FS_NOT_FOUND' } } });
  await expect(result).rejects.toEqual(new CortexRpcError('missing', -32603, { code: 'FS_NOT_FOUND' }));
  expect(f.client.isClosed).toBe(false);
  await f.client.close();
});

test('timeout closes all pending work and ignores late replies; no operation is retried', async () => {
  const f = fixture();
  const slow = f.client.request('slow', {}, 5);
  const other = f.client.request('other');
  const results = await Promise.allSettled([slow, other]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  await expect(f.client.request('next')).rejects.toThrow('timed out');
  f.send({ id: 1, result: 'late' });
  expect(f.writes.map(frame => frame.method)).toEqual(['slow', 'other']);
  await f.client.close();
  expect(f.cleanup).toHaveBeenCalledTimes(1);
});

test.each(['exit', 'spawn-error', 'stdin-error', 'stdout-error', 'stderr-error', 'eof', 'truncated'])('%s terminates pending RPCs and reverse interactions', async failure => {
  const f = fixture();
  const pending = f.client.request('session/prompt');
  f.client.subscribe(() => true);
  f.send({ id: 'unanswered', method: 'question' });
  if (failure === 'exit') f.child.emit('exit', 1);
  else if (failure === 'spawn-error') f.child.emit('error', new Error('private-path'));
  else if (failure === 'eof' || failure === 'truncated') {
    if (failure === 'truncated') f.child.stdout.write('{"private":');
    f.child.stdout.end();
  } else f.child[failure.split('-')[0] as 'stdin' | 'stdout' | 'stderr'].emit('error', new Error('private'));
  await expect(pending).rejects.toThrow(/Cortex ACP/);
  expect(f.client.respond('unanswered', {})).toBe(false);
  await f.client.close();
  expect(f.cleanup).toHaveBeenCalledTimes(1);
});

test('duplicate outstanding reverse ID and listener exceptions fail closed', async () => {
  const f = fixture();
  f.client.subscribe(() => true);
  f.send({ id: 0, method: 'question' });
  f.send({ id: 0, method: 'question' });
  expect((await f.client.closed).message).toMatch(/Duplicate/);
  await f.client.close();
  const g = fixture();
  g.client.subscribe(() => { throw new Error('private'); });
  g.send({ method: 'update' });
  expect((await g.client.closed).message).toBe('Cortex ACP listener failed');
  await g.client.close();
});

test('diagnostics expose only counts and a login hint, never stderr content', async () => {
  const f = fixture();
  const secret = 'open browser https://private.example/oauth?code=secret';
  f.child.stderr.write(secret.slice(0, 25));
  f.child.stderr.write(secret.slice(25));
  expect(f.client.diagnostics).toEqual({ stderrBytes: Buffer.byteLength(secret), loginPromptSeen: true });
  expect(JSON.stringify(f.client.diagnostics)).not.toContain('secret');
  await f.client.close();
});
