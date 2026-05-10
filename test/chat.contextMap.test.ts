/* eslint-disable @typescript-eslint/no-explicit-any */

import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';

let env: ChatRouterEnv;
const NOW = '2026-05-07T20:00:00.000Z';

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}

describe('GET /workspaces/:hash/context-map/settings', () => {
  test('returns enabled=false and global-mode settings for a new workspace', async () => {
    const conv = await env.chatService.createConversation('Context Map GET', '/tmp/ws-context-map-empty');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/settings`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      settings: { processorMode: 'global' },
    });
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await env.request('GET', '/api/chat/workspaces/nonexistent999/context-map/settings');

    expect(res.status).toBe(404);
  });
});

describe('PUT /workspaces/:hash/context-map/enabled', () => {
  test('persists the enable flag and is round-tripped via GET', async () => {
    const conv = await env.chatService.createConversation('Context Map Toggle', '/tmp/ws-context-map-toggle');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const put = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/enabled`,
      { enabled: true },
    );
    expect(put.status).toBe(200);
    expect(put.body.enabled).toBe(true);

    const get = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/settings`);
    expect(get.status).toBe(200);
    expect(get.body.enabled).toBe(true);
  });

  test('starts the initial scan asynchronously when first enabled', async () => {
    const conv = await env.chatService.createConversation('Context Map Initial Scan', '/tmp/ws-context-map-initial-scan');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.addMessage(conv.id, 'user', 'Track the Launch Workflow for this workspace.', 'claude-code');
    env.mockBackend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'workflow',
            name: 'Launch Workflow',
            summaryMarkdown: 'Initial workflow found when enabling Context Map.',
          },
        },
      ],
    }));

    const put = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/enabled`,
      { enabled: true },
    );

    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ enabled: true, initialScanStarted: true });
    const db = env.chatService.getContextMapDb(hash)!;
    await waitForCondition(() => db.listRuns({ source: 'initial_scan' }).some((run) => run.status === 'completed'));
    expect(db.listCandidates()).toMatchObject([
      expect.objectContaining({
        candidateType: 'new_entity',
        status: 'active',
        payload: expect.objectContaining({
          name: 'Launch Workflow',
          sourceSpan: expect.objectContaining({
            conversationId: conv.id,
            sourceType: 'conversation_message',
          }),
        }),
      }),
    ]);
  });

  test('disabling stops an active scan before turning the workspace off', async () => {
    const conv = await env.chatService.createConversation('Context Map Disable Stop', '/tmp/ws-context-map-disable-stop');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    await env.chatService.addMessage(conv.id, 'user', 'This scan should stop when disabled.', 'claude-code');
    env.mockBackend.setOneShotImpl(async (_prompt, opts) => new Promise<string>((_resolve, reject) => {
      opts?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
    }));

    const scan = await env.request('POST', `/api/chat/workspaces/${hash}/context-map/scan`, {});
    expect(scan.status).toBe(200);
    const db = env.chatService.getContextMapDb(hash)!;
    await waitForCondition(() => db.listRuns({ source: 'manual_rebuild' }).some((run) => run.status === 'running'));

    const disabled = await env.request('PUT', `/api/chat/workspaces/${hash}/context-map/enabled`, { enabled: false });

    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ enabled: false, initialScanStarted: false });
    await waitForCondition(() => !env.contextMapService.isRunning(hash));
    expect(db.listRuns({ source: 'manual_rebuild' })).toMatchObject([
      { source: 'manual_rebuild', status: 'stopped', errorMessage: 'Stopped by user' },
    ]);
  });

  test('rejects non-boolean enabled values', async () => {
    const conv = await env.chatService.createConversation('Context Map Bad', '/tmp/ws-context-map-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/enabled`,
      { enabled: 'yes' as unknown as boolean },
    );

    expect(res.status).toBe(400);
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await env.request(
      'PUT',
      '/api/chat/workspaces/nonexistent999/context-map/enabled',
      { enabled: true },
    );

    expect(res.status).toBe(404);
  });

  test('does not touch Memory or KB enablement when toggled', async () => {
    const conv = await env.chatService.createConversation('Context Map Split', '/tmp/ws-context-map-split');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);
    await env.chatService.setWorkspaceKbEnabled(hash, true);

    await env.request('PUT', `/api/chat/workspaces/${hash}/context-map/enabled`, { enabled: true });

    expect(await env.chatService.getWorkspaceMemoryEnabled(hash)).toBe(true);
    expect(await env.chatService.getWorkspaceKbEnabled(hash)).toBe(true);
    expect(await env.chatService.getWorkspaceContextMapEnabled(hash)).toBe(true);
  });
});

describe('PUT /workspaces/:hash/context-map/settings', () => {
  test('persists normalized override settings and returns them through GET', async () => {
    const conv = await env.chatService.createConversation('Context Map Settings', '/tmp/ws-context-map-settings');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const put = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/settings`,
      {
        settings: {
          processorMode: 'override',
          cliBackend: 'codex',
          cliModel: 'gpt-5.4',
          cliEffort: 'high',
          scanIntervalMinutes: 10,
          sources: {
            conversations: true,
            memory: false,
            git: true,
          },
        },
      },
    );

    expect(put.status).toBe(200);
    expect(put.body.settings).toEqual({
      processorMode: 'override',
      cliBackend: 'codex',
      cliModel: 'gpt-5.4',
      cliEffort: 'high',
      scanIntervalMinutes: 10,
    });

    const get = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/settings`);
    expect(get.status).toBe(200);
    expect(get.body.settings).toEqual(put.body.settings);
  });

  test('accepts direct settings objects for compatibility with config routes', async () => {
    const conv = await env.chatService.createConversation('Context Map Direct', '/tmp/ws-context-map-direct');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/settings`,
      {
        processorMode: 'global',
        cliBackend: 'codex',
        scanIntervalMinutes: 0,
        sources: { connectors: true, github: 'yes' },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      processorMode: 'global',
      scanIntervalMinutes: 1,
    });
  });

  test('rejects non-object settings values', async () => {
    const conv = await env.chatService.createConversation('Context Map Settings Bad', '/tmp/ws-context-map-settings-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/settings`,
      { settings: null },
    );

    expect(res.status).toBe(400);
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await env.request(
      'PUT',
      '/api/chat/workspaces/nonexistent999/context-map/settings',
      { settings: { processorMode: 'global' } },
    );

    expect(res.status).toBe(404);
  });
});

