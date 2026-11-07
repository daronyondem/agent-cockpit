import fs from 'fs/promises';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import type { CliProfile } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { KbIngestionService } from '../src/services/knowledgeBase/ingestion';
import { WorkspaceTaskQueueRegistry } from '../src/services/knowledgeBase/workspaceTaskQueue';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('CoCo KB conversion through the real process adapter', () => {
  let env: ChatRouterEnv;
  let adapter: CortexCodeAdapter;
  let ingestion: KbIngestionService;
  let workspaceId: string;
  let trace: string;
  let bytes: Buffer;
  beforeEach(async () => {
    env = await createChatRouterEnv({ configureDefaultCli: false });
    const command = path.join(env.tmpDir, 'cortex');
    await fs.copyFile(path.join(__dirname, 'fixtures/cortex/chat-acp.cjs'), command); await fs.chmod(command, 0o700);
    trace = path.join(env.tmpDir, 'trace.jsonl');
    const profile: CliProfile = { id: 'cortex-kb', name: 'KB fixture', harness: 'cortex-code', authMode: 'account', command,
      cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '',
      env: { CORTEX_FIXTURE_STATE: path.join(env.tmpDir, 'state.json'), CORTEX_FIXTURE_TRACE: trace } };
    adapter = new CortexCodeAdapter({ workingDir: env.tmpDir }); env.backendRegistry.register(adapter);
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [profile], defaultCliProfileId: profile.id,
      knowledgeBase: { ingestionCliProfileId: profile.id, ingestionCliModel: 'claude-sonnet-4-6', ingestionCliEffort: 'low' } });
    workspaceId = (await env.chatService.createConversation('KB seed', env.tmpDir, 'cortex-code', undefined, undefined, profile.id)).workspaceId;
    await env.chatService.setWorkspaceKbEnabled(workspaceId, true);
    ingestion = new KbIngestionService({ chatService: env.chatService, backendRegistry: env.backendRegistry, queueRegistry: new WorkspaceTaskQueueRegistry() });
    bytes = createCanvas(480, 320).toBuffer('image/jpeg');
  });
  afterEach(async () => {
    adapter.shutdown(); await adapter.stopping;
    await env.chatService.closeKbVectorStores(); env.chatService.closeKbDatabases(); await destroyChatRouterEnv(env);
  });
  const prompts = async () => (await fs.readFile(trace, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(frame => frame.method === 'session/prompt');
  async function upload(filename: string) {
    const input = { filename, buffer: bytes, mimeType: 'image/jpeg' };
    const uploaded = await ingestion.enqueueUpload(workspaceId, input); await ingestion.waitForIdle(workspaceId);
    const directory = path.join(env.chatService.getKbConvertedDir(workspaceId), uploaded.entry.rawId);
    const metaBytes = await fs.readFile(path.join(directory, 'meta.json'), 'utf8');
    return { uploaded, directory, metaBytes, meta: JSON.parse(metaBytes), input };
  }

  test('normalizes JPEG for the verified model, preserves original media, persists records and reuses conversion without another native prompt', async () => {
    const result = await upload('diagram.jpg');
    expect(result.meta.metadata).toMatchObject({ source: 'artificial-intelligence', aiRetries: 0, aiImagePrepared: true });
    expect(result.meta.mediaFiles).toEqual(['media/diagram.jpg', 'media/diagram.jpg.ai.png']);
    expect(await fs.readFile(path.join(result.directory, 'media/diagram.jpg'))).toEqual(bytes);
    const frames = await prompts(); expect(frames).toHaveLength(1);
    expect(frames[0].params.prompt).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png' }));
    const reused = await ingestion.enqueueUpload(workspaceId, { ...result.input, folderPath: 'second' }); await ingestion.waitForIdle(workspaceId);
    expect(reused.deduped).toBe(true); expect(reused.entry.rawId).toBe(result.uploaded.entry.rawId);
    expect(await fs.readFile(path.join(result.directory, 'meta.json'), 'utf8')).toBe(result.metaBytes);
    expect(await prompts()).toHaveLength(1);
    expect(env.chatService.getKbDb(workspaceId)!.listLocations(reused.entry.rawId)).toHaveLength(2);
  });

  test('an unsupported saved Auto image model keeps image-only output without silently selecting Sonnet', async () => {
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, knowledgeBase: { ...settings.knowledgeBase, ingestionCliModel: 'auto' } });
    const result = await upload('diagram.jpg');
    expect(result.meta.metadata).toMatchObject({ source: 'image-only', aiRetries: 0 });
    expect(result.meta.mediaFiles).toEqual(['media/diagram.jpg']);
    expect(await prompts()).toEqual([]);
  });

  test('a native human decision fails once and records no fabricated retry or partial answer', async () => {
    const result = await upload('fixture-question.jpg');
    expect(result.meta.metadata).toMatchObject({ source: 'image-only', aiRetries: 0, note: 'AI conversion failed without retry' });
    expect(await prompts()).toHaveLength(1);
    expect(await fs.readFile(path.join(result.directory, 'text.md'), 'utf8')).not.toContain('CHOICE');
  });

  test('shutdown during conversion drains the job and preserves image-only recovery without automatic resend', async () => {
    const pending = upload('fixture-wait.jpg');
    for (let i = 0; i < 200 && !(await prompts()).length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await prompts()).toHaveLength(1);
    adapter.shutdown(); await adapter.stopping;
    const result = await pending;
    expect(result.meta.metadata).toMatchObject({ source: 'image-only', aiRetries: 0 });
    expect(await prompts()).toHaveLength(1);
    expect(env.chatService.getKbDb(workspaceId)!.getRawById(result.uploaded.entry.rawId)?.status).toBe('ingested');
  });
});
