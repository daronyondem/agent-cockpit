import fs from 'fs';
import path from 'path';
import { WorkspaceContextScheduler } from '../src/services/workspaceContext/service';
import { createCopilotWorkflowEnv, MEMORY_MARKER, prepareWorkflowContext, saveWorkflowNote, type CopilotWorkflowEnv } from './helpers/copilotWorkflowEnv';

const integration = process.platform === 'win32' ? describe.skip : describe;

integration('automatic Copilot Workspace Context triggers', () => {
  let env: CopilotWorkflowEnv;
  let now: Date;
  let scheduler: WorkspaceContextScheduler;
  beforeEach(async () => {
    env = await createCopilotWorkflowEnv();
    now = new Date();
    scheduler = new WorkspaceContextScheduler({ chatService: env.chatService, processor: env.workspaceContextService, now: () => now });
  });
  afterEach(async () => {
    scheduler?.stop();
    if (env) {
      await env.workspaceContextService.stopWorkspace(env.conv.workspaceId);
      await idle();
      await env.close();
    }
  });

  async function until(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Automatic Context condition did not settle');
  }
  const calls = () => fs.existsSync(env.callsPath) ? fs.readFileSync(env.callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[] }) : [];
  const contextCalls = () => calls().filter(call => /Workspace Context (Catch-Up|Maintenance)/.test(call.args[call.args.indexOf('-p') + 1]));
  async function idle() { await until(() => !env.workspaceContextService.isRunning(env.conv.workspaceId)); }
  async function seedScan() {
    await prepareWorkflowContext(env, []);
    await env.chatService.addMessage(env.conv.id, 'user', 'SEED_CONTEXT_FIXTURE', 'copilot');
    await env.workspaceContextService.processWorkspace(env.conv.workspaceId, { source: 'initial_scan', forceAll: true });
  }
  async function startMaintenance() {
    const filename = await saveWorkflowNote(env);
    await prepareWorkflowContext(env, [filename]);
    env.plan.contextWait = true;
    env.plan.contextRelease = path.join(env.tmpDir, 'release-context');
    env.writePlan();
    const before = contextCalls().length;
    now = new Date(Date.now() + 60_000);
    await scheduler.tick();
    await until(() => contextCalls().length === before + 1);
    expect(env.workspaceContextService.getRunningSource(env.conv.workspaceId)).toBe('maintenance');
    return filename;
  }

  test('enabling Context starts a Copilot scan and scheduled maintenance consumes the inbox once despite overlapping ticks', async () => {
    const filename = await saveWorkflowNote(env);
    await prepareWorkflowContext(env, [filename]);
    await env.chatService.addMessage(env.conv.id, 'user', 'INITIAL_CONTEXT_FIXTURE', 'copilot');
    await env.chatService.setWorkspaceContextEnabled(env.conv.workspaceId, false);
    const enabled = await env.request('PUT', `/api/chat/workspaces/${env.conv.workspaceId}/workspace-context/enabled`, { enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.initialRunStarted).toBe(true);
    await until(() => contextCalls().length === 1);
    await idle();
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).lastRun).toMatchObject({ source: 'initial_scan', status: 'completed' });
    env.plan.contextWait = true;
    env.plan.contextRelease = path.join(env.tmpDir, 'release-context');
    env.writePlan();
    now = new Date(Date.now() + 60_000);
    await scheduler.tick();
    await until(() => contextCalls().length === 2);
    now = new Date(now.getTime() + 25 * 60 * 60_000);
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(contextCalls()).toHaveLength(2);
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'scheduled', status: 'skipped', skippedReason: 'maintenance-running' }),
      expect.objectContaining({ source: 'maintenance', status: 'skipped', skippedReason: 'maintenance-running' }),
    ]));
    fs.writeFileSync(env.plan.contextRelease, 'release');
    await idle();
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files).toHaveLength(0);
    expect(fs.readFileSync(env.plan.destination!, 'utf8')).toContain(MEMORY_MARKER);
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).lastRun).toMatchObject({ source: 'maintenance', status: 'completed' });
  });

  test('scheduled Copilot failure preserves the inbox and the next maintenance check retries successfully', async () => {
    await seedScan();
    const filename = await saveWorkflowNote(env);
    await prepareWorkflowContext(env, [filename]);
    env.plan.contextError = true;
    env.writePlan();
    now = new Date(Date.now() + 60_000);
    await scheduler.tick();
    await until(() => contextCalls().length === 2);
    await idle();
    const failed = await env.workspaceContextService.getState(env.conv.workspaceId);
    expect(failed.lastRun).toMatchObject({ source: 'maintenance', status: 'failed' });
    expect(failed.lastMaintenanceCompletedAt).toBeFalsy();
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files[0].filename).toBe(filename);
    env.plan.contextError = false;
    env.writePlan();
    now = new Date(now.getTime() + 61 * 60_000);
    await scheduler.tick();
    await until(() => contextCalls().length === 3);
    await idle();
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).lastRun).toMatchObject({ source: 'maintenance', status: 'completed' });
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files).toHaveLength(0);
    expect(contextCalls()).toHaveLength(3);
  });

  test('disabling Context aborts scheduled Copilot work, preserves the inbox, and prevents further scheduled starts', async () => {
    await seedScan();
    const filename = await startMaintenance();
    const disabled = await env.request('PUT', `/api/chat/workspaces/${env.conv.workspaceId}/workspace-context/enabled`, { enabled: false });
    expect(disabled.status).toBe(200);
    await idle();
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).lastRun?.status).toBe('stopped');
    expect((await env.chatService.getWorkspaceMemory(env.conv.workspaceId))!.files[0].filename).toBe(filename);
    expect(fs.readFileSync(path.join(env.workspace, 'AGENTS.md'), 'utf8')).not.toContain(env.plan.instructions);
    expect(fs.existsSync(env.plan.destination!)).toBe(true); // Only the seed scan wrote this file.
    expect(fs.readFileSync(env.plan.destination!, 'utf8')).not.toContain(MEMORY_MARKER);
    const count = contextCalls().length;
    now = new Date(now.getTime() + 25 * 60 * 60_000);
    await scheduler.tick();
    expect(contextCalls()).toHaveLength(count);
    expect(env.workspaceContextService.isRunning(env.conv.workspaceId)).toBe(false);
  });

  test('reset queues an asynchronous Copilot final pass scoped to the ended session', async () => {
    await prepareWorkflowContext(env, []);
    await env.chatService.setWorkspaceMemoryEnabled(env.conv.workspaceId, false);
    await env.chatService.addMessage(env.conv.id, 'user', 'ENDED_SESSION_FIXTURE', 'copilot');
    env.plan.sources = [env.chatService.getConversationSessionFilePath(env.conv.workspaceId, env.conv.id, 1)];
    env.writePlan();
    env.sessionFinalizers.stop();
    expect((await env.request('POST', `/api/chat/conversations/${env.conv.id}/reset`, {})).status).toBe(200);
    await env.chatService.addMessage(env.conv.id, 'user', 'REPLACEMENT_SESSION_FIXTURE', 'copilot');
    expect(contextCalls()).toHaveLength(0);
    const jobs = await env.sessionFinalizers.listJobs(env.conv.workspaceId);
    expect(jobs).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'workspace_context_conversation_final_pass', sessionNumber: 1, status: 'pending', payload: { source: 'session_reset' } })]));
    await env.sessionFinalizers.start();
    await env.sessionFinalizers.waitForIdle(15_000);
    const text = fs.readFileSync(env.plan.destination!, 'utf8');
    expect(text).toContain('ENDED_SESSION_FIXTURE');
    expect(text).not.toContain('REPLACEMENT_SESSION_FIXTURE');
    expect(contextCalls()).toHaveLength(1);
    expect((await env.workspaceContextService.getState(env.conv.workspaceId)).lastRun).toMatchObject({ source: 'session_reset', status: 'completed' });
    expect((await env.chatService.getConversation(env.conv.id))!.sessionNumber).toBe(2);
  });

  test('a reset finalizer retries after overlapping scheduled maintenance rather than losing the final pass', async () => {
    await seedScan();
    await startMaintenance();
    await env.chatService.setWorkspaceMemoryEnabled(env.conv.workspaceId, false);
    await env.chatService.addMessage(env.conv.id, 'user', 'RETRY_FINAL_PASS_FIXTURE', 'copilot');
    expect((await env.request('POST', `/api/chat/conversations/${env.conv.id}/reset`, {})).status).toBe(200);
    await until(async () => (await env.sessionFinalizers.listJobs(env.conv.workspaceId)).some(job => job.type === 'workspace_context_conversation_final_pass' && job.status === 'retrying'));
    expect(contextCalls()).toHaveLength(2);
    fs.writeFileSync(env.plan.contextRelease!, 'release');
    await idle();
    env.plan.sources = [env.chatService.getConversationSessionFilePath(env.conv.workspaceId, env.conv.id, 1)];
    env.plan.contextWait = false;
    env.writePlan();
    await env.sessionFinalizers.waitForIdle(15_000);
    const job = (await env.sessionFinalizers.listJobs(env.conv.workspaceId)).find(item => item.type === 'workspace_context_conversation_final_pass');
    expect(job).toMatchObject({ status: 'completed', attempts: 2, sessionNumber: 1 });
    expect(fs.readFileSync(env.plan.destination!, 'utf8')).toContain('RETRY_FINAL_PASS_FIXTURE');
    expect(contextCalls()).toHaveLength(3);
  });
});
