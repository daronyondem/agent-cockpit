import {
  buildContextMapJsonRepairPrompt,
  CONTEXT_MAP_JSON_REPAIR_TIMEOUT_MS,
  extractJsonObject,
  insertMissingCommasBetweenArrayValues,
  parseContextMapJsonOutput,
  repairContextMapJsonOutput,
} from '../src/services/contextMap/jsonRepair';

describe('Context Map JSON repair helpers', () => {
  test('extracts fenced JSON object output', () => {
    expect(extractJsonObject('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
  });

  test('extracts the first balanced object from surrounding text', () => {
    expect(extractJsonObject('before {"items":[{"a":1}]} after')).toBe('{"items":[{"a":1}]}');
  });

  test('repairs missing commas between adjacent array values', () => {
    const repaired = insertMissingCommasBetweenArrayValues('{"items":["a" "b" {"c":1} ["d"]]}');
    expect(JSON.parse(repaired)).toEqual({ items: ['a', 'b', { c: 1 }, ['d']] });
  });

  test('parse helper uses local repair before surfacing invalid JSON', () => {
    expect(parseContextMapJsonOutput(
      '{"candidates":[{"type":"new_entity"} {"type":"new_entity_type"}]}',
      'missing',
      'invalid',
    )).toEqual({
      candidates: [
        { type: 'new_entity' },
        { type: 'new_entity_type' },
      ],
    });
  });

  test('builds schema-specific repair prompts without prose instructions leaking from service', () => {
    const prompt = buildContextMapJsonRepairPrompt({
      rawOutput: '```json\n{"keepRefs":["candidate-1",]}\n```',
      errorMessage: 'Unexpected token',
      schema: 'arbiter',
    });

    expect(prompt).toContain('Context Map JSON repair processor');
    expect(prompt).toContain('"keepRefs"');
    expect(prompt).toContain('Unexpected token');
    expect(prompt).toContain('{"keepRefs"');
  });

  test('repair runner applies bounded one-shot options and returns repaired output', async () => {
    const controller = new AbortController();
    const runOneShot = jest.fn(async () => '{"candidates":[]}');

    await expect(repairContextMapJsonOutput({
      rawOutput: '{"candidates":[]',
      errorMessage: 'Expected }',
      schema: 'extraction',
      runOneShot,
      processor: {
        model: 'test-model',
        effort: 'medium',
      },
      abortSignal: controller.signal,
      workspacePath: '/tmp/workspace',
    })).resolves.toBe('{"candidates":[]}');

    expect(runOneShot).toHaveBeenCalledWith(
      expect.stringContaining('Expected }'),
      expect.objectContaining({
        model: 'test-model',
        effort: 'medium',
        timeoutMs: CONTEXT_MAP_JSON_REPAIR_TIMEOUT_MS,
        workingDir: '/tmp/workspace',
        allowTools: false,
      }),
      controller.signal,
    );
  });
});
