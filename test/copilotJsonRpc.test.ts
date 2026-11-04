import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { StreamMessageReader } from 'vscode-jsonrpc/node';
import { connectCopilotClient } from '../src/services/backends/copilotJsonRpc';
import { writeCopilotSdkPeer } from './helpers/copilotSdkPeer';

test('a partial Copilot frame cannot retain a recurring timer after transport disposal', async () => {
  jest.useFakeTimers();
  const stream = new PassThrough();
  const reader = new StreamMessageReader(stream);
  try {
    await connectCopilotClient({ start: async () => { reader.listen(() => {}); } });
    stream.write('Content-Length: 1000\r\n\r\n{');
    expect(jest.getTimerCount()).toBe(0);
    reader.dispose(); stream.destroy();
    jest.advanceTimersByTime(30000);
    expect(jest.getTimerCount()).toBe(0);
  } finally { reader.dispose(); stream.destroy(); jest.useRealTimers(); }
});

test('other JSON-RPC readers retain their defaults and complete fragmented messages normally', async () => {
  jest.useFakeTimers();
  const stream = new PassThrough();
  const reader = new StreamMessageReader(stream);
  const received = jest.fn();
  try {
    reader.listen(received);
    expect(reader.partialMessageTimeout).toBe(10000);
    stream.write('Content-Length: 8\r\n\r\n{');
    expect(jest.getTimerCount()).toBe(1);
    stream.write('"id":1}');
    await jest.runAllTimersAsync();
    expect(received).toHaveBeenCalledWith({ id: 1 });
    expect(jest.getTimerCount()).toBe(0);
  } finally { reader.dispose(); stream.destroy(); jest.useRealTimers(); }
});

test('the actual SDK process exits naturally after a truncated frame without forced-exit flags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-partial-frame-'));
  try {
    const peer = writeCopilotSdkPeer(dir);
    const script = `
const { CopilotConversations } = require(${JSON.stringify(path.resolve('src/services/backends/copilotConversations.ts'))});
(async()=>{
 const owner=new CopilotConversations();
 try {
  const frames=[];
  for await(const frame of owner.sendMessage('PARTIAL_EXIT',${JSON.stringify({ sessionId: 'partial', isNewSession: true, workingDir: dir, systemPrompt: '', cliProfile: peer.profile() })}).stream)frames.push(frame);
  if(!frames.some(frame=>frame.type==='error')||frames.at(-1)?.type!=='done')throw new Error('Missing terminal frames');
 } finally {await owner.shutdown();}
 process.stdout.write('partial-frame-cleaned');
})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});`;
    expect(execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { cwd: process.cwd(), timeout: 10000, encoding: 'utf8' })).toContain('partial-frame-cleaned');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 15000);