describe('GET /workspaces/:hash/context-map/review', () => {
  test('returns pending candidates, counts, and source runs for enabled workspaces', async () => {
    const conv = await env.chatService.createConversation('Context Map Review', '/tmp/ws-context-map-review');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.finishRun('run-1', 'completed', '2026-05-07T20:02:00.000Z');
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { typeSlug: 'project', name: 'Context Map' },
      confidence: 0.8,
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-2',
      runId: 'run-1',
      candidateType: 'new_relationship',
      status: 'discarded',
      payload: { subjectName: 'Context Map', predicate: 'uses', objectName: 'Review Queue' },
      confidence: 0.7,
      now: NOW,
    });

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/review`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      status: 'pending',
      counts: { pending: 1, discarded: 1 },
      candidates: [
        {
          candidateId: 'cand-1',
          candidateType: 'new_entity',
          status: 'pending',
          payload: { typeSlug: 'project', name: 'Context Map' },
        },
      ],
      runs: [
        { runId: 'run-1', source: 'initial_scan', status: 'completed' },
      ],
    });
  });

  test('status=all includes dismissed candidates and disabled workspaces return an empty queue', async () => {
    const conv = await env.chatService.createConversation('Context Map Review All', '/tmp/ws-context-map-review-all');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const disabled = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/review?status=all`);
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ enabled: false, candidates: [], runs: [] });

    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      status: 'discarded',
      payload: { name: 'Dismissed' },
      now: NOW,
    });

    const all = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/review?status=all`);
    expect(all.status).toBe(200);
    expect(all.body.candidates).toMatchObject([
      { candidateId: 'cand-1', status: 'discarded' },
    ]);
  });

  test('returns recent runs even when no candidates reference them', async () => {
    const conv = await env.chatService.createConversation('Context Map Review Runs', '/tmp/ws-context-map-review-runs');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'scheduled', startedAt: '2026-05-07T20:00:00.000Z' });
    db.finishRun('run-1', 'completed', '2026-05-07T20:01:00.000Z');

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/review?status=all`);

    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
    expect(res.body.runs).toMatchObject([
      { runId: 'run-1', source: 'scheduled', status: 'completed' },
    ]);
  });

  test('rejects invalid review status and returns 404 for unknown workspace', async () => {
    const conv = await env.chatService.createConversation('Context Map Review Bad', '/tmp/ws-context-map-review-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const bad = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/review?status=unknown`);
    expect(bad.status).toBe(400);

    const missing = await env.request('GET', '/api/chat/workspaces/nonexistent999/context-map/review');
    expect(missing.status).toBe(404);
  });
});

