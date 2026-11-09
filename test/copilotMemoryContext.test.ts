import fs from 'fs';
import path from 'path';
import { ChatService } from '../src/services/chatService';
import { WorkspaceContextService } from '../src/services/workspaceContext/service';
import { callMemory, createCopilotWorkflowEnv, MEMORY_MARKER, prepareWorkflowContext, REFERENCE_MARKER, saveWorkflowNote, type CopilotWorkflowEnv } from './helpers/copilotWorkflowEnv';

const integration = process.platform === 'win32' ? describe.skip : describe;

integration('Copilot Memory and Workspace Context application integration', () => {
  let env: CopilotWorkflowEnv;
  beforeEach(async () => { env = await createCopilotWorkflowEnv(); });
  afterEach(async () => { await env?.close(); });
  const calls = () => fs.readFileSync(env.callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; cwd: string; pid: number });
  const server = () => env.memoryMcp.issueMemoryMcpSession(env.conv.id, env.conv.workspaceId).mcpServers[0];

  test('governs a real MCP note through Copilot, persists metadata, recalls it after reload, and deduplicates it', async () => {
    const filename = await saveWorkflowNote(env);
    const snapshot = (await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!;
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0].metadata).toMatchObject({ status: 'active', sourceConversationId: env.conv.id });
    expect(calls()[0].args).toEqual(expect.arrayContaining(['--available-tools', 'none', '--model', env.model]));
    expect(calls()[0].args).not.toContain('--allow-all');
    expect(calls()[0].cwd).toBe(fs.realpathSync(env.workspace));
    const recall = await callMemory(server(), 'memory_search', { query: MEMORY_MARKER });
    expect(recall.isError).not.toBe(true);
    expect(JSON.parse(recall.content[0].text).results).toEqual(expect.arrayContaining([expect.objectContaining({ filename, status: 'active' })]));
    const reloaded = new ChatService(env.tmpDir, { backendRegistry: env.backendRegistry });
    await reloaded.initialize();
    expect((await reloaded.searchWorkspaceMemory(env.conv.workspaceId, { query: MEMORY_MARKER }))[0].filename).toBe(filename);
    env.plan.memoryOutput = JSON.stringify({ action: 'skipped_duplicate', reason: 'Already saved.', duplicateOf: filename });
    env.writePlan();
    const duplicate = await callMemory(server(), 'memory_note', { content: MEMORY_MARKER });
    expect(duplicate.content[0].text).toContain('skipped');
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files).toHaveLength(1);
  });

  test('isolates workspace recall, rejects disabled writes, and revokes the old token on session reset', async () => {
    await saveWorkflowNote(env);
    const original = server();
    const otherPath = path.join(env.tmpDir, 'other-workspace');
    fs.mkdirSync(otherPath);
    const other = await env.chatService.createConversation('Other fixture', otherPath);
    await env.chatService.setWorkspaceMemoryEnabled(other.workspaceId, true);
    const otherServer = env.memoryMcp.issueMemoryMcpSession(other.id, other.workspaceId).mcpServers[0];
    expect(JSON.parse((await callMemory(otherServer, 'memory_search', { query: MEMORY_MARKER })).content[0].text).results).toEqual([]);
    await env.chatService.setWorkspaceMemoryEnabled(env.conv.workspaceId, false);
    const count = calls().length;
    const disabled = await callMemory(original, 'memory_note', { content: 'Do not save this.' });
    expect(disabled.isError).toBe(true);
    expect(disabled.content[0].text).toContain('disabled');
    expect(calls()).toHaveLength(count);
    expect((await env.request('POST', `/api/chat/conversations/${env.conv.id}/reset`, {})).status).toBe(200);
    const expired = await callMemory(original, 'memory_search', { query: MEMORY_MARKER });
    expect(expired.isError).toBe(true);
    expect(expired.content[0].text).toContain('Invalid or missing memory token');
    await env.chatService.setWorkspaceMemoryEnabled(env.conv.workspaceId, true);
    expect((await callMemory(server(), 'memory_search', { query: MEMORY_MARKER })).isError).not.toBe(true);
  });

  test.each(['bad output', 'process failure'])('reports Memory %s without saving fallback files', async failure => {
    env.plan.memoryOutput = '{"action":"saved","entry":""}';
    env.plan.memoryError = failure === 'process failure';
    env.writePlan();
    const result = await callMemory(server(), 'memory_note', { content: MEMORY_MARKER });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Memory note was not saved');
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))?.files || []).toHaveLength(0);
    expect((await env.chatService.getSettings()).memory?.lastProcessorStatus?.status).toBe(failure === 'bad output' ? 'bad_output' : 'runtime_failed');
    expect(fs.readdirSync(env.workspace)).toEqual(['AGENTS.md']);
  });

  test('Context uses Copilot tools and actual sources, consumes only accepted notes, and survives service reload', async () => {
    const accepted = await saveWorkflowNote(env);
    const retained = await env.chatService.addMemoryNoteEntry(env.conv.workspaceId, { content: '---\nname: later-note\ntype: project\ndescription: Keep for later\n---\n\nUnresolved fixture decision.', source: 'memory-note', filenameHint: 'later-note' });
    await prepareWorkflowContext(env, [accepted]);
    const result = await env.workspaceContextService.processWorkspace(env.conv.workspaceId, { source: 'maintenance', forceAll: true });
    expect(result.summary).toContain('Consumed 1 Memory entry');
    const content = fs.readFileSync(env.plan.destination!, 'utf8');
    expect(content).toContain(MEMORY_MARKER);
    expect(content).toContain(REFERENCE_MARKER);
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files.map(file => file.filename)).toEqual([retained]);
    const call = calls().at(-1)!;
    expect(call.args).toContain('--allow-all');
    expect(call.args).not.toContain('--available-tools');
    expect(call.cwd).toBe(fs.realpathSync(env.workspace));
    expect(call.args[call.args.indexOf('-p') + 1]).toContain(accepted);
    const reloaded = new WorkspaceContextService({ chatService: env.chatService, backendRegistry: env.backendRegistry });
    expect((await reloaded.readFile(env.conv.workspaceId, 'projects.md'))?.content).toBe(content);
    expect((await reloaded.getState(env.conv.workspaceId)).lastRun?.status).toBe('completed');
    const report = fs.readFileSync(path.join(reloaded.getWorkspaceContextDir(env.conv.workspaceId), 'runs', 'latest.md'), 'utf8');
    expect(report).toContain(accepted);
    expect(report).toContain('Updated projects.md');
    const agents = fs.readFileSync(path.join(env.workspace, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# Fixture instructions');
    expect(agents).toContain(reloaded.getInstructionPath(env.conv.workspaceId));
  });

  test.each(['missing actions', 'unknown accepted file', 'process failure'])('Context preserves inbox entries after %s and permits retry', async failure => {
    const filename = await saveWorkflowNote(env);
    await prepareWorkflowContext(env, [filename]);
    const output = env.plan.contextOutput;
    env.plan.contextError = failure === 'process failure';
    env.plan.contextOutput = failure === 'unknown accepted file'
      ? '```workspace-context-memory-actions\n{"acceptedMemoryFiles":["notes/not-in-plan.md"]}\n```'
      : 'No action block supplied.';
    env.writePlan();
    await expect(env.workspaceContextService.processWorkspace(env.conv.workspaceId, { source: 'maintenance', forceAll: true })).rejects.toThrow();
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files[0].filename).toBe(filename);
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).lastRun?.status).toBe('failed');
    env.plan.contextError = false;
    env.plan.contextOutput = output;
    env.writePlan();
    expect((await env.workspaceContextService.processWorkspace(env.conv.workspaceId, { source: 'maintenance', forceAll: true })).summary).toContain('Consumed 1 Memory entry');
  });

  test('stopping a running Copilot Context processor retains inbox entries and releases the run', async () => {
    const filename = await saveWorkflowNote(env);
    await prepareWorkflowContext(env, [filename]);
    env.plan.contextWait = true;
    env.writePlan();
    const count = calls().length;
    const run = env.workspaceContextService.processWorkspace(env.conv.workspaceId, { source: 'maintenance', forceAll: true });
    try {
      const deadline = Date.now() + 5000;
      while (calls().length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(calls().length).toBe(count + 1);
    } finally { await env.workspaceContextService.stopWorkspace(env.conv.workspaceId); }
    expect((await run).stopped).toBe(true);
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).lastRun?.status).toBe('stopped');
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files[0].filename).toBe(filename);
    env.plan.contextWait = false;
    env.writePlan();
    expect((await env.workspaceContextService.processWorkspace(env.conv.workspaceId, { source: 'maintenance', forceAll: true })).summary).toContain('Consumed 1 Memory entry');
  });
});
