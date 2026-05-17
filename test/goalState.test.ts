const {
  cleanGoalObjectiveText,
  goalElapsedSeconds,
  goalSnapshotTimeMs,
  goalStatusLabel,
  goalSupportsAction,
  isActiveGoal,
} = require('../web/AgentCockpitWeb/src/goalState.js');

describe('goalState helpers', () => {
  test('normalizes second and millisecond goal timestamps', () => {
    expect(goalSnapshotTimeMs({ updatedAt: 1_760_000_000 })).toBe(1_760_000_000_000);
    expect(goalSnapshotTimeMs({ updatedAt: 1_760_000_000_123 })).toBe(1_760_000_000_123);
  });

  test('active goals tick elapsed time from the latest snapshot', () => {
    const goal = {
      status: 'active',
      timeUsedSeconds: 10,
      updatedAt: 1_760_000_000_000,
    };

    expect(isActiveGoal(goal)).toBe(true);
    expect(goalElapsedSeconds(goal, 1_760_000_005_900)).toBe(15);
  });

  test('paused goals keep the upstream elapsed snapshot', () => {
    const goal = {
      status: 'paused',
      timeUsedSeconds: 10,
      updatedAt: 1_760_000_000_000,
    };

    expect(isActiveGoal(goal)).toBe(false);
    expect(goalElapsedSeconds(goal, 1_760_000_005_900)).toBe(10);
  });

  test('goal action support follows backend-specific supportedActions', () => {
    expect(goalSupportsAction({ backend: 'codex', status: 'active' }, 'pause')).toBe(true);
    expect(goalSupportsAction({
      backend: 'claude-code',
      status: 'active',
      supportedActions: { clear: true, stopTurn: true, pause: false, resume: false },
    }, 'pause')).toBe(false);
    expect(goalSupportsAction({
      backend: 'claude-code',
      status: 'active',
      supportedActions: { clear: true, stopTurn: true, pause: false, resume: false },
    }, 'clear')).toBe(true);
  });

  test('complete goals use achieved label', () => {
    expect(goalStatusLabel('complete')).toBe('Goal achieved');
  });

  test('cleans pasted goal card text without stripping ordinary Codex objectives', () => {
    expect(cleanGoalObjectiveText('Goal setcodexResearch the benefits of banana')).toBe('Research the benefits of banana');
    expect(cleanGoalObjectiveText('Goal achieved 20s Goal setcodexResearch the benefits of banana')).toBe('Research the benefits of banana');
    expect(cleanGoalObjectiveText('Codex should keep this prefix')).toBe('Codex should keep this prefix');
    expect(cleanGoalObjectiveText('Goal settings should stay intact')).toBe('Goal settings should stay intact');
  });
});
