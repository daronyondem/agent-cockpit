const { BaseBackendAdapter } = require('../src/services/backends/base');
const { BackendRegistry } = require('../src/services/backends/registry');
const { ClaudeCodeAdapter } = require('../src/services/backends/claudeCode');

// extractToolDetails / shortenPath are not public on the class, so access via exports
const { extractToolDetails, shortenPath } = require('../src/services/backends/claudeCode');

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── BaseBackendAdapter ─────────────────────────────────────────────────────

describe('BaseBackendAdapter', () => {
  test('metadata throws on base class', () => {
    const adapter = new BaseBackendAdapter();
    expect(() => adapter.metadata).toThrow('must be implemented');
  });

  test('sendMessage throws on base class', () => {
    const adapter = new BaseBackendAdapter();
    expect(() => adapter.sendMessage('hi')).toThrow('must be implemented');
  });

  test('generateSummary throws on base class', async () => {
    const adapter = new BaseBackendAdapter();
    await expect(adapter.generateSummary([], 'fallback')).rejects.toThrow('must be implemented');
  });

  test('stores workingDir from options', () => {
    const adapter = new BaseBackendAdapter({ workingDir: '/tmp/test' });
    expect(adapter.workingDir).toBe('/tmp/test');
  });
});

// ── BackendRegistry ────────────────────────────────────────────────────────

describe('BackendRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new BackendRegistry();
  });

  test('register and get adapter', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    registry.register(adapter);
    expect(registry.get('claude-code')).toBe(adapter);
  });

  test('get returns null for unknown id', () => {
    expect(registry.get('nonexistent')).toBeNull();
  });

  test('list returns metadata array', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    registry.register(adapter);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('claude-code');
    expect(list[0].label).toBe('Claude Code');
    expect(list[0].capabilities.thinking).toBe(true);
    expect(list[0].icon).toContain('<svg');
  });

  test('getDefault returns first registered adapter', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    registry.register(adapter);
    expect(registry.getDefault()).toBe(adapter);
  });

  test('getDefault returns null when empty', () => {
    expect(registry.getDefault()).toBeNull();
  });

  test('register rejects non-BaseBackendAdapter', () => {
    expect(() => registry.register({})).toThrow('must extend BaseBackendAdapter');
  });

  test('register multiple adapters', () => {
    // Create a minimal second adapter for testing
    class FakeAdapter extends BaseBackendAdapter {
      get metadata() {
        return { id: 'fake', label: 'Fake', icon: null, capabilities: {} };
      }
      sendMessage() { return { stream: (async function*() {})(), abort: () => {}, sendInput: () => {} }; }
      async generateSummary(msgs, fb) { return fb; }
    }

    const claude = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const fake = new FakeAdapter();
    registry.register(claude);
    registry.register(fake);

    expect(registry.list()).toHaveLength(2);
    expect(registry.get('claude-code')).toBe(claude);
    expect(registry.get('fake')).toBe(fake);
    // Default is first registered
    expect(registry.getDefault()).toBe(claude);
  });
});

// ── ClaudeCodeAdapter metadata ──────────────────────────────────────────────

describe('ClaudeCodeAdapter', () => {
  test('metadata has correct shape', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;
    expect(meta.id).toBe('claude-code');
    expect(meta.label).toBe('Claude Code');
    expect(meta.icon).toContain('<svg');
    expect(meta.capabilities).toEqual({
      thinking: true,
      planMode: true,
      agents: true,
      toolActivity: true,
      userQuestions: true,
      stdinInput: true,
    });
  });

  test('uses default working directory', () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.workingDir).toContain('.openclaw');
  });

  test('accepts custom working directory', () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp/test' });
    expect(adapter.workingDir).toBe('/tmp/test');
  });
});

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

// ── ClaudeCodeAdapter sendMessage ──────────────────────────────────────────

describe('ClaudeCodeAdapter sendMessage', () => {
  test('returns stream, abort, and sendInput', async () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const { stream, abort, sendInput } = adapter.sendMessage('hello', {
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

  test('includes --append-system-prompt for new sessions with systemPrompt', async () => {
    let capturedArgs;
    let streamRef;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd, args) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-sys-prompt',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: 'You are a helpful assistant',
      });
      streamRef = stream;
    });

    for await (const event of streamRef) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    const idx = capturedArgs.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(capturedArgs[idx + 1]).toBe('You are a helpful assistant');
  });

  test('omits --append-system-prompt when systemPrompt is empty', async () => {
    let capturedArgs;
    let streamRef;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd, args) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-no-prompt',
        isNewSession: true,
        workingDir: '/tmp',
        systemPrompt: '',
      });
      streamRef = stream;
    });

    for await (const event of streamRef) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--append-system-prompt');
  });

  test('omits --append-system-prompt on resumed sessions', async () => {
    let capturedArgs;
    let streamRef;
    jest.isolateModules(() => {
      jest.mock('child_process', () => ({
        spawn: (_cmd, args) => {
          capturedArgs = args;
          const { EventEmitter } = require('events');
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdin = { write: () => {}, destroyed: false };
          proc.kill = () => {};
          setTimeout(() => proc.emit('close', 0, null), 10);
          return proc;
        },
        execFile: () => {},
      }));
      const { ClaudeCodeAdapter: IsolatedAdapter } = require('../src/services/backends/claudeCode');
      const adapter = new IsolatedAdapter({ workingDir: '/tmp' });
      const { stream } = adapter.sendMessage('hello', {
        sessionId: 'test-resume',
        isNewSession: false,
        workingDir: '/tmp',
        systemPrompt: 'You are a helpful assistant',
      });
      streamRef = stream;
    });

    for await (const event of streamRef) {
      if (event.type === 'done') break;
    }

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).not.toContain('--append-system-prompt');
    expect(capturedArgs).toContain('--resume');
  });

  test('abort yields error and done events', async () => {
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const { stream, abort } = adapter.sendMessage('hello', {
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
    const adapter = new ClaudeCodeAdapter({ workingDir: '/tmp' });
    const { sendInput, abort } = adapter.sendMessage('hello', {
      sessionId: 'test-input-safe',
      isNewSession: true,
      workingDir: '/tmp',
    });

    abort();
    expect(() => sendInput('some text')).not.toThrow();
  });
});
