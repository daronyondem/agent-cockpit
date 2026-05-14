import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const root = process.cwd();
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const artifactDir = process.env.CLAUDE_INTERACTIVE_E2E_ARTIFACT_DIR
  || path.join(root, 'data', 'chat', 'claude-interactive-compat', stamp);

fs.mkdirSync(artifactDir, { recursive: true });

const command = [
  'test',
  '--',
  'test/claudeCodeInteractive.e2e.test.ts',
  '--runInBand',
  '--forceExit',
];

const env = {
  ...process.env,
  CLAUDE_INTERACTIVE_E2E: '1',
  CLAUDE_INTERACTIVE_E2E_ARTIFACT_DIR: artifactDir,
};

const result = spawnSync('npm', command, {
  cwd: root,
  env,
  encoding: 'utf8',
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

const finishedAt = new Date();
const report = [
  '# Claude Code Interactive Compatibility Report',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${finishedAt.toISOString()}`,
  `- Exit code: ${result.status ?? 'null'}`,
  `- Signal: ${result.signal || 'none'}`,
  `- Artifact directory: ${artifactDir}`,
  `- Config dir: ${process.env.CLAUDE_INTERACTIVE_E2E_CONFIG_DIR || '(default Claude config)'}`,
  '',
  '## Command',
  '',
  '```sh',
  `CLAUDE_INTERACTIVE_E2E=1 CLAUDE_INTERACTIVE_E2E_ARTIFACT_DIR="${artifactDir}" npm ${command.join(' ')}`,
  '```',
  '',
  '## stdout',
  '',
  '```text',
  trimForReport(result.stdout),
  '```',
  '',
  '## stderr',
  '',
  '```text',
  trimForReport(result.stderr),
  '```',
  '',
].join('\n');

fs.writeFileSync(path.join(artifactDir, 'report.md'), report);
fs.writeFileSync(path.join(artifactDir, 'result.json'), `${JSON.stringify({
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  exitCode: result.status,
  signal: result.signal,
  artifactDir,
  configDir: process.env.CLAUDE_INTERACTIVE_E2E_CONFIG_DIR || null,
}, null, 2)}\n`);

process.stdout.write(`\nClaude Code Interactive compatibility artifacts: ${artifactDir}\n`);

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);

function trimForReport(value: string | null | undefined): string {
  const text = value || '';
  const limit = 50_000;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}