describe('conversation Context Map notification status', () => {
  test('hydrates pending Context Map review status on conversation reads', async () => {
    const conv = await env.chatService.createConversation('Context Map Composer Status', '/tmp/ws-context-map-composer-status');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'scheduled', status: 'failed', startedAt: NOW });
    db.finishRun('run-1', 'failed', NOW, 'Processor failed');
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { typeSlug: 'project', name: 'Context Map' },
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-2',
      runId: 'run-1',
      candidateType: 'conflict_flag',
      status: 'conflict',
      payload: { targetKind: 'entity', targetId: 'ent-1' },
      now: NOW,
    });

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}`);

    expect(res.status).toBe(200);
    expect(res.body.contextMap).toMatchObject({
      enabled: true,
      pending: true,
      pendingCandidates: 1,
      conflictCandidates: 1,
      failedRuns: 1,
      latestRunId: 'run-1',
      latestRunStatus: 'failed',
    });
  });
});

describe('POST /workspaces/:hash/context-map/candidates/:candidateId/discard', () => {
  test('marks a candidate dismissed and records an audit event', async () => {
    const conv = await env.chatService.createConversation('Context Map Discard', '/tmp/ws-context-map-discard');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { name: 'Candidate' },
      now: NOW,
    });

    const res = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-1/discard`,
      {},
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      candidate: { candidateId: 'cand-1', status: 'discarded' },
    });
    expect(db.listAuditEvents('candidate', 'cand-1')).toMatchObject([
      { eventType: 'discarded', details: { previousStatus: 'pending' } },
    ]);
  });

  test('restores a dismissed candidate to pending and rejects disabled workspaces', async () => {
    const conv = await env.chatService.createConversation('Context Map Reopen', '/tmp/ws-context-map-reopen');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      status: 'discarded',
      payload: { name: 'Candidate' },
      now: NOW,
    });

    const reopened = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-1/reopen`,
      {},
    );
    expect(reopened.status).toBe(200);
    expect(reopened.body.candidate).toMatchObject({ candidateId: 'cand-1', status: 'pending' });

    await env.chatService.setWorkspaceContextMapEnabled(hash, false);
    const disabled = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-1/discard`,
      {},
    );
    expect(disabled.status).toBe(403);
  });

  test('returns 404 for missing candidates', async () => {
    const conv = await env.chatService.createConversation('Context Map Missing Candidate', '/tmp/ws-context-map-missing-candidate');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);

    const res = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/nope/discard`,
      {},
    );

    expect(res.status).toBe(404);
  });

  test('does not discard or restore active candidates', async () => {
    const conv = await env.chatService.createConversation('Context Map Active Candidate State', '/tmp/ws-context-map-active-state');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-active',
      runId: 'run-1',
      candidateType: 'new_entity',
      status: 'active',
      payload: { name: 'Already Applied' },
      now: NOW,
    });

    const discard = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-active/discard`,
      {},
    );
    const reopen = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-active/reopen`,
      {},
    );

    expect(discard.status).toBe(409);
    expect(reopen.status).toBe(409);
    expect(db.getCandidate('cand-active')).toMatchObject({ status: 'active' });
  });
});

describe('PUT /workspaces/:hash/context-map/candidates/:candidateId', () => {
  test('edits a pending candidate payload while preserving source provenance', async () => {
    const conv = await env.chatService.createConversation('Context Map Edit Candidate', '/tmp/ws-context-map-edit-candidate');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: {
        typeSlug: 'project',
        name: 'Original Candidate',
        sourceSpan: {
          sourceType: 'conversation_message',
          conversationId: conv.id,
          sessionEpoch: 1,
          startMessageId: 'msg-1',
          endMessageId: 'msg-2',
          sourceHash: 'hash-1',
        },
      },
      confidence: 0.4,
      now: NOW,
    });

    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-1`,
      {
        payload: {
          typeSlug: 'project',
          name: 'Edited Candidate',
          summaryMarkdown: 'Edited before approval.',
        },
        confidence: 1.4,
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.candidate).toMatchObject({
      candidateId: 'cand-1',
      status: 'pending',
      confidence: 1,
      payload: {
        typeSlug: 'project',
        name: 'Edited Candidate',
        summaryMarkdown: 'Edited before approval.',
        sourceSpan: expect.objectContaining({
          conversationId: conv.id,
          startMessageId: 'msg-1',
        }),
      },
    });
    expect(db.listAuditEvents('candidate', 'cand-1')).toMatchObject([
      { eventType: 'edited', details: { previousConfidence: 0.4 } },
    ]);
  });

  test('rejects invalid edits, non-pending candidates, disabled workspaces, and unknown workspaces', async () => {
    const conv = await env.chatService.createConversation('Context Map Edit Bad', '/tmp/ws-context-map-edit-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { name: 'Candidate' },
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-active',
      runId: 'run-1',
      candidateType: 'new_entity',
      status: 'active',
      payload: { name: 'Applied Candidate' },
      now: NOW,
    });

    const invalidPayload = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-1`,
      { payload: null },
    );
    expect(invalidPayload.status).toBe(400);

    const invalidConfidence = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-1`,
      { payload: { name: 'Candidate' }, confidence: 'high' },
    );
    expect(invalidConfidence.status).toBe(400);

    const active = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-active`,
      { payload: { name: 'Applied Candidate Edited' } },
    );
    expect(active.status).toBe(409);

    await env.chatService.setWorkspaceContextMapEnabled(hash, false);
    const disabled = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-1`,
      { payload: { name: 'Candidate' } },
    );
    expect(disabled.status).toBe(403);

    const missing = await env.request(
      'PUT',
      '/api/chat/workspaces/nonexistent999/context-map/candidates/cand-1',
      { payload: { name: 'Candidate' } },
    );
    expect(missing.status).toBe(404);
  });
});

