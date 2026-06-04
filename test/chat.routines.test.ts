import fsp from 'fs/promises';
import path from 'path';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { workspaceHash } from './helpers/workspace';

describe('Routine routes', () => {
  let env: ChatRouterEnv;
  let workspacePath: string;
  let hash: string;

  beforeEach(async () => {
    env = await createChatRouterEnv();
    workspacePath = path.join(env.tmpDir, 'routine-routes-workspace');
    await fsp.mkdir(workspacePath, { recursive: true });
    await env.chatService.createConversation('Routine routes', workspacePath);
    hash = workspaceHash(workspacePath);
  });

  afterEach(async () => {
    await destroyChatRouterEnv(env);
  });

  test('initializes authoring files and validates routine proposals', async () => {
    const listed = await env.request('GET', `/api/chat/workspaces/${hash}/routines`);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body.routines).toEqual([]);
    expect(listed.body.settings.authoringPath).toContain('ROUTINE_AUTHORING.md');

    const authoring = await fsp.readFile(listed.body.settings.authoringPath, 'utf8');
    expect(authoring).toContain('Agent Cockpit Routine Authoring');
    const agents = await fsp.readFile(path.join(workspacePath, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Agent Cockpit Routines');

    const manifestPath = await writeRoutine(listed.body.settings.routinesDir, {
      id: 'proposal-test',
      title: 'Proposal Test',
      state: 'proposed',
    });
    const validated = await env.request('POST', `/api/chat/workspaces/${hash}/routines/proposals/validate`, {
      content: `Done.\n<!-- AGENT_COCKPIT_ROUTINE_PROPOSAL:v1:${manifestPath} -->`,
    });
    expect(validated.status).toBe(200);
    expect(validated.body.proposals).toHaveLength(1);
    expect(validated.body.proposals[0].routineId).toBe('proposal-test');
  });

  test('installs, edits, starts, and deletes routines through routes', async () => {
    env.mockBackend.setOneShotImpl(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'Routine route run completed.';
    });
    const listed = await env.request('GET', `/api/chat/workspaces/${hash}/routines`);
    const manifestPath = await writeRoutine(listed.body.settings.routinesDir, {
      id: 'route-routine',
      title: 'Route Routine',
      state: 'proposed',
    });

    const proposedRun = await env.request('POST', `/api/chat/workspaces/${hash}/routines/route-routine/run`, {});
    expect(proposedRun.status).toBe(409);

    const installed = await env.request('POST', `/api/chat/workspaces/${hash}/routines/route-routine/install`, { state: 'enabled' });
    expect(installed.status).toBe(200);
    expect(installed.body.routine.manifest.state).toBe('enabled');
    const installedProposal = await env.request('POST', `/api/chat/workspaces/${hash}/routines/proposals/validate`, {
      marker: manifestPath,
    });
    expect(installedProposal.status).toBe(200);
    expect(installedProposal.body.proposals[0].manifest.state).toBe('enabled');

    const updated = await env.request('PUT', `/api/chat/workspaces/${hash}/routines/route-routine`, {
      manifest: {
        title: 'Edited Route Routine',
        state: 'disabled',
        trigger: { type: 'manual' },
      },
      routineContent: '# Edited route routine\n',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.routine.manifest.title).toBe('Edited Route Routine');

    const started = await env.request('POST', `/api/chat/workspaces/${hash}/routines/route-routine/run`, {});
    expect(started.status).toBe(200);
    expect(started.body.started).toBe(true);
    expect(started.body.run.status).toBe('running');
    expect(started.body.routine.running).toBe(true);
    await eventually(async () => {
      const detail = await env.request('GET', `/api/chat/workspaces/${hash}/routines/route-routine`);
      expect(detail.status).toBe(200);
      expect(detail.body.routine.lastRun.status).toBe('completed');
      expect(detail.body.routine.routineContent).toContain('Edited route routine');
    });
    const completedDetail = await env.request('GET', `/api/chat/workspaces/${hash}/routines/route-routine`);
    const runId = completedDetail.body.routine.lastRun.runId;
    await fsp.writeFile(path.join(completedDetail.body.routine.lastRun.outputDir, 'artifact.txt'), 'artifact\n', 'utf8');
    const outputTree = await env.request('GET', `/api/chat/workspaces/${hash}/explorer/tree?scope=routine-output&routineId=route-routine&runId=${encodeURIComponent(runId)}`);
    expect(outputTree.status).toBe(200);
    expect(outputTree.body.entries.map((entry: { name: string }) => entry.name)).toContain('artifact.txt');
    const outputsTree = await env.request('GET', `/api/chat/workspaces/${hash}/explorer/tree?scope=routine-outputs&routineId=route-routine`);
    expect(outputsTree.status).toBe(200);
    expect(outputsTree.body.entries.map((entry: { name: string }) => entry.name)).toContain(runId);
    const outputRunTree = await env.request('GET', `/api/chat/workspaces/${hash}/explorer/tree?scope=routine-outputs&routineId=route-routine&path=${encodeURIComponent(runId)}`);
    expect(outputRunTree.status).toBe(200);
    expect(outputRunTree.body.entries.map((entry: { name: string }) => entry.name)).toContain('output');
    await fsp.mkdir(path.join(completedDetail.body.routine.routineDir, 'persistent-state'), { recursive: true });
    await fsp.writeFile(path.join(completedDetail.body.routine.routineDir, 'persistent-state', 'state.txt'), 'state\n', 'utf8');
    const stateTree = await env.request('GET', `/api/chat/workspaces/${hash}/explorer/tree?scope=routine-state&routineId=route-routine`);
    expect(stateTree.status).toBe(200);
    expect(stateTree.body.entries.map((entry: { name: string }) => entry.name)).toContain('state.txt');
    const statePreview = await env.request('GET', `/api/chat/workspaces/${hash}/explorer/preview?scope=routine-state&routineId=route-routine&path=state.txt`);
    expect(statePreview.status).toBe(200);
    expect(statePreview.body.content).toBe('state\n');
    const writeAttempt = await env.request('POST', `/api/chat/workspaces/${hash}/explorer/mkdir?scope=routine-output&routineId=route-routine&runId=${encodeURIComponent(runId)}`, {
      parent: '',
      name: 'blocked',
    });
    expect(writeAttempt.status).toBe(403);
    const outputsWriteAttempt = await env.request('POST', `/api/chat/workspaces/${hash}/explorer/mkdir?scope=routine-outputs&routineId=route-routine`, {
      parent: '',
      name: 'blocked',
    });
    expect(outputsWriteAttempt.status).toBe(403);
    const stateWriteAttempt = await env.request('POST', `/api/chat/workspaces/${hash}/explorer/mkdir?scope=routine-state&routineId=route-routine`, {
      parent: '',
      name: 'blocked',
    });
    expect(stateWriteAttempt.status).toBe(403);

    const deleted = await env.request('DELETE', `/api/chat/workspaces/${hash}/routines/route-routine`);
    expect(deleted.status).toBe(200);
    const missingDetail = await env.request('GET', `/api/chat/workspaces/${hash}/routines/route-routine`);
    expect(missingDetail.status).toBe(404);
  });

  test('stores notification settings without echoing the Telegram token', async () => {
    const saved = await env.request('PUT', `/api/chat/workspaces/${hash}/routines/settings`, {
      settings: {
        telegram: { enabled: true, botToken: 'token:secret', chatId: 'chat-1' },
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.notification).toEqual({
      telegram: {
        enabled: true,
        configured: true,
        botConfigured: true,
        destinationConfigured: true,
        chatId: 'chat-1',
      },
    });

    const settings = await env.request('GET', `/api/chat/workspaces/${hash}/routines/settings`);
    expect(settings.status).toBe(200);
    expect(settings.body.notification.telegram.configured).toBe(true);
    expect(JSON.stringify(settings.body)).not.toContain('token:secret');

    const cleared = await env.request('PUT', `/api/chat/workspaces/${hash}/routines/settings`, {
      settings: {
        telegram: { enabled: true, botToken: '', chatId: 'chat-1' },
      },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.notification.telegram.configured).toBe(false);
    expect(cleared.body.notification.telegram.botConfigured).toBe(false);
    expect(cleared.body.notification.telegram.destinationConfigured).toBe(true);
  });

  test('pairs a Telegram destination through route polling', async () => {
    await env.chatService.saveSettings({
      ...(await env.chatService.getSettings()),
      integrations: { telegram: { botToken: 'route-token' } },
    });

    const started = await env.request('POST', `/api/chat/workspaces/${hash}/routines/telegram-destination/start`, {});
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('pending');
    expect(started.body.code).toMatch(/^AC-\d{6}$/);

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: [{
          update_id: 7,
          message: {
            date: Math.floor(Date.now() / 1000),
            text: `/connect ${started.body.code}`,
            chat: { id: 991, type: 'private', first_name: 'Daron' },
          },
        }],
      }),
    } as unknown as Response);

    try {
      const polled = await env.request('POST', `/api/chat/workspaces/${hash}/routines/telegram-destination/poll`, {});

      expect(polled.status).toBe(200);
      expect(polled.body.status).toBe('connected');
      expect(polled.body.destination).toEqual({
        chatId: '991',
        chatTitle: 'Daron',
        chatType: 'private',
      });
      expect(polled.body.settings.notification.telegram).toMatchObject({
        enabled: true,
        configured: true,
        botConfigured: true,
        destinationConfigured: true,
        chatId: '991',
        chatTitle: 'Daron',
        chatType: 'private',
      });
      expect(JSON.stringify(polled.body)).not.toContain('route-token');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

async function writeRoutine(
  routinesDir: string,
  input: { id: string; title: string; state: 'proposed' | 'enabled' | 'disabled' },
): Promise<string> {
  const routineDir = path.join(routinesDir, 'items', input.id);
  await fsp.mkdir(routineDir, { recursive: true });
  await fsp.writeFile(
    path.join(routineDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'agent-cockpit.routine',
      id: input.id,
      title: input.title,
      routineFile: 'routine.md',
      state: input.state,
      trigger: { type: 'manual' },
      notification: { mode: 'off' },
    }, null, 2),
    'utf8',
  );
  await fsp.writeFile(path.join(routineDir, 'routine.md'), `# ${input.title}\n`, 'utf8');
  return path.join(routineDir, 'manifest.json');
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}
