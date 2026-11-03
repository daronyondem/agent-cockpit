import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createCopilotWorkflowEnv, MEMORY_MARKER, prepareWorkflowContext, REFERENCE_MARKER, saveWorkflowNote, type CopilotWorkflowEnv } from './helpers/copilotWorkflowEnv';

const native = process.env.COPILOT_WORKFLOWS_E2E === '1' && process.platform !== 'win32' ? describe : describe.skip;

native('real Copilot Memory and Workspace Context workflows with a local model fixture', () => {
  let env: CopilotWorkflowEnv;
  beforeAll(() => {
    console.info('Copilot workflow compatibility evidence', {
      cli: execFileSync('copilot', ['--no-auto-update', '--version'], { encoding: 'utf8' }).split('\n')[0],
      platform: process.platform, arch: process.arch,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
      model: 'fixed local OpenAI-compatible responses; no hosted account',
    });
  });
  beforeEach(async () => { env = await createCopilotWorkflowEnv(true); });
  afterEach(async () => { await env?.close(); });

  async function chat(content: string) {
    const conv = await env.chatService.createConversation('Native workflow', env.workspace, 'copilot', 'gpt-4', undefined, env.profileId);
    await env.chatService.renameConversation(conv.id, 'Native workflow');
    const ws = await env.connectWs(conv.id);
    const reading = env.readWsEvents(ws, 45_000);
    try {
      expect((await env.request('POST', `/api/chat/conversations/${conv.id}/message`, { content })).status).toBe(200);
      const events = await reading;
      expect(events.some(event => event.type === 'done')).toBe(true);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      const saved = (await env.chatService.getConversation(conv.id))!;
      const text = saved.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n');
      return { conv, events, text };
    } finally { ws.close(); }
  }

  test('chat uses production Memory MCP, Copilot governance, durable recall, and live update frames', async () => {
    const first = await chat(`Save ${MEMORY_MARKER} through memory_note, then retrieve it with memory_search. Do not write fallback files.`);
    expect(first.events.some(event => event.type === 'tool_activity' && /memory_note/.test(event.tool))).toBe(true);
    expect(first.events.some(event => event.type === 'tool_activity' && /memory_search/.test(event.tool))).toBe(true);
    expect(first.events.some(event => event.type === 'memory_update' && event.changedFiles.length === 1)).toBe(true);
    expect(first.text).toContain(MEMORY_MARKER);
    const snapshot = (await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!;
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].metadata).toMatchObject({ status: 'active', sourceConversationId: first.conv.id });
    const second = await chat(`WORKFLOW_RECALL_ONLY: find the stored ${MEMORY_MARKER} with memory_search.`);
    expect(second.text).toContain(MEMORY_MARKER);
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files).toHaveLength(1);
    expect(fs.readdirSync(env.workspace)).toEqual(['AGENTS.md']);
  }, 90_000);

  test('Context folds governed Memory and references into markdown, then a new chat reads it through AGENTS.md', async () => {
    const filename = await saveWorkflowNote(env);
    await prepareWorkflowContext(env, [filename]);
    const result = await env.workspaceContextService.processWorkspace(env.conv.workspaceId, { source: 'maintenance', forceAll: true });
    expect(result.summary).toContain('Consumed 1 Memory entry');
    expect(fs.readFileSync(env.plan.destination!, 'utf8')).toContain(REFERENCE_MARKER);
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files).toHaveLength(0);
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).lastRun?.status).toBe('completed');
    const recall = await chat('WORKFLOW_CONTEXT_RECALL_ONLY: read the managed AGENTS.md Workspace Context pointer and retrieve the stored project identifiers.');
    expect(recall.text).toContain(MEMORY_MARKER);
    expect(recall.text).toContain(REFERENCE_MARKER);
    expect(fs.readFileSync(path.join(env.workspace, 'AGENTS.md'), 'utf8')).toContain('# Fixture instructions');
  }, 90_000);

  test('a real Memory governance failure reaches chat without a fallback file or inbox entry', async () => {
    env.plan.memoryOutput = '{"action":"saved","entry":""}';
    env.writePlan();
    const result = await chat(`Save ${MEMORY_MARKER} with memory_note. If it fails, report the tool error without writing fallback files.`);
    expect(result.text).toContain('Memory note was not saved');
    expect((await env.chatService.getSettings()).memory?.lastProcessorStatus?.status).toBe('bad_output');
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))?.files || []).toHaveLength(0);
    expect(fs.readdirSync(env.workspace)).toEqual(['AGENTS.md']);
  }, 90_000);

  test('invalid native Context output leaves Memory pending and a successful retry consumes it', async () => {
    const filename = await saveWorkflowNote(env);
    await prepareWorkflowContext(env, [filename]);
    const output = env.plan.contextOutput;
    env.plan.contextOutput = 'Updated projects.md but omitted Memory actions.';
    await expect(env.workspaceContextService.processWorkspace(env.conv.workspaceId, { source: 'maintenance', forceAll: true })).rejects.toThrow('memory action block is required');
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files[0].filename).toBe(filename);
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).lastRun?.status).toBe('failed');
    env.plan.contextOutput = output;
    expect((await env.workspaceContextService.processWorkspace(env.conv.workspaceId, { source: 'maintenance', forceAll: true })).summary).toContain('Consumed 1 Memory entry');
  }, 90_000);
});