describe('GET /workspaces/:hash/context-map/graph', () => {
  test('returns active entities and relationships for the workspace map', async () => {
    const conv = await env.chatService.createConversation('Context Map Graph', '/tmp/ws-context-map-graph');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertEntity({
      entityId: 'ent-project',
      typeSlug: 'project',
      name: 'Context Map',
      summaryMarkdown: 'Reviewed workspace graph.',
      confidence: 0.91,
      now: NOW,
    });
    db.addAlias('ent-project', 'Workspace Graph', NOW);
    db.insertFact({
      factId: 'fact-project',
      entityId: 'ent-project',
      statementMarkdown: 'Context Map exposes active graph browsing.',
      now: NOW,
    });
    db.insertEntity({
      entityId: 'ent-workflow',
      typeSlug: 'workflow',
      name: 'Review Workflow',
      summaryMarkdown: 'Governed approval flow.',
      now: NOW,
    });
    db.insertRelationship({
      relationshipId: 'rel-project-workflow',
      subjectEntityId: 'ent-project',
      predicate: 'uses',
      objectEntityId: 'ent-workflow',
      now: NOW,
    });

    const res = await env.request(
      'GET',
      `/api/chat/workspaces/${hash}/context-map/graph?query=Workspace%20Graph&type=project`,
    );

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.counts).toMatchObject({ entities: 2, relationships: 1 });
    expect(res.body.entities).toEqual([
      expect.objectContaining({
        entityId: 'ent-project',
        aliases: ['Workspace Graph'],
        facts: ['Context Map exposes active graph browsing.'],
        factCount: 1,
        relationshipCount: 1,
      }),
    ]);
    expect(res.body.relationships).toEqual([
      expect.objectContaining({
        relationshipId: 'rel-project-workflow',
        subjectName: 'Context Map',
        predicate: 'uses',
        objectName: 'Review Workflow',
      }),
    ]);
  });

  test('filters entities by status and sensitivity', async () => {
    const conv = await env.chatService.createConversation('Context Map Graph Filters', '/tmp/ws-context-map-graph-filters');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertEntity({
      entityId: 'ent-active',
      typeSlug: 'project',
      name: 'Active Map',
      sensitivity: 'normal',
      now: NOW,
    });
    db.insertEntity({
      entityId: 'ent-secret-stale',
      typeSlug: 'project',
      name: 'Sensitive Plan',
      summaryMarkdown: 'Hidden summary should not be searchable.',
      status: 'stale',
      sensitivity: 'secret-pointer',
      now: NOW,
    });

    const stale = await env.request(
      'GET',
      `/api/chat/workspaces/${hash}/context-map/graph?status=stale&sensitivity=secret-pointer`,
    );
    const active = await env.request(
      'GET',
      `/api/chat/workspaces/${hash}/context-map/graph`,
    );
    const invalid = await env.request(
      'GET',
      `/api/chat/workspaces/${hash}/context-map/graph?status=failed`,
    );
    const hiddenSummary = await env.request(
      'GET',
      `/api/chat/workspaces/${hash}/context-map/graph?status=all&query=${encodeURIComponent('Hidden summary')}`,
    );

    expect(stale.status).toBe(200);
    expect(stale.body.entities).toEqual([
      expect.objectContaining({
        entityId: 'ent-secret-stale',
        status: 'stale',
        sensitivity: 'secret-pointer',
      }),
    ]);
    expect(active.body.entities).toEqual([
      expect.objectContaining({ entityId: 'ent-active', status: 'active' }),
    ]);
    expect(invalid.status).toBe(400);
    expect(hiddenSummary.status).toBe(200);
    expect(hiddenSummary.body.entities).toEqual([]);
  });

  test('returns an empty graph without opening storage while disabled', async () => {
    const conv = await env.chatService.createConversation('Context Map Graph Disabled', '/tmp/ws-context-map-graph-disabled');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/graph`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: false,
      entities: [],
      relationships: [],
      counts: { entities: 0, relationships: 0 },
    });
  });
});

describe('GET /workspaces/:hash/context-map/entities/:entityId', () => {
  test('returns entity detail with facts, relationships, evidence, and audit', async () => {
    const conv = await env.chatService.createConversation('Context Map Entity Detail', '/tmp/ws-context-map-entity-detail');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    const project = db.insertEntity({
      entityId: 'ent-project',
      typeSlug: 'project',
      name: 'Context Map',
      summaryMarkdown: 'Reviewed workspace graph.',
      now: NOW,
    });
    db.addAlias(project.entityId, 'Workspace Graph', NOW);
    db.insertFact({
      factId: 'fact-project',
      entityId: project.entityId,
      statementMarkdown: 'Entity detail shows evidence.',
      now: NOW,
    });
    const workflow = db.insertEntity({
      entityId: 'ent-workflow',
      typeSlug: 'workflow',
      name: 'Review Queue',
      now: NOW,
    });
    db.insertRelationship({
      relationshipId: 'rel-1',
      subjectEntityId: project.entityId,
      predicate: 'uses',
      objectEntityId: workflow.entityId,
      now: NOW,
    });
    db.upsertEvidenceRef({
      evidenceId: 'ev-1',
      sourceType: 'file',
      sourceId: 'docs/SPEC.md',
      locator: { path: 'docs/SPEC.md' },
      excerpt: 'Context Map detail evidence.',
      now: NOW,
    });
    db.linkEvidence('entity', project.entityId, 'ev-1', NOW);
    db.linkEvidence('fact', 'fact-project', 'ev-1', NOW);
    db.insertAuditEvent({
      eventId: 'audit-1',
      targetKind: 'entity',
      targetId: project.entityId,
      eventType: 'edited',
      details: { field: 'summaryMarkdown' },
      createdAt: NOW,
    });

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/entities/${project.entityId}`);

    expect(res.status).toBe(200);
    expect(res.body.entity).toMatchObject({
      entityId: project.entityId,
      aliases: ['Workspace Graph'],
      facts: [
        {
          factId: 'fact-project',
          statementMarkdown: 'Entity detail shows evidence.',
          evidence: [expect.objectContaining({ sourceType: 'file', sourceId: 'docs/SPEC.md' })],
        },
      ],
      relationships: [
        expect.objectContaining({ relationshipId: 'rel-1', predicate: 'uses', objectName: 'Review Queue' }),
      ],
      evidence: [
        expect.objectContaining({ evidenceId: 'ev-1', excerpt: 'Context Map detail evidence.' }),
      ],
      audit: [
        expect.objectContaining({ eventId: 'audit-1', eventType: 'edited' }),
      ],
    });
  });

  test('handles secret, disabled, unknown workspace, and missing entity detail reads', async () => {
    const conv = await env.chatService.createConversation('Context Map Entity Detail Secret', '/tmp/ws-context-map-entity-detail-secret');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertEntity({
      entityId: 'ent-secret',
      typeSlug: 'asset',
      name: 'Secret Pointer',
      summaryMarkdown: 'Hidden summary.',
      sensitivity: 'secret-pointer',
      now: NOW,
    });
    db.insertFact({
      factId: 'fact-secret',
      entityId: 'ent-secret',
      statementMarkdown: 'Hidden fact.',
      now: NOW,
    });
    db.insertAuditEvent({
      eventId: 'audit-secret',
      targetKind: 'entity',
      targetId: 'ent-secret',
      eventType: 'edited',
      details: {
        previous: {
          name: 'Secret Pointer',
          summaryMarkdown: 'Hidden summary.',
          notesMarkdown: 'Hidden notes.',
        },
      },
      createdAt: NOW,
    });

    const secret = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/entities/ent-secret`);
    expect(secret.status).toBe(200);
    expect(secret.body.entity).toMatchObject({
      summaryMarkdown: null,
      facts: [],
      evidence: [],
      audit: [
        expect.objectContaining({
          details: null,
        }),
      ],
    });
    expect(JSON.stringify(secret.body.entity)).not.toContain('Hidden summary.');
    expect(JSON.stringify(secret.body.entity)).not.toContain('Hidden notes.');

    const missingEntity = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/entities/nope`);
    expect(missingEntity.status).toBe(404);

    await env.chatService.setWorkspaceContextMapEnabled(hash, false);
    const disabled = await env.request('GET', `/api/chat/workspaces/${hash}/context-map/entities/ent-secret`);
    expect(disabled.status).toBe(403);

    const missingWorkspace = await env.request('GET', '/api/chat/workspaces/nonexistent999/context-map/entities/ent-secret');
    expect(missingWorkspace.status).toBe(404);
  });
});

