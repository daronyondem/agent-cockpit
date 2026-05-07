/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { workspaceHash } from './helpers/workspace';
import type { StreamEvent } from '../src/types';

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

describe('GET /workspaces/:hash/memory', () => {
  test('returns enabled=false and snapshot=null when no snapshot has been captured', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-empty');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await env.request('GET', `/api/chat/workspaces/${hash}/memory`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.snapshot).toBeNull();
  });

  test('returns 200 with null snapshot and enabled for unknown workspace (legacy empty contract)', async () => {
    const res = await env.request('GET', '/api/chat/workspaces/nonexistent999/memory');
    // The new GET endpoint returns a consistent empty shape regardless of
    // whether the workspace index exists; this mirrors the panel UX which
    // treats "unknown" and "no memory yet" identically.
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toBeNull();
    expect(res.body.enabled).toBe(false);
  });

  test('returns the snapshot when one has been saved', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-full');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const snapshot = {
      capturedAt: '2026-04-07T12:00:00.000Z',
      sourceBackend: 'claude-code',
      sourcePath: '/tmp/source-mem',
      index: '- [Pref](user_pref.md)\n',
      files: [
        {
          filename: 'user_pref.md',
          name: 'Pref',
          description: 'A preference',
          type: 'user' as const,
          content: '---\nname: Pref\ndescription: A preference\ntype: user\n---\n\nBody',
        },
      ],
    };
    await env.chatService.saveWorkspaceMemory(hash, snapshot);

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/memory`);
    expect(res.status).toBe(200);
    expect(res.body.snapshot.sourceBackend).toBe('claude-code');
    expect(res.body.snapshot.files).toHaveLength(1);
    // Saved files now live under `claude/` in the merged snapshot.
    expect(res.body.snapshot.files[0].filename).toBe('claude/user_pref.md');
    expect(res.body.snapshot.files[0].type).toBe('user');
    expect(res.body.snapshot.files[0].source).toBe('cli-capture');
    expect(res.body.enabled).toBe(false);
  });
});

describe('GET /workspaces/:hash/memory/search', () => {
  test('rejects an empty query', async () => {
    const conv = await env.chatService.createConversation('Search Bad', '/tmp/ws-mem-search-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/memory/search`);

    expect(res.status).toBe(400);
  });

  test('returns no results while memory is disabled', async () => {
    const conv = await env.chatService.createConversation('Search Disabled', '/tmp/ws-mem-search-disabled');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: disabled\ndescription: TypeScript preference\ntype: user\n---\n\nUse TypeScript.',
      source: 'memory-note',
      filenameHint: 'disabled',
    });

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/memory/search?query=typescript`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, query: 'typescript', results: [] });
  });

  test('searches enabled workspace memory and honors type/status filters', async () => {
    const conv = await env.chatService.createConversation('Search Enabled', '/tmp/ws-mem-search-enabled');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);
    const activePath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: active_pref\ndescription: TypeScript examples\ntype: user\n---\n\nUse TypeScript examples.',
      source: 'memory-note',
      filenameHint: 'active-pref',
    });
    await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: old_pref\ndescription: old TypeScript examples\ntype: user\n---\n\nOld TypeScript guidance.',
      source: 'memory-note',
      filenameHint: 'old-pref',
    });
    const snapshot = await env.chatService.getWorkspaceMemory(hash);
    const oldPath = snapshot!.files.find((file) => file.filename !== activePath)!.filename;
    await env.chatService.patchMemoryEntryMetadata(hash, [{
      filename: oldPath,
      patch: { status: 'superseded' },
    }]);

    const defaultRes = await env.request('GET', `/api/chat/workspaces/${hash}/memory/search?query=typescript&type=user`);
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.enabled).toBe(true);
    expect(defaultRes.body.results.map((result: any) => result.filename)).toEqual([activePath]);
    expect(defaultRes.body.results[0]).toMatchObject({
      filename: activePath,
      type: 'user',
      status: 'active',
      snippet: expect.stringMatching(/TypeScript/i),
    });

    const supersededRes = await env.request(
      'GET',
      `/api/chat/workspaces/${hash}/memory/search?query=typescript&status=superseded`,
    );
    expect(supersededRes.status).toBe(200);
    expect(supersededRes.body.results.map((result: any) => result.filename)).toEqual([oldPath]);
  });
});

describe('POST /workspaces/:hash/memory/consolidate', () => {
  test('proposes and applies safe supersession actions', async () => {
    const conv = await env.chatService.createConversation('Consolidate', '/tmp/ws-mem-consolidate');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);
    const oldPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: old_deadline\ndescription: old deadline\ntype: project\n---\n\nThe deadline is Thursday.',
      source: 'memory-note',
      filenameHint: 'old-deadline',
    });
    const newPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: new_deadline\ndescription: new deadline\ntype: project\n---\n\nThe deadline is Friday.',
      source: 'memory-note',
      filenameHint: 'new-deadline',
    });

    env.mockBackend.setOneShotImpl(async (prompt) => {
      expect(prompt).toContain(oldPath);
      expect(prompt).toContain(newPath);
      return JSON.stringify({
        summary: 'One deadline entry is stale.',
        actions: [{
          action: 'mark_superseded',
          filename: oldPath,
          supersededBy: newPath,
          reason: 'Friday replaces Thursday.',
        }],
      });
    });

    const proposed = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/consolidate/propose`,
      {},
    );
    expect(proposed.status).toBe(200);
    expect(proposed.body.proposal.actions).toEqual([{
      action: 'mark_superseded',
      filename: oldPath,
      supersededBy: newPath,
      reason: 'Friday replaces Thursday.',
    }]);

    const applied = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/consolidate/apply`,
      {
        summary: proposed.body.proposal.summary,
        actions: proposed.body.proposal.actions,
      },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toHaveLength(1);
    expect(applied.body.auditPath).toMatch(/^audits\/consolidation_/);
    expect(applied.body.snapshot.files.find((file: any) => file.filename === oldPath).metadata.status).toBe('superseded');
  });

  test('drafts and applies reviewed consolidation rewrites', async () => {
    const conv = await env.chatService.createConversation('Consolidate Draft', '/tmp/ws-mem-consolidate-draft');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);
    const firstPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: old_testing_a\ndescription: old testing a\ntype: feedback\n---\n\nUse node:test for services.',
      source: 'memory-note',
      filenameHint: 'old-testing-a',
    });
    const secondPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: old_testing_b\ndescription: old testing b\ntype: feedback\n---\n\nUse node:test for service modules.',
      source: 'memory-note',
      filenameHint: 'old-testing-b',
    });

    env.mockBackend.setOneShotImpl(async (prompt) => {
      expect(prompt).toContain('Draft exact');
      expect(prompt).toContain(firstPath);
      expect(prompt).toContain(secondPath);
      return JSON.stringify({
        summary: 'Merge testing preferences.',
        operations: [{
          operation: 'create',
          filenameHint: 'node-test-preference',
          supersedes: [firstPath, secondPath],
          reason: 'Duplicate service testing preferences.',
          content: '---\nname: node_test_preference\ndescription: user prefers node:test for services\ntype: feedback\n---\n\nUse node:test for focused service coverage.',
        }],
      });
    });

    const drafted = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/consolidate/draft`,
      {
        action: {
          action: 'merge_candidates',
          filenames: [firstPath, secondPath],
          reason: 'Duplicate testing preferences.',
        },
      },
    );
    expect(drafted.status).toBe(200);
    expect(drafted.body.draft.operations).toHaveLength(1);

    const applied = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/consolidate/drafts/apply`,
      {
        summary: drafted.body.draft.summary,
        draft: drafted.body.draft,
      },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toHaveLength(1);
    expect(applied.body.createdFiles).toHaveLength(1);
    expect(applied.body.snapshot.files.find((file: any) => file.filename === firstPath).metadata.status).toBe('superseded');
  });

  test('restores a superseded memory entry', async () => {
    const conv = await env.chatService.createConversation('Restore Memory', '/tmp/ws-mem-restore');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);
    const oldPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: old_pref\ndescription: old preference\ntype: user\n---\n\nOld preference.',
      source: 'memory-note',
      filenameHint: 'old-pref',
    });
    const newPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: new_pref\ndescription: new preference\ntype: user\n---\n\nNew preference.',
      source: 'memory-note',
      filenameHint: 'new-pref',
    });
    const snapshot = await env.chatService.getWorkspaceMemory(hash);
    const oldEntryId = snapshot!.files.find((file) => file.filename === oldPath)!.metadata!.entryId;
    const newEntryId = snapshot!.files.find((file) => file.filename === newPath)!.metadata!.entryId;
    await env.chatService.patchMemoryEntryMetadata(hash, [
      { filename: oldPath, patch: { status: 'superseded', supersededBy: newEntryId } },
      { filename: newPath, patch: { supersedes: [oldEntryId] } },
    ]);

    const restored = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/memory/entries/restore`,
      { relPath: oldPath },
    );

    expect(restored.status).toBe(200);
    expect(restored.body.restored.status).toBe('active');
    const oldFile = restored.body.snapshot.files.find((file: any) => file.filename === oldPath);
    const newFile = restored.body.snapshot.files.find((file: any) => file.filename === newPath);
    expect(oldFile.metadata.status).toBe('active');
    expect(oldFile.metadata.supersededBy).toBeUndefined();
    expect(newFile.metadata.supersedes).toBeUndefined();
  });

  test('rejects apply payloads without an actions array', async () => {
    const conv = await env.chatService.createConversation('Consolidate Bad', '/tmp/ws-mem-consolidate-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);

    const res = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/consolidate/apply`,
      { actions: 'all' },
    );

    expect(res.status).toBe(400);
  });

  test('rejects draft apply payloads without operations', async () => {
    const conv = await env.chatService.createConversation('Consolidate Draft Bad', '/tmp/ws-mem-consolidate-draft-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);

    const res = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/consolidate/drafts/apply`,
      { draft: { operations: 'all' } },
    );

    expect(res.status).toBe(400);
  });
});

