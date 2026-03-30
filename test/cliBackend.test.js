const { CLIBackend } = require('../src/services/cliBackend');

// extractToolDetails is not exported, so we access it via a test seam:
// We require the module source and extract the function
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Extract extractToolDetails and shortenPath from the module source
const moduleSource = fs.readFileSync(path.join(__dirname, '../src/services/cliBackend.js'), 'utf8');
const extractToolDetails = (() => {
  const sandbox = { module: { exports: {} }, exports: {}, require, console, process, __dirname: path.join(__dirname, '../src/services') };
  vm.runInNewContext(moduleSource, sandbox);
  // The function is in module scope — re-parse it directly
  const fnMatch = moduleSource.match(/function extractToolDetails\(block\) \{[\s\S]*?^}/m);
  const helperMatch = moduleSource.match(/function shortenPath\(filePath\) \{[\s\S]*?^}/m);
  if (fnMatch && helperMatch) {
    const combined = helperMatch[0] + '\n' + fnMatch[0] + '\nreturn extractToolDetails;';
    return new Function(combined)();
  }
  throw new Error('Could not extract extractToolDetails from source');
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── extractToolDetails ──────────────────────────────────────────────────────

describe('extractToolDetails', () => {
  test('Read with file_path returns shortened path description', () => {
    const result = extractToolDetails({ name: 'Read', input: { file_path: '/Users/me/project/src/index.js' } });
    expect(result.tool).toBe('Read');
    expect(result.description).toContain('Reading');
    expect(result.description).toContain('`');
    expect(result.description).toContain('index.js');
  });

  test('Read without file_path returns generic description', () => {
    const result = extractToolDetails({ name: 'Read', input: {} });
    expect(result.description).toBe('Reading file');
  });

  test('Write with file_path returns description', () => {
    const result = extractToolDetails({ name: 'Write', input: { file_path: '/tmp/out.txt' } });
    expect(result.tool).toBe('Write');
    expect(result.description).toContain('Writing');
  });

  test('Write with plan file path sets isPlanFile', () => {
    const result = extractToolDetails({ name: 'Write', input: { file_path: '/home/user/.claude/plans/my-plan.md' } });
    expect(result.isPlanFile).toBe(true);
  });

  test('Write without plan path does not set isPlanFile', () => {
    const result = extractToolDetails({ name: 'Write', input: { file_path: '/tmp/regular.txt' } });
    expect(result.isPlanFile).toBe(false);
  });

  test('Edit with file_path returns description', () => {
    const result = extractToolDetails({ name: 'Edit', input: { file_path: '/src/app.js' } });
    expect(result.description).toContain('Editing');
    expect(result.description).toContain('app.js');
  });

  test('Edit without file_path returns generic description', () => {
    const result = extractToolDetails({ name: 'Edit', input: {} });
    expect(result.description).toBe('Editing file');
  });

  test('Bash with description uses description field', () => {
    const result = extractToolDetails({ name: 'Bash', input: { description: 'Install dependencies', command: 'npm install' } });
    expect(result.description).toBe('Install dependencies');
  });

  test('Bash without description uses truncated command', () => {
    const result = extractToolDetails({ name: 'Bash', input: { command: 'npm test' } });
    expect(result.description).toBe('Running: `npm test`');
  });

  test('Bash truncates long commands at 60 chars', () => {
    const longCmd = 'a'.repeat(80);
    const result = extractToolDetails({ name: 'Bash', input: { command: longCmd } });
    expect(result.description).toContain('...');
    expect(result.description.length).toBeLessThan(80);
  });

  test('Bash with no description or command returns generic', () => {
    const result = extractToolDetails({ name: 'Bash', input: {} });
    expect(result.description).toBe('Running command');
  });

  test('Grep with pattern and glob returns detailed description', () => {
    const result = extractToolDetails({ name: 'Grep', input: { pattern: 'TODO', glob: '*.js' } });
    expect(result.description).toContain('`TODO`');
    expect(result.description).toContain('*.js');
  });

  test('Grep with pattern only omits glob', () => {
    const result = extractToolDetails({ name: 'Grep', input: { pattern: 'error' } });
    expect(result.description).toContain('`error`');
    expect(result.description).not.toContain(' in ');
  });

  test('Grep without pattern returns generic', () => {
    const result = extractToolDetails({ name: 'Grep', input: {} });
    expect(result.description).toBe('Searching files');
  });

  test('Glob with pattern returns description', () => {
    const result = extractToolDetails({ name: 'Glob', input: { pattern: '**/*.ts' } });
    expect(result.description).toContain('`**/*.ts`');
  });

  test('Glob without pattern returns generic', () => {
    const result = extractToolDetails({ name: 'Glob', input: {} });
    expect(result.description).toBe('Finding files');
  });

  test('Agent sets isAgent, subagentType, and description', () => {
    const result = extractToolDetails({ name: 'Agent', input: { description: 'Explore tests', subagent_type: 'Explore' } });
    expect(result.isAgent).toBe(true);
    expect(result.subagentType).toBe('Explore');
    expect(result.description).toBe('Explore tests');
  });

  test('Agent without inputs uses defaults', () => {
    const result = extractToolDetails({ name: 'Agent', input: {} });
    expect(result.isAgent).toBe(true);
    expect(result.subagentType).toBe('general-purpose');
    expect(result.description).toBe('Running sub-agent');
  });

  test('TodoWrite returns fixed description', () => {
    const result = extractToolDetails({ name: 'TodoWrite', input: {} });
    expect(result.description).toBe('Updating task list');
  });

  test('WebSearch with query returns description', () => {
    const result = extractToolDetails({ name: 'WebSearch', input: { query: 'node.js streams' } });
    expect(result.description).toContain('`node.js streams`');
  });

  test('WebSearch without query returns generic', () => {
    const result = extractToolDetails({ name: 'WebSearch', input: {} });
    expect(result.description).toBe('Searching the web');
  });

  test('WebFetch with url returns description', () => {
    const result = extractToolDetails({ name: 'WebFetch', input: { url: 'https://example.com' } });
    expect(result.description).toContain('https://example.com');
  });

  test('WebFetch without url returns generic', () => {
    const result = extractToolDetails({ name: 'WebFetch', input: {} });
    expect(result.description).toBe('Fetching web content');
  });

  test('EnterPlanMode sets isPlanMode and planAction=enter', () => {
    const result = extractToolDetails({ name: 'EnterPlanMode', input: {} });
    expect(result.isPlanMode).toBe(true);
    expect(result.planAction).toBe('enter');
    expect(result.description).toBe('Entering plan mode');
  });

  test('ExitPlanMode sets isPlanMode and planAction=exit', () => {
    const result = extractToolDetails({ name: 'ExitPlanMode', input: {} });
    expect(result.isPlanMode).toBe(true);
    expect(result.planAction).toBe('exit');
    expect(result.description).toBe('Plan ready for approval');
  });

  test('AskUserQuestion sets isQuestion and passes questions array', () => {
    const questions = [{ question: 'Pick a color?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
    const result = extractToolDetails({ name: 'AskUserQuestion', input: { questions } });
    expect(result.isQuestion).toBe(true);
    expect(result.questions).toEqual(questions);
    expect(result.description).toBe('Asking a question');
  });

  test('AskUserQuestion without questions defaults to empty array', () => {
    const result = extractToolDetails({ name: 'AskUserQuestion', input: {} });
    expect(result.isQuestion).toBe(true);
    expect(result.questions).toEqual([]);
  });

  test('unknown tool returns generic description', () => {
    const result = extractToolDetails({ name: 'SomeNewTool', input: {} });
    expect(result.description).toBe('Using SomeNewTool');
  });

  test('preserves block id', () => {
    const result = extractToolDetails({ name: 'Read', id: 'tool_123', input: { file_path: '/a.txt' } });
    expect(result.id).toBe('tool_123');
  });

  test('handles missing input gracefully', () => {
    const result = extractToolDetails({ name: 'Read' });
    expect(result.description).toBe('Reading file');
  });
});

// ── shortenPath (tested via extractToolDetails) ──────────────────────────────

describe('shortenPath via Read tool', () => {
  test('short paths are not shortened', () => {
    const result = extractToolDetails({ name: 'Read', input: { file_path: 'a/b' } });
    expect(result.description).toBe('Reading `a/b`');
  });

  test('long paths are shortened to last 2 segments', () => {
    const result = extractToolDetails({ name: 'Read', input: { file_path: '/a/b/c/d/e.js' } });
    expect(result.description).toContain('.../d/e.js');
  });
});

// ── CLIBackend ──────────────────────────────────────────────────────────────

describe('CLIBackend', () => {
  describe('constructor', () => {
    test('uses default working directory', () => {
      const backend = new CLIBackend();
      expect(backend.workingDir).toContain('.openclaw');
    });

    test('accepts custom working directory', () => {
      const backend = new CLIBackend({ workingDir: '/tmp/test' });
      expect(backend.workingDir).toBe('/tmp/test');
    });
  });

  describe('sendMessage', () => {
    test('returns stream, abort, and sendInput', async () => {
      const backend = new CLIBackend({ workingDir: '/tmp' });
      const { stream, abort, sendInput } = backend.sendMessage('hello', {
        sessionId: 'test-session',
        isNewSession: true,
        workingDir: '/tmp',
      });

      expect(stream).toBeDefined();
      expect(typeof stream[Symbol.asyncIterator]).toBe('function');
      expect(typeof abort).toBe('function');
      expect(typeof sendInput).toBe('function');

      abort();
      for await (const event of stream) {
        if (event.type === 'done') break;
      }
      await sleep(500);
    }, 10000);

    test('abort yields error and done events', async () => {
      const backend = new CLIBackend({ workingDir: '/tmp' });
      const { stream, abort } = backend.sendMessage('hello', {
        sessionId: 'test-abort',
        isNewSession: true,
        workingDir: '/tmp',
      });

      abort();

      const events = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type === 'done') break;
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
      expect(events[events.length - 1].type).toBe('done');
      await sleep(500);
    }, 10000);

    test('sendInput does not throw when process is not started', () => {
      const backend = new CLIBackend({ workingDir: '/tmp' });
      const { sendInput, abort } = backend.sendMessage('hello', {
        sessionId: 'test-input-safe',
        isNewSession: true,
        workingDir: '/tmp',
      });

      // Abort immediately so process gets killed
      abort();

      // sendInput should not throw even after abort
      expect(() => sendInput('some text')).not.toThrow();
    });
  });
});