describe('PUT /workspaces/:hash/context-map/entities/:entityId', () => {
  test('updates editable entity fields and records audit history', async () => {
    const conv = await env.chatService.createConversation('Context Map Entity Update', '/tmp/ws-context-map-entity-update');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertEntity({
      entityId: 'ent-project',
      typeSlug: 'project',
      name: 'Context Map',
      summaryMarkdown: 'Old summary.',
      now: NOW,
    });

    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/entities/ent-project`,
      {
        entity: {
          name: 'Context Map System',
          status: 'stale',
          sensitivity: 'work-sensitive',
          summaryMarkdown: 'Updated summary.',
          notesMarkdown: 'Reviewed note.',
          confidence: 0.72,
        },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.entity).toMatchObject({
      entityId: 'ent-project',
      name: 'Context Map System',
      status: 'stale',
      sensitivity: 'work-sensitive',
      summaryMarkdown: 'Updated summary.',
      notesMarkdown: 'Reviewed note.',
      confidence: 0.72,
    });
    expect(db.listAuditEvents('entity', 'ent-project')).toEqual([
      expect.objectContaining({ eventType: 'edited' }),
    ]);
  });

  test('validates entity edits and rejects disabled workspaces', async () => {
    const conv = await env.chatService.createConversation('Context Map Entity Update Bad', '/tmp/ws-context-map-entity-update-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertEntity({ entityId: 'ent-project', typeSlug: 'project', name: 'Context Map', now: NOW });

    const badStatus = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/entities/ent-project`,
      { entity: { status: 'failed' } },
    );
    expect(badStatus.status).toBe(400);

    const badType = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/entities/ent-project`,
      { entity: { typeSlug: 'missing_type' } },
    );
    expect(badType.status).toBe(400);

    await env.chatService.setWorkspaceContextMapEnabled(hash, false);
    const disabled = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/context-map/entities/ent-project`,
      { entity: { name: 'Nope' } },
    );
    expect(disabled.status).toBe(403);
  });
});

describe('POST /workspaces/:hash/context-map/scan', () => {
  test('starts a manual incremental scan asynchronously for enabled workspaces', async () => {
    const conv = await env.chatService.createConversation('Context Map Manual Scan', '/tmp/ws-context-map-manual-scan');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    await env.chatService.addMessage(conv.id, 'user', 'Manual scan should map the Review Board project.', 'claude-code');
    env.mockBackend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.8,
          payload: {
            typeSlug: 'project',
            name: 'Review Board',
            summaryMarkdown: 'Workspace project discovered by a manual Context Map scan.',
          },
        },
      ],
    }));

    const res = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/scan`,
      {},
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, started: true, source: 'manual_rebuild' });
    const db = env.chatService.getContextMapDb(hash)!;
    await waitForCondition(() => db.listRuns({ source: 'manual_rebuild' }).some((run) => run.status === 'completed'));
    expect(db.listRuns({ source: 'manual_rebuild' })).toMatchObject([
      { source: 'manual_rebuild', status: 'completed' },
    ]);
    expect(db.listCandidates()).toMatchObject([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          name: 'Review Board',
          sourceSpan: expect.objectContaining({
            conversationId: conv.id,
            sourceType: 'conversation_message',
          }),
        }),
      }),
    ]);
  });

  test('stops a running manual scan and leaves it retryable later', async () => {
    const conv = await env.chatService.createConversation('Context Map Manual Stop', '/tmp/ws-context-map-manual-stop');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    await env.chatService.addMessage(conv.id, 'user', 'Manual scan should be stoppable.', 'claude-code');
    env.mockBackend.setOneShotImpl(async (_prompt, opts) => new Promise<string>((_resolve, reject) => {
      opts?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
    }));

    const scan = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/scan`,
      {},
    );
    expect(scan.status).toBe(200);
    expect(scan.body).toMatchObject({ ok: true, started: true, source: 'manual_rebuild' });
    const db = env.chatService.getContextMapDb(hash)!;
    await waitForCondition(() => db.listRuns({ source: 'manual_rebuild' }).some((run) => run.status === 'running'));

    const duplicate = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/scan`,
      {},
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('Context Map scan already running');

    const stop = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/scan/stop`,
      {},
    );

    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ ok: true, stopped: true });
    await waitForCondition(() => !env.contextMapService.isRunning(hash));
    expect(db.listRuns({ source: 'manual_rebuild' })).toMatchObject([
      { source: 'manual_rebuild', status: 'stopped', errorMessage: 'Stopped by user' },
    ]);
    expect(db.listCandidates()).toHaveLength(0);
    expect(db.getConversationCursor(conv.id)).toBeNull();

    env.mockBackend.setOneShotImpl(async () => JSON.stringify({ candidates: [] }));
    const retry = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/scan`,
      {},
    );

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, started: true, source: 'manual_rebuild' });
    await waitForCondition(() => db.listRuns({ source: 'manual_rebuild' }).map((run) => run.status).includes('completed'));
    expect(db.listRuns({ source: 'manual_rebuild' }).map((run) => run.status)).toEqual(['stopped', 'completed']);
  });

  test('can stop a running scan even after Context Map has been disabled', async () => {
    const conv = await env.chatService.createConversation('Context Map Stop Disabled', '/tmp/ws-context-map-stop-disabled');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    await env.chatService.addMessage(conv.id, 'user', 'Stop should still work after disabled.', 'claude-code');
    env.mockBackend.setOneShotImpl(async (_prompt, opts) => new Promise<string>((_resolve, reject) => {
      opts?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
    }));

    const scan = await env.request('POST', `/api/chat/workspaces/${hash}/context-map/scan`, {});
    expect(scan.status).toBe(200);
    const db = env.chatService.getContextMapDb(hash)!;
    await waitForCondition(() => db.listRuns({ source: 'manual_rebuild' }).some((run) => run.status === 'running'));
    await env.chatService.setWorkspaceContextMapEnabled(hash, false);

    const stop = await env.request('POST', `/api/chat/workspaces/${hash}/context-map/scan/stop`, {});

    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ ok: true, stopped: true });
    await waitForCondition(() => !env.contextMapService.isRunning(hash));
    expect(db.listRuns({ source: 'manual_rebuild' })).toMatchObject([
      { source: 'manual_rebuild', status: 'stopped', errorMessage: 'Stopped by user' },
    ]);
  });

  test('rejects disabled and unknown workspaces', async () => {
    const conv = await env.chatService.createConversation('Context Map Manual Disabled', '/tmp/ws-context-map-manual-disabled');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const disabled = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/scan`,
      {},
    );
    expect(disabled.status).toBe(403);

    const missing = await env.request(
      'POST',
      '/api/chat/workspaces/nonexistent999/context-map/scan',
      {},
    );
    expect(missing.status).toBe(404);
  });
});

