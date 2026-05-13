const { goalElapsedSeconds, goalSnapshotTimeMs, isActiveGoal } = require('../web/AgentCockpitWeb/src/goalState.js');

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
});
