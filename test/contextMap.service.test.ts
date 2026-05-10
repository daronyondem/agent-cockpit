import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  ContextMapWorkspaceSettings,
  Conversation,
  ConversationListItem,
  Message,
  Settings,
} from '../src/types';
import type { CliProfileRuntime } from '../src/services/cliProfiles';
import { BackendRegistry } from '../src/services/backends/registry';
import { ContextMapDatabase } from '../src/services/contextMap/db';
import {
  ContextMapScheduler,
  ContextMapService,
  type ContextMapChatService,
} from '../src/services/contextMap/service';
import { MockBackendAdapter } from './helpers/mockBackendAdapter';

let tmpDir: string;
let db: ContextMapDatabase;
let chat: FakeContextMapChatService;
let nowMs: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-map-service-'));
  db = new ContextMapDatabase(path.join(tmpDir, 'state.db'));
  nowMs = Date.parse('2026-05-07T20:00:00.000Z');
  chat = new FakeContextMapChatService(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ContextMapService', () => {
  test('initial scan records one source span and cursor, then skips unchanged conversations', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Map this workspace.', '2026-05-07T20:01:00.000Z'),
      message('msg-2', 'assistant', 'I will track entities later.', '2026-05-07T20:02:00.000Z'),
    ]));
    const service = new ContextMapService({ chatService: chat, now });

    const first = await service.processWorkspace('ws-1');

    expect(first).toMatchObject({
      workspaceHash: 'ws-1',
      source: 'initial_scan',
      spansInserted: 1,
      cursorsUpdated: 1,
      messagesProcessed: 2,
    });
    expect(db.listRuns()).toMatchObject([
      { runId: first.runId, source: 'initial_scan', status: 'completed' },
    ]);
    expect(db.listSourceSpans()).toMatchObject([
      {
        runId: first.runId,
        conversationId: 'conv-1',
        sessionEpoch: 1,
        startMessageId: 'msg-1',
        endMessageId: 'msg-2',
      },
    ]);
    expect(db.getConversationCursor('conv-1')).toMatchObject({
      conversationId: 'conv-1',
      sessionEpoch: 1,
      lastProcessedMessageId: 'msg-2',
    });

    const second = await service.processWorkspace('ws-1');
    expect(second.skippedReason).toBe('no-changes');
    expect(db.listRuns()).toHaveLength(1);
    expect(db.listSourceSpans()).toHaveLength(1);
  });

  test('scheduled scan records only messages after the conversation cursor', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'First turn.', '2026-05-07T20:01:00.000Z'),
      message('msg-2', 'assistant', 'First answer.', '2026-05-07T20:02:00.000Z'),
    ]));
    const service = new ContextMapService({ chatService: chat, now });
    await service.processWorkspace('ws-1');

    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'First turn.', '2026-05-07T20:01:00.000Z'),
      message('msg-2', 'assistant', 'First answer.', '2026-05-07T20:02:00.000Z'),
      message('msg-3', 'user', 'Second turn.', '2026-05-07T20:06:00.000Z'),
    ]));
    const second = await service.processWorkspace('ws-1');

    expect(second).toMatchObject({
      source: 'scheduled',
      spansInserted: 1,
      messagesProcessed: 1,
    });
    expect(db.listSourceSpans()).toMatchObject([
      { startMessageId: 'msg-1', endMessageId: 'msg-2' },
      { startMessageId: 'msg-3', endMessageId: 'msg-3' },
    ]);
    expect(db.getConversationCursor('conv-1')).toMatchObject({
      lastProcessedMessageId: 'msg-3',
    });
  });

  test('changed last processed message creates a replacement span instead of skipping', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'First turn.', '2026-05-07T20:01:00.000Z'),
      message('msg-2', 'assistant', 'Draft answer.', '2026-05-07T20:02:00.000Z'),
    ]));
    const service = new ContextMapService({ chatService: chat, now });
    await service.processWorkspace('ws-1');

    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'First turn.', '2026-05-07T20:01:00.000Z'),
      message('msg-2', 'assistant', 'Final answer.', '2026-05-07T20:03:00.000Z'),
    ]));
    const second = await service.processWorkspace('ws-1');

    expect(second).toMatchObject({
      source: 'scheduled',
      spansInserted: 1,
      messagesProcessed: 1,
    });
    expect(db.listSourceSpans()).toMatchObject([
      { startMessageId: 'msg-1', endMessageId: 'msg-2' },
      { startMessageId: 'msg-2', endMessageId: 'msg-2' },
    ]);
  });

  test('processor output creates pending review candidates for new source spans', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'We decided Context Map should keep a review queue.', '2026-05-07T20:01:00.000Z'),
      message('msg-2', 'assistant', 'I will track the Context Map project and review queue relationship.', '2026-05-07T20:02:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      expect(prompt).toContain('msg-1');
      expect(prompt).toContain('Context Map Test');
      expect(prompt).toContain('ordinary filenames');
      return JSON.stringify({
        candidates: [
          {
            type: 'new_entity',
            confidence: 0.79,
            payload: {
              typeSlug: 'project',
              name: 'Context Map',
              summaryMarkdown: 'Workspace graph feature with reviewed updates.',
            },
          },
          {
            type: 'new_entity',
            confidence: 0.71,
            payload: {
              typeSlug: 'workflow',
              name: 'Review Queue',
              summaryMarkdown: 'Governed review workflow for Context Map suggestions.',
            },
          },
          {
            type: 'new_entity',
            confidence: 0.71,
            payload: {
              typeSlug: 'asset',
              name: 'openai-codex-logo-unofficial.svg',
              summaryMarkdown: 'A local SVG file mentioned in the conversation.',
            },
          },
          {
            type: 'new_entity',
            confidence: 0.69,
            payload: {
              typeSlug: 'workspace',
              name: 'workspace',
              summaryMarkdown: 'The local workspace folder.',
            },
          },
          {
            type: 'new_relationship',
            confidence: 0.65,
            payload: {
              subjectName: 'Context Map',
              predicate: 'references',
              objectName: 'SAMPLE_PLAN.md',
            },
          },
          {
            type: 'new_relationship',
            confidence: 0.72,
            payload: {
              subjectName: 'Context Map',
              predicate: 'uses',
              objectName: 'Review Queue',
              evidenceMarkdown: 'The conversation says the Context Map project uses a governed review queue.',
            },
          },
        ],
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result).toMatchObject({
      spansInserted: 1,
      candidatesCreated: 3,
    });
    expect(backend._oneShotCalls).toHaveLength(1);
    expect(backend._oneShotCalls[0].options).toMatchObject({
      timeoutMs: 120000,
      workingDir: '/tmp/workspace',
      allowTools: false,
      cliProfile: expect.objectContaining({ vendor: 'claude-code' }),
    });
    const candidates = db.listCandidates('pending');
    expect(candidates).toHaveLength(3);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: result.runId,
        candidateType: 'new_entity',
        confidence: 0.79,
        payload: expect.objectContaining({
          typeSlug: 'project',
          name: 'Context Map',
          sourceSpan: expect.objectContaining({
            conversationId: 'conv-1',
            startMessageId: 'msg-1',
            endMessageId: 'msg-2',
            sourceType: 'conversation_message',
          }),
        }),
      }),
      expect.objectContaining({
        runId: result.runId,
        candidateType: 'new_relationship',
        confidence: 0.72,
      }),
    ]));
  });

  test('auto-applies high-confidence safe candidates while leaving risky candidates pending', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'The Active Map should be transparent and self-maintaining.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.97,
          payload: {
            typeSlug: 'feature',
            name: 'Transparent Context Map Maintenance',
            summaryMarkdown: 'Context Map updates the active graph automatically for safe high-confidence discoveries.',
          },
        },
        {
          type: 'conflict_flag',
          confidence: 0.97,
          payload: {
            entityName: 'Transparent Context Map Maintenance',
            issueMarkdown: 'Conflicts should still require attention.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(2);
    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Transparent Context Map Maintenance' }),
      }),
    ]);
    expect(db.listCandidates('pending')).toEqual([
      expect.objectContaining({ candidateType: 'conflict_flag' }),
    ]);
    expect(db.listEntities({ status: 'active' })).toEqual([
      expect.objectContaining({
        typeSlug: 'feature',
        name: 'Transparent Context Map Maintenance',
      }),
    ]);
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidatesInserted: 2,
      candidatesAutoApplied: 1,
      candidatesNeedingAttention: 1,
    });
    const activeCandidate = db.listCandidates('active')[0];
    expect(db.listAuditEvents('candidate', activeCandidate.candidateId)).toEqual([
      expect.objectContaining({
        eventType: 'applied',
        details: expect.objectContaining({ appliedBy: 'processor' }),
      }),
    ]);
  });

  test('does not auto-apply relationships that depend on pending endpoint entities', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A relationship can be safe only after both endpoint entities are active.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.96,
          payload: {
            typeSlug: 'workflow',
            name: 'Published Article Workflow',
            summaryMarkdown: 'High-confidence workflow that can apply automatically.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.79,
          payload: {
            typeSlug: 'tool',
            name: 'Shared Browser Profile',
            summaryMarkdown: 'Lower-confidence endpoint that should remain pending.',
          },
        },
        {
          type: 'new_relationship',
          confidence: 0.96,
          payload: {
            subjectName: 'Published Article Workflow',
            predicate: 'uses',
            objectName: 'Shared Browser Profile',
            evidenceMarkdown: 'The workflow uses the shared browser profile.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1');

    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Published Article Workflow' }),
      }),
    ]);
    expect(db.listCandidates('pending').map((candidate) => candidate.candidateType).sort()).toEqual([
      'new_entity',
      'new_relationship',
    ]);
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidatesInserted: 3,
      candidatesAutoApplied: 1,
      candidatesNeedingAttention: 2,
      autoApplyFailures: [],
    });
  });

  test('auto-applies lower-confidence relationships only when endpoints are already active', async () => {
    db.insertEntity({
      entityId: 'ent-workflow',
      typeSlug: 'workflow',
      name: 'Article Workflow',
      summaryMarkdown: 'Existing workflow.',
      now: now().toISOString(),
    });
    db.insertEntity({
      entityId: 'ent-tool',
      typeSlug: 'tool',
      name: 'Shared Browser Profile',
      summaryMarkdown: 'Existing tool.',
      now: now().toISOString(),
    });
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'The article workflow uses the shared browser profile.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_relationship',
          confidence: 0.84,
          payload: {
            subjectName: 'Article Workflow',
            predicate: 'uses',
            objectName: 'Shared Browser Profile',
            evidenceMarkdown: 'The article workflow uses the shared browser profile.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1');

    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({ candidateType: 'new_relationship' }),
    ]);
    expect(db.listCandidates('pending')).toEqual([]);
    expect(db.listRelationshipsForEntity('ent-workflow')).toEqual([
      expect.objectContaining({
        subjectEntityId: 'ent-workflow',
        predicate: 'uses',
        objectEntityId: 'ent-tool',
      }),
    ]);
  });

  test('auto-applies high-confidence sensitive additive entities except secret pointers', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Track a sensitive but durable planning workflow.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.97,
          payload: {
            typeSlug: 'workflow',
            name: 'Private Planning Workflow',
            sensitivity: 'personal-sensitive',
            summaryMarkdown: 'A durable private workflow owned by the workspace user.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.99,
          payload: {
            typeSlug: 'concept',
            name: 'Secret Pointer Example',
            sensitivity: 'secret-pointer',
            summaryMarkdown: 'Pointer-only material still requires explicit review.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1');

    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ name: 'Private Planning Workflow' }),
      }),
    ]);
    expect(db.listCandidates('pending')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ name: 'Secret Pointer Example' }),
      }),
    ]);
  });

  test('auto-applies safe entity candidates at calibrated confidence and leaves lower confidence pending', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Track two durable workflows with different confidence.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.81,
          payload: {
            typeSlug: 'workflow',
            name: 'High Confidence Workflow',
            summaryMarkdown: 'Safe durable workflow above the auto-apply threshold.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.79,
          payload: {
            typeSlug: 'workflow',
            name: 'Needs Review Workflow',
            summaryMarkdown: 'Durable workflow just below the auto-apply threshold.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1');

    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ name: 'High Confidence Workflow' }),
      }),
    ]);
    expect(db.listCandidates('pending')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ name: 'Needs Review Workflow' }),
      }),
    ]);
  });

  test('auto-applies additive entity updates but leaves rewrites pending', async () => {
    db.insertEntity({
      entityId: 'ent-existing-workflow',
      typeSlug: 'workflow',
      name: 'Existing Workflow',
      summaryMarkdown: 'Reviewed summary stays intact.',
      sensitivity: 'normal',
      now: now().toISOString(),
    });
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Existing Workflow now has a new additive fact.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'entity_update',
          confidence: 0.93,
          payload: {
            entityName: 'Existing Workflow',
            typeSlug: 'workflow',
            aliases: ['Workflow Alias'],
            facts: ['Existing Workflow has a newly discovered additive fact.'],
          },
        },
        {
          type: 'entity_update',
          confidence: 0.95,
          payload: {
            entityName: 'Existing Workflow',
            typeSlug: 'workflow',
            summaryMarkdown: 'A replacement summary still needs review.',
            facts: ['This fact should wait because the update rewrites the summary.'],
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1');

    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        candidateType: 'entity_update',
        payload: expect.objectContaining({ aliases: ['Workflow Alias'] }),
      }),
    ]);
    expect(db.listCandidates('pending')).toEqual([
      expect.objectContaining({
        candidateType: 'entity_update',
        payload: expect.objectContaining({ summaryMarkdown: 'A replacement summary still needs review.' }),
      }),
    ]);
    expect(db.getEntity('ent-existing-workflow')).toEqual(expect.objectContaining({
      summaryMarkdown: 'Reviewed summary stays intact.',
    }));
    expect(db.listAliases('ent-existing-workflow')).toEqual([
      expect.objectContaining({ alias: 'Workflow Alias' }),
    ]);
    expect(db.listFacts('ent-existing-workflow')).toEqual([
      expect.objectContaining({ statementMarkdown: 'Existing Workflow has a newly discovered additive fact.' }),
    ]);
  });

  test('re-evaluates existing pending candidates with the current auto-apply policy during later runs', async () => {
    db.insertCandidate({
      candidateId: 'cm-cand-existing-pending',
      candidateType: 'new_entity',
      confidence: 0.81,
      payload: {
        typeSlug: 'project',
        name: 'Previously Pending Program',
        summaryMarkdown: 'Durable project that became eligible after policy calibration.',
        sourceSpan: {
          sourceType: 'file',
          sourceId: 'context/previously-pending.md',
          locator: { path: 'context/previously-pending.md' },
        },
      },
      now: now().toISOString(),
    });
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Trigger a later Context Map run.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({ candidates: [] }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(0);
    expect(db.getCandidate('cm-cand-existing-pending')).toEqual(expect.objectContaining({
      status: 'active',
    }));
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidatesInserted: 0,
      candidatesAutoApplied: 1,
      existingCandidatesAutoApplied: 1,
      candidatesNeedingAttention: 0,
    });
  });

  test('normalizes object-shaped fact payloads before persistence', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'The processor may return facts as markdown objects.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'person',
            name: 'Example Person',
            facts: [
              { markdown: 'Owns the durable planning thread.' },
              { text: 'Coordinates the review workflow.' },
              { value: 'Coordinates the review workflow.' },
            ],
            factsMarkdown: [
              { statementMarkdown: 'Keeps related contacts organized.' },
              'Uses weekly planning checkpoints.',
            ],
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1');

    expect(db.listCandidates()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
            facts: [
              'Owns the durable planning thread.',
              'Coordinates the review workflow.',
              'Keeps related contacts organized.',
              'Uses weekly planning checkpoints.',
            ],
          }),
        }),
      ]);
    expect(db.listCandidates()[0].payload).not.toHaveProperty('factsMarkdown');
  });

  test('corrects file-source sensitivity without downgrading secret pointers', async () => {
    chat.workspacePath = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'context'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'context', 'aws.md'), 'Work operating workflow notes.');
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'workflow',
            name: 'Cloud Partner Workflow',
            sensitivity: 'personal-sensitive',
            summaryMarkdown: 'Work operating workflow sourced from cloud partner notes.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.81,
          payload: {
            typeSlug: 'concept',
            name: 'Credential Pointer',
            sensitivity: 'secret-pointer',
            summaryMarkdown: 'Pointer-only sensitive material.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(db.listCandidates()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          name: 'Cloud Partner Workflow',
          sensitivity: 'work-sensitive',
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          name: 'Credential Pointer',
          sensitivity: 'secret-pointer',
        }),
      }),
    ]));
  });

  test('does not mark software client terminology as work-sensitive from path alone', async () => {
    chat.workspacePath = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'docs', 'adr'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'adr', '0025-use-mobile-pwa-as-sole-mobile-client.md'),
      'Mobile client architecture decision notes.',
    );
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [{
        type: 'new_entity',
        confidence: 0.82,
        payload: {
          typeSlug: 'decision',
          name: 'Use mobile PWA as sole mobile client',
          sensitivity: 'normal',
          summaryMarkdown: 'Public architecture decision about the mobile client strategy.',
        },
      }],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(db.listCandidates()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          name: 'Use mobile PWA as sole mobile client',
          sensitivity: 'normal',
        }),
      }),
    ]);
  });

  test('drops self-relationships before persistence', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'The planning workflow supports itself is not a useful graph edge.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'workflow',
            name: 'Planning Workflow',
            summaryMarkdown: 'Durable planning workflow.',
          },
        },
        {
          type: 'new_relationship',
          confidence: 0.94,
          payload: {
            subjectName: 'Planning Workflow',
            predicate: 'supports',
            objectName: 'Planning Workflow',
            evidenceMarkdown: 'The extracted endpoints point to the same entity.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(1);
    expect(db.listCandidates()).toEqual([
      expect.objectContaining({ candidateType: 'new_entity' }),
    ]);
  });

  test('synthesizes noisy extraction output into fewer higher-value candidates', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A broad context scan found several overlapping workspace concepts.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map synthesis processor')) {
        expect(prompt).toContain('sourceRefs');
        expect(prompt).toContain('candidate-1');
        expect(prompt).toContain('candidate-8');
        return JSON.stringify({
          candidates: [
            {
              sourceRefs: ['candidate-1', 'candidate-2'],
              type: 'new_entity',
              confidence: 0.9,
              payload: {
                typeSlug: 'project',
                name: 'Alpha Program',
                summaryMarkdown: 'Consolidated durable project context for Alpha.',
                aliases: ['Alpha Workspace'],
              },
            },
            {
              sourceRefs: ['candidate-3'],
              type: 'new_entity',
              confidence: 0.86,
              payload: {
                typeSlug: 'workflow',
                name: 'Alpha Review Workflow',
                summaryMarkdown: 'Repeatable workflow for reviewing Alpha work.',
              },
            },
          ],
          dropped: [
            { sourceRef: 'candidate-4', reason: 'too narrow' },
            { sourceRef: 'candidate-5', reason: 'too narrow' },
            { sourceRef: 'candidate-6', reason: 'too narrow' },
            { sourceRef: 'candidate-7', reason: 'too narrow' },
            { sourceRef: 'candidate-8', reason: 'too narrow' },
          ],
          openQuestions: ['Confirm the owner for Alpha Program.'],
        });
      }
      return JSON.stringify({
        candidates: [
          { type: 'new_entity', confidence: 0.83, payload: { typeSlug: 'project', name: 'Alpha Program', summaryMarkdown: 'Durable Alpha project context.' } },
          { type: 'new_entity', confidence: 0.82, payload: { typeSlug: 'project', name: 'Alpha Workspace', summaryMarkdown: 'Adjacent Alpha workspace context.' } },
          { type: 'new_entity', confidence: 0.84, payload: { typeSlug: 'workflow', name: 'Alpha Review Workflow', summaryMarkdown: 'Review workflow for Alpha.' } },
          { type: 'new_entity', confidence: 0.81, payload: { typeSlug: 'concept', name: 'Alpha Notes', summaryMarkdown: 'A narrow supporting concept.' } },
          { type: 'new_entity', confidence: 0.81, payload: { typeSlug: 'concept', name: 'Alpha Draft Queue', summaryMarkdown: 'A narrow supporting concept.' } },
          { type: 'new_entity', confidence: 0.81, payload: { typeSlug: 'concept', name: 'Alpha Session Marker', summaryMarkdown: 'A narrow supporting concept.' } },
          { type: 'new_entity', confidence: 0.81, payload: { typeSlug: 'concept', name: 'Alpha Checklist Item', summaryMarkdown: 'A narrow supporting concept.' } },
          { type: 'new_entity', confidence: 0.81, payload: { typeSlug: 'concept', name: 'Alpha Scratch Decision', summaryMarkdown: 'A narrow supporting concept.' } },
        ],
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(2);
    expect(backend._oneShotCalls).toHaveLength(2);
    expect(backend._oneShotCalls[1].options).toMatchObject({
      timeoutMs: 180000,
      workingDir: '/tmp/workspace',
      allowTools: false,
    });
    expect(db.listCandidates()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateType: 'new_entity',
        status: 'active',
        confidence: 0.9,
        payload: expect.objectContaining({
          typeSlug: 'project',
          name: 'Alpha Program',
          aliases: expect.arrayContaining(['Alpha Workspace']),
          sourceSpan: expect.objectContaining({ conversationId: 'conv-1' }),
        }),
      }),
      expect.objectContaining({
        candidateType: 'new_entity',
        status: 'active',
        payload: expect.objectContaining({
          typeSlug: 'workflow',
          name: 'Alpha Review Workflow',
        }),
      }),
    ]));
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidateSynthesis: {
        attempted: true,
        inputCandidates: 8,
        outputCandidates: 2,
        droppedCandidates: 6,
        openQuestions: ['Confirm the owner for Alpha Program.'],
      },
      candidatesInserted: 2,
    });
  });

  test('keeps synthesized source candidate ids stable across manual rebuilds', async () => {
    chat.workspacePath = tmpDir;
    chat.instructions = 'Instruction source describes durable alpha context.';
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'README source describes the same durable alpha context.');
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map synthesis processor')) {
        return JSON.stringify({
          candidates: [
            {
              sourceRefs: ['candidate-1', 'candidate-5'],
              type: 'new_entity',
              confidence: 0.91,
              payload: {
                typeSlug: 'concept',
                name: 'Durable Alpha Context',
                summaryMarkdown: 'Merged source-backed context from instructions and README.',
                sensitivity: 'secret-pointer',
              },
            },
          ],
        });
      }
      const prefix = prompt.includes('"sourceId":"workspace-instructions"') ? 'Instruction' : 'Readme';
      return JSON.stringify({
        candidates: Array.from({ length: 4 }, (_item, index) => ({
          type: 'new_entity',
          confidence: 0.84,
          payload: {
            typeSlug: 'concept',
            name: `${prefix} Candidate ${index + 1}`,
            summaryMarkdown: `${prefix} context candidate ${index + 1}.`,
            sensitivity: 'secret-pointer',
          },
        })),
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const first = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });
    const firstCandidateIds = db.listCandidates().map((candidate) => candidate.candidateId);
    const second = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(first.candidatesCreated).toBe(1);
    expect(second.candidatesCreated).toBe(0);
    expect(db.listCandidates().map((candidate) => candidate.candidateId)).toEqual(firstCandidateIds);
    expect(db.listCandidates()[0].payload.relatedSourceSpans).toHaveLength(2);
  });

  test('scheduled scans synthesize smaller candidate batches than initial scans', async () => {
    chat.workspacePath = path.join(tmpDir, 'missing-workspace');
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A scheduled incremental scan found three related concepts.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map synthesis processor')) {
        return JSON.stringify({
          candidates: [{
            sourceRefs: ['candidate-1', 'candidate-2', 'candidate-3'],
            type: 'new_entity',
            confidence: 0.9,
            payload: {
              typeSlug: 'project',
              name: 'Scheduled Incremental Program',
              summaryMarkdown: 'Consolidated from a small scheduled batch.',
            },
          }],
          openQuestions: [],
        });
      }
      return JSON.stringify({
        candidates: [
          { type: 'new_entity', confidence: 0.84, payload: { typeSlug: 'project', name: 'Scheduled Program', summaryMarkdown: 'Durable scheduled project context.' } },
          { type: 'new_entity', confidence: 0.83, payload: { typeSlug: 'workflow', name: 'Scheduled Workflow', summaryMarkdown: 'Durable scheduled workflow context.' } },
          { type: 'new_entity', confidence: 0.82, payload: { typeSlug: 'concept', name: 'Scheduled Concept', summaryMarkdown: 'Durable scheduled concept context.' } },
        ],
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'scheduled' });

    expect(result.candidatesCreated).toBe(1);
    expect(backend._oneShotCalls).toHaveLength(2);
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidateSynthesis: {
        attempted: true,
        inputCandidates: 3,
        outputCandidates: 1,
      },
    });
  });

  test('initial scans keep the normal synthesis threshold for small candidate batches', async () => {
    chat.workspacePath = path.join(tmpDir, 'missing-workspace');
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'An initial scan found three related concepts.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      expect(prompt).not.toContain('Context Map synthesis processor');
      return JSON.stringify({
        candidates: [
          { type: 'new_entity', confidence: 0.84, payload: { typeSlug: 'project', name: 'Initial Program', summaryMarkdown: 'Durable initial project context.' } },
          { type: 'new_entity', confidence: 0.83, payload: { typeSlug: 'workflow', name: 'Initial Workflow', summaryMarkdown: 'Durable initial workflow context.' } },
          { type: 'new_entity', confidence: 0.82, payload: { typeSlug: 'concept', name: 'Initial Concept', summaryMarkdown: 'Durable initial concept context.' } },
        ],
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(3);
    expect(backend._oneShotCalls).toHaveLength(1);
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidateSynthesis: {
        attempted: false,
        inputCandidates: 3,
        outputCandidates: 3,
      },
    });
  });

  test('falls back to deterministic candidates when synthesis output is malformed', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A broad context scan should survive a synthesis failure.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map synthesis processor')) return 'not json';
      return JSON.stringify({
        candidates: Array.from({ length: 8 }, (_item, index) => ({
          type: 'new_entity',
          confidence: 0.8,
          payload: {
            typeSlug: 'concept',
            name: `Fallback Concept ${index + 1}`,
            summaryMarkdown: 'Durable enough to keep when synthesis fails.',
          },
        })),
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(8);
    expect(db.listCandidates()).toHaveLength(8);
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidateSynthesis: {
        attempted: true,
        inputCandidates: 8,
        outputCandidates: 8,
        droppedCandidates: 0,
        fallback: true,
        errorMessage: expect.stringContaining('no JSON object'),
      },
    });
  });

  test('repairs malformed synthesis JSON before using deterministic fallback', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A broad context scan can be repaired if synthesis only malformed JSON.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map JSON repair processor')) {
        return JSON.stringify({
          candidates: [
            {
              sourceRefs: ['candidate-1', 'candidate-2'],
              type: 'new_entity',
              confidence: 0.86,
              payload: {
                typeSlug: 'project',
                name: 'Repaired Program',
                summaryMarkdown: 'Repaired synthesis output.',
              },
            },
          ],
          openQuestions: [],
        });
      }
      if (prompt.includes('Context Map synthesis processor')) return '{"candidates":[';
      return JSON.stringify({
        candidates: Array.from({ length: 8 }, (_item, index) => ({
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'concept',
            name: `Repair Input ${index + 1}`,
            summaryMarkdown: 'Input candidate for repair.',
          },
        })),
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(1);
    expect(backend._oneShotCalls).toHaveLength(3);
    expect(db.listCandidates()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ name: 'Repaired Program' }),
      }),
    ]);
    const synthesis = (db.listRuns()[0].metadata || {}).candidateSynthesis as {
      attempted: boolean;
      fallback?: boolean;
      stages: Array<Record<string, unknown>>;
    };
    expect(synthesis.fallback).toBeUndefined();
    expect(synthesis).toMatchObject({
      attempted: true,
      stages: [
        expect.objectContaining({
          repairAttempted: true,
          repairSucceeded: true,
        }),
      ],
    });
  });

  test('locally repairs missing commas between synthesized JSON array objects', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A broad context scan can recover common malformed synthesis JSON locally.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map JSON repair processor')) {
        throw new Error('local repair should avoid the processor repair pass');
      }
      if (prompt.includes('Context Map synthesis processor')) {
        return [
          '{"candidates":[',
          '{"sourceRefs":["candidate-1"],"type":"new_entity","confidence":0.86,"payload":{"typeSlug":"project","name":"Locally Repaired Program","summaryMarkdown":"First locally repaired synthesis item.","aliases":["Local Program" "Recovered Program"]}}',
          '{"sourceRefs":["candidate-2"],"type":"new_entity","confidence":0.86,"payload":{"typeSlug":"workflow","name":"Locally Repaired Workflow","summaryMarkdown":"Second locally repaired synthesis item."}}',
          '],"openQuestions":[]}',
        ].join('');
      }
      return JSON.stringify({
        candidates: Array.from({ length: 8 }, (_item, index) => ({
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'concept',
            name: `Local Repair Input ${index + 1}`,
            summaryMarkdown: 'Input candidate for local synthesis repair.',
          },
        })),
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(2);
    expect(backend._oneShotCalls).toHaveLength(2);
    expect(db.listCandidates().map((candidate) => candidate.payload.name).sort()).toEqual([
      'Locally Repaired Program',
      'Locally Repaired Workflow',
    ]);
    const synthesis = (db.listRuns()[0].metadata || {}).candidateSynthesis as {
      fallback?: boolean;
      stages: Array<Record<string, unknown>>;
    };
    expect(synthesis.fallback).toBeUndefined();
    expect(synthesis.stages).toHaveLength(1);
    expect(synthesis.stages[0]).not.toHaveProperty('repairAttempted');
    expect(synthesis.stages[0]).not.toHaveProperty('repairSucceeded');
  });

  test('uses chunked synthesis plus a final arbiter pass for large candidate sets', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A large scan should be reduced in stages.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map synthesis processor')) {
        if (prompt.includes('"stage":"final"')) {
          expect(prompt).toContain('"mode":"arbiter_decisions"');
          expect(prompt).toContain('keepRefs');
          return JSON.stringify({
            keepRefs: [],
            dropRefs: ['candidate-3', 'candidate-4', 'candidate-5', 'candidate-6', 'candidate-8', 'candidate-9', 'candidate-10'],
            mergeGroups: [
              {
                sourceRefs: ['candidate-1', 'candidate-2'],
                canonicalRef: 'candidate-1',
                typeSlug: 'project',
                name: 'Large Scan Program',
                summaryMarkdown: 'Final synthesized project from chunk outputs.',
              },
              {
                sourceRefs: ['candidate-7'],
                canonicalRef: 'candidate-7',
                typeSlug: 'workflow',
                name: 'Large Scan Review Workflow',
                summaryMarkdown: 'Final synthesized workflow from chunk outputs.',
              },
            ],
            typeCorrections: [],
            relationshipToFactRefs: [],
          });
        }
        const outputCount = prompt.includes('"inputCandidates":36') ? 6 : 4;
        return JSON.stringify({
          candidates: Array.from({ length: outputCount }, (_item, index) => ({
            sourceRefs: [`candidate-${index + 1}`],
            type: 'new_entity',
            confidence: 0.84,
            payload: {
              typeSlug: index % 2 === 0 ? 'project' : 'workflow',
              name: `Chunk Candidate ${prompt.includes('"inputCandidates":36') ? 'A' : 'B'} ${index + 1}`,
              summaryMarkdown: 'Reduced chunk candidate.',
            },
          })),
        });
      }
      return JSON.stringify({
        candidates: Array.from({ length: 45 }, (_item, index) => ({
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'concept',
            name: `Large Extracted Concept ${index + 1}`,
            summaryMarkdown: 'Large extracted candidate.',
          },
        })),
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(2);
    expect(backend._oneShotCalls).toHaveLength(4);
    const synthesisPrompts = backend._oneShotCalls.slice(1).map((call) => call.prompt);
    expect(synthesisPrompts.filter((prompt) => prompt.includes('"stage":"chunk"'))).toHaveLength(2);
    expect(synthesisPrompts.filter((prompt) => prompt.includes('"stage":"final"'))).toHaveLength(1);
    expect(db.listCandidates()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Large Scan Program' }),
      }),
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Large Scan Review Workflow' }),
      }),
    ]));
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidateSynthesis: {
        attempted: true,
        inputCandidates: 45,
        outputCandidates: 2,
        stages: [
          expect.objectContaining({ stage: 'chunk', durationMs: expect.any(Number), inputCandidates: 36, outputCandidates: 6 }),
          expect.objectContaining({ stage: 'chunk', durationMs: expect.any(Number), inputCandidates: 9, outputCandidates: 4 }),
          expect.objectContaining({ stage: 'final', durationMs: expect.any(Number), inputCandidates: 10, outputCandidates: 2 }),
        ],
      },
      timings: {
        totalMs: expect.any(Number),
        planningMs: expect.any(Number),
        sourceDiscoveryMs: expect.any(Number),
        extractionMs: expect.any(Number),
        synthesisMs: expect.any(Number),
        persistenceMs: expect.any(Number),
        autoApplyMs: expect.any(Number),
        synthesisStages: [
          expect.objectContaining({ stage: 'chunk', durationMs: expect.any(Number) }),
          expect.objectContaining({ stage: 'chunk', durationMs: expect.any(Number) }),
          expect.objectContaining({ stage: 'final', durationMs: expect.any(Number) }),
        ],
      },
    });
  });

  test('runs synthesis chunks concurrently while preserving stage order and the global cap', async () => {
    chat.settings.contextMap = {
      ...(chat.settings.contextMap || {}),
      synthesisConcurrency: 2,
    };
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A very large extraction should be chunked.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    let activeSynthesis = 0;
    let maxActiveSynthesis = 0;
    let synthesisStarted = 0;
    const releases: Array<() => void> = [];
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map synthesis processor')) {
        synthesisStarted += 1;
        activeSynthesis += 1;
        maxActiveSynthesis = Math.max(maxActiveSynthesis, activeSynthesis);
        const chunkId = /"chunkId":"([^"]+)"/.exec(prompt)?.[1] || 'unknown';
        return new Promise<string>((resolve) => {
          releases.push(() => {
            activeSynthesis -= 1;
            resolve(JSON.stringify({
              candidates: [{
                sourceRefs: ['candidate-1'],
                type: 'new_entity',
                confidence: 0.85,
                payload: {
                  typeSlug: 'concept',
                  name: `Kept ${chunkId}`,
                  summaryMarkdown: 'Kept from a synthesis chunk.',
                },
              }],
            }));
          });
        });
      }
      return JSON.stringify({
        candidates: Array.from({ length: 145 }, (_item, index) => ({
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'concept',
            name: `Chunked Input ${index + 1}`,
            summaryMarkdown: 'Input candidate for synthesis chunking.',
          },
        })),
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const running = service.processWorkspace('ws-1');
    await waitForCondition(() => synthesisStarted === 2);
    expect(activeSynthesis).toBe(2);
    expect(maxActiveSynthesis).toBe(2);

    releases.shift()?.();
    await waitForCondition(() => synthesisStarted === 3);
    expect(maxActiveSynthesis).toBe(2);
    releases.shift()?.();
    await waitForCondition(() => synthesisStarted === 4);
    expect(maxActiveSynthesis).toBe(2);
    releases.shift()?.();
    await waitForCondition(() => synthesisStarted === 5);
    expect(maxActiveSynthesis).toBe(2);
    while (releases.length > 0) releases.shift()?.();

    const result = await running;

    expect(result.candidatesCreated).toBe(5);
    expect(backend._oneShotCalls.filter((call) => call.prompt.includes('"stage":"chunk"'))).toHaveLength(5);
    const synthesis = (db.listRuns()[0].metadata || {}).candidateSynthesis as {
      stages: Array<{ chunkId?: string; stage: string }>;
    };
    expect(synthesis.stages.map((stage) => stage.chunkId)).toEqual([
      'conversation:conv-1:1',
      'conversation:conv-1:2',
      'conversation:conv-1:3',
      'conversation:conv-1:4',
      'conversation:conv-1:5',
    ]);
    expect(synthesis.stages.every((stage) => stage.stage === 'chunk')).toBe(true);
  });

  test('folds weak same-source entities into a stronger synthesized parent fact', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A workflow note mentioned a low-value local concept.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map synthesis processor')) {
        return JSON.stringify({
          candidates: [
            {
              sourceRefs: ['candidate-1'],
              type: 'new_entity',
              confidence: 0.9,
              payload: {
                typeSlug: 'workflow',
                name: 'Publishing Workflow',
                summaryMarkdown: 'Durable publishing process.',
              },
            },
            {
              sourceRefs: ['candidate-2'],
              type: 'new_entity',
              confidence: 0.72,
              payload: {
                typeSlug: 'concept',
                name: 'Draft Screenshot Choice',
                summaryMarkdown: 'A source-local decision mentioned by the workflow note.',
              },
            },
          ],
        });
      }
      return JSON.stringify({
        candidates: Array.from({ length: 8 }, (_item, index) => ({
          type: 'new_entity',
          confidence: index === 0 ? 0.9 : 0.72,
          payload: {
            typeSlug: index === 0 ? 'workflow' : 'concept',
            name: index === 0 ? 'Publishing Workflow' : `Draft Screenshot Choice ${index}`,
            summaryMarkdown: index === 0 ? 'Durable publishing process.' : 'A source-local detail.',
          },
        })),
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(1);
    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          name: 'Publishing Workflow',
          facts: expect.arrayContaining([
            expect.stringContaining('Draft Screenshot Choice'),
          ]),
        }),
      }),
    ]);
  });

  test('recovers strict relationships from extraction when synthesis keeps both endpoints', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'The publishing workflow uses the editorial calendar.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map synthesis processor')) {
        return JSON.stringify({
          candidates: [
            {
              sourceRefs: ['candidate-1'],
              type: 'new_entity',
              confidence: 0.89,
              payload: {
                typeSlug: 'workflow',
                name: 'Publishing Workflow',
                summaryMarkdown: 'Durable publishing process.',
              },
            },
            {
              sourceRefs: ['candidate-2'],
              type: 'new_entity',
              confidence: 0.87,
              payload: {
                typeSlug: 'tool',
                name: 'Editorial Calendar',
                summaryMarkdown: 'Planning tool used by the publishing workflow.',
              },
            },
          ],
        });
      }
      return JSON.stringify({
        candidates: [
          {
            type: 'new_entity',
            confidence: 0.89,
            payload: {
              typeSlug: 'workflow',
              name: 'Publishing Workflow',
              summaryMarkdown: 'Durable publishing process.',
            },
          },
          {
            type: 'new_entity',
            confidence: 0.87,
            payload: {
              typeSlug: 'tool',
              name: 'Editorial Calendar',
              summaryMarkdown: 'Planning tool used by the publishing workflow.',
            },
          },
          {
            type: 'new_relationship',
            confidence: 0.9,
            payload: {
              subjectName: 'Publishing Workflow',
              predicate: 'uses',
              objectName: 'Editorial Calendar',
              evidenceMarkdown: 'The source explicitly says the publishing workflow uses the editorial calendar.',
            },
          },
          ...Array.from({ length: 5 }, (_item, index) => ({
            type: 'new_entity',
            confidence: 0.7,
            payload: {
              typeSlug: 'concept',
              name: `Loose Concept ${index + 1}`,
            },
          })),
        ],
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(3);
    expect(db.listCandidates()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateType: 'new_relationship',
        payload: expect.objectContaining({
          subjectName: 'Publishing Workflow',
          predicate: 'uses',
          objectName: 'Editorial Calendar',
        }),
      }),
    ]));
  });

  test('caps large fallback output when synthesis fails in every stage', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'A large scan should not flood Needs Attention when synthesis fails.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map synthesis processor')) return 'not json';
      return JSON.stringify({
        candidates: Array.from({ length: 90 }, (_item, index) => ({
          type: 'new_entity',
          confidence: index < 10 ? 0.94 : 0.8,
          payload: {
            typeSlug: index < 10 ? 'project' : 'concept',
            name: `Fallback Large Candidate ${index + 1}`,
            summaryMarkdown: 'Large fallback candidate.',
          },
        })),
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(10);
    expect(db.listCandidates('active')).toHaveLength(10);
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidateSynthesis: {
        attempted: true,
        inputCandidates: 90,
        outputCandidates: 10,
        fallback: true,
        fallbackBound: 40,
        stages: [
          expect.objectContaining({ stage: 'chunk', inputCandidates: 36, outputCandidates: 10, fallback: true }),
          expect.objectContaining({ stage: 'chunk', inputCandidates: 36, outputCandidates: 10, fallback: true }),
          expect.objectContaining({ stage: 'chunk', inputCandidates: 18, outputCandidates: 10, fallback: true }),
          expect.objectContaining({ stage: 'final', inputCandidates: 10, outputCandidates: 10, fallback: true }),
        ],
      },
    });
  });

  test('folds same-output sensitivity onto new entities and drops orphan sensitivity candidates', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Environment configuration should be tracked without secrets.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      expect(prompt).toContain('put sensitivity directly');
      return JSON.stringify({
        candidates: [
          {
            type: 'new_entity',
            confidence: 0.88,
            payload: {
              typeSlug: 'concept',
              name: 'Environment configuration',
              summaryMarkdown: 'Configuration pointers without copied secret values.',
            },
          },
          {
            type: 'sensitivity_classification',
            confidence: 0.9,
            payload: {
              entityName: 'Environment configuration',
              sensitivity: 'secret_pointer_only',
              summaryMarkdown: 'Classify the proposed configuration entity as pointer-only.',
            },
          },
          {
            type: 'sensitivity_classification',
            confidence: 0.85,
            payload: {
              entityName: 'Missing environment secrets',
              sensitivity: 'secret-pointer',
              summaryMarkdown: 'No active or proposed entity exists for this target.',
            },
          },
        ],
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(1);
    expect(db.listCandidates()).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        confidence: 0.88,
        payload: expect.objectContaining({
          name: 'Environment configuration',
          sensitivity: 'secret-pointer',
        }),
      }),
    ]);
  });

  test('does not auto-apply sensitivity downgrades', async () => {
    db.insertEntity({
      entityId: 'ent-sensitive',
      typeSlug: 'project',
      name: 'Sensitive Program',
      sensitivity: 'secret-pointer',
      now: '2026-05-07T20:00:00.000Z',
    });
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Sensitive Program can be treated as normal context.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'sensitivity_classification',
          confidence: 0.99,
          payload: {
            entityId: 'ent-sensitive',
            sensitivity: 'normal',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(1);
    expect(db.getEntity('ent-sensitive')).toMatchObject({ sensitivity: 'secret-pointer' });
    expect(db.listCandidates()).toEqual([
      expect.objectContaining({
        candidateType: 'sensitivity_classification',
        status: 'pending',
        confidence: 0.99,
      }),
    ]);
  });

  test('preserves custom entity types only when a reviewed type candidate is proposed', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Track the research lens and a stray unsupported category.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity_type',
          confidence: 0.82,
          payload: {
            typeSlug: 'research_lens',
            label: 'Research lens',
            description: 'A workspace-specific analysis frame.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.84,
          payload: {
            typeSlug: 'research_lens',
            name: 'Strategic positioning lens',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.74,
          payload: {
            typeSlug: 'unsupported_category',
            name: 'Unsupported category entity',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.78,
          payload: {
            typeSlug: 'feature',
            name: 'Context pack assembly',
          },
        },
        {
          type: 'new_entity_type',
          confidence: 0.7,
          payload: {
            typeSlug: 'feature',
            label: 'Feature',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1');

    expect(db.listCandidates('pending')).toHaveLength(4);
    expect(db.listCandidates('pending')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateType: 'new_entity_type',
        payload: expect.objectContaining({ typeSlug: 'research_lens' }),
      }),
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Strategic positioning lens', typeSlug: 'research_lens' }),
      }),
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Unsupported category entity', typeSlug: 'concept' }),
      }),
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Context pack assembly', typeSlug: 'feature' }),
      }),
    ]));
    expect(db.listCandidates('pending').some((candidate) => (
      candidate.candidateType === 'new_entity_type' && candidate.payload.typeSlug === 'feature'
    ))).toBe(false);
  });

  test('emits updates when a processing run starts and completes', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Remember the Launch Workflow.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.86,
          payload: {
            typeSlug: 'workflow',
            name: 'Launch Workflow',
            summaryMarkdown: 'Workflow discovered during processing.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const statuses: string[] = [];
    const service = new ContextMapService({
      chatService: chat,
      now,
      backendRegistry,
      emitUpdate: async () => {
        statuses.push(db.listRuns()[0]?.status || 'none');
      },
    });

    await service.processWorkspace('ws-1');

    expect(statuses).toEqual(['running', 'completed']);
  });

  test('manual scans process high-signal workspace sources into review candidates', async () => {
    chat.settings.contextMap = {
      scanIntervalMinutes: 5,
      cliConcurrency: 1,
    };
    chat.instructions = 'Use Context Map to remember durable workspace relationships.';
    const readmePath = path.join(tmpDir, 'README.md');
    fs.writeFileSync(readmePath, 'README for Context Map workspace scanning.');
    chat.workspacePath = tmpDir;

    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('workspace_instruction')) {
        return JSON.stringify({
          candidates: [{
            type: 'new_entity',
            confidence: 0.8,
            payload: { typeSlug: 'workflow', name: 'Workspace instructions' },
          }],
        });
      }
      return JSON.stringify({ candidates: [] });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(result).toMatchObject({
      source: 'manual_rebuild',
      spansInserted: 0,
      candidatesCreated: 1,
    });
    expect(backend._oneShotCalls).toHaveLength(2);
    expect(db.listRuns()).toMatchObject([
      {
        source: 'manual_rebuild',
        status: 'completed',
        metadata: expect.objectContaining({ sourcePacketsProcessed: 2 }),
      },
    ]);
    expect(db.listCandidates()).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          sourceSpan: expect.objectContaining({
            sourceType: 'workspace_instruction',
            sourceId: 'workspace-instructions',
          }),
        }),
      }),
    ]);
  });

  test('bounds recursively discovered Markdown source packets', async () => {
    chat.workspacePath = tmpDir;
    const docsDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    for (let index = 0; index < 125; index += 1) {
      fs.writeFileSync(path.join(docsDir, `source-${String(index).padStart(3, '0')}.md`), `Source ${index}`);
    }
    db.insertRun({
      runId: 'old-run',
      source: 'manual_rebuild',
      startedAt: '2026-05-07T19:00:00.000Z',
    });
    db.finishRun('old-run', 'completed', '2026-05-07T19:01:00.000Z');
    db.upsertSourceCursor({
      sourceType: 'file',
      sourceId: 'docs/source-124.md',
      lastProcessedSourceHash: 'old-hash',
      lastProcessedAt: '2026-05-07T19:00:00.000Z',
      lastSeenAt: '2026-05-07T19:00:00.000Z',
      lastRunId: 'old-run',
      status: 'active',
      errorMessage: null,
    });
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({ candidates: [] }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(backend._oneShotCalls).toHaveLength(120);
    const currentRun = db.listRuns().find((run) => run.runId !== 'old-run');
    expect(currentRun).toMatchObject({
      source: 'manual_rebuild',
      status: 'completed',
      metadata: expect.objectContaining({
        sourcePacketsDiscovered: 120,
        sourcePacketsProcessed: 120,
        sourceCursorsMarkedMissing: 0,
      }),
    });
    expect(db.getSourceCursor('file', 'docs/source-124.md')).toMatchObject({ status: 'active' });
  });

  test('scheduled scans process changed workspace source packets and skip unchanged ones', async () => {
    chat.workspacePath = tmpDir;
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'First version documents the Source Workflow.');
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Second version')) {
        return JSON.stringify({
          candidates: [{
            type: 'new_entity',
            confidence: 0.91,
            payload: {
              typeSlug: 'workflow',
              name: 'Updated Source Workflow',
              summaryMarkdown: 'Durable workflow from a changed workspace source.',
            },
          }],
        });
      }
      return JSON.stringify({ candidates: [] });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const first = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });
    expect(first).toMatchObject({ source: 'manual_rebuild', candidatesCreated: 0 });
    expect(db.getSourceCursor('file', 'README.md')).toMatchObject({
      sourceType: 'file',
      sourceId: 'README.md',
      status: 'active',
    });

    const unchanged = await service.processWorkspace('ws-1');
    expect(unchanged.skippedReason).toBe('no-changes');
    expect(backend._oneShotCalls).toHaveLength(1);

    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Second version documents the Updated Source Workflow.');
    const changed = await service.processWorkspace('ws-1');

    expect(changed).toMatchObject({
      source: 'scheduled',
      spansInserted: 0,
      candidatesCreated: 1,
    });
    expect(backend._oneShotCalls).toHaveLength(2);
    expect(db.listRuns().find((run) => run.runId === changed.runId)).toMatchObject({
      source: 'scheduled',
      status: 'completed',
      metadata: expect.objectContaining({
        sourcePacketsDiscovered: 1,
        sourcePacketsProcessed: 1,
        sourcePacketsSkippedUnchanged: 0,
        sourcePacketsSucceeded: 1,
      }),
    });
    expect(db.getSourceCursor('file', 'README.md')).toMatchObject({
      status: 'active',
      lastRunId: changed.runId,
    });
    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          name: 'Updated Source Workflow',
          sourceSpan: expect.objectContaining({
            sourceType: 'file',
            sourceId: 'README.md',
          }),
        }),
      }),
    ]);
  });

  test('manual rebuilds reprocess unchanged workspace sources', async () => {
    chat.workspacePath = tmpDir;
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Manual rebuild source packet.');
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({ candidates: [] }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1', { source: 'manual_rebuild' });
    await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(backend._oneShotCalls).toHaveLength(2);
    expect(db.listRuns()).toMatchObject([
      { source: 'manual_rebuild', metadata: expect.objectContaining({ sourcePacketsProcessed: 1 }) },
      { source: 'manual_rebuild', metadata: expect.objectContaining({ sourcePacketsProcessed: 1 }) },
    ]);
  });

  test('scheduled scans mark missing workspace sources stale without deleting graph data', async () => {
    chat.workspacePath = tmpDir;
    const readmePath = path.join(tmpDir, 'README.md');
    fs.writeFileSync(readmePath, 'Stale Source documents a durable workflow.');
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [{
        type: 'new_entity',
        confidence: 0.91,
        payload: {
          typeSlug: 'workflow',
          name: 'Stale Source Workflow',
          summaryMarkdown: 'Durable workflow discovered before the source disappeared.',
        },
      }],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const first = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });
    expect(first.candidatesCreated).toBe(1);
    expect(db.listEntities({ status: 'active' })).toEqual([
      expect.objectContaining({ name: 'Stale Source Workflow' }),
    ]);

    fs.unlinkSync(readmePath);
    const missing = await service.processWorkspace('ws-1');

    expect(missing).toMatchObject({
      source: 'scheduled',
      spansInserted: 0,
      candidatesCreated: 0,
    });
    expect(backend._oneShotCalls).toHaveLength(1);
    expect(db.getSourceCursor('file', 'README.md')).toMatchObject({
      status: 'missing',
      lastRunId: missing.runId,
      errorMessage: expect.stringContaining('not discovered'),
    });
    expect(db.getRun(missing.runId!)).toMatchObject({
      metadata: expect.objectContaining({
      sourcePacketsDiscovered: 0,
      sourcePacketsProcessed: 0,
      sourceCursorsMarkedMissing: 1,
      staleSources: [
        expect.objectContaining({
          sourceType: 'file',
          sourceId: 'README.md',
        }),
      ],
      }),
    });
    expect(db.listEntities({ status: 'active' })).toEqual([
      expect.objectContaining({ name: 'Stale Source Workflow' }),
    ]);

    fs.writeFileSync(readmePath, 'Stale Source documents a durable workflow again.');
    const restored = await service.processWorkspace('ws-1');
    expect(restored).toMatchObject({ source: 'scheduled' });
    expect(backend._oneShotCalls).toHaveLength(2);
    expect(db.getSourceCursor('file', 'README.md')).toMatchObject({
      status: 'active',
      lastRunId: restored.runId,
      errorMessage: null,
    });
  });

  test('scheduled scans mark selected Markdown sources missing when they become unprocessable', async () => {
    chat.workspacePath = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    const sourcePath = path.join(tmpDir, 'notes', 'current.md');
    fs.writeFileSync(sourcePath, 'Current Source documents a durable workflow.');
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({ candidates: [] }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await service.processWorkspace('ws-1', { source: 'manual_rebuild' });
    expect(db.getSourceCursor('file', 'notes/current.md')).toMatchObject({
      status: 'active',
    });

    fs.writeFileSync(sourcePath, '');
    const missing = await service.processWorkspace('ws-1');

    expect(missing).toMatchObject({
      source: 'scheduled',
      candidatesCreated: 0,
    });
    expect(backend._oneShotCalls).toHaveLength(1);
    expect(db.getSourceCursor('file', 'notes/current.md')).toMatchObject({
      status: 'missing',
      lastRunId: missing.runId,
    });
    expect(db.getRun(missing.runId!)).toMatchObject({
      metadata: expect.objectContaining({
        sourcePacketsDiscovered: 0,
        sourcePacketsProcessed: 0,
        sourceCursorsMarkedMissing: 1,
      }),
    });
  });

  test('manual scans include bounded code outline packets for software workspaces', async () => {
    chat.workspacePath = tmpDir;
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'context-map-code-test',
      scripts: { test: 'jest' },
      dependencies: { express: '^4.0.0' },
    }));
    fs.mkdirSync(path.join(tmpDir, 'src', 'services'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'services', 'exampleService.ts'), [
      "import express from 'express';",
      'export class ExampleService {}',
      "router.get('/api/example', handler);",
    ].join('\n'));

    const backend = new MockBackendAdapter();
    const prompts: string[] = [];
    backend.setOneShotImpl(async (prompt) => {
      prompts.push(prompt);
      if (!prompt.includes('"sourceType":"code_outline"')) return JSON.stringify({ candidates: [] });
      expect(prompt).toContain('Workspace code outline');
      expect(prompt).toContain('ExampleService');
      expect(prompt).toContain('GET /api/example');
      expect(prompt).toContain('Do not create entities for individual ordinary functions');
      return JSON.stringify({
        candidates: [{
          type: 'new_entity',
          confidence: 0.86,
          payload: {
            typeSlug: 'concept',
            name: 'Example service layer',
            summaryMarkdown: 'Durable implementation area inferred from code outlines.',
          },
        }],
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(result).toMatchObject({
      source: 'manual_rebuild',
      spansInserted: 0,
      candidatesCreated: 1,
    });
    expect(prompts.some((prompt) => prompt.includes('"sourceType":"code_outline"'))).toBe(true);
    expect(db.listRuns()).toMatchObject([
      {
        source: 'manual_rebuild',
        status: 'completed',
        metadata: expect.objectContaining({ sourcePacketsProcessed: 1, sourcePacketsSucceeded: 1 }),
      },
    ]);
    expect(db.listCandidates()).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          name: 'Example service layer',
          sourceSpan: expect.objectContaining({
            sourceType: 'code_outline',
            sourceId: 'code-outline/1',
          }),
        }),
      }),
    ]);
  });

  test('repairs malformed source extraction JSON before marking a source packet failed', async () => {
    chat.instructions = '';
    chat.workspacePath = tmpDir;
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Recovered Project is a durable workspace project.');

    const backend = new MockBackendAdapter();
    let repairCalls = 0;
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map JSON repair processor')) {
        repairCalls += 1;
        expect(prompt).toContain('Expected JSON shape');
        expect(prompt).toContain('Malformed output');
        return JSON.stringify({
          candidates: [{
            type: 'new_entity',
            confidence: 0.9,
            payload: {
              typeSlug: 'project',
              name: 'Recovered Project',
              summaryMarkdown: 'Durable workspace project recovered from malformed JSON.',
            },
          }],
        });
      }
      return '{"candidates":[{"type":"new_entity","confidence":0.9,"payload":{"typeSlug":"project","name":"Recovered Project","summaryMarkdown":"Durable workspace project."}}';
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(repairCalls).toBe(1);
    expect(result.candidatesCreated).toBe(1);
    expect(db.listRuns()[0].metadata).toMatchObject({
      sourcePacketsSucceeded: 1,
      extractionUnitsFailed: 0,
      extractionRepairs: {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        failures: [],
      },
      timings: {
        totalMs: expect.any(Number),
        planningMs: expect.any(Number),
        sourceDiscoveryMs: expect.any(Number),
        extractionMs: expect.any(Number),
        synthesisMs: expect.any(Number),
        persistenceMs: expect.any(Number),
        autoApplyMs: expect.any(Number),
        extractionUnits: {
          total: 1,
          succeeded: 1,
          failed: 0,
          slowest: [
            expect.objectContaining({
              sourceType: 'file',
              sourceId: 'README.md',
              status: 'succeeded',
              candidates: 1,
              repaired: true,
              durationMs: expect.any(Number),
            }),
          ],
        },
      },
    });
    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Recovered Project' }),
      }),
    ]);
  });

  test('manual scans process nested markdown files recursively', async () => {
    chat.instructions = '';
    chat.workspacePath = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'context', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'data', 'chat'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'context', 'projects', 'mission-control.md'), 'Mission Control is a durable personal project.');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'README.md'), 'Dependency package README should not be scanned.');
    fs.writeFileSync(path.join(tmpDir, 'data', 'chat', 'runtime.md'), 'Runtime chat data should not be scanned.');

    const backend = new MockBackendAdapter();
    const prompts: string[] = [];
    backend.setOneShotImpl(async (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('"sourceId":"context/projects/mission-control.md"')) {
        return JSON.stringify({
          candidates: [{
            type: 'new_entity',
            confidence: 0.9,
            payload: {
              typeSlug: 'project',
              name: 'Mission Control',
              summaryMarkdown: 'Durable personal project from nested workspace notes.',
            },
          }],
        });
      }
      return JSON.stringify({ candidates: [] });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(result).toMatchObject({
      source: 'manual_rebuild',
      candidatesCreated: 1,
    });
    expect(db.listRuns()[0]).toMatchObject({
      metadata: expect.objectContaining({ sourcePacketsProcessed: 1 }),
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"sourceId":"context/projects/mission-control.md"');
    expect(prompts[0]).not.toContain('node_modules/pkg/README.md');
    expect(prompts[0]).not.toContain('data/chat/runtime.md');
    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          name: 'Mission Control',
          sourceSpan: expect.objectContaining({
            sourceType: 'file',
            sourceId: 'context/projects/mission-control.md',
          }),
        }),
      }),
    ]);
  });

  test('source candidate caps reserve strict relationships when entity candidates fill the source budget', async () => {
    chat.instructions = '';
    chat.workspacePath = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'context', 'contact-sponsor.md'),
      'A sponsor owns the Launch Workflow and works through the Platform Team.',
    );

    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.91,
          payload: {
            typeSlug: 'person',
            name: 'Launch Sponsor',
            summaryMarkdown: 'Primary sponsor for launch operations.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.9,
          payload: {
            typeSlug: 'workflow',
            name: 'Launch Workflow',
            summaryMarkdown: 'Durable launch operating workflow.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.89,
          payload: {
            typeSlug: 'organization',
            name: 'Platform Team',
            summaryMarkdown: 'Team involved in launch operations.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.88,
          payload: {
            typeSlug: 'concept',
            name: 'Launch Timing',
            summaryMarkdown: 'Source-local timing detail.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.87,
          payload: {
            typeSlug: 'concept',
            name: 'Launch Review Notes',
            summaryMarkdown: 'Source-local review detail.',
          },
        },
        {
          type: 'new_relationship',
          confidence: 0.86,
          payload: {
            subjectName: 'Launch Workflow',
            predicate: 'managed_by',
            objectName: 'Launch Sponsor',
            evidenceMarkdown: 'The source says the sponsor owns the Launch Workflow.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(result.candidatesCreated).toBe(4);
    expect(db.listCandidates()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateType: 'new_relationship',
        payload: expect.objectContaining({
          subjectName: 'Launch Workflow',
          predicate: 'managed_by',
          objectName: 'Launch Sponsor',
        }),
      }),
    ]));
    expect(db.listCandidates().some((candidate) => candidate.payload.name === 'Launch Review Notes')).toBe(false);
    expect(db.listRuns()[0].metadata).toMatchObject({
      candidateSynthesis: expect.objectContaining({
        attempted: false,
        inputCandidateTypes: expect.objectContaining({
          new_entity: 3,
          new_relationship: 1,
        }),
        outputCandidateTypes: expect.objectContaining({
          new_entity: 3,
          new_relationship: 1,
        }),
      }),
    });
  });

  test('source scans do not turn ordinary filenames or workspace folders into entities', async () => {
    chat.instructions = '';
    chat.workspacePath = tmpDir;
    fs.writeFileSync(
      path.join(tmpDir, 'CLAUDE.md'),
      [
        'Scratch workspace notes.',
        'Files: SAMPLE_PLAN.md, openai-codex-logo-unofficial.svg.',
        `The folder is ${path.basename(tmpDir)}.`,
      ].join('\n'),
    );

    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      expect(prompt).toContain('Do not create an entity for the source file itself');
      expect(prompt).toContain('ordinary filenames/paths/assets');
      return JSON.stringify({
        candidates: [
          {
            type: 'new_entity',
            confidence: 0.78,
            payload: {
              typeSlug: 'document',
              name: 'SAMPLE_PLAN.md',
              summaryMarkdown: 'Example implementation plan.',
            },
          },
          {
            type: 'new_entity',
            confidence: 0.76,
            payload: {
              typeSlug: 'asset',
              name: 'openai-codex-logo-unofficial.svg',
              summaryMarkdown: 'Unofficial SVG logo asset.',
            },
          },
          {
            type: 'new_entity',
            confidence: 0.92,
            payload: {
              typeSlug: 'workspace',
              name: path.basename(tmpDir),
              summaryMarkdown: 'Scratch workspace.',
            },
          },
          {
            type: 'new_relationship',
            confidence: 0.68,
            payload: {
              subjectName: 'Workspace review workflow',
              predicate: 'references',
              objectName: 'SAMPLE_PLAN.md',
            },
          },
          {
            type: 'new_entity',
            confidence: 0.84,
            payload: {
              typeSlug: 'workflow',
              name: 'Workspace review workflow',
              summaryMarkdown: 'A durable workflow worth reviewing.',
            },
          },
        ],
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(result.candidatesCreated).toBe(1);
    expect(db.listCandidates()).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        confidence: 0.84,
        payload: expect.objectContaining({
          typeSlug: 'workflow',
          name: 'Workspace review workflow',
        }),
      }),
    ]);
  });

  test('source scans skip redundant shims, normalize noisy codebase candidates, and dedupe repeated entities', async () => {
    chat.instructions = '';
    chat.workspacePath = tmpDir;
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'Use SPEC and ADRs as durable project guidance.');
    fs.writeFileSync(
      path.join(tmpDir, 'CLAUDE.md'),
      [
        '# Claude Code Instructions',
        '',
        '@AGENTS.md',
        '',
        'This file is intentionally thin. `AGENTS.md` is the canonical cross-agent instruction file for this repository.',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'SPEC.md'),
      [
        '# Agent Cockpit - Specification',
        '',
        'The full specification has been split into a wiki-style structure under [docs/](docs/SPEC.md).',
        '',
        '**Start here:** [docs/SPEC.md](docs/SPEC.md)',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, 'docs'));
    fs.writeFileSync(path.join(tmpDir, 'docs', 'SPEC.md'), 'Agent Cockpit has local owner authentication and runs local CLI processes.');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'Agent Cockpit supports Claude Code as a backend.');

    const backend = new MockBackendAdapter();
    const prompts: string[] = [];
    backend.setOneShotImpl(async (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('"sourceId":"AGENTS.md"')) {
        return JSON.stringify({
          candidates: [
            {
              type: 'new_entity',
              confidence: 0.91,
              payload: {
                typeSlug: 'document',
                name: 'Agent Cockpit Specification',
                summaryMarkdown: 'Canonical project specification.',
              },
            },
          ],
        });
      }
      if (prompt.includes('"sourceId":"README.md"')) {
        return JSON.stringify({
          candidates: [
            {
              type: 'new_entity',
              confidence: 0.9,
              payload: {
                typeSlug: 'product',
                name: 'Agent Cockpit',
                summaryMarkdown: 'Self-hosted browser UI for local CLI agents.',
              },
            },
            {
              type: 'new_entity',
              confidence: 0.85,
              payload: {
                typeSlug: 'backend',
                name: 'Claude Code backend',
                summaryMarkdown: 'Supported CLI backend.',
              },
            },
            {
              type: 'new_relationship',
              confidence: 0.8,
              payload: {
                sourceName: 'Agent Cockpit',
                relationshipType: 'supports_backend',
                targetName: 'Claude Code backend',
              },
            },
            {
              type: 'evidence_link',
              confidence: 0.75,
              payload: {
                targetName: 'Agent Cockpit',
                summaryMarkdown: 'Source-level evidence without a reviewed target ID.',
              },
            },
            {
              type: 'sensitivity_classification',
              confidence: 0.7,
              payload: {
                classification: 'private_personal_data',
                summaryMarkdown: 'Source-level sensitivity without an entity target.',
              },
            },
          ],
        });
      }
      return JSON.stringify({
        candidates: [
          {
            type: 'new_entity',
            confidence: 0.88,
            payload: {
              typeSlug: 'product',
              name: 'Agent Cockpit',
              summaryMarkdown: 'Duplicate product mention from the docs spec.',
            },
          },
          {
            type: 'new_entity',
            confidence: 0.86,
            payload: {
              typeSlug: 'security_policy',
              name: 'Agent Cockpit local owner authentication policy',
              summaryMarkdown: 'Local owner authentication protects access.',
            },
          },
        ],
      });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(result.candidatesCreated).toBe(5);
    expect(prompts).toHaveLength(3);
    expect(prompts.some((prompt) => prompt.includes('"sourceId":"CLAUDE.md"'))).toBe(false);
    expect(prompts.some((prompt) => prompt.includes('"sourceId":"SPEC.md"'))).toBe(false);
    expect(prompts.some((prompt) => prompt.includes('"sourceId":"docs/SPEC.md"'))).toBe(true);
    expect(db.listRuns()[0]).toMatchObject({
      metadata: expect.objectContaining({ sourcePacketsProcessed: 3 }),
    });

    const candidates = db.listCandidates();
    expect(candidates).toHaveLength(5);
    expect(candidates.map((candidate) => candidate.candidateType).sort()).toEqual([
      'new_entity',
      'new_entity',
      'new_entity',
      'new_entity',
      'new_relationship',
    ]);
    const entityNames = candidates.map((candidate) => candidate.payload.name).filter(Boolean);
    expect(entityNames).toHaveLength(4);
    expect(entityNames).toEqual(expect.arrayContaining([
      'Agent Cockpit',
      'Agent Cockpit local owner authentication policy',
      'Agent Cockpit Specification',
      'Claude Code backend',
    ]));
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Agent Cockpit', typeSlug: 'project' }),
      }),
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Claude Code backend', typeSlug: 'tool' }),
      }),
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({ name: 'Agent Cockpit local owner authentication policy', typeSlug: 'concept' }),
      }),
      expect.objectContaining({
        candidateType: 'new_relationship',
        payload: expect.objectContaining({
          subjectName: 'Agent Cockpit',
          predicate: 'supports',
          objectName: 'Claude Code backend',
        }),
      }),
    ]));
    expect(candidates.filter((candidate) => candidate.payload.name === 'Agent Cockpit')).toHaveLength(1);
    expect(candidates.some((candidate) => candidate.candidateType === 'evidence_link')).toBe(false);
    expect(candidates.some((candidate) => candidate.candidateType === 'sensitivity_classification')).toBe(false);

    const second = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });
    expect(second.candidatesCreated).toBe(0);
    expect(prompts).toHaveLength(6);
    expect(db.listCandidates()).toHaveLength(5);
  });

  test('canonicalizes entity variants, converts active duplicates into updates, and drops weak relationships', async () => {
    db.insertEntity({
      entityId: 'ent-agent-cockpit',
      typeSlug: 'project',
      name: 'Agent Cockpit',
      summaryMarkdown: 'Existing reviewed project.',
      now: now().toISOString(),
    });
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Review Context Map extraction quality for Agent Cockpit.', '2026-05-07T20:01:00.000Z'),
    ]));

    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.9,
          payload: {
            typeSlug: 'project',
            name: 'Agent Cockpit',
            summaryMarkdown: 'Updated project context.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'document',
            name: 'Agent Cockpit Specification',
            summaryMarkdown: 'Maintained product specification.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.88,
          payload: {
            typeSlug: 'document',
            name: 'Project specification',
            summaryMarkdown: 'Duplicate naming for the maintained spec.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.93,
          payload: {
            typeSlug: 'document',
            name: 'Agent Cockpit Specification Documents',
            summaryMarkdown: 'Plural duplicate naming for the maintained spec.',
          },
        },
        {
          type: 'new_relationship',
          confidence: 0.8,
          payload: {
            subjectName: 'Agent Cockpit',
            predicate: 'is specified by',
            objectName: 'Project specification',
          },
        },
        {
          type: 'new_relationship',
          confidence: 0.78,
          payload: {
            subjectName: 'Agent Cockpit Specification Documents',
            predicate: 'relates_to',
            objectName: 'Agent Cockpit',
            evidenceMarkdown: 'The source only loosely associates the specification with the project.',
          },
        },
        {
          type: 'new_relationship',
          confidence: 0.75,
          payload: {
            subjectName: 'Missing Thing',
            predicate: 'uses',
            objectName: 'Agent Cockpit',
          },
        },
        {
          type: 'new_relationship',
          confidence: 0.78,
          payload: {
            subjectName: 'Agent Cockpit Specification',
            predicate: 'preserves_data_unlike',
            objectName: 'Agent Cockpit',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(3);
    const candidates = db.listCandidates();
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateType: 'entity_update',
        payload: expect.objectContaining({
          entityId: 'ent-agent-cockpit',
          summaryMarkdown: 'Updated project context.',
        }),
      }),
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          typeSlug: 'document',
          name: 'Agent Cockpit Specification',
          aliases: expect.arrayContaining(['Project specification', 'Agent Cockpit Specification Documents']),
          facts: expect.arrayContaining([
            expect.stringContaining('loosely associates the specification with the project'),
          ]),
        }),
      }),
      expect.objectContaining({
        candidateType: 'new_relationship',
        payload: expect.objectContaining({
          subjectName: 'Agent Cockpit',
          predicate: 'specified_by',
          objectName: 'Agent Cockpit Specification',
        }),
      }),
    ]));
    expect(candidates.some((candidate) => (
      candidate.candidateType === 'new_relationship'
      && candidate.payload.subjectName === 'Missing Thing'
    ))).toBe(false);
    expect(candidates.some((candidate) => (
      candidate.candidateType === 'new_relationship'
      && candidate.payload.predicate === 'preserves_data_unlike'
    ))).toBe(false);
  });

  test('folds UI-placement implemented_by relationships into facts instead of feature-to-feature edges', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Workspace Instructions are edited from the workspace group header.', '2026-05-07T20:01:00.000Z'),
    ]));

    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.94,
          payload: {
            typeSlug: 'feature',
            name: 'Workspace Instructions',
            summaryMarkdown: 'Per-workspace custom instructions.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.82,
          payload: {
            typeSlug: 'feature',
            name: 'Workspace Grouped Conversation Sidebar',
            summaryMarkdown: 'Sidebar groups conversations under workspace headers.',
          },
        },
        {
          type: 'new_relationship',
          confidence: 0.9,
          payload: {
            subjectName: 'Workspace Instructions',
            predicate: 'implemented_by',
            objectName: 'Workspace Grouped Conversation Sidebar',
            evidenceMarkdown: 'The UI places the edit button in the workspace group header.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(2);
    const candidates = db.listCandidates();
    expect(candidates.some((candidate) => candidate.candidateType === 'new_relationship')).toBe(false);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          name: 'Workspace Instructions',
          facts: expect.arrayContaining([
            expect.stringContaining('edit button in the workspace group header'),
          ]),
        }),
      }),
    ]));
  });

  test('folds low-confidence part_of project relationships into facts', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'The CLI completion UI state bug belongs to the Agent Cockpit project.', '2026-05-07T20:01:00.000Z'),
    ]));

    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'new_entity',
          confidence: 0.95,
          payload: {
            typeSlug: 'project',
            name: 'Agent Cockpit',
            summaryMarkdown: 'Self-hosted browser interface for command-line AI tools.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.72,
          payload: {
            typeSlug: 'feature',
            name: 'CLI Operation Completion UI State',
            summaryMarkdown: 'UI state issue tied to CLI operation completion.',
          },
        },
        {
          type: 'new_relationship',
          confidence: 0.66,
          payload: {
            subjectName: 'CLI Operation Completion UI State',
            predicate: 'part_of',
            objectName: 'Agent Cockpit',
            evidenceMarkdown: 'The bug was filed for a UI state issue tied to CLI operation completion.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(2);
    const candidates = db.listCandidates('pending');
    expect(candidates.some((candidate) => candidate.candidateType === 'new_relationship')).toBe(false);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          name: 'CLI Operation Completion UI State',
          facts: expect.arrayContaining([
            expect.stringContaining('UI state issue tied to CLI operation completion'),
          ]),
        }),
      }),
    ]));
  });

  test('caps high-signal source suggestions before review', async () => {
    chat.instructions = 'Capture the highest-value workspace context only.';
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: Array.from({ length: 6 }, (_item, index) => ({
        type: 'new_entity',
        confidence: 0.9 - (index * 0.01),
        payload: {
          typeSlug: 'concept',
          name: `Workspace concept ${index + 1}`,
        },
      })),
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(result.candidatesCreated).toBe(4);
    expect(db.listCandidates('pending').map((candidate) => candidate.payload.name).sort()).toEqual([
      'Workspace concept 1',
      'Workspace concept 2',
      'Workspace concept 3',
      'Workspace concept 4',
    ].sort());
  });

  test('drops entity update candidates that do not target an active entity', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Workspace Instructions should be remembered.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => JSON.stringify({
      candidates: [
        {
          type: 'entity_update',
          confidence: 0.9,
          payload: {
            name: 'Workspace Instructions',
            summaryMarkdown: 'This should be an update only if the entity already exists.',
          },
        },
        {
          type: 'new_entity',
          confidence: 0.88,
          payload: {
            typeSlug: 'feature',
            name: 'Workspace Instructions',
            summaryMarkdown: 'Per-workspace free-form instructions.',
          },
        },
      ],
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1');

    expect(result.candidatesCreated).toBe(1);
    expect(db.listCandidates()).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          typeSlug: 'feature',
          name: 'Workspace Instructions',
        }),
      }),
    ]);
  });

  test('stops an active scan without advancing cursors or writing candidates', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'This scan will be stopped.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (_prompt, opts) => new Promise<string>((_resolve, reject) => {
      opts?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const running = service.processWorkspace('ws-1');
    await waitForCondition(() => db.listRuns().some((run) => run.status === 'running'));

    await expect(service.stopWorkspace('ws-1')).resolves.toBe(true);
    const result = await running;

    expect(result).toMatchObject({ stopped: true, candidatesCreated: 0, cursorsUpdated: 0 });
    expect(service.isRunning('ws-1')).toBe(false);
    expect(db.listRuns()).toMatchObject([
      { source: 'initial_scan', status: 'stopped', errorMessage: 'Stopped by user' },
    ]);
    expect(db.listSourceSpans()).toHaveLength(0);
    expect(db.listCandidates()).toHaveLength(0);
    expect(db.getConversationCursor('conv-1')).toBeNull();
  });

  test('stops an active source scan without advancing source cursors', async () => {
    chat.workspacePath = tmpDir;
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'This source scan will be stopped.');
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (_prompt, opts) => new Promise<string>((_resolve, reject) => {
      opts?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
    }));
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const running = service.processWorkspace('ws-1', { source: 'manual_rebuild' });
    await waitForCondition(() => backend._oneShotCalls.length === 1);

    await expect(service.stopWorkspace('ws-1')).resolves.toBe(true);
    const result = await running;

    expect(result).toMatchObject({ stopped: true, candidatesCreated: 0, cursorsUpdated: 0 });
    expect(db.listRuns()).toMatchObject([
      { source: 'manual_rebuild', status: 'stopped', errorMessage: 'Stopped by user' },
    ]);
    expect(db.listSourceCursors()).toHaveLength(0);
    expect(db.listCandidates()).toHaveLength(0);
  });

  test('processor parse failures mark the run failed without advancing cursors', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'Track this only if extraction succeeds.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => 'not json');
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    await expect(service.processWorkspace('ws-1')).rejects.toThrow('Context Map processor returned no JSON object');

    expect(db.listRuns()).toMatchObject([
      { source: 'initial_scan', status: 'failed' },
    ]);
    expect(db.listSourceSpans()).toHaveLength(0);
    expect(db.listCandidates()).toHaveLength(0);
    expect(db.getConversationCursor('conv-1')).toBeNull();
  });

  test('shares the extraction limiter across concurrent workspace scans', async () => {
    const secondDb = new ContextMapDatabase(path.join(tmpDir, 'state-second.db'));
    try {
      const secondChat = new FakeContextMapChatService(secondDb);
      for (const target of [chat, secondChat]) {
        target.settings.contextMap = {
          ...(target.settings.contextMap || {}),
          extractionConcurrency: 2,
        };
        target.setConversation(conversation('conv-1', [
          message('msg-1', 'user', 'First extraction unit.', '2026-05-07T20:01:00.000Z'),
        ]));
        target.setConversation(conversation('conv-2', [
          message('msg-2', 'user', 'Second extraction unit.', '2026-05-07T20:02:00.000Z'),
        ]));
      }
      const backend = new MockBackendAdapter();
      let activeExtraction = 0;
      let maxActiveExtraction = 0;
      let extractionStarted = 0;
      const releases: Array<() => void> = [];
      backend.setOneShotImpl(async (_prompt, opts) => {
        extractionStarted += 1;
        activeExtraction += 1;
        maxActiveExtraction = Math.max(maxActiveExtraction, activeExtraction);
        return new Promise<string>((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            opts?.abortSignal?.removeEventListener('abort', abort);
            activeExtraction -= 1;
          };
          const abort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('aborted'));
          };
          opts?.abortSignal?.addEventListener('abort', abort, { once: true });
          releases.push(() => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(JSON.stringify({ candidates: [] }));
          });
        });
      });
      const backendRegistry = new BackendRegistry();
      backendRegistry.register(backend);
      const firstService = new ContextMapService({ chatService: chat, now, backendRegistry });
      const secondService = new ContextMapService({ chatService: secondChat, now, backendRegistry });

      const firstRun = firstService.processWorkspace('ws-1', { source: 'scheduled' });
      const secondRun = secondService.processWorkspace('ws-1', { source: 'scheduled' });
      await waitForCondition(() => extractionStarted === 2);
      expect(activeExtraction).toBe(2);
      expect(maxActiveExtraction).toBe(2);

      releases.shift()?.();
      await waitForCondition(() => extractionStarted === 3);
      expect(maxActiveExtraction).toBe(2);
      releases.shift()?.();
      await waitForCondition(() => extractionStarted === 4);
      expect(maxActiveExtraction).toBe(2);
      while (releases.length > 0) releases.shift()?.();

      await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
        expect.objectContaining({ candidatesCreated: 0 }),
        expect.objectContaining({ candidatesCreated: 0 }),
      ]);
      expect(backend._oneShotCalls).toHaveLength(4);
      expect(maxActiveExtraction).toBe(2);
    } finally {
      secondDb.close();
    }
  });

  test('source packet parse failures do not discard successful source suggestions', async () => {
    chat.workspacePath = tmpDir;
    fs.writeFileSync(path.join(tmpDir, 'good.md'), 'Good Source documents a durable workflow.');
    fs.writeFileSync(path.join(tmpDir, 'bad.md'), 'Bad Source will return malformed JSON.');
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async (prompt) => {
      if (prompt.includes('Context Map JSON repair processor')) return 'not json';
      if (prompt.includes('"sourceId":"bad.md"')) return '{"candidates":[';
      if (prompt.includes('"sourceId":"good.md"')) {
        return JSON.stringify({
          candidates: [{
            type: 'new_entity',
            confidence: 0.91,
            payload: {
              typeSlug: 'workflow',
              name: 'Good Source Workflow',
              summaryMarkdown: 'Durable workflow from a successfully parsed source packet.',
            },
          }],
        });
      }
      return JSON.stringify({ candidates: [] });
    });
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });

    const result = await service.processWorkspace('ws-1', { source: 'manual_rebuild' });

    expect(result).toMatchObject({
      source: 'manual_rebuild',
      spansInserted: 0,
      candidatesCreated: 1,
    });
    expect(backend._oneShotCalls).toHaveLength(3);
    expect(db.listRuns()).toEqual([
      expect.objectContaining({
        source: 'manual_rebuild',
        status: 'completed',
        errorMessage: expect.stringContaining('1 Context Map extraction unit failed'),
        metadata: expect.objectContaining({
          sourcePacketsProcessed: 2,
          sourcePacketsSucceeded: 1,
          extractionUnitsFailed: 1,
          extractionRepairs: {
            attempted: 1,
            succeeded: 0,
            failed: 1,
            failures: [
              expect.objectContaining({
                sourceType: 'file',
                sourceId: 'bad.md',
              }),
            ],
          },
          extractionFailures: [
            expect.objectContaining({
              sourceType: 'file',
              sourceId: 'bad.md',
            }),
          ],
          timings: expect.objectContaining({
            extractionUnits: expect.objectContaining({
              total: 2,
              succeeded: 1,
              failed: 1,
              slowest: expect.arrayContaining([
                expect.objectContaining({
                  sourceType: 'file',
                  sourceId: 'bad.md',
                  status: 'failed',
                  candidates: 0,
                  repaired: true,
                  durationMs: expect.any(Number),
                }),
                expect.objectContaining({
                  sourceType: 'file',
                  sourceId: 'good.md',
                  status: 'succeeded',
                  candidates: 1,
                  durationMs: expect.any(Number),
                }),
              ]),
            }),
          }),
        }),
      }),
    ]);
    expect(db.listCandidates('active')).toEqual([
      expect.objectContaining({
        candidateType: 'new_entity',
        payload: expect.objectContaining({
          name: 'Good Source Workflow',
          sourceSpan: expect.objectContaining({
            sourceType: 'file',
            sourceId: 'good.md',
          }),
        }),
      }),
    ]);
    expect(db.getSourceCursor('file', 'good.md')).toMatchObject({
      sourceType: 'file',
      sourceId: 'good.md',
      status: 'active',
    });
    expect(db.getSourceCursor('file', 'bad.md')).toBeNull();
  });
});

