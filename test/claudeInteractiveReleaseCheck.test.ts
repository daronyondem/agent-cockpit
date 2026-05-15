import fs from 'fs';
import os from 'os';
import path from 'path';

const releaseCheck = require('../scripts/check-claude-interactive-release.js');

type CommandCall = { command: string; args: string[] };

function makeRoot(testedVersion: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interactive-release-'));
  const sourceDir = path.join(root, 'src', 'services', 'backends');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'claudeInteractiveCompatibility.ts'),
    `export const CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION = '${testedVersion}';\n`,
  );
  return root;
}

function makeRunner(responses: Record<string, string | ((args: string[]) => string)>) {
  const calls: CommandCall[] = [];
  const runner = async (command: string, args: string[]) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(' ')}`;
    const response = responses[key];
    if (typeof response === 'function') return response(args);
    if (typeof response === 'string') return response;
    throw new Error(`unexpected command: ${key}`);
  };
  return { runner, calls };
}

describe('Claude Code Interactive release check script', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('skips GitHub when the latest Claude Code version is already tested', async () => {
    const root = makeRoot('2.1.141');
    const { runner, calls } = makeRunner({
      'npm view @anthropic-ai/claude-code version': '2.1.141',
    });

    try {
      const result = await releaseCheck.checkClaudeInteractiveRelease({
        root,
        repo: 'daronyondem/agent-cockpit',
        runner,
        log: jest.fn(),
      });

      expect(result).toMatchObject({
        status: 'current',
        testedVersion: '2.1.141',
        latestVersion: '2.1.141',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('npm');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('creates a deduped support issue when npm has a newer Claude Code version', async () => {
    const root = makeRoot('2.1.141');
    const { runner, calls } = makeRunner({
      'npm view @anthropic-ai/claude-code version': '2.1.142',
      'gh issue list --state open --limit 100 --json number,title,body,url --search "Support Claude Code Interactive for Claude Code" in:title --repo daronyondem/agent-cockpit': '[]',
    });

    try {
      const result = await releaseCheck.checkClaudeInteractiveRelease({
        root,
        repo: 'daronyondem/agent-cockpit',
        runner: async (command: string, args: string[]) => {
          if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
            calls.push({ command, args });
            return 'https://github.com/daronyondem/agent-cockpit/issues/999';
          }
          return runner(command, args);
        },
        log: jest.fn(),
      });

      expect(result).toMatchObject({
        status: 'created',
        testedVersion: '2.1.141',
        latestVersion: '2.1.142',
        issueUrl: 'https://github.com/daronyondem/agent-cockpit/issues/999',
      });

      const createCall = calls.find((call) => call.command === 'gh' && call.args[1] === 'create');
      expect(createCall).toBeTruthy();
      expect(createCall?.args).toContain('Support Claude Code Interactive for Claude Code 2.1.142');
      const body = createCall?.args[createCall.args.indexOf('--body') + 1] || '';
      expect(body).toContain(releaseCheck.issueMarker('2.1.142'));
      expect(body).toContain('tested Claude Code Interactive version 2.1.141');
      expect(body).toContain('npm run e2e:claude-interactive:report');
      expect(body).toContain('npm run e2e:claude-interactive-ui:report');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not create a second issue when an open issue already has the version marker', async () => {
    const root = makeRoot('2.1.141');
    const existing = [{
      number: 42,
      title: 'Support Claude Code Interactive for Claude Code 2.1.142',
      body: releaseCheck.issueMarker('2.1.142'),
      url: 'https://github.com/daronyondem/agent-cockpit/issues/42',
    }];
    const { runner, calls } = makeRunner({
      'npm view @anthropic-ai/claude-code version': '2.1.142',
      'gh issue list --state open --limit 100 --json number,title,body,url --search "Support Claude Code Interactive for Claude Code" in:title --repo daronyondem/agent-cockpit': JSON.stringify(existing),
    });

    try {
      const result = await releaseCheck.checkClaudeInteractiveRelease({
        root,
        repo: 'daronyondem/agent-cockpit',
        runner,
        log: jest.fn(),
      });

      expect(result).toMatchObject({
        status: 'existing',
        issueNumber: 42,
        issueUrl: 'https://github.com/daronyondem/agent-cockpit/issues/42',
      });
      expect(calls.some((call) => call.command === 'gh' && call.args[1] === 'create')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
