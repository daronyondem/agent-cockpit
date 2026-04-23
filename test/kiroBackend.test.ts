import { BaseBackendAdapter } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import { KiroAdapter, extractKiroToolDetails, parseKiroChatOutput } from '../src/services/backends/kiro';
import type { BackendMetadata, SendMessageResult } from '../src/types';

// ── KiroAdapter metadata ────────────────────────────────────────────────────

describe('KiroAdapter', () => {
  test('metadata has correct shape', () => {
    const adapter = new KiroAdapter({ workingDir: '/tmp' });
    const meta = adapter.metadata;
    expect(meta.id).toBe('kiro');
    expect(meta.label).toBe('Kiro');
    expect(meta.icon).toContain('<svg');
    expect(meta.capabilities).toEqual({
      thinking: true,
      planMode: false,
      agents: true,
      toolActivity: true,
      userQuestions: false,
      stdinInput: false,
    });
  });

  test('metadata.models is populated immediately with hardcoded list', () => {
    const adapter = new KiroAdapter({ workingDir: '/tmp' });
    const models = adapter.metadata.models;
    expect(models).toBeDefined();
    expect(models!.length).toBe(13); // auto + 3 opus + 3 sonnet + haiku + 5 open-weight

    const auto = models!.find(m => m.id === 'auto');
    expect(auto).toBeDefined();
    expect(auto!.default).toBe(true);
    expect(auto!.family).toBe('router');
    expect(auto!.costTier).toBe('medium');

    // auto is the only default
    expect(models!.filter(m => m.default).length).toBe(1);

    const opus47 = models!.find(m => m.id === 'claude-opus-4.7');
    expect(opus47).toBeDefined();
    expect(opus47!.family).toBe('opus');
    expect(opus47!.costTier).toBe('high');

    const opus45 = models!.find(m => m.id === 'claude-opus-4.5');
    expect(opus45).toBeDefined();
    expect(opus45!.family).toBe('opus');

    const sonnet46 = models!.find(m => m.id === 'claude-sonnet-4.6');
    expect(sonnet46).toBeDefined();
    expect(sonnet46!.family).toBe('sonnet');
    expect(sonnet46!.costTier).toBe('medium');

    const sonnet40 = models!.find(m => m.id === 'claude-sonnet-4.0');
    expect(sonnet40).toBeDefined();
    expect(sonnet40!.family).toBe('sonnet');

    const haiku = models!.find(m => m.id === 'claude-haiku-4.5');
    expect(haiku).toBeDefined();
    expect(haiku!.family).toBe('haiku');
    expect(haiku!.costTier).toBe('low');

    // Open-weight models are tagged family='other' and costTier='low'
    for (const id of ['deepseek-3.2', 'minimax-m2.5', 'minimax-m2.1', 'glm-5', 'qwen3-coder-next']) {
      const m = models!.find(x => x.id === id);
      expect(m).toBeDefined();
      expect(m!.family).toBe('other');
      expect(m!.costTier).toBe('low');
    }
  });

  test('stdinInput is false', () => {
    const adapter = new KiroAdapter();
    expect(adapter.metadata.capabilities.stdinInput).toBe(false);
  });

  test('uses default working directory', () => {
    const adapter = new KiroAdapter();
    expect(adapter.workingDir).toContain('.kiro');
  });

  test('accepts custom working directory', () => {
    const adapter = new KiroAdapter({ workingDir: '/tmp/test' });
    expect(adapter.workingDir).toBe('/tmp/test');
  });

  test('extends BaseBackendAdapter', () => {
    const adapter = new KiroAdapter();
    expect(adapter).toBeInstanceOf(BaseBackendAdapter);
  });

  test('can be registered in BackendRegistry', () => {
    const registry = new BackendRegistry();
    const adapter = new KiroAdapter({ workingDir: '/tmp' });
    registry.register(adapter);
    expect(registry.get('kiro')).toBe(adapter);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].id).toBe('kiro');
  });

  test('sendMessage returns stream, abort, and sendInput', () => {
    const adapter = new KiroAdapter({ workingDir: '/tmp' });
    const { stream, abort, sendInput } = adapter.sendMessage('hello', {
      sessionId: 'test-session',
      isNewSession: true,
      workingDir: '/tmp',
      systemPrompt: '',
    });

    expect(stream).toBeDefined();
    expect(typeof stream[Symbol.asyncIterator]).toBe('function');
    expect(typeof abort).toBe('function');
    expect(typeof sendInput).toBe('function');

    // sendInput is a no-op for Kiro — should not throw
    expect(() => sendInput('some text')).not.toThrow();

    // Abort to prevent the stream from hanging
    abort();
  });
});

