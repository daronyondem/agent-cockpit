import { copilotSessionConfig, composePrompt } from '../src/services/backends/copilotSessionConfig';
import type { SendMessageOptions } from '../src/types';

const options: SendMessageOptions = { sessionId: 'cockpit', isNewSession: true, workingDir: '/tmp', systemPrompt: 'rules' };

test('preserves streaming, directory, permission and non-interactive question policy', async () => {
  const config = copilotSessionConfig({ ...options, model: 'gpt-6.1-sol', effort: 'high' }, {}, '/canonical');
  expect(config).toMatchObject({ clientName: 'agent-cockpit', model: 'gpt-6.1-sol', reasoningEffort: 'high', workingDirectory: '/canonical', streaming: true, excludedTools: ['ask_user'] });
  expect(await config.onPermissionRequest!({} as never, {} as never)).toEqual({ kind: 'approve-once' });
  expect(config.onUserInputRequest).toBeUndefined();
});

test.each(['auto', 'claude-haiku-5.5', 'gemini-3.8-flash', 'unknown'])('keeps unsupported effort absent for %s', model => {
  expect(copilotSessionConfig({ ...options, model, effort: 'high' }, {}, '/tmp').reasoningEffort).toBeUndefined();
});

test('maps the existing local provider environment without using it as profile identity', () => {
  const config = copilotSessionConfig(options, { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:123/v1', COPILOT_PROVIDER_API_KEY: 'fixture-key', COPILOT_MODEL: 'fixture-model' }, '/tmp');
  expect(config).toMatchObject({ model: 'fixture-model', provider: { type: 'openai', baseUrl: 'http://127.0.0.1:123/v1', apiKey: 'fixture-key' } });
  expect(copilotSessionConfig(options, { COPILOT_PROVIDER_BASE_URL: 'http://localhost' }, '/tmp').provider).toEqual({ type: 'openai', baseUrl: 'http://localhost' });
  expect(() => copilotSessionConfig(options, { COPILOT_PROVIDER_BASE_URL: 'http://localhost', COPILOT_PROVIDER_TYPE: 'other' }, '/tmp')).toThrow('Unsupported Copilot provider');
});

test('preserves MCP names, args, environment and all-tools selection across transports', () => {
  const config = copilotSessionConfig({ ...options, mcpServers: [{ name: 'agent-cockpit-memory', command: 'node', args: ['stub.cjs'], env: [{ name: 'TOKEN', value: 'fixture' }] }] }, {}, '/tmp');
  expect(config.mcpServers).toEqual({ 'agent-cockpit-memory': { type: 'local', command: 'node', args: ['stub.cjs'], env: { TOKEN: 'fixture' }, tools: ['*'] } });
});

test('keeps first-turn system instructions in history and does not prepend them on resume', () => {
  expect(composePrompt('request', 'rules', true)).toBe('System instructions:\nrules\n\nUser message:\nrequest');
  expect(composePrompt('request', 'rules', false)).toBe('request');
  expect(composePrompt('request', '', true)).toBe('request');
});
