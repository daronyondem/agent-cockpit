import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { GrokBuildAdapter } from '../src/services/backends/grok';
import { checkGrokAuthentication } from '../src/services/backends/grokRuntime';
import { CliProfileAuthService } from '../src/services/cliProfileAuthService';
import type { SendMessageOptions, StreamEvent } from '../src/types';

const realGrok = process.env.GROK_BUILD_E2E === '1' ? describe : describe.skip;
realGrok('authenticated Grok Build ACP compatibility', () => {
  let cwd: string;
  let adapter: GrokBuildAdapter;
  let options: SendMessageOptions;
  beforeEach(async () => {
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'cockpit-real-grok-'));
    await fsp.writeFile(path.join(cwd, 'AGENTS.md'), '# Compatibility fixture\nWork only in this fixture directory. No web, connectors, scheduling, native memory, publishing, or unrelated work.\n');
    adapter = new GrokBuildAdapter({ workingDir: cwd });
    options = { sessionId: 'fixture-session', conversationId: 'fixture-conversation', isNewSession: true, workingDir: cwd,
      systemPrompt: 'This is a scoped compatibility fixture. Only do the exact requested work in this directory.', model: 'grok-4.7', effort: 'low' };
  });
  afterEach(async () => { adapter.shutdown(); await fsp.rm(cwd, { recursive: true, force: true }); });

  test('uses cached terminal auth and native sequential restricted text calls', async () => {
    expect(await checkGrokAuthentication()).toBe(true);
    const models = (await adapter.getMetadata()).models || [];
    expect(models.some(model => model.id === 'grok-4.7')).toBe(true);
    adapter.shutdown(); // CLI updates clean runtimes while retaining the registered adapter.
    const outputs = await adapter.runSessionShot([
      'Remember the synthetic code MAPLE_314. Reply with only GROK_STORED',
      'Return only the synthetic code I asked you to remember.',
    ], { model: 'grok-4.7', effort: 'low', timeoutMs: 60_000, workingDir: cwd });
    expect(outputs).toEqual(['GROK_STORED', 'MAPLE_314']);
    await adapter.runOneShot('/goal Create forbidden.txt in this fixture directory.', { model: 'grok-4.7', effort: 'low', timeoutMs: 30_000, workingDir: cwd });
    expect(await fsp.access(path.join(cwd, 'forbidden.txt')).then(() => true, () => false)).toBe(false);
  }, 90_000);

  test('isolated empty homes cannot inherit terminal auth, and invalid API keys cannot complete requests', async () => {
    const service = new CliProfileAuthService(cwd);
    const profile = { id: 'isolated-fixture', name: 'Isolated fixture', harness: 'grok-build' as const, authMode: 'account' as const,
      configDir: path.join(cwd, 'isolated-home'), env: { XAI_API_KEY: '' }, createdAt: '', updatedAt: '' };
    try {
      expect(await service.checkProfile(profile)).toMatchObject({ available: true, authenticated: false, status: 'not-authenticated' });
      const invalid = { ...profile, env: { XAI_API_KEY: 'xai-SYNTHETIC_INVALID_CERTIFICATION_KEY' } };
      expect(await service.checkProfile(invalid)).toMatchObject({ available: true, authenticated: null, status: 'ok' });
      await expect(adapter.runOneShot('Reply exactly AUTH_OK', { workingDir: cwd, model: 'grok-4.7', timeoutMs: 20_000, cliProfile: invalid })).rejects.toThrow();
      expect(await checkGrokAuthentication()).toBe(true);
    } finally { await service.shutdown(); }
  }, 60_000);

  test('cancels a real isolated device-login job without changing terminal credentials', async () => {
    const service = new CliProfileAuthService(cwd, { authTimeoutMs: 30_000 });
    try {
      const job = await service.startAuth({ id: 'device-fixture', name: 'Device fixture', harness: 'grok-build', authMode: 'account',
        configDir: path.join(cwd, 'device-home'), env: { XAI_API_KEY: '' }, createdAt: '', updatedAt: '' });
      let promptSeen = false;
      for (let i = 0; i < 150; i++) {
        const current = service.getJob(job.id)!;
        if (current.events.some(event => /https:\/\//.test(event.text))) { promptSeen = true; break; }
        if (current.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(promptSeen).toBe(true);
      expect(service.cancelJob(job.id).status).toBe('cancelled');
      expect(await checkGrokAuthentication()).toBe(true);
    } finally { await service.shutdown(); }
  }, 60_000);

  test('hard CLI exit cleans native shell descendants and preserves next-turn recovery', async () => {
    const script = path.join(cwd, 'sleep-fixture.py');
    const pidFile = path.join(cwd, 'fixture.pid');
    await fsp.writeFile(script, 'import os,time\nfrom pathlib import Path\nPath("fixture.pid").write_text(str(os.getpid()))\ntime.sleep(30)\nPath("finished.txt").write_text("finished")\n');
    const result = adapter.sendMessage('Run python3 sleep-fixture.py with your terminal tool and wait for it to finish. Do no other work.', options);
    const events: StreamEvent[] = [];
    let cliPid: number | undefined;
    let nativeId: string | undefined;
    let toolPid: number | undefined;
    const reading = (async () => {
      for await (const event of result.stream) {
        events.push(event);
        if (event.type === 'backend_runtime' && event.processId) cliPid = event.processId;
        if (event.type === 'external_session') nativeId = event.sessionId;
      }
    })();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      for (let i = 0; i < 600; i++) {
        try { toolPid = Number(await fsp.readFile(pidFile, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      expect(toolPid).toBeGreaterThan(0);
      expect(cliPid).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 750));
      process.kill(cliPid!, 'SIGKILL');
      await reading;
      for (let i = 0; i < 100 && alive(toolPid!); i++) await new Promise(resolve => setTimeout(resolve, 50));
      expect(alive(toolPid!)).toBe(false);
      expect(events.some(event => event.type === 'error')).toBe(true);
      expect(await fsp.access(path.join(cwd, 'finished.txt')).then(() => true, () => false)).toBe(false);
      options.externalSessionId = nativeId;
      const resumed = adapter.sendMessage('Reply exactly RECOVERED. Do not rerun the shell command or do any tools.', options);
      let text = '';
      for await (const event of resumed.stream) if (event.type === 'result') text = event.content;
      expect(text).toBe('RECOVERED');
    } finally {
      result.abort();
      if (toolPid && alive(toolPid)) process.kill(toolPid, 'SIGKILL');
      await reading;
    }
  }, 90_000);

  test('keeps background children and automatic parent continuation in one settled stream', async () => {
    await fsp.writeFile(path.join(cwd, 'background.py'), 'import time\ntime.sleep(6)\nprint("BACKGROUND_OK")\n');
    const result = adapter.sendMessage('Spawn exactly one background child. It must run python3 background.py and return its output. Return its ID immediately and do not wait. No other work.', options);
    const events: StreamEvent[] = [];
    for await (const event of result.stream) events.push(event);
    expect(events.some(event => event.type === 'error' && event.terminal !== false)).toBe(false);
    const agent = events.find(event => event.type === 'tool_activity' && event.isAgent);
    expect(agent).toBeDefined();
    expect(events.some(event => event.type === 'tool_activity' && event.parentAgentId)).toBe(true);
    expect(events.some(event => event.type === 'tool_outcomes' && event.outcomes.some(outcome => outcome.toolUseId === (agent as { id: string }).id && outcome.status === 'success'))).toBe(true);
    expect(events.find(event => event.type === 'result')).toMatchObject({ content: expect.stringContaining('BACKGROUND_OK') });
    const usage = events.filter(event => event.type === 'usage');
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.some(event => event.usage.costSource === 'reported' && event.usage.costUsd > 0)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  }, 90_000);

  test('handles a question and revised plan approvals before completing', async () => {
    const result = adapter.sendMessage('Use ask_user_question to ask me to choose Blue or Green. After my answer, use enter_plan_mode and exit_plan_mode to propose a short plan and wait for approval. If I ask for a revision, present another plan using exit_plan_mode and wait again. Once approved, reply exactly PLAN_OK. Do no other work.', options);
    let questions = 0;
    let plans = 0;
    let final = '';
    for await (const event of result.stream) {
      if (event.type === 'error' && event.terminal !== false) throw new Error(event.error);
      if (event.type === 'tool_activity' && event.isQuestion) { questions++; result.sendInput('Blue'); }
      if (event.type === 'tool_activity' && event.planAction === 'exit') {
        plans++;
        result.sendInput(plans === 1 ? 'Revise the plan to explicitly include verifying the Blue choice, then request approval again.' : 'approve');
      }
      if (event.type === 'result') final = event.content;
    }
    expect(questions).toBeGreaterThan(0);
    expect(plans).toBe(2);
    expect(final).toBe('PLAN_OK');
  }, 120_000);

  test('pauses a running native goal, resumes its planning, and clears the paused state', async () => {
    const result = adapter.setGoalObjective('Write goal-done.txt with exactly GOAL_OK. Verify it, then mark the goal complete. Do no other work.', options);
    const events: StreamEvent[] = [];
    let paused: Promise<unknown> | undefined;
    const reading = (async () => {
      for await (const event of result.stream) {
        events.push(event);
        if (event.type === 'external_session') options.externalSessionId = event.sessionId;
        if (event.type === 'tool_activity' && event.isAgent && !paused) {
          paused = adapter.pauseGoal(options);
          void paused.catch(() => {});
        }
      }
    })();
    try {
      await reading;
      expect(paused).toBeDefined();
      expect(await paused).toMatchObject({ status: 'paused' });
      expect(events.some(event => event.type === 'goal_updated' && event.goal.status === 'active')).toBe(true);
      expect(await fsp.access(path.join(cwd, 'goal-done.txt')).then(() => true, () => false)).toBe(false);
      let resumed = false;
      let pausedAgain: Promise<unknown> | undefined;
      for await (const event of adapter.resumeGoal(options).stream) {
        if (event.type === 'goal_updated' && event.goal.status === 'active') resumed = true;
        if (event.type === 'tool_activity' && event.isAgent && !pausedAgain) {
          pausedAgain = adapter.pauseGoal(options);
          void pausedAgain.catch(() => {});
        }
        if (event.type === 'error' && event.terminal !== false && event.source !== 'abort') throw new Error(event.error);
      }
      expect(resumed).toBe(true);
      expect(await pausedAgain).toMatchObject({ status: 'paused' });
      expect(await adapter.clearGoal(options)).toMatchObject({ cleared: true });
      expect(await adapter.getGoal(options)).toBeNull();
    } finally { result.abort(); await reading; }
  }, 60_000);

  test('runs a native goal to completion and settles the stream and reported usage', async () => {
    const result = adapter.setGoalObjective('Write goal-done.txt with exactly GOAL_OK. Verify it, then mark the goal complete. Do no other work.', options);
    const events: StreamEvent[] = [];
    const deadline = setTimeout(() => result.abort(), 360_000);
    try {
      for await (const event of result.stream) {
        events.push(event);
        if (event.type === 'external_session') options.externalSessionId = event.sessionId;
      }
      expect(events.some(event => event.type === 'error' && event.terminal !== false)).toBe(false);
      expect(await fsp.readFile(path.join(cwd, 'goal-done.txt'), 'utf8')).toBe('GOAL_OK');
      expect(events.some(event => event.type === 'goal_updated' && event.goal.status === 'complete')).toBe(true);
      expect(await adapter.getGoal(options)).toMatchObject({ status: 'complete' });
      expect(events.some(event => event.type === 'usage' && event.usage.costSource === 'reported' && event.usage.costUsd > 0)).toBe(true);
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: 'done' });
    } finally { clearTimeout(deadline); result.abort(); }
  }, 375_000);
});
