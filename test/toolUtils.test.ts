import {
  extractToolDetails,
  extractToolOutcome,
  extractUsage,
  shortenPath,
  sanitizeSystemPrompt,
  isApiError,
} from '../src/services/backends/toolUtils';

// ── extractToolDetails ──────────────────────────────────────────────────────

describe('extractToolDetails', () => {
  test('Read with file_path returns shortened path description', () => {
    const result = extractToolDetails({ name: 'Read', input: { file_path: '/Users/me/project/src/index.js' } } as any);
    expect(result.tool).toBe('Read');
    expect(result.description).toContain('Reading');
    expect(result.description).toContain('`');
    expect(result.description).toContain('index.js');
  });

  test('Read without file_path returns generic description', () => {
    const result = extractToolDetails({ name: 'Read', input: {} } as any);
    expect(result.description).toBe('Reading file');
  });

  test('Write with file_path returns description', () => {
    const result = extractToolDetails({ name: 'Write', input: { file_path: '/tmp/out.txt' } } as any);
    expect(result.tool).toBe('Write');
    expect(result.description).toContain('Writing');
  });

  test('Write with plan file path sets isPlanFile', () => {
    const result = extractToolDetails({ name: 'Write', input: { file_path: '/home/user/.claude/plans/my-plan.md', content: '# Plan' } } as any);
    expect(result.isPlanFile).toBe(true);
    expect(result.planFilePath).toBe('/home/user/.claude/plans/my-plan.md');
    expect(result.planContent).toBe('# Plan');
  });

  test('Write without plan path does not set isPlanFile', () => {
    const result = extractToolDetails({ name: 'Write', input: { file_path: '/tmp/regular.txt' } } as any);
    expect(result.isPlanFile).toBe(false);
  });

  test('Edit with file_path returns description', () => {
    const result = extractToolDetails({ name: 'Edit', input: { file_path: '/src/app.js' } } as any);
    expect(result.description).toContain('Editing');
    expect(result.description).toContain('app.js');
  });

  test('Edit without file_path returns generic description', () => {
    const result = extractToolDetails({ name: 'Edit', input: {} } as any);
    expect(result.description).toBe('Editing file');
  });

  test('Bash with description uses description field', () => {
    const result = extractToolDetails({ name: 'Bash', input: { description: 'Install dependencies', command: 'npm install' } } as any);
    expect(result.description).toBe('Install dependencies');
  });

  test('Bash without description uses truncated command', () => {
    const result = extractToolDetails({ name: 'Bash', input: { command: 'npm test' } } as any);
    expect(result.description).toBe('Running: `npm test`');
  });

  test('Bash truncates long commands at 60 chars', () => {
    const longCmd = 'a'.repeat(80);
    const result = extractToolDetails({ name: 'Bash', input: { command: longCmd } } as any);
    expect(result.description).toContain('...');
    expect(result.description.length).toBeLessThan(80);
  });

  test('Bash with no description or command returns generic', () => {
    const result = extractToolDetails({ name: 'Bash', input: {} } as any);
    expect(result.description).toBe('Running command');
  });

  test('Grep with pattern and glob returns detailed description', () => {
    const result = extractToolDetails({ name: 'Grep', input: { pattern: 'TODO', glob: '*.js' } } as any);
    expect(result.description).toContain('`TODO`');
    expect(result.description).toContain('*.js');
  });

  test('Grep with pattern only omits glob', () => {
    const result = extractToolDetails({ name: 'Grep', input: { pattern: 'error' } } as any);
    expect(result.description).toContain('`error`');
    expect(result.description).not.toContain(' in ');
  });

  test('Grep without pattern returns generic', () => {
    const result = extractToolDetails({ name: 'Grep', input: {} } as any);
    expect(result.description).toBe('Searching files');
  });

  test('Glob with pattern returns description', () => {
    const result = extractToolDetails({ name: 'Glob', input: { pattern: '**/*.ts' } } as any);
    expect(result.description).toContain('`**/*.ts`');
  });

  test('Glob without pattern returns generic', () => {
    const result = extractToolDetails({ name: 'Glob', input: {} } as any);
    expect(result.description).toBe('Finding files');
  });

  test('Agent sets isAgent, subagentType, and description', () => {
    const result = extractToolDetails({ name: 'Agent', input: { description: 'Explore tests', subagent_type: 'Explore' } } as any);
    expect(result.isAgent).toBe(true);
    expect(result.subagentType).toBe('Explore');
    expect(result.description).toBe('Explore tests');
  });

  test('Agent without inputs uses defaults', () => {
    const result = extractToolDetails({ name: 'Agent', input: {} } as any);
    expect(result.isAgent).toBe(true);
    expect(result.subagentType).toBe('general-purpose');
    expect(result.description).toBe('Running sub-agent');
  });

  test('TodoWrite returns fixed description', () => {
    const result = extractToolDetails({ name: 'TodoWrite', input: {} } as any);
    expect(result.description).toBe('Updating task list');
  });

  test('WebSearch with query returns description', () => {
    const result = extractToolDetails({ name: 'WebSearch', input: { query: 'node.js streams' } } as any);
    expect(result.description).toContain('`node.js streams`');
  });

  test('WebSearch without query returns generic', () => {
    const result = extractToolDetails({ name: 'WebSearch', input: {} } as any);
    expect(result.description).toBe('Searching the web');
  });

  test('WebFetch with url returns description', () => {
    const result = extractToolDetails({ name: 'WebFetch', input: { url: 'https://example.com' } } as any);
    expect(result.description).toContain('https://example.com');
  });

  test('WebFetch without url returns generic', () => {
    const result = extractToolDetails({ name: 'WebFetch', input: {} } as any);
    expect(result.description).toBe('Fetching web content');
  });

  test('EnterPlanMode sets isPlanMode and planAction=enter', () => {
    const result = extractToolDetails({ name: 'EnterPlanMode', input: {} } as any);
    expect(result.isPlanMode).toBe(true);
    expect(result.planAction).toBe('enter');
    expect(result.description).toBe('Entering plan mode');
  });

  test('ExitPlanMode sets isPlanMode, planAction=exit, and plan content', () => {
    const result = extractToolDetails({ name: 'ExitPlanMode', input: { plan: '# Plan', planFilePath: '/home/user/.claude/plans/my-plan.md' } } as any);
    expect(result.isPlanMode).toBe(true);
    expect(result.planAction).toBe('exit');
    expect(result.planContent).toBe('# Plan');
    expect(result.planFilePath).toBe('/home/user/.claude/plans/my-plan.md');
    expect(result.description).toBe('Plan ready for approval');
  });

  test('AskUserQuestion sets isQuestion and passes questions array', () => {
    const questions = [{ question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
    const result = extractToolDetails({ name: 'AskUserQuestion', input: { questions } } as any);
    expect(result.isQuestion).toBe(true);
    expect(result.questions).toEqual(questions);
    expect(result.description).toBe('Asking a question');
  });

  test('AskUserQuestion without questions defaults to empty array', () => {
    const result = extractToolDetails({ name: 'AskUserQuestion', input: {} } as any);
    expect(result.isQuestion).toBe(true);
    expect(result.questions).toEqual([]);
  });

  test('unknown tool returns generic description', () => {
    const result = extractToolDetails({ name: 'SomeNewTool', input: {} } as any);
    expect(result.description).toBe('Using SomeNewTool');
  });

  test('preserves block id', () => {
    const result = extractToolDetails({ name: 'Read', id: 'tool_123', input: { file_path: '/a.txt' } } as any);
    expect(result.id).toBe('tool_123');
  });

  test('handles missing input gracefully', () => {
    const result = extractToolDetails({ name: 'Read' } as any);
    expect(result.description).toBe('Reading file');
  });
});

// ── shortenPath ────────────────────────────────────────────────────────────

describe('shortenPath', () => {
  test('short paths are not shortened', () => {
    expect(shortenPath('a/b')).toBe('a/b');
  });

  test('long paths are shortened to last 2 segments', () => {
    expect(shortenPath('/a/b/c/d/e.js')).toBe('.../d/e.js');
  });

  test('empty string returns empty', () => {
    expect(shortenPath('')).toBe('');
  });
});

// ── sanitizeSystemPrompt ──────────────────────────────────────────────────

describe('sanitizeSystemPrompt', () => {
  test('returns empty string for null/undefined', () => {
    expect(sanitizeSystemPrompt(null)).toBe('');
    expect(sanitizeSystemPrompt(undefined)).toBe('');
    expect(sanitizeSystemPrompt('')).toBe('');
  });

  test('returns non-string types as empty', () => {
    expect(sanitizeSystemPrompt(42 as any)).toBe('');
    expect(sanitizeSystemPrompt({} as any)).toBe('');
  });

  test('passes through normal text unchanged', () => {
    expect(sanitizeSystemPrompt('You are a helpful assistant.')).toBe('You are a helpful assistant.');
  });

  test('preserves newlines, tabs, and carriage returns', () => {
    expect(sanitizeSystemPrompt('line1\nline2\ttab\r')).toBe('line1\nline2\ttab\r');
  });

  test('strips control characters', () => {
    expect(sanitizeSystemPrompt('hello\x00world\x07!')).toBe('helloworld!');
    expect(sanitizeSystemPrompt('\x01\x02\x03safe\x1F')).toBe('safe');
  });

  test('truncates at max length', () => {
    const long = 'a'.repeat(60000);
    const result = sanitizeSystemPrompt(long);
    expect(result.length).toBe(50000);
  });
});

// ── isApiError ─────────────────────────────────────────────────────────────

describe('isApiError', () => {
  test('detects API Error: 500 pattern', () => {
    expect(isApiError('API Error: 500 {"type":"error"}')).toBe(true);
  });

  test('detects API Error: 429 pattern', () => {
    expect(isApiError('API Error: 429 rate limited')).toBe(true);
  });

  test('detects with leading whitespace', () => {
    expect(isApiError('  API Error: 500 server error')).toBe(true);
  });

  test('rejects normal text', () => {
    expect(isApiError('Hello world')).toBe(false);
    expect(isApiError('The API returned an error')).toBe(false);
  });

  test('rejects partial match', () => {
    expect(isApiError('API Error without code')).toBe(false);
  });
});

// ── extractToolOutcome ────────────────────────────────────────────────────

describe('extractToolOutcome', () => {
  test('returns null for null content', () => {
    expect(extractToolOutcome('Bash', null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractToolOutcome('Bash', '')).toBeNull();
  });

  test('Bash: detects exit code 0 as success', () => {
    const result = extractToolOutcome('Bash', 'Output\nexit code: 0');
    expect(result).toEqual({ outcome: 'exit 0', status: 'success' });
  });

  test('Bash: detects non-zero exit code as error', () => {
    const result = extractToolOutcome('Bash', 'Error\nexit code: 1');
    expect(result).toEqual({ outcome: 'exit 1', status: 'error' });
  });

  test('Bash: detects error patterns', () => {
    const result = extractToolOutcome('Bash', 'command not found: foobar');
    expect(result).toEqual({ outcome: 'error', status: 'error' });
  });

  test('Bash: returns done for normal output', () => {
    const result = extractToolOutcome('Bash', 'some output here');
    expect(result).toEqual({ outcome: 'done', status: 'success' });
  });

  test('Grep: counts matches', () => {
    const result = extractToolOutcome('Grep', 'file1.js:10:match\nfile2.js:20:match\nfile3.js:30:match');
    expect(result).toEqual({ outcome: '3 matches', status: 'success' });
  });

  test('Grep: returns 0 matches for no results', () => {
    const result = extractToolOutcome('Grep', 'No matches found');
    expect(result).toEqual({ outcome: '0 matches', status: 'warning' });
  });

  test('Glob: counts files', () => {
    const result = extractToolOutcome('Glob', 'src/a.js\nsrc/b.js');
    expect(result).toEqual({ outcome: '2 files', status: 'success' });
  });

  test('Glob: returns 0 files when empty', () => {
    const result = extractToolOutcome('Glob', 'No files found');
    expect(result).toEqual({ outcome: '0 files', status: 'warning' });
  });

  test('Read: returns read on success', () => {
    const result = extractToolOutcome('Read', 'file contents here...');
    expect(result).toEqual({ outcome: 'read', status: 'success' });
  });

  test('Read: detects not found', () => {
    const result = extractToolOutcome('Read', 'Error: file not found at /path/to/file');
    expect(result).toEqual({ outcome: 'not found', status: 'error' });
  });

  test('Edit: returns edited on success', () => {
    const result = extractToolOutcome('Edit', 'The file was updated successfully');
    expect(result).toEqual({ outcome: 'edited', status: 'success' });
  });

  test('Edit: detects no match', () => {
    const result = extractToolOutcome('Edit', 'old_string not found in the file');
    expect(result).toEqual({ outcome: 'no match', status: 'error' });
  });

  test('Write: returns written on success', () => {
    const result = extractToolOutcome('Write', 'File created');
    expect(result).toEqual({ outcome: 'written', status: 'success' });
  });

  test('Agent: returns done on success', () => {
    const result = extractToolOutcome('Agent', 'Task completed');
    expect(result).toEqual({ outcome: 'done', status: 'success' });
  });

  test('returns null for unknown tool', () => {
    expect(extractToolOutcome('SomeUnknownTool', 'output')).toBeNull();
  });
});

// ── extractUsage ──────────────────────────────────────────────────────────

describe('extractUsage', () => {
  test('returns null when no usage or cost data', () => {
    expect(extractUsage({ type: 'result', result: 'done' } as any)).toBeNull();
  });

  test('extracts full usage data from result event', () => {
    const event = {
      type: 'result',
      result: 'done',
      cost_usd: 0.05,
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    };
    const result = extractUsage(event as any);
    expect(result).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        costUsd: 0.05,
      },
    });
  });

  test('extracts cost when usage object is missing', () => {
    const result = extractUsage({ type: 'result', cost_usd: 0.01 } as any);
    expect(result).not.toBeNull();
    expect(result!.usage.costUsd).toBe(0.01);
    expect(result!.usage.inputTokens).toBe(0);
    expect(result!.usage.outputTokens).toBe(0);
  });

  test('handles partial usage object', () => {
    const result = extractUsage({
      type: 'result',
      cost_usd: 0.02,
      usage: { input_tokens: 500 },
    } as any);
    expect(result!.usage.inputTokens).toBe(500);
    expect(result!.usage.outputTokens).toBe(0);
    expect(result!.usage.cacheReadTokens).toBe(0);
    expect(result!.usage.cacheWriteTokens).toBe(0);
    expect(result!.usage.costUsd).toBe(0.02);
  });

  test('returns null for event with no usage and no cost_usd', () => {
    expect(extractUsage({ type: 'result' } as any)).toBeNull();
    expect(extractUsage({} as any)).toBeNull();
  });
});
