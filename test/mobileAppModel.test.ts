import { loadMobileModule } from './mobileModuleLoader';

describe('mobile app model helpers', () => {
  const model = loadMobileModule('appModel.ts');

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

  test('replaces and removes optimistic mobile transcript messages', () => {
    const pendingUser = {
      id: 'pending-user-1',
      role: 'user',
      content: 'Hello',
      backend: 'codex',
      timestamp: '2026-05-01T00:00:00.000Z',
    };
    const duplicateServerUser = {
      id: 'server-user-1',
      role: 'user',
      content: 'Duplicate',
      backend: 'codex',
      timestamp: '2026-05-01T00:00:01.000Z',
    };
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Hi',
      backend: 'codex',
      timestamp: '2026-05-01T00:00:02.000Z',
    };
    const serverUser = {
      id: 'server-user-1',
      role: 'user',
      content: 'Hello',
      backend: 'codex',
      timestamp: '2026-05-01T00:00:03.000Z',
    };

    expect(model.replaceMessageByID([pendingUser, duplicateServerUser, assistantMessage], 'pending-user-1', serverUser)).toEqual([
      serverUser,
      assistantMessage,
    ]);
    expect(model.removeMessagesByID([pendingUser, assistantMessage], ['pending-user-1'])).toEqual([assistantMessage]);
  });

  test('reconciles recovered mobile sends with the persisted user message when the server accepted the turn', () => {
    const pendingUser = {
      id: 'pending-user-1',
      role: 'user',
      content: 'Hello',
      backend: 'codex',
      timestamp: '2026-05-01T00:00:00.000Z',
    };
    const earlierUser = {
      id: 'server-user-old',
      role: 'user',
      content: 'Hello',
      backend: 'codex',
      timestamp: '2026-05-01T00:00:01.000Z',
    };
    const serverUser = {
      id: 'server-user-new',
      role: 'user',
      content: 'Hello',
      backend: 'codex',
      timestamp: '2026-05-01T00:00:02.000Z',
    };
    const assistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Working',
      backend: 'codex',
      timestamp: '2026-05-01T00:00:03.000Z',
    };
    const currentConversation = { id: 'conv-1', messages: [earlierUser, pendingUser] };
    const serverConversation = { id: 'conv-1', messages: [earlierUser, serverUser, assistantMessage] };

    expect(model.reconcileRecoveredSendConversation(
      currentConversation,
      serverConversation,
      1,
      'Hello',
    )).toEqual(serverConversation);
    expect(model.reconcileRecoveredSendConversation(
      currentConversation,
      { id: 'conv-1', messages: [earlierUser] },
      1,
      'Hello',
    )).toBe(currentConversation);
  });

  test('applies selected runtime metadata to optimistic mobile sends', () => {
    const conversation = {
      id: 'conv-1',
      title: 'New Chat',
      backend: 'codex',
      cliProfileId: 'profile-codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
      serviceTier: 'fast',
    };

    expect(model.applyConversationRuntimeSelection(conversation, {
      backend: 'claude-code',
      cliProfileId: 'profile-claude',
      model: 'claude-opus-4-6',
      effort: 'max',
      claudeCodeMode: 'ultracode',
      serviceTier: undefined,
    })).toEqual({
      ...conversation,
      backend: 'claude-code',
      cliProfileId: 'profile-claude',
      model: 'claude-opus-4-6',
      effort: 'max',
      claudeCodeMode: 'ultracode',
      serviceTier: undefined,
    });

    expect(model.applyConversationRuntimeSelection({
      ...conversation,
      backend: 'claude-code',
      claudeCodeMode: 'ultracode',
      serviceTier: undefined,
    }, {
      backend: 'claude-code',
    })).toEqual({
      ...conversation,
      backend: 'claude-code',
      claudeCodeMode: 'ultracode',
      serviceTier: undefined,
    });

    expect(model.applyConversationRuntimeSelection({
      ...conversation,
      backend: 'claude-code',
      claudeCodeMode: 'ultracode',
      serviceTier: undefined,
    }, {
      backend: 'claude-code',
      claudeCodeMode: null,
    })).toEqual({
      ...conversation,
      backend: 'claude-code',
      serviceTier: undefined,
    });
  });

  test('resolves queued sends from the live active conversation ref', () => {
    const liveConversation = {
      id: 'conv-1',
      messages: [],
      backend: 'codex',
    };
    const renderedConversation = {
      id: 'stale-conv',
      messages: [],
      backend: 'claude-code',
    };

    expect(model.conversationForSend(null, { current: liveConversation }, 'conv-1')).toBe(liveConversation);
    expect(model.conversationForSend(renderedConversation, { current: liveConversation }, 'conv-1')).toBe(liveConversation);
    expect(model.conversationForSend(renderedConversation, { current: null }, 'stale-conv')).toBe(renderedConversation);
    expect(model.conversationForSend(renderedConversation, { current: liveConversation }, 'stale-conv')).toBeNull();
    expect(model.conversationForSend(renderedConversation, { current: liveConversation }, 'missing-conv')).toBeNull();
  });

  test('normalizes mobile backend profile and workspace identity helpers', () => {
    const profiles = [
      { id: 'codex-profile', name: 'Codex', harness: 'codex' },
      { id: 'claude-profile', name: 'Claude Interactive', harness: 'claude-code', protocol: 'interactive' },
      { id: 'open-profile', name: 'OpenCode', harness: 'opencode', opencode: { provider: 'openrouter' } },
    ];

    expect(model.workspaceRef({ workspaceId: 'workspace-1', workspaceHash: 'legacy-hash' })).toBe('workspace-1');
    expect(model.workspaceRef({ workspaceHash: 'legacy-hash' })).toBe('legacy-hash');
    expect(model.backendIdForProfile(profiles[1])).toBe('claude-code-interactive');
    expect(model.backendIdForProfile(profiles[0])).toBe('codex');
    expect(model.profileForID(profiles, 'open-profile')).toBe(profiles[2]);
    expect(model.profileForID(profiles, 'missing')).toBeNull();
    expect(model.opencodeProviderLabel('ollama')).toBe('Ollama');
    expect(model.opencodeProviderLabel('openrouter')).toBe('OpenRouter');
    expect(model.opencodeProviderLabel('custom-provider')).toBe('Custom Provider');
    expect(model.modelDisplayLabel('openrouter/google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
    expect(model.modelDisplayLabel({ id: 'openrouter/anthropic/claude-sonnet-4', label: 'openrouter/anthropic/claude-sonnet-4' })).toBe('anthropic/claude-sonnet-4');
    expect(model.modelDisplayLabel('deepseek/deepseek-chat')).toBe('deepseek/deepseek-chat');
  });

  test('parses mobile goal slash commands without mutating composer state', () => {
    expect(model.parseGoalSlashCommand('hello')).toBeNull();
    expect(model.parseGoalSlashCommand('/goal')).toEqual({ kind: 'enter-goal-mode' });
    expect(model.parseGoalSlashCommand('/GOAL   ')).toEqual({ kind: 'enter-goal-mode' });
    expect(model.parseGoalSlashCommand('/goal pause')).toEqual({ kind: 'pause' });
    expect(model.parseGoalSlashCommand('/Goal RESUME')).toEqual({ kind: 'resume' });
    expect(model.parseGoalSlashCommand('/goal clear')).toEqual({ kind: 'clear' });
    expect(model.parseGoalSlashCommand('/goal Ship the mobile split')).toEqual({
      kind: 'set',
      objective: 'Ship the mobile split',
    });
    expect(model.parseGoalSlashCommand('/goal paused but still text')).toEqual({
      kind: 'set',
      objective: 'paused but still text',
    });
  });

  test('chooses mobile reset profile repair using selected, backend match, sole profile, then none', () => {
    const codex = { id: 'codex-profile', name: 'Codex', harness: 'codex' };
    const claude = { id: 'claude-profile', name: 'Claude', harness: 'claude-code' };
    const interactive = { id: 'interactive-profile', name: 'Claude Interactive', harness: 'claude-code', protocol: 'interactive' };
    const staleConversation = { cliProfileId: 'missing-profile', backend: 'codex' };

    expect(model.chooseResetProfileRepair([codex, claude], staleConversation, 'claude-profile')).toBe(claude);
    expect(model.chooseResetProfileRepair([codex, claude], staleConversation, undefined)).toBe(codex);
    expect(model.chooseResetProfileRepair([interactive], { ...staleConversation, backend: 'claude-code-interactive' }, undefined)).toBe(interactive);
    expect(model.chooseResetProfileRepair([claude], staleConversation, undefined)).toBe(claude);
    expect(model.chooseResetProfileRepair([codex, claude], { ...staleConversation, backend: 'opencode' }, undefined)).toBeNull();
    expect(model.chooseResetProfileRepair([codex], { cliProfileId: 'codex-profile', backend: 'codex' }, undefined)).toBeNull();
  });

  test('caps mobile stream reconnect backoff at fifteen seconds', () => {
    expect(model.streamReconnectDelayMs(0)).toBe(1_000);
    expect(model.streamReconnectDelayMs(1)).toBe(2_000);
    expect(model.streamReconnectDelayMs(2)).toBe(4_000);
    expect(model.streamReconnectDelayMs(3)).toBe(8_000);
    expect(model.streamReconnectDelayMs(4)).toBe(15_000);
    expect(model.streamReconnectDelayMs(8)).toBe(15_000);
  });

  test('keeps mobile transcript pin patching and scroll threshold deterministic', () => {
    const first = { id: 'm1', role: 'assistant', content: 'First', timestamp: '2026-05-01T00:00:00.000Z' };
    const second = { id: 'm2', role: 'assistant', content: 'Second', pinned: true, timestamp: '2026-05-01T00:00:01.000Z' };
    const conversation = { id: 'conv-1', messages: [first, second] };
    const replacement = { ...first, content: 'Updated', pinned: true };

    expect(model.patchConversationMessage(conversation, 'm1', true).messages[0]).toEqual({ ...first, pinned: true });
    expect(model.patchConversationMessage(conversation, 'm2', false).messages[1]).toEqual(expect.not.objectContaining({ pinned: true }));
    expect(model.patchConversationMessage(conversation, 'm1', true, replacement).messages[0]).toBe(replacement);
    expect(model.isChatScrolledToEnd({ scrollHeight: 1000, clientHeight: 500, scrollTop: 452 })).toBe(true);
    expect(model.isChatScrolledToEnd({ scrollHeight: 1000, clientHeight: 500, scrollTop: 451 })).toBe(false);
    expect(model.chatScrollTopForEnd({ scrollHeight: 1000, clientHeight: 500 })).toBe(500);
    expect(model.chatScrollTopForEnd({ scrollHeight: 360, clientHeight: 500 })).toBe(0);
    expect(model.messageScrollSignature({ content: '', contentBlocks: [] })).toBe('');
    expect(model.messageScrollSignature({
      content: '',
      contentBlocks: [{ type: 'tool', activity: { id: 'tool-1', tool: 'Bash', description: 'Running tests', startTime: 1000 } }],
    })).not.toBe('');
    expect(model.messageScrollSignature({
      content: '',
      contentBlocks: [{ type: 'thinking', content: 'checking more context' }],
    })).toBe('thinking:21');
  });

  test('normalizes Codex service tier when applying mobile runtime metadata', () => {
    const conversation = {
      backend: 'codex',
      cliProfileId: 'profile-codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
      serviceTier: 'fast',
    };

    expect(model.applyConversationRuntimeSelection(conversation, {
      backend: 'codex',
      cliProfileId: 'profile-codex',
      serviceTier: 'default',
    })).toEqual({
      ...conversation,
      serviceTier: undefined,
    });
    expect(model.applyConversationRuntimeSelection(conversation, {
      backend: 'codex',
      cliProfileId: 'profile-codex',
      serviceTier: 'fast',
    })).toEqual(conversation);
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

  test('normalizes mobile goal capability metadata by backend', () => {
    expect(model.goalCapabilityForBackend([{ id: 'codex', capabilities: { goals: true } }], 'codex')).toEqual({
      set: true,
      clear: true,
      pause: true,
      resume: true,
      status: 'native',
    });
    expect(model.goalCapabilityForBackend([], 'claude-code-interactive')).toEqual({
      set: true,
      clear: true,
      pause: false,
      resume: false,
      status: 'transcript',
    });
    expect(model.goalCapabilityForBackend([{ id: 'custom', capabilities: { goals: { set: true, clear: false, status: 'native' } } }], 'custom')).toEqual({
      set: true,
      clear: false,
      pause: false,
      resume: false,
      status: 'native',
    });
    expect(model.goalActionUnsupportedMessage('resume', 'claude-code')).toBe('Goal resume is not supported by Claude Code.');
  });

  test('treats rejected mobile WebSocket construction as a recoverable transport miss', () => {
    class FakeSocket {
      url: string;

      constructor(url: string) {
        this.url = url;
      }
    }
    class ThrowingSocket {
      constructor() {
        throw new DOMException('The string did not match the expected pattern.', 'SyntaxError');
      }
    }

    expect(model.tryCreateWebSocket('ws://127.0.0.1/test', FakeSocket as any)).toEqual({ url: 'ws://127.0.0.1/test' });
    expect(model.tryCreateWebSocket('ws://127.0.0.1/test', ThrowingSocket as any)).toBeNull();
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
    expect(model.shouldPreserveLocalRuntimeGoal({
      conversationID: 'conv-1',
      goal: { ...olderGoal, source: 'runtime' },
    }, 'conv-1')).toBe(true);
    expect(model.shouldPreserveLocalRuntimeGoal({
      conversationID: 'conv-2',
      goal: { ...olderGoal, source: 'runtime' },
    }, 'conv-1')).toBe(false);
    expect(model.shouldPreserveLocalRuntimeGoal({
      conversationID: 'conv-1',
      goal: { ...olderGoal, source: 'server' },
    }, 'conv-1')).toBe(false);
  });
});
