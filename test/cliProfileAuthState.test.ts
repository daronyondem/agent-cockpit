const { cliProfileAuthStateLabel } = require('../web/AgentCockpitWeb/src/screens/cliProfileAuthState.js') as {
  cliProfileAuthStateLabel: (state?: unknown) => string;
};

test('distinguishes installed, authenticated and catalog-denied profile checks', () => {
  expect(cliProfileAuthStateLabel({ kind: 'check', result: { authenticated: null, status: 'ok' } })).toBe('ok');
  expect(cliProfileAuthStateLabel({ kind: 'check', result: { authenticated: false, status: 'not-authenticated' } })).toBe('not authenticated');
  expect(cliProfileAuthStateLabel({ kind: 'check', result: { authenticated: true, modelsAvailable: false, status: 'error' } })).toBe('authenticated · catalog unavailable');
  expect(cliProfileAuthStateLabel({ kind: 'check', result: { authenticated: true, modelsAvailable: true, status: 'ok' } })).toBe('authenticated');
});

test('retains pending, job and transport-error labels', () => {
  expect(cliProfileAuthStateLabel()).toBe('not checked');
  expect(cliProfileAuthStateLabel({ message: 'Checking' })).toBe('Checking');
  expect(cliProfileAuthStateLabel({ error: 'Network failed' })).toBe('error');
  expect(cliProfileAuthStateLabel({ job: { status: 'running' } })).toBe('running');
  expect(cliProfileAuthStateLabel({ status: 'cancelled' })).toBe('cancelled');
});
