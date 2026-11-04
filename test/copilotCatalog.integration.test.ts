import fs from 'fs';
import os from 'os';
import path from 'path';
import { CopilotAdapter } from '../src/services/backends/copilot';
import * as copilotRuntime from '../src/services/backends/copilotRuntime';
import type { CliProfile, SendMessageOptions, StreamEvent } from '../src/types';
import { waitForCopilotPeer, writeCopilotSdkPeer } from './helpers/copilotSdkPeer';

async function collect(stream: AsyncGenerator<StreamEvent>, events: StreamEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
}

describe('Copilot catalog gates through the official SDK and executable RPC peer', () => {
  let dir: string;
  let peer: ReturnType<typeof writeCopilotSdkPeer>;
  let adapter: CopilotAdapter;
  let profile: CliProfile;
  const resolveRuntime = copilotRuntime.resolveCopilotCliRuntime;
  const options = (extra: Partial<SendMessageOptions> = {}): SendMessageOptions => ({ sessionId: 's', conversationId: 'c',
    isNewSession: true, workingDir: dir, systemPrompt: '', cliProfile: profile, ...extra });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-catalog-integration-'));
    peer = writeCopilotSdkPeer(dir);
    profile = { ...peer.profile(), command: 'copilot' };
    // Keep production transport selection while resolving the default executable
    // to a strict peer rather than the developer's authenticated installation.
    jest.spyOn(copilotRuntime, 'resolveCopilotCliRuntime').mockImplementation(selected => resolveRuntime({ ...selected!, command: peer.command }));
    adapter = new CopilotAdapter({ workingDir: dir });
  });
  afterEach(async () => { await adapter.shutdown(); jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('shares the profile-scoped discovery result with turns and restricted JSONL one-shots, including new models and max effort', async () => {
    profile.env!.COPILOT_FIXTURE_MODELS = JSON.stringify([{ id: 'account-model', name: 'Account model',
      capabilities: { supports: { reasoningEffort: true, vision: true } }, supportedReasoningEfforts: ['low', 'max'] }]);
    const metadata = await adapter.getMetadata({ cliProfile: profile });
    expect(adapter.metadata.capabilities).toMatchObject({ userQuestions: false, stdinInput: false });
    expect(metadata.capabilities).toMatchObject({ userQuestions: true, stdinInput: true });
    expect(metadata.modelCatalog?.source).toBe('runtime');
    expect(metadata.models?.find(model => model.id === 'account-model')).toMatchObject({ supportedEffortLevels: ['low', 'max'], capabilities: { input: { image: false, pdf: false } } });
    const frames = await collect(adapter.sendMessage('hello', options({ model: 'account-model', effort: 'max' })).stream);
    expect(frames.some(frame => frame.type === 'error')).toBe(false);
    expect(peer.calls().find(call => call.method === 'session.create')?.params).toMatchObject({ model: 'account-model', reasoningEffort: 'max' });
    expect(await adapter.runOneShot('restricted', { cliProfile: profile, model: 'account-model', effort: 'max' })).toBe('jsonl:restricted');
    expect(peer.calls().filter(call => call.method === 'models.list')).toHaveLength(1);
    expect(peer.calls().find(call => call.method === 'spawn' && call.args?.includes('-p'))?.args)
      .toEqual(expect.arrayContaining(['--model', 'account-model', '--reasoning-effort', 'max', '--available-tools', 'none']));
    await adapter.getMetadata({ cliProfile: profile, refreshModels: true });
    expect(peer.calls().filter(call => call.method === 'models.list')).toHaveLength(2);
    expect((await adapter.getMetadata({ cliProfile: { ...profile, command: peer.command } })).capabilities)
      .toMatchObject({ userQuestions: false, stdinInput: false });
  }, 15000);

  test.each([
    [{ model: 'retired' }, 'unavailable'],
    [{ model: 'gpt-6.1-sol', effort: 'medium' as const }, 'does not support effort'],
  ])('rejects invalid selection %j before native session creation or prompt submission', async (selection, error) => {
    const frames = await collect(adapter.sendMessage('must not execute', options(selection)).stream);
    expect(frames).toContainEqual({ type: 'error', error: expect.stringContaining(error) });
    expect(peer.calls().filter(call => ['session.create', 'session.resume', 'session.send'].includes(call.method))).toEqual([]);
    expect(frames.at(-1)).toEqual({ type: 'done' });
  }, 15000);

  test('gates media even for direct one-shot callers and explicit previously verified models', async () => {
    profile.env!.COPILOT_FIXTURE_MODELS = JSON.stringify([{ id: 'gpt-6.1-sol', name: 'Sol', capabilities: { supports: { reasoningEffort: false, vision: false } } }]);
    await expect(adapter.runOneShot('read', { cliProfile: profile, model: 'gpt-6.1-sol', attachments: [{ kind: 'image', path: '/fixture.png' }] })).rejects.toThrow('does not report image input');
    await expect(adapter.runOneShot('read', { cliProfile: profile, model: 'retired' })).rejects.toThrow('unavailable');
    expect(peer.calls().filter(call => call.method === 'spawn' && call.args?.includes('-p'))).toEqual([]);
  }, 15000);

  test('Stop drains discovery before session creation and reusable shutdown prevents delayed one-shot launch', async () => {
    profile.env!.COPILOT_FIXTURE_CATALOG = 'hang';
    const turn = adapter.sendMessage('must not submit', options());
    const reading = collect(turn.stream);
    await waitForCopilotPeer(() => peer.calls().some(call => call.method === 'models.list'));
    turn.abort();
    await reading;
    expect(peer.calls().some(call => call.method === 'session.send')).toBe(false);
    const shot = adapter.runOneShot('must not launch', { cliProfile: profile });
    const rejected = expect(shot).rejects.toThrow(/abort/i);
    await waitForCopilotPeer(() => peer.calls().filter(call => call.method === 'models.list').length === 2);
    await adapter.shutdown();
    await rejected;
    expect(peer.calls().some(call => call.method === 'spawn' && call.args?.includes('-p'))).toBe(false);
    delete profile.env!.COPILOT_FIXTURE_CATALOG;
    const frames = await collect(adapter.sendMessage('works after update', options()).stream);
    expect(frames.some(frame => frame.type === 'error')).toBe(false);
  }, 15000);
});