// ── Shutdown & Reset ──────────────────────────────────���───────────────────

describe('KiroAdapter lifecycle', () => {
  test('shutdown does not throw when no processes', () => {
    const adapter = new KiroAdapter();
    expect(() => adapter.shutdown()).not.toThrow();
  });

  test('onSessionReset does not throw when no processes', () => {
    const adapter = new KiroAdapter();
    expect(() => adapter.onSessionReset('nonexistent-conv')).not.toThrow();
  });
});

// ── BackendRegistry with Kiro ───────────────────────────────────────────────

describe('BackendRegistry with KiroAdapter', () => {
  test('registers alongside ClaudeCodeAdapter', () => {
    const { ClaudeCodeAdapter } = require('../src/services/backends/claudeCode');
    const registry = new BackendRegistry();
    registry.register(new ClaudeCodeAdapter({ workingDir: '/tmp' }));
    registry.register(new KiroAdapter({ workingDir: '/tmp' }));

    expect(registry.list()).toHaveLength(2);
    expect(registry.get('claude-code')).toBeDefined();
    expect(registry.get('kiro')).toBeDefined();
    expect(registry.getDefault()?.metadata.id).toBe('claude-code'); // First registered = default
  });

  test('shutdownAll calls shutdown on all adapters', () => {
    const registry = new BackendRegistry();
    const kiro = new KiroAdapter({ workingDir: '/tmp' });
    const shutdownSpy = jest.spyOn(kiro, 'shutdown');
    registry.register(kiro);
    registry.shutdownAll();
    expect(shutdownSpy).toHaveBeenCalled();
  });
});

// ── extractKiroToolDetails ──────────────────────────────────────────────────

