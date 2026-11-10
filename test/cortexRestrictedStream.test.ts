import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { CortexRestrictedStream } from '../src/services/backends/cortexRestrictedStream';

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const stop = jest.fn().mockResolvedValue(undefined);
  const stream = new CortexRestrictedStream(child as unknown as ChildProcess, stop);
  const send = (row: object) => child.stdout.write(JSON.stringify({ session_id: 'fixture', ...row }) + '\n');
  const init = () => send({ type: 'system', subtype: 'init', tools: [], skills: [], plugins: [], mcp_servers: [], slash_commands: [] });
  const result = (extra = {}) => send({ type: 'result', uuid: 'result-a', subtype: 'success', is_error: false, num_turns: 1, result: 'ANSWER', permission_denials: [],
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...extra });
  return { child, stop, stream, send, init, result };
}
test.each(['tools', 'skills', 'plugins', 'mcp_servers', 'slash_commands'])('nonempty %s catalog rejects before any prompt', async key => {
  const f = fixture(); f.send({ type: 'system', subtype: 'init', tools: [], skills: [], plugins: [], mcp_servers: [], slash_commands: [], [key]: ['forbidden'] });
  await expect(f.stream.ready).rejects.toThrow('tool-free protocol'); await f.stream.close();
  expect(f.child.stdin.read()).toBeNull(); expect(f.stop).toHaveBeenCalledTimes(1);
});
test('literal UTF-8 replies, one owner, exact session and distinct result ownership', async () => {
  const f = fixture(); f.init(); await f.stream.ready;
  const first = f.stream.request('/sh never'); await Promise.resolve();
  expect(JSON.parse(String(f.child.stdin.read())).message.content[0].text).toContain('"/sh never"');
  await expect(f.stream.request('overlap')).rejects.toThrow('already active');
  const line = Buffer.from(JSON.stringify({ type: 'assistant', session_id: 'fixture', message: { content: [{ type: 'text', text: 'é' }] } }) + '\n');
  for (const byte of line) f.child.stdout.write(Buffer.from([byte]));
  f.send({ type: 'system', subtype: 'context_usage' }); f.result(); expect(await first).toBe('ANSWER');
  const next = f.stream.request('next'); await Promise.resolve(); f.result();
  await expect(next).rejects.toThrow('tool-free protocol'); await f.stream.close();
});
test.each([
  { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
  { type: 'control_request', request: { subtype: 'can_use_tool' } },
  { type: 'result', session_id: 'wrong' },
  { type: 'system', subtype: 'init' },
])('unexpected native frame fails closed: %j', async row => {
  const f = fixture(); f.init(); const pending = f.stream.request('text'); await Promise.resolve(); f.send(row);
  await expect(pending).rejects.toThrow('tool-free protocol'); await f.stream.close(); expect(f.stop).toHaveBeenCalledTimes(1);
});
test('a same-batch tool frame after a completed result still rejects its caller', async () => {
  const f = fixture(); f.init(); const pending = f.stream.request('text'); await Promise.resolve();
  f.result(); f.send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'read' }] } });
  await expect(pending).rejects.toThrow('tool-free protocol'); await f.stream.close();
});
test.each([{ usage: {} }, { num_turns: 2 }, { permission_denials: ['read'] }, { is_error: true }, { uuid: null }])('incomplete or denied result fails: %j', async extra => {
  const f = fixture(); f.init(); const pending = f.stream.request('text'); await Promise.resolve(); f.result(extra);
  await expect(pending).rejects.toThrow('tool-free protocol'); await f.stream.close();
});
test('startup exit, malformed/oversized frames and cleanup failures cannot report success', async () => {
  const gone = fixture(); gone.child.emit('exit', 1); await expect(gone.stream.ready).rejects.toThrow('exited'); await gone.stream.close();
  const malformed = fixture(); malformed.child.stdout.write('invalid\n'); await expect(malformed.stream.ready).rejects.toThrow('tool-free protocol'); await malformed.stream.close();
  const large = fixture(); large.child.stdout.write(Buffer.alloc(32 * 1024 * 1024 + 1, 65)); await expect(large.stream.ready).rejects.toThrow('limit'); await large.stream.close();
  const failed = fixture(); failed.stop.mockRejectedValue(new Error('cleanup failed')); const close = failed.stream.close(); expect(failed.stream.close()).toBe(close);
  await expect(close).rejects.toThrow('cleanup failed'); await expect(failed.stream.request('late')).rejects.toThrow('stopped');
});