describe('DELETE /workspaces/:hash/context-map', () => {
  test('clears Context Map state without disabling the workspace', async () => {
    const conv = await env.chatService.createConversation('Context Map Clear', '/tmp/ws-context-map-clear');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertEntity({ entityId: 'ent-1', typeSlug: 'project', name: 'Context Map', now: NOW });
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { name: 'Candidate' },
      now: NOW,
    });

    const res = await env.request('DELETE', `/api/chat/workspaces/${hash}/context-map`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      deleted: { runs: 1, entities: 1, candidates: 1 },
    });
    expect(await env.chatService.getWorkspaceContextMapEnabled(hash)).toBe(true);
    expect(db.listRuns()).toHaveLength(0);
    expect(db.listEntities()).toHaveLength(0);
    expect(db.listCandidates()).toHaveLength(0);
  });

  test('rejects clear while a scan is running', async () => {
    const conv = await env.chatService.createConversation('Context Map Clear Running', '/tmp/ws-context-map-clear-running');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    await env.chatService.addMessage(conv.id, 'user', 'Clear must not race this scan.', 'claude-code');
    env.mockBackend.setOneShotImpl(async (_prompt, opts) => new Promise<string>((_resolve, reject) => {
      opts?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
    }));
    const scan = await env.request('POST', `/api/chat/workspaces/${hash}/context-map/scan`, {});
    expect(scan.status).toBe(200);
    const db = env.chatService.getContextMapDb(hash)!;
    await waitForCondition(() => db.listRuns({ source: 'manual_rebuild' }).some((run) => run.status === 'running'));

    const res = await env.request('DELETE', `/api/chat/workspaces/${hash}/context-map`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stop the scan before clearing');
    await env.request('POST', `/api/chat/workspaces/${hash}/context-map/scan/stop`, {});
    await waitForCondition(() => !env.contextMapService.isRunning(hash));
  });

  test('returns 404 for unknown workspaces', async () => {
    const res = await env.request('DELETE', '/api/chat/workspaces/nonexistent999/context-map');

    expect(res.status).toBe(404);
  });
});