describe('ContextMapScheduler', () => {
  test('checks enabled workspaces on startup and respects scan interval before later scans', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'First turn.', '2026-05-07T20:01:00.000Z'),
    ]));
    const service = new ContextMapService({ chatService: chat, now });
    const scheduler = new ContextMapScheduler({
      chatService: chat,
      processor: service,
      now,
      logger: { warn: jest.fn() },
    });

    await scheduler.checkNow({ force: true });
    expect(db.listRuns()).toHaveLength(1);

    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'First turn.', '2026-05-07T20:01:00.000Z'),
      message('msg-2', 'assistant', 'Second turn.', '2026-05-07T20:02:00.000Z'),
    ]));
    await scheduler.checkNow();
    expect(db.listRuns()).toHaveLength(1);

    nowMs += 5 * 60 * 1000;
    await scheduler.checkNow();
    expect(db.listRuns()).toHaveLength(2);
    expect(db.listSourceSpans()).toMatchObject([
      { startMessageId: 'msg-1', endMessageId: 'msg-1' },
      { startMessageId: 'msg-2', endMessageId: 'msg-2' },
    ]);
  });

  test('uses workspace scan interval overrides when deciding whether a scan is due', async () => {
    chat.workspaceSettings = { processorMode: 'global', scanIntervalMinutes: 10 };
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'First turn.', '2026-05-07T20:01:00.000Z'),
    ]));
    const service = new ContextMapService({ chatService: chat, now });
    const scheduler = new ContextMapScheduler({
      chatService: chat,
      processor: service,
      now,
      logger: { warn: jest.fn() },
    });

    await scheduler.checkNow({ force: true });
    expect(db.listRuns()).toHaveLength(1);

    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'First turn.', '2026-05-07T20:01:00.000Z'),
      message('msg-2', 'assistant', 'Second turn.', '2026-05-07T20:02:00.000Z'),
    ]));
    nowMs += 5 * 60 * 1000;
    await scheduler.checkNow();
    expect(db.listRuns()).toHaveLength(1);

    nowMs += 5 * 60 * 1000;
    await scheduler.checkNow();
    expect(db.listRuns()).toHaveLength(2);
  });

  test('failed workspace attempts still respect the next scan interval', async () => {
    chat.setConversation(conversation('conv-1', [
      message('msg-1', 'user', 'This scheduled extraction will fail.', '2026-05-07T20:01:00.000Z'),
    ]));
    const backend = new MockBackendAdapter();
    backend.setOneShotImpl(async () => 'not json');
    const backendRegistry = new BackendRegistry();
    backendRegistry.register(backend);
    const service = new ContextMapService({ chatService: chat, now, backendRegistry });
    const scheduler = new ContextMapScheduler({
      chatService: chat,
      processor: service,
      now,
      logger: { warn: jest.fn() },
    });

    await scheduler.checkNow({ force: true });
    expect(db.listRuns()).toMatchObject([{ status: 'failed' }]);

    await scheduler.checkNow();
    expect(db.listRuns()).toHaveLength(1);

    nowMs += 5 * 60 * 1000;
    await scheduler.checkNow();
    expect(db.listRuns()).toHaveLength(2);
  });
});