describe('extractKiroToolDetails', () => {
  // ── File operations ────────────────────────────────────────────────────
  test('read normalizes to Read', () => {
    const result = extractKiroToolDetails('call-1', 'read', 'Reading /src/index.ts');
    expect(result.tool).toBe('Read');
    expect(result.description).toBe('Reading /src/index.ts');
    expect(result.id).toBe('call-1');
  });

  test('fs_read normalizes to Read', () => {
    const result = extractKiroToolDetails('call-2', 'fs_read', 'Reading file');
    expect(result.tool).toBe('Read');
  });

  test('fsRead normalizes to Read', () => {
    const result = extractKiroToolDetails('call-3', 'fsRead', 'Reading file');
    expect(result.tool).toBe('Read');
  });

  test('write normalizes to Write', () => {
    const result = extractKiroToolDetails('call-4', 'write', 'Creating app.py');
    expect(result.tool).toBe('Write');
    expect(result.description).toBe('Creating app.py');
  });

  test('fs_write normalizes to Write', () => {
    const result = extractKiroToolDetails('call-5', 'fs_write', 'Writing file');
    expect(result.tool).toBe('Write');
  });

  test('fsWrite normalizes to Write', () => {
    const result = extractKiroToolDetails('call-6', 'fsWrite', 'Writing file');
    expect(result.tool).toBe('Write');
  });

  // ── Shell / Bash ───────────────────────────────────────────────────────
  test('shell normalizes to Bash', () => {
    const result = extractKiroToolDetails('call-7', 'shell', 'npm install');
    expect(result.tool).toBe('Bash');
    expect(result.description).toBe('npm install');
  });

  test('execute_bash normalizes to Bash', () => {
    const result = extractKiroToolDetails('call-8', 'execute_bash', 'Running command');
    expect(result.tool).toBe('Bash');
  });

  test('execute_cmd normalizes to Bash', () => {
    const result = extractKiroToolDetails('call-9', 'execute_cmd', 'Running command');
    expect(result.tool).toBe('Bash');
  });

  // ── Search ─────────────────────────────────────────────────────────────
  test('grep normalizes to Grep', () => {
    const result = extractKiroToolDetails('call-10', 'grep', 'Searching for TODO');
    expect(result.tool).toBe('Grep');
  });

  test('glob normalizes to Glob', () => {
    const result = extractKiroToolDetails('call-11', 'glob', 'Finding *.ts files');
    expect(result.tool).toBe('Glob');
  });

  // ── Agent / Delegation ─────────────────────────────────────────────────
  test('delegate normalizes to Agent with isAgent flag', () => {
    const result = extractKiroToolDetails('call-12', 'delegate', 'Researching API docs');
    expect(result.tool).toBe('Agent');
    expect(result.isAgent).toBe(true);
    expect(result.subagentType).toBe('general-purpose');
  });

  test('subagent normalizes to Agent with isAgent flag', () => {
    const result = extractKiroToolDetails('call-13', 'subagent', 'Running sub-agent');
    expect(result.tool).toBe('Agent');
    expect(result.isAgent).toBe(true);
  });

  test('use_subagent normalizes to Agent with isAgent flag', () => {
    const result = extractKiroToolDetails('call-14', 'use_subagent', 'Running sub-agent');
    expect(result.tool).toBe('Agent');
    expect(result.isAgent).toBe(true);
  });

  // ── Web tools ──────────────────────────────────────────────────────────
  test('web_search normalizes to WebSearch', () => {
    const result = extractKiroToolDetails('call-15', 'web_search', 'Searching: node.js streams');
    expect(result.tool).toBe('WebSearch');
  });

  test('web_fetch normalizes to WebFetch', () => {
    const result = extractKiroToolDetails('call-16', 'web_fetch', 'Fetching https://example.com');
    expect(result.tool).toBe('WebFetch');
  });

  // ── Task management ────────────────────────────────────────────────────
  test('todo normalizes to TodoWrite', () => {
    const result = extractKiroToolDetails('call-17', 'todo', 'Updating task list');
    expect(result.tool).toBe('TodoWrite');
  });

  // ── Kiro-specific tools ────────────────────────────────────────────────
  test('aws normalizes to AWS', () => {
    const result = extractKiroToolDetails('call-18', 'aws', 'Running AWS CLI: s3');
    expect(result.tool).toBe('AWS');
  });

  test('use_aws normalizes to AWS', () => {
    const result = extractKiroToolDetails('call-19', 'use_aws', 'Running AWS CLI');
    expect(result.tool).toBe('AWS');
  });

  test('code normalizes to Code', () => {
    const result = extractKiroToolDetails('call-20', 'code', 'Symbol search');
    expect(result.tool).toBe('Code');
  });

  test('introspect normalizes to Introspect', () => {
    const result = extractKiroToolDetails('call-21', 'introspect', 'Checking Kiro docs');
    expect(result.tool).toBe('Introspect');
  });

  test('knowledge normalizes to Knowledge', () => {
    const result = extractKiroToolDetails('call-22', 'knowledge', 'Accessing knowledge base');
    expect(result.tool).toBe('Knowledge');
  });

  // ── Unknown tools ──────────────────────────────────────────────────────
  test('unknown tool passes through name', () => {
    const result = extractKiroToolDetails('call-23', 'some_new_tool', 'Doing something');
    expect(result.tool).toBe('some_new_tool');
    expect(result.description).toBe('Doing something');
  });

  test('unknown tool with empty title gets generic description', () => {
    const result = extractKiroToolDetails('call-24', 'some_new_tool', '');
    expect(result.description).toBe('Using some_new_tool');
  });

  // ── Non-agent tools don't set isAgent ──────────────────────────────────
  test('non-agent tools do not set isAgent', () => {
    const result = extractKiroToolDetails('call-25', 'read', 'Reading file');
    expect(result.isAgent).toBeUndefined();
  });
});

// ── generateSummary / generateTitle fallbacks ───────────────────────────────

describe('KiroAdapter generateSummary', () => {
  test('returns fallback for empty messages', async () => {
    const adapter = new KiroAdapter();
    const result = await adapter.generateSummary([], 'fallback text');
    expect(result).toBe('fallback text');
  });

  test('returns default fallback when messages empty and no fallback', async () => {
    const adapter = new KiroAdapter();
    const result = await adapter.generateSummary([], '');
    expect(result).toBe('Empty session');
  });
});

