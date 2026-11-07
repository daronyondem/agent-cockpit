import os from 'os';
import path from 'path';
import { resolveClaudeCliRuntime } from '../src/services/backends/claudeCode';
import { resolveCodexCliRuntime } from '../src/services/backends/codexRuntime';
import { resolveGrokCliRuntime } from '../src/services/backends/grokRuntime';
import { resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import type { CliHarness, CliProfile } from '../src/types';

const { cliConfigDirField } = require('../web/AgentCockpitWeb/src/screens/cliProfileConfigDir.js') as {
  cliConfigDirField: (harness: string) => { hint: string; placeholder: string };
};

const RESOLVERS: Partial<Record<CliHarness, (profile: CliProfile) => { env: NodeJS.ProcessEnv }>> = {
  'claude-code': resolveClaudeCliRuntime,
  codex: resolveCodexCliRuntime,
  'grok-build': resolveGrokCliRuntime,
  'cortex-code': profile => resolveCortexRuntime({ profile, workspaceId: 'fixture', cwd: os.tmpdir() }),
};

describe('account profile Config directory field', () => {
  test.each(Object.keys(RESOLVERS) as CliHarness[])('%s hint names the variable its runtime sets from configDir', (harness) => {
    const configDir = path.join(os.tmpdir(), 'cockpit-account-home');
    const profile = { id: `fixture-${harness}`, name: 'Fixture', harness, authMode: 'account', configDir,
      ...(harness === 'cortex-code' ? { cortexCode: { connection: 'fixture' } } : {}) } as CliProfile;
    const { hint, placeholder } = cliConfigDirField(harness);
    const variable = /^Maps to ([A-Z_]+) at runtime\./.exec(hint)?.[1];

    expect(variable).toBeDefined();
    expect(RESOLVERS[harness]!(profile).env[variable!]).toBe(path.resolve(configDir));
    expect(placeholder).toMatch(/^\/Users\/server\/\.[a-z]+-account$/);
  });

  test('Grok Build no longer falls back to the Claude Code copy', () => {
    expect(cliConfigDirField('grok-build')).toEqual({
      hint: 'Maps to GROK_HOME at runtime.',
      placeholder: '/Users/server/.grok-account',
    });
  });
});