class FakeContextMapChatService implements ContextMapChatService {
  settings: Settings = {
    defaultBackend: 'claude-code',
    contextMap: {
      scanIntervalMinutes: 5,
      cliConcurrency: 1,
      extractionConcurrency: 3,
      synthesisConcurrency: 3,
    },
  } as Settings;
  workspaceSettings: ContextMapWorkspaceSettings = { processorMode: 'global' };
  enabledHashes = ['ws-1'];
  workspacePath = '/tmp/workspace';
  instructions = '';
  private readonly db: ContextMapDatabase;
  private readonly conversations = new Map<string, Conversation>();

  constructor(db: ContextMapDatabase) {
    this.db = db;
  }

  setConversation(conv: Conversation): void {
    this.conversations.set(conv.id, conv);
  }

  async getSettings(): Promise<Settings> {
    return this.settings;
  }

  async resolveCliProfileRuntime(
    cliProfileId: string | undefined | null,
    fallbackBackend?: string | null,
  ): Promise<CliProfileRuntime> {
    const backendId = fallbackBackend || this.settings.defaultBackend || 'claude-code';
    return {
      backendId,
      cliProfileId: cliProfileId || `server-configured-${backendId}`,
      profile: {
        id: cliProfileId || `server-configured-${backendId}`,
        name: `${backendId} test profile`,
        vendor: backendId as 'claude-code',
        authMode: 'server-configured',
        createdAt: '2026-05-07T20:00:00.000Z',
        updatedAt: '2026-05-07T20:00:00.000Z',
      },
    };
  }

