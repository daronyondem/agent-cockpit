import { copilotMessageInput } from '../src/services/backends/copilotMedia';
import { copilotFallbackModels } from '../src/services/backends/copilotModels';

test('translates only the trailing upload tag, preserving prose and unique file paths', () => {
  const models = copilotFallbackModels();
  expect(copilotMessageInput('Discuss [Uploaded files: example] normally.', models, 'auto', {})).toEqual({ prompt: 'Discuss [Uploaded files: example] normally.' });
  expect(copilotMessageInput('Read these.\n\n[Uploaded files: /tmp/a.png, /tmp/notes.txt, /tmp/a.png]', models, 'gpt-6.1-sol', {}))
    .toEqual({ prompt: 'Read these.', attachments: [{ type: 'file', path: '/tmp/a.png', displayName: 'a.png' }, { type: 'file', path: '/tmp/notes.txt', displayName: 'notes.txt' }] });
  expect(copilotMessageInput('[Uploaded files: /tmp/a.png]', models, undefined, { COPILOT_MODEL: 'gpt-6.1-sol' }).prompt).toBe('');
  expect(copilotMessageInput('[Uploaded files: /tmp/a.png]', models, ' auto ', { COPILOT_MODEL: 'gpt-6.1-sol' }).attachments).toHaveLength(1);
});

test.each(['auto', 'missing', 'claude-sonnet-5'])('fails media closed for unverified %s while preserving text files', model => {
  expect(() => copilotMessageInput('[Uploaded files: /tmp/a.png]', copilotFallbackModels(), model, {})).toThrow('verified image input');
  expect(copilotMessageInput('[Uploaded files: /tmp/notes.txt]', copilotFallbackModels(), model, {}).attachments).toHaveLength(1);
});

test('media evidence is scoped to the native provider transport', () => {
  const openai = { COPILOT_PROVIDER_BASE_URL: 'http://localhost', COPILOT_MODEL: 'gpt-6.1-sol' };
  expect(() => copilotMessageInput('[Uploaded files: /tmp/a.pdf]', copilotFallbackModels(openai), 'auto', openai)).toThrow('verified pdf input');
  expect(() => copilotMessageInput('[Uploaded files: /tmp/a.pdf]', copilotFallbackModels(), 'gpt-6.1-sol', {})).toThrow('verified pdf input');
  expect(copilotMessageInput('[Uploaded files: /tmp/a.pdf]', copilotFallbackModels(), 'gpt-6.1-sol', {}, 'jsonl').attachments).toHaveLength(1);
  const anthropic = { ...openai, COPILOT_PROVIDER_TYPE: 'anthropic', COPILOT_MODEL: 'claude-sonnet-4.6' };
  expect(copilotMessageInput('[Uploaded files: /tmp/a.pdf, /tmp/a.png]', copilotFallbackModels(anthropic), 'auto', anthropic).attachments).toHaveLength(2);
  expect(copilotFallbackModels({ ...openai, COPILOT_PROVIDER_TYPE: 'azure' }).find(model => model.id === 'gpt-6.1-sol')?.capabilities?.input).toMatchObject({ image: false, pdf: false });
});
