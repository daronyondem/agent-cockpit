const {
  messageAuthorLabel,
  messageAvatarBackend,
  pinMessageSourceLabel,
} = require('../web/AgentCockpitWeb/src/chat/messageIdentity') as {
  messageAuthorLabel: (message: Record<string, unknown> | null, assistantName?: string) => string;
  messageAvatarBackend: (message: Record<string, unknown> | null) => string | null;
  pinMessageSourceLabel: (message: Record<string, unknown> | null) => string;
};

describe('frontend message identity helpers', () => {
  test('renders system-owned messages as Agent Cockpit instead of the harness', () => {
    const recoveryMessage = {
      role: 'system',
      backend: 'claude-code',
      content: 'Your previous harness session could not be resumed.',
      sessionRecovery: { backend: 'claude-code' },
    };

    expect(messageAuthorLabel(recoveryMessage, 'Claude Code')).toBe('Agent Cockpit');
    expect(messageAvatarBackend(recoveryMessage)).toBeNull();
    expect(pinMessageSourceLabel(recoveryMessage)).toBe('Agent Cockpit');
  });

  test('preserves harness identity for assistant messages', () => {
    const assistantMessage = {
      role: 'assistant',
      backend: 'claude-code',
      content: 'Done',
    };

    expect(messageAuthorLabel(assistantMessage, 'Claude Code')).toBe('Claude Code');
    expect(messageAvatarBackend(assistantMessage)).toBe('claude-code');
    expect(pinMessageSourceLabel(assistantMessage)).toBe('claude-code');
  });

  test('keeps goal lifecycle messages under the Goal identity', () => {
    const goalMessage = {
      role: 'system',
      backend: 'codex',
      content: 'Goal set',
      goalEvent: { kind: 'set' },
    };

    expect(messageAuthorLabel(goalMessage, 'Codex')).toBe('Goal');
    expect(messageAvatarBackend(goalMessage)).toBe('codex');
    expect(pinMessageSourceLabel(goalMessage)).toBe('Goal');
  });
});
