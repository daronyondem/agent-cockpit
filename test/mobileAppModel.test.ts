import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

function loadMobileAppModel(): Record<string, any> {
  const sourcePath = path.join(ROOT, 'mobile/AgentCockpitPWA/src/appModel.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transformed = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      isolatedModules: true,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  const sandbox = {
    exports: module.exports,
    module,
    URL,
    document: {
      createElement: jest.fn(),
      body: { append: jest.fn() },
    },
  };
  vm.runInNewContext(transformed, sandbox, { filename: sourcePath });
  return module.exports;
}

describe('mobile app model helpers', () => {
  const model = loadMobileAppModel();

  test('parses uploaded and delivered file markers without leaking marker text into previews', () => {
    const parsed = model.parseMessageFiles([
      'Here is the result.',
      '',
      '<!-- FILE_DELIVERY:/tmp/report.md -->',
      '[Uploaded files: /tmp/image.png, notes.txt]',
    ].join('\n'));

    expect(parsed).toEqual({
      text: 'Here is the result.',
      deliveredPaths: ['/tmp/report.md'],
      uploadedPaths: ['/tmp/image.png', 'notes.txt'],
    });
    expect(model.displayMessagePreview('<!-- FILE_DELIVERY:/tmp/report.md -->')).toBe('File: report.md');
    expect(model.displayMessagePreview('[Uploaded files: /tmp/image.png, notes.txt]')).toBe('2 attachments: image.png, notes.txt');
  });

  test('normalizes reset session list items with explicit null fields for shared contracts', () => {
    const sessions = [{
      number: 1,
      sessionId: 'old-session',
      startedAt: '2026-05-01T00:00:00.000Z',
      endedAt: null,
      messageCount: 2,
      summary: null,
      isCurrent: true,
    }];
    const response = {
      conversation: { currentSessionId: 'new-session' },
      newSessionNumber: 2,
      archivedSession: {
        number: 1,
        sessionId: 'old-session',
        startedAt: '2026-05-01T00:00:00.000Z',
        endedAt: '2026-05-01T01:00:00.000Z',
        messageCount: 2,
        summary: '',
      },
    };

    expect(model.updateSessionsAfterReset(sessions, response)).toEqual([
      expect.objectContaining({ number: 1, endedAt: '2026-05-01T01:00:00.000Z', summary: null, isCurrent: false }),
      expect.objectContaining({ number: 2, sessionId: 'new-session', endedAt: null, summary: null, isCurrent: true }),
    ]);
  });

  test('projects conversations into shared list items with null last-message and usage fields', () => {
    const conversation = {
      id: 'conv-1',
      title: 'Empty',
      backend: 'codex',
      workingDir: '/tmp/workspace',
      workspaceHash: 'hash-1',
      messages: [],
      archived: false,
    };

    expect(model.conversationListItemFromConversation(conversation)).toEqual(expect.objectContaining({
      id: 'conv-1',
      lastMessage: null,
      usage: null,
      messageCount: 0,
    }));
  });

  test('normalizes backend-neutral goal elapsed time, actions, and status labels for mobile UI', () => {
    const activeGoal = {
      backend: 'codex',
      threadId: 'thread-1',
      objective: 'Ship mobile goals',
      status: 'active',
      supportedActions: { clear: true, stopTurn: true, pause: true, resume: true },
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 10,
      createdAt: 1_760_000_000,
      updatedAt: 1_760_000_000,
    };
    const pausedGoal = { ...activeGoal, status: 'paused', updatedAt: 1_760_000_005_123 };

    expect(model.goalSnapshotTimeMs(activeGoal)).toBe(1_760_000_000_000);
    expect(model.goalSnapshotTimeMs(pausedGoal)).toBe(1_760_000_005_123);
    expect(model.isActiveGoal(activeGoal)).toBe(true);
    expect(model.goalElapsedSeconds(activeGoal, 1_760_000_005_900)).toBe(15);
    expect(model.goalElapsedSeconds(pausedGoal, 1_760_000_020_000)).toBe(10);
    expect(model.goalStatusLabel(pausedGoal)).toBe('Goal paused');
    expect(model.goalStatusLabel({ ...activeGoal, status: 'complete' })).toBe('Goal achieved');
    expect(model.goalSupportsAction(activeGoal, 'pause')).toBe(true);
    expect(model.goalSupportsAction({
      ...activeGoal,
      backend: 'claude-code',
      supportedActions: { clear: true, stopTurn: true, pause: false, resume: false },
    }, 'pause')).toBe(false);
    expect(model.goalSupportsAction({ backend: 'claude-code' }, 'clear')).toBe(true);
    expect(model.formatGoalElapsed(65)).toBe('1m 05s');
    expect(model.cleanGoalObjectiveText('Goal setcodexShip mobile goals')).toBe('Ship mobile goals');
    expect(model.cleanGoalObjectiveText('Codex should keep this prefix')).toBe('Codex should keep this prefix');
    expect(model.cleanGoalObjectiveText('Goal settings should stay intact')).toBe('Goal settings should stay intact');
  });

  test('rejects stale replayed goal snapshots', () => {
    const olderGoal = {
      threadId: 'thread-1',
      objective: 'Older',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1000,
      updatedAt: 1000,
    };

    expect(model.shouldApplyGoalSnapshot(2_000_000, olderGoal)).toBe(false);
    expect(model.shouldApplyGoalSnapshot(999_000, olderGoal)).toBe(true);
    expect(model.shouldApplyGoalSnapshot(2_000_000, null)).toBe(true);
  });
});