describe('POST /workspaces/:hash/context-map/candidates/:candidateId/apply', () => {
  test('applies new entity candidates into the active graph with evidence and audit', async () => {
    const conv = await env.chatService.createConversation('Context Map Apply Entity', '/tmp/ws-context-map-apply-entity');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-entity',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: {
        typeSlug: 'project',
        name: 'Context Map',
        summaryMarkdown: 'Reviewed workspace graph.',
        aliases: ['Workspace Graph'],
        factsMarkdown: ['Context Map stores reviewed entity relationships.'],
        sourceSpan: {
          sourceType: 'conversation_message',
          conversationId: 'conv-1',
          sessionEpoch: 1,
          startMessageId: 'msg-1',
          endMessageId: 'msg-2',
          sourceHash: 'hash-1',
        },
      },
      confidence: 0.82,
      now: NOW,
    });

    const res = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-entity/apply`,
      {},
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      candidate: { candidateId: 'cand-entity', status: 'active' },
      applied: [{ kind: 'entity', label: 'Context Map' }],
    });
    const entity = db.listEntities({ typeSlug: 'project' }).find((row) => row.name === 'Context Map');
    expect(entity).toBeTruthy();
    expect(entity).toMatchObject({
      status: 'active',
      summaryMarkdown: 'Reviewed workspace graph.',
      confidence: 0.82,
    });
    expect(db.listAliases(entity!.entityId)).toMatchObject([
      { alias: 'Workspace Graph' },
    ]);
    expect(db.listFacts(entity!.entityId)).toMatchObject([
      { statementMarkdown: 'Context Map stores reviewed entity relationships.' },
    ]);
    expect(db.listEvidenceForTarget('entity', entity!.entityId)).toHaveLength(1);
    expect(db.listEvidenceForTarget('candidate', 'cand-entity')).toHaveLength(1);
    expect(db.listAuditEvents('candidate', 'cand-entity')).toMatchObject([
      { eventType: 'applied', details: { candidateType: 'new_entity' } },
    ]);
  });

  test('applies relationship, alias, and sensitivity candidates against existing entities', async () => {
    const conv = await env.chatService.createConversation('Context Map Apply Relationship', '/tmp/ws-context-map-apply-rel');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    const project = db.insertEntity({
      entityId: 'ent-context-map',
      typeSlug: 'project',
      name: 'Context Map',
      now: NOW,
    });
    const workflow = db.insertEntity({
      entityId: 'ent-review-queue',
      typeSlug: 'workflow',
      name: 'Review Queue',
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-rel',
      runId: 'run-1',
      candidateType: 'new_relationship',
      payload: {
        subjectName: 'Context Map',
        predicate: 'uses',
        objectName: 'Review Queue',
      },
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-alias',
      runId: 'run-1',
      candidateType: 'alias_addition',
      payload: { entityId: project.entityId, alias: 'CM' },
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-sensitivity',
      runId: 'run-1',
      candidateType: 'sensitivity_classification',
      payload: { entityId: workflow.entityId, sensitivity: 'work-sensitive' },
      now: NOW,
    });

    const rel = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-rel/apply`,
      {},
    );
    const alias = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-alias/apply`,
      {},
    );
    const sensitivity = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-sensitivity/apply`,
      {},
    );

    expect(rel.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(sensitivity.status).toBe(200);
    expect(db.listRelationshipsForEntity(project.entityId)).toMatchObject([
      {
        subjectEntityId: project.entityId,
        predicate: 'uses',
        objectEntityId: workflow.entityId,
        status: 'active',
      },
    ]);
    expect(db.listAliases(project.entityId)).toMatchObject([{ alias: 'CM' }]);
    expect(db.getEntity(workflow.entityId)).toMatchObject({ sensitivity: 'work-sensitive' });
  });

  test('requires confirmation before applying relationship endpoint entity dependencies', async () => {
    const conv = await env.chatService.createConversation('Context Map Apply Dependencies', '/tmp/ws-context-map-apply-dependencies');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-project',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { typeSlug: 'project', name: 'Context Map', summaryMarkdown: 'Reviewed workspace graph.' },
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-workflow',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { typeSlug: 'workflow', name: 'Review Queue', summaryMarkdown: 'Candidate governance workflow.' },
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-rel',
      runId: 'run-1',
      candidateType: 'new_relationship',
      payload: {
        subjectName: 'Context Map',
        subjectTypeSlug: 'project',
        predicate: 'uses',
        objectName: 'Review Queue',
        objectTypeSlug: 'workflow',
      },
      now: NOW,
    });

    const preview = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-rel/apply`,
      {},
    );

    expect(preview.status).toBe(409);
    expect(preview.body).toMatchObject({
      error: expect.stringContaining('pending entity candidates'),
      dependencies: [
        { candidateId: 'cand-project', role: 'subject', name: 'Context Map', typeSlug: 'project' },
        { candidateId: 'cand-workflow', role: 'object', name: 'Review Queue', typeSlug: 'workflow' },
      ],
    });
    expect(db.listEntities({ status: 'active' })).toEqual([]);
    const pendingIds = db.listCandidates('pending').map((candidate) => candidate.candidateId);
    expect(pendingIds).toHaveLength(3);
    expect(pendingIds).toEqual(expect.arrayContaining([
      'cand-project',
      'cand-workflow',
      'cand-rel',
    ]));

    const applied = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-rel/apply`,
      { includeDependencies: true },
    );

    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      ok: true,
      candidate: { candidateId: 'cand-rel', status: 'active' },
      applied: [{ kind: 'relationship', label: 'uses' }],
      dependenciesApplied: [
        { candidate: { candidateId: 'cand-project', status: 'active' }, applied: [{ kind: 'entity', label: 'Context Map' }] },
        { candidate: { candidateId: 'cand-workflow', status: 'active' }, applied: [{ kind: 'entity', label: 'Review Queue' }] },
      ],
    });
    const project = db.listEntities({ typeSlug: 'project' }).find((row) => row.name === 'Context Map');
    const workflow = db.listEntities({ typeSlug: 'workflow' }).find((row) => row.name === 'Review Queue');
    expect(project).toBeTruthy();
    expect(workflow).toBeTruthy();
    expect(db.listRelationshipsForEntity(project!.entityId)).toMatchObject([
      {
        subjectEntityId: project!.entityId,
        predicate: 'uses',
        objectEntityId: workflow!.entityId,
        status: 'active',
      },
    ]);
  });

  test('applies entity update and merge candidates against existing entities', async () => {
    const conv = await env.chatService.createConversation('Context Map Apply Entity Updates', '/tmp/ws-context-map-apply-entity-updates');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    const target = db.insertEntity({
      entityId: 'ent-target',
      typeSlug: 'project',
      name: 'Context Map',
      summaryMarkdown: 'Old summary.',
      now: NOW,
    });
    const duplicate = db.insertEntity({
      entityId: 'ent-duplicate',
      typeSlug: 'project',
      name: 'Workspace Graph',
      now: NOW,
    });
    db.addAlias(duplicate.entityId, 'Graph Memory', NOW);
    db.insertCandidate({
      candidateId: 'cand-update',
      runId: 'run-1',
      candidateType: 'entity_update',
      payload: {
        entityId: target.entityId,
        summaryMarkdown: 'Updated summary.',
        aliases: ['CM'],
        facts: ['Context Map supports reviewed edits.'],
      },
      confidence: 0.88,
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-merge',
      runId: 'run-1',
      candidateType: 'entity_merge',
      payload: {
        targetEntityId: target.entityId,
        sourceEntityIds: [duplicate.entityId],
      },
      now: NOW,
    });

    const update = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-update/apply`,
      {},
    );
    const merge = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-merge/apply`,
      {},
    );

    expect(update.status).toBe(200);
    expect(merge.status).toBe(200);
    expect(db.getEntity(target.entityId)).toMatchObject({
      summaryMarkdown: 'Updated summary.',
      confidence: 0.88,
    });
    expect(db.listAliases(target.entityId).map((row) => row.alias)).toEqual(expect.arrayContaining([
      'CM',
      'Workspace Graph',
      'Graph Memory',
    ]));
    expect(db.listFacts(target.entityId)).toMatchObject([
      { statementMarkdown: 'Context Map supports reviewed edits.' },
    ]);
    expect(db.getEntity(duplicate.entityId)).toMatchObject({ status: 'superseded' });
  });

  test('applies relationship update/removal, evidence-link, and conflict candidates', async () => {
    const conv = await env.chatService.createConversation('Context Map Apply Relationship Updates', '/tmp/ws-context-map-apply-rel-updates');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    const project = db.insertEntity({ entityId: 'ent-project', typeSlug: 'project', name: 'Context Map', now: NOW });
    const workflow = db.insertEntity({ entityId: 'ent-workflow', typeSlug: 'workflow', name: 'Review Queue', now: NOW });
    const relationship = db.insertRelationship({
      relationshipId: 'rel-1',
      subjectEntityId: project.entityId,
      predicate: 'uses',
      objectEntityId: workflow.entityId,
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-rel-update',
      runId: 'run-1',
      candidateType: 'relationship_update',
      payload: { relationshipId: relationship.relationshipId, newPredicate: 'depends_on', qualifiers: { mode: 'reviewed' } },
      confidence: 0.77,
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-evidence',
      runId: 'run-1',
      candidateType: 'evidence_link',
      payload: {
        targetKind: 'relationship',
        targetId: relationship.relationshipId,
        evidence: {
          sourceType: 'file',
          sourceId: 'SPEC.md',
          locator: { path: 'docs/SPEC.md' },
          excerpt: 'Context Map is documented.',
        },
      },
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-conflict',
      runId: 'run-1',
      candidateType: 'conflict_flag',
      payload: { entityId: project.entityId },
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-rel-remove',
      runId: 'run-1',
      candidateType: 'relationship_removal',
      payload: { relationshipId: relationship.relationshipId },
      now: NOW,
    });

    const updated = await env.request('POST', `/api/chat/workspaces/${hash}/context-map/candidates/cand-rel-update/apply`, {});
    const evidence = await env.request('POST', `/api/chat/workspaces/${hash}/context-map/candidates/cand-evidence/apply`, {});
    const conflict = await env.request('POST', `/api/chat/workspaces/${hash}/context-map/candidates/cand-conflict/apply`, {});
    const removed = await env.request('POST', `/api/chat/workspaces/${hash}/context-map/candidates/cand-rel-remove/apply`, {});

    expect(updated.status).toBe(200);
    expect(evidence.status).toBe(200);
    expect(conflict.status).toBe(200);
    expect(removed.status).toBe(200);
    expect(db.getRelationship(relationship.relationshipId)).toMatchObject({
      predicate: 'depends_on',
      status: 'superseded',
      confidence: 0.77,
      qualifiers: { mode: 'reviewed' },
    });
    expect(db.listEvidenceForTarget('relationship', relationship.relationshipId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: 'file', sourceId: 'SPEC.md' }),
    ]));
    expect(db.getEntity(project.entityId)).toMatchObject({ status: 'conflict' });
  });

  test('rejects invalid and non-pending candidate applications', async () => {
    const conv = await env.chatService.createConversation('Context Map Apply Bad', '/tmp/ws-context-map-apply-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    const db = env.chatService.getContextMapDb(hash)!;
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-invalid',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { typeSlug: 'project' },
      now: NOW,
    });
    db.insertCandidate({
      candidateId: 'cand-discarded',
      runId: 'run-1',
      candidateType: 'new_entity',
      status: 'discarded',
      payload: { name: 'Nope' },
      now: NOW,
    });

    const invalid = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-invalid/apply`,
      {},
    );
    const discarded = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/context-map/candidates/cand-discarded/apply`,
      {},
    );

    expect(invalid.status).toBe(400);
    expect(discarded.status).toBe(409);
  });
});