  async getWorkspaceContextMapSettings(hash: string): Promise<ContextMapWorkspaceSettings | null> {
    return hash === 'ws-1' ? this.workspaceSettings : null;
  }

  getContextMapDb(hash: string): ContextMapDatabase | null {
    return hash === 'ws-1' ? this.db : null;
  }

  async listContextMapEnabledWorkspaceHashes(): Promise<string[]> {
    return this.enabledHashes;
  }

  async listConversations(): Promise<ConversationListItem[]> {
    return Array.from(this.conversations.values()).map((conv) => ({
      id: conv.id,
      title: conv.title,
      updatedAt: conv.messages[conv.messages.length - 1]?.timestamp || '2026-05-07T20:00:00.000Z',
      backend: conv.backend,
      model: conv.model,
      effort: conv.effort,
      workingDir: conv.workingDir,
      workspaceHash: conv.workspaceHash,
      workspaceKbEnabled: false,
      messageCount: conv.messages.length,
      lastMessage: conv.messages[conv.messages.length - 1]?.content || null,
      usage: null,
      archived: false,
    }));
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) || null;
  }

  async getWorkspacePath(hash: string): Promise<string | null> {
    return hash === 'ws-1' ? this.workspacePath : null;
  }

  async getWorkspaceInstructions(hash: string): Promise<string | null> {
    return hash === 'ws-1' ? this.instructions : null;
  }
}

function now(): Date {
  return new Date(nowMs);
}

function conversation(id: string, messages: Message[], sessionNumber = 1): Conversation {
  return {
    id,
    title: 'Context Map Test',
    backend: 'claude-code',
    workingDir: '/tmp/workspace',
    workspaceHash: 'ws-1',
    currentSessionId: `session-${sessionNumber}`,
    sessionNumber,
    messages,
  } as Conversation;
}

function message(id: string, role: Message['role'], content: string, timestamp: string): Message {
  return {
    id,
    role,
    content,
    backend: 'claude-code',
    timestamp,
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}