describe('Memory Review scheduling and runs', () => {
  async function waitForMemoryReviewRun(hash: string, runId: string, status: string): Promise<any> {
    for (let i = 0; i < 50; i += 1) {
      const run = await env.chatService.getMemoryReviewRun(hash, runId);
      if (run?.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for Memory Review ${runId} to reach ${status}`);
  }

  test('persists a workspace Memory Review schedule', async () => {
    const conv = await env.chatService.createConversation('Review Schedule', '/tmp/ws-mem-review-schedule');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const initial = await env.request('GET', `/api/chat/workspaces/${hash}/memory/review-schedule`);
    expect(initial.status).toBe(200);
    expect(initial.body.schedule).toEqual({ mode: 'off' });
    expect(initial.body.status).toMatchObject({ enabled: false, pending: false });

    const put = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/memory/review-schedule`,
      {
        schedule: {
          mode: 'window',
          days: 'weekdays',
          windowStart: '01:00',
          windowEnd: '04:00',
          timezone: 'America/Los_Angeles',
        },
      },
    );
    expect(put.status).toBe(200);
    expect(put.body.schedule).toMatchObject({
      mode: 'window',
      days: 'weekdays',
      windowStart: '01:00',
      windowEnd: '04:00',
      timezone: 'America/Los_Angeles',
    });
    expect(typeof put.body.scheduleUpdatedAt).toBe('string');

    const reloaded = await env.request('GET', `/api/chat/workspaces/${hash}/memory/review-schedule`);
    expect(reloaded.body.schedule).toEqual(put.body.schedule);
    expect(reloaded.body.scheduleUpdatedAt).toBe(put.body.scheduleUpdatedAt);
  });

  test('creates a pending Memory Review run and applies reviewed items', async () => {
    const conv = await env.chatService.createConversation('Review Run', '/tmp/ws-mem-review-run');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);
    const oldPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: old_deadline\ndescription: old deadline\ntype: project\n---\n\nThe deadline is Thursday.',
      source: 'memory-note',
      filenameHint: 'old-deadline',
    });
    const newPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: new_deadline\ndescription: new deadline\ntype: project\n---\n\nThe deadline is Friday.',
      source: 'memory-note',
      filenameHint: 'new-deadline',
    });
    const firstPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: old_testing_a\ndescription: old testing a\ntype: feedback\n---\n\nUse node:test for services.',
      source: 'memory-note',
      filenameHint: 'old-testing-a',
    });
    const secondPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: old_testing_b\ndescription: old testing b\ntype: feedback\n---\n\nUse node:test for service modules.',
      source: 'memory-note',
      filenameHint: 'old-testing-b',
    });

    const proposalOutput = () => JSON.stringify({
      summary: 'Review has one metadata action and one draft.',
      actions: [
        {
          action: 'mark_superseded',
          filename: oldPath,
          supersededBy: newPath,
          reason: 'Friday replaces Thursday.',
        },
        {
          action: 'merge_candidates',
          filenames: [firstPath, secondPath],
          reason: 'Duplicate testing preferences.',
        },
      ],
    });
    const draftOutput = () => JSON.stringify({
      summary: 'Merge testing preferences.',
      operations: [{
        operation: 'create',
        filenameHint: 'node-test-preference',
        supersedes: [firstPath, secondPath],
        reason: 'Duplicate service testing preferences.',
        content: '---\nname: node_test_preference\ndescription: user prefers node:test for services\ntype: feedback\n---\n\nUse node:test for focused service coverage.',
      }],
    });
    let holdNextProposal = true;
    let releaseProposal: (() => void) | null = null;

    env.mockBackend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Draft exact')) {
        expect(prompt).toContain(firstPath);
        expect(prompt).toContain(secondPath);
        return draftOutput();
      }
      if (!holdNextProposal) return proposalOutput();
      holdNextProposal = false;
      return new Promise((resolve) => {
        releaseProposal = () => resolve(proposalOutput());
      });
    });

    const created = await env.request('POST', `/api/chat/workspaces/${hash}/memory/reviews`, {});
    expect(created.status).toBe(202);
    expect(created.body.run.status).toBe('running');
    expect(created.body.run.safeActions).toHaveLength(0);
    expect(created.body.run.drafts).toHaveLength(0);
    expect(created.body.status).toMatchObject({
      enabled: true,
      pending: true,
      pendingRuns: 1,
      latestRunStatus: 'running',
    });
    for (let i = 0; i < 20 && !releaseProposal; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(releaseProposal).toBeTruthy();
    releaseProposal!();

    const completedCreated = await waitForMemoryReviewRun(hash, created.body.run.id, 'pending_review');
    expect(completedCreated.safeActions).toHaveLength(1);
    expect(completedCreated.drafts).toHaveLength(1);
    expect(await env.chatService.getMemoryReviewStatus(hash)).toMatchObject({
      enabled: true,
      pending: true,
      pendingRuns: 1,
      pendingDrafts: 1,
      pendingSafeActions: 1,
    });
    expect(env.mockBackend._oneShotCalls.slice(0, 2).map((call) => call.options?.timeoutMs)).toEqual([
      10 * 60_000,
      10 * 60_000,
    ]);

    const restarted = await env.request('POST', `/api/chat/workspaces/${hash}/memory/reviews`, {});
    expect(restarted.status).toBe(202);
    expect(restarted.body.run.id).not.toBe(created.body.run.id);
    expect(restarted.body.run.status).toBe('running');
    const completedRestarted = await waitForMemoryReviewRun(hash, restarted.body.run.id, 'pending_review');
    expect(await env.chatService.getMemoryReviewStatus(hash)).toMatchObject({
      enabled: true,
      pending: true,
      pendingRuns: 1,
      pendingDrafts: 1,
      pendingSafeActions: 1,
    });

    const retired = await env.request(
      'GET',
      `/api/chat/workspaces/${hash}/memory/reviews/${created.body.run.id}`,
    );
    expect(retired.status).toBe(200);
    expect(retired.body.run.status).toBe('dismissed');
    expect(retired.body.run.safeActions[0].status).toBe('discarded');
    expect(retired.body.run.drafts[0].status).toBe('discarded');

    const convRes = await env.request('GET', `/api/chat/conversations/${conv.id}`);
    expect(convRes.status).toBe(200);
    expect(convRes.body.memoryReview.pending).toBe(true);
    expect(convRes.body.memoryReview.latestRunId).toBe(restarted.body.run.id);

    const draftId = completedRestarted.drafts[0].id;
    const draftDismissed = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/reviews/${restarted.body.run.id}/drafts/${draftId}/discard`,
      {},
    );
    expect(draftDismissed.status).toBe(200);
    expect(draftDismissed.body.run.drafts[0].status).toBe('discarded');

    const draftRegenerated = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/reviews/${restarted.body.run.id}/drafts/${draftId}/regenerate`,
      {},
    );
    expect(draftRegenerated.status).toBe(200);
    expect(draftRegenerated.body.run.drafts[0].status).toBe('pending');
    expect(draftRegenerated.body.run.drafts[0].discardedAt).toBeUndefined();

    const reviewedDraft = draftRegenerated.body.run.drafts[0].draft;
    reviewedDraft.operations[0].content = reviewedDraft.operations[0].content.replace(
      'Use node:test for focused service coverage.',
      'Use node:test for focused service coverage, including REST route tests.',
    );
    const draftApplied = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/reviews/${restarted.body.run.id}/drafts/${draftId}/apply`,
      { draft: reviewedDraft },
    );
    expect(draftApplied.status).toBe(200);
    expect(draftApplied.body.run.drafts[0].status).toBe('applied');
    const createdDraftFile = draftApplied.body.run.drafts[0].result.createdFiles[0];
    const memoryAfterDraftApply = await env.chatService.getWorkspaceMemory(hash);
    const createdDraftMemory = memoryAfterDraftApply!.files.find((file) => file.filename === createdDraftFile)!;
    expect(createdDraftMemory.content).toContain('including REST route tests');

    const actionId = completedRestarted.safeActions[0].id;
    const actionApplied = await env.request(
      'POST',
      `/api/chat/workspaces/${hash}/memory/reviews/${restarted.body.run.id}/actions/${actionId}/apply`,
      {},
    );
    expect(actionApplied.status).toBe(200);
    expect(actionApplied.body.run.safeActions[0].status).toBe('applied');
    expect(actionApplied.body.run.status).toBe('completed');
    expect(actionApplied.body.status.pending).toBe(false);
  });
});

// ── Workspace memory: enable toggle + entry deletion ─────────────────────

describe('PUT /workspaces/:hash/memory/enabled', () => {
  test('persists the enable flag and is round-tripped via GET', async () => {
    const conv = await env.chatService.createConversation('Toggle', '/tmp/ws-mem-toggle');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const put = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/memory/enabled`,
      { enabled: true },
    );
    expect(put.status).toBe(200);
    expect(put.body.enabled).toBe(true);

    const get = await env.request('GET', `/api/chat/workspaces/${hash}/memory`);
    expect(get.status).toBe(200);
    expect(get.body.enabled).toBe(true);
  });

  test('rejects non-boolean enabled values', async () => {
    const conv = await env.chatService.createConversation('Toggle Bad', '/tmp/ws-mem-toggle-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/memory/enabled`,
      { enabled: 'yes' as unknown as boolean },
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /workspaces/:hash/memory/entries/:relpath', () => {
  test('deletes a note entry and returns the updated snapshot', async () => {
    const conv = await env.chatService.createConversation('Del', '/tmp/ws-mem-del');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const relPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: drop\ndescription: drop me\ntype: user\n---\n\nDrop.',
      source: 'memory-note',
      filenameHint: 'drop',
    });

    const res = await env.request(
      'DELETE',
      `/api/chat/workspaces/${hash}/memory/entries/${encodeURIComponent(relPath)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const loaded = await env.chatService.getWorkspaceMemory(hash);
    expect((loaded?.files || []).find((f) => f.filename === relPath)).toBeUndefined();
  });

  test('returns 400 on path traversal attempts', async () => {
    const conv = await env.chatService.createConversation('Traverse', '/tmp/ws-mem-traverse-http');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await env.request(
      'DELETE',
      `/api/chat/workspaces/${hash}/memory/entries/${encodeURIComponent('../../../etc/passwd')}`,
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /workspaces/:hash/memory/entries (bulk)', () => {
  test('clears every memory entry and returns the emptied snapshot', async () => {
    const conv = await env.chatService.createConversation('ClearAll', '/tmp/ws-mem-clear-all');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    // Seed two note entries so there's something to wipe.
    await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: one\ndescription: first\ntype: user\n---\n\nOne.',
      source: 'memory-note',
      filenameHint: 'one',
    });
    await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: two\ndescription: second\ntype: feedback\n---\n\nTwo.',
      source: 'memory-note',
      filenameHint: 'two',
    });

    const beforeClear = await env.chatService.getWorkspaceMemory(hash);
    expect((beforeClear?.files || []).length).toBe(2);

    const res = await env.request(
      'DELETE',
      `/api/chat/workspaces/${hash}/memory/entries`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(2);
    expect((res.body.snapshot?.files || []).length).toBe(0);

    const afterClear = await env.chatService.getWorkspaceMemory(hash);
    expect((afterClear?.files || []).length).toBe(0);
  });

  test('is a no-op (200, deleted: 0) when no entries exist', async () => {
    const conv = await env.chatService.createConversation('ClearEmpty', '/tmp/ws-mem-clear-empty');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request(
      'DELETE',
      `/api/chat/workspaces/${hash}/memory/entries`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(0);
  });
});

// ── Workspace Knowledge Base endpoints ────────────────────────────────────


describe('memory_update WebSocket frame', () => {
  function makeMockMemoryDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-mem-'));
    return dir;
  }

  function writeMemoryFile(dir: string, name: string, body: string) {
    fs.writeFileSync(
      path.join(dir, name),
      `---\nname: ${name}\ndescription: test\ntype: user\n---\n\n${body}`,
    );
  }

  test('emits memory_update frame with all files on first capture during stream', async () => {
    const memDir = makeMockMemoryDir();
    writeMemoryFile(memDir, 'one.md', 'first');

    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-frame-1');
    await env.chatService.setWorkspaceMemoryEnabled(env.chatService.getWorkspaceHashForConv(conv.id)!, true);
    env.mockBackend.setMockMemoryDir(memDir);
    env.mockBackend.setStreamDelayMs(900); // keep stream alive past the 500ms watcher debounce
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws, 5000);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'hello',
      backend: 'claude-code',
    });

    // Trigger a memory file change after the watcher has had time to attach
    await new Promise((r) => setTimeout(r, 100));
    writeMemoryFile(memDir, 'two.md', 'second');

    const events = await eventsPromise;
    fs.rmSync(memDir, { recursive: true, force: true });

    const memUpdate = events.find((e) => e.type === 'memory_update');
    expect(memUpdate).toBeDefined();
    expect(memUpdate.fileCount).toBe(2);
    expect(memUpdate.changedFiles).toEqual(expect.arrayContaining(['one.md', 'two.md']));
    expect(typeof memUpdate.capturedAt).toBe('string');
    expect(memUpdate.sourceConversationId).toBe(conv.id);
    expect(memUpdate.displayInChat).toBe(true);
  });

  test('idle connected workspace conversation receives memory_update from another conversation memory capture', async () => {
    const memDir = makeMockMemoryDir();
    const workspacePath = '/tmp/ws-mem-fanout';
    writeMemoryFile(memDir, 'one.md', 'first');

    const activeConv = await env.chatService.createConversation('Active', workspacePath);
    const idleConv = await env.chatService.createConversation('Idle', workspacePath);
    const hash = env.chatService.getWorkspaceHashForConv(activeConv.id)!;
    expect(env.chatService.getWorkspaceHashForConv(idleConv.id)).toBe(hash);
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);

    env.mockBackend.setMockMemoryDir(memDir);
    env.mockBackend.setStreamDelayMs(900);
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const idleWs = await env.connectWs(idleConv.id);
    const idleMemoryUpdate = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for idle memory_update')), 3000);
      idleWs.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'memory_update') {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });

    const activeWs = await env.connectWs(activeConv.id);
    const activeEventsPromise = env.readWsEvents(activeWs, 5000);

    await env.request('POST', `/api/chat/conversations/${activeConv.id}/message`, {
      content: 'hello',
      backend: 'claude-code',
    });

    await new Promise((r) => setTimeout(r, 100));
    writeMemoryFile(memDir, 'two.md', 'second');

    const frame = await idleMemoryUpdate;
    const activeEvents = await activeEventsPromise;
    idleWs.close();
    fs.rmSync(memDir, { recursive: true, force: true });

    const activeFrame = activeEvents.find((e) => e.type === 'memory_update');
    expect(activeFrame).toBeDefined();
    expect(activeFrame.sourceConversationId).toBe(activeConv.id);
    expect(activeFrame.displayInChat).toBe(true);
    expect(frame.type).toBe('memory_update');
    expect(frame.fileCount).toBe(2);
    expect(frame.changedFiles).toEqual(expect.arrayContaining(['one.md', 'two.md']));
    expect(frame.sourceConversationId).toBe(activeConv.id);
    expect(frame.displayInChat).toBe(false);
  });

  test('changedFiles only includes files that changed since previous frame', async () => {
    const memDir = makeMockMemoryDir();
    writeMemoryFile(memDir, 'a.md', 'A');
    writeMemoryFile(memDir, 'b.md', 'B');

    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-frame-2');
    await env.chatService.setWorkspaceMemoryEnabled(env.chatService.getWorkspaceHashForConv(conv.id)!, true);
    env.mockBackend.setMockMemoryDir(memDir);
    env.mockBackend.setStreamDelayMs(1500);
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'x', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws, 6000);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'hello',
      backend: 'claude-code',
    });

    // First memory burst → first frame should include both files
    await new Promise((r) => setTimeout(r, 100));
    fs.utimesSync(path.join(memDir, 'a.md'), new Date(), new Date()); // touch
    await new Promise((r) => setTimeout(r, 700)); // wait past debounce so a frame fires

    // Second burst: change only b.md
    writeMemoryFile(memDir, 'b.md', 'B-changed');

    const events = await eventsPromise;
    fs.rmSync(memDir, { recursive: true, force: true });

    const memUpdates = events.filter((e) => e.type === 'memory_update');
    expect(memUpdates.length).toBeGreaterThanOrEqual(2);
    // First frame: both files are unknown to the diff state, so both appear
    expect(memUpdates[0].changedFiles).toEqual(expect.arrayContaining(['a.md', 'b.md']));
    // Second frame: only b.md changed
    expect(memUpdates[memUpdates.length - 1].changedFiles).toEqual(['b.md']);
  });

  test('does not emit memory_update when adapter has no memory dir', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-frame-3');
    await env.chatService.setWorkspaceMemoryEnabled(env.chatService.getWorkspaceHashForConv(conv.id)!, true);
    env.mockBackend.setMockMemoryDir(null);
    env.mockBackend.setStreamDelayMs(800);
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws, 4000);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'hello',
      backend: 'claude-code',
    });

    const events = await eventsPromise;
    expect(events.find((e) => e.type === 'memory_update')).toBeUndefined();
  });
});