describe('Context Map MCP runtime wiring', () => {
  test('enabled workspaces receive read-only Context Map MCP tools on chat sends', async () => {
    const conv = await env.chatService.createConversation('Context Map MCP', '/tmp/ws-context-map-mcp-runtime');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    env.mockBackend.setMockEvents([{ type: 'done' }] as any[]);

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'What is in the reviewed map?',
      backend: 'claude-code',
    });

    expect(res.status).toBe(200);
    expect(env.mockBackend._lastOptions?.mcpServers?.map((server) => server.name)).toContain('agent-cockpit-context-map');
    expect(env.mockBackend._lastOptions?.systemPrompt).toContain('read-only Context Map MCP tools');
  });
});

describe('Context Map reset/archive final processing', () => {
  test('session reset runs a best-effort Context Map final pass before archiving the session', async () => {
    const conv = await env.chatService.createConversation('Context Map Reset Final', '/tmp/ws-context-map-reset-final');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    await env.chatService.addMessage(conv.id, 'user', 'Capture this context before reset.', 'claude-code');
    env.mockBackend.setOneShotImpl(async () => JSON.stringify({ candidates: [] }));

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/reset`, {});

    expect(res.status).toBe(200);
    const db = env.chatService.getContextMapDb(hash)!;
    expect(db.listRuns({ source: 'session_reset' })).toMatchObject([
      { source: 'session_reset', status: 'completed' },
    ]);
    expect(db.listSourceSpans(conv.id)).toHaveLength(1);
  });

  test('archive runs a best-effort Context Map final pass before archiving the conversation', async () => {
    const conv = await env.chatService.createConversation('Context Map Archive Final', '/tmp/ws-context-map-archive-final');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceContextMapEnabled(hash, true);
    await env.chatService.addMessage(conv.id, 'user', 'Capture this context before archive.', 'claude-code');
    env.mockBackend.setOneShotImpl(async () => JSON.stringify({ candidates: [] }));

    const res = await env.request('PATCH', `/api/chat/conversations/${conv.id}/archive`, {});

    expect(res.status).toBe(200);
    const db = env.chatService.getContextMapDb(hash)!;
    expect(db.listRuns({ source: 'archive' })).toMatchObject([
      { source: 'archive', status: 'completed' },
    ]);
    expect(db.listSourceSpans(conv.id)).toHaveLength(1);
  });
});