describe('KiroAdapter generateTitle', () => {
  test('returns fallback for empty message', async () => {
    const adapter = new KiroAdapter();
    const result = await adapter.generateTitle('', 'My Fallback');
    expect(result).toBe('My Fallback');
  });

  test('returns New Chat for empty message and no fallback', async () => {
    const adapter = new KiroAdapter();
    const result = await adapter.generateTitle('', '');
    expect(result).toBe('New Chat');
  });
});

// ── parseKiroChatOutput ─────────────────────────────────────────────────────

describe('parseKiroChatOutput', () => {
  // Build the real output shape that `kiro-cli chat --no-interactive
  // --trust-all-tools` produces, so the tests exercise the same bytes that
  // the adapter will see in production.
  function buildKiroRawOutput(answer: string): string {
    return (
      '\x1b[32mAll tools are now trusted (\x1b[0m\x1b[31m!\x1b[0m\x1b[32m). ' +
      'Kiro will execute tools without asking for confirmation.\x1b[0m\n' +
      'Agents can sometimes do unexpected things so understand the risks.\n\n' +
      'Learn more at \x1b[38;5;141mhttps://kiro.dev/docs/cli/chat/security/' +
      '#using-tools-trust-all-safely\x1b[0m\n\n\n\n' +
      '\x1b[38;5;252m\x1b[0m\x1b[?25l\x1b[38;5;141m> \x1b[0m' + answer + '\n\n' +
      ' \x1b[38;5;141m▸\x1b[0m Credits: 0.02 • Time: 3s\n'
    );
  }

  test('strips ANSI, trust header, prompt prefix and credits footer', () => {
    const raw = buildKiroRawOutput('Hey there, friend!');
    expect(parseKiroChatOutput(raw)).toBe('Hey there, friend!');
  });

  test('preserves multi-line answers', () => {
    const raw = buildKiroRawOutput('Red\nBlue\nGreen');
    expect(parseKiroChatOutput(raw)).toBe('Red\nBlue\nGreen');
  });

  test('preserves markdown blockquotes inside the answer', () => {
    // Leading `> ` in the answer body must survive — only the FIRST `> `
    // prompt prefix is stripped.
    const raw = buildKiroRawOutput('Here is a quote:\n> the inner quote\nDone.');
    expect(parseKiroChatOutput(raw)).toBe('Here is a quote:\n> the inner quote\nDone.');
  });

  test('strips ANSI codes embedded inside the answer', () => {
    const raw = buildKiroRawOutput('\x1b[1mBold\x1b[0m answer');
    expect(parseKiroChatOutput(raw)).toBe('Bold answer');
  });

  test('returns empty string for empty input', () => {
    expect(parseKiroChatOutput('')).toBe('');
  });

  test('handles output without the trust-warning header (format drift safety)', () => {
    // If kiro-cli ever stops emitting the trust header, we should still
    // return a usable answer rather than a blank string.
    const raw = '\x1b[38;5;141m> \x1b[0mHello world\n\n \x1b[38;5;141m▸\x1b[0m Credits: 0.01 • Time: 1s\n';
    expect(parseKiroChatOutput(raw)).toBe('Hello world');
  });

  test('handles output without the credits footer', () => {
    const raw = buildKiroRawOutput('No footer answer').replace(/\n \x1b\[38;5;141m▸.*$/s, '\n');
    expect(parseKiroChatOutput(raw)).toBe('No footer answer');
  });

  test('strips the specific sequence reported in the bug ([38;5;141m> [0m)', () => {
    // Reproducer from GitHub issue: user reported seeing
    //   "[38;5;141m> [0mAsking about a number"
    // in their Kiro conversation titles.
    const raw = buildKiroRawOutput('Asking about a number');
    const result = parseKiroChatOutput(raw);
    expect(result).toBe('Asking about a number');
    expect(result).not.toMatch(/\x1b/);
    expect(result).not.toMatch(/^> /);
    expect(result).not.toMatch(/\[38;5;141m/);
  });
});
