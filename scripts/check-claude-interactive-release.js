#!/usr/bin/env node

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COMPATIBILITY_SOURCE = path.join(ROOT, 'src', 'services', 'backends', 'claudeInteractiveCompatibility.ts');
const CLAUDE_CODE_NPM_PACKAGE = '@anthropic-ai/claude-code';
const ISSUE_MARKER_PREFIX = 'agent-cockpit:claude-code-interactive-version';
const ISSUE_TITLE_PREFIX = 'Support Claude Code Interactive for Claude Code';
const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 2 * 1024 * 1024;

function parseVersion(output) {
  const match = String(output || '').match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

function compareSemver(a, b) {
  if (!a || !b) return 0;
  const left = a.split(/[-+]/)[0].split('.').map(Number);
  const right = b.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const av = left[i] || 0;
    const bv = right[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function readTestedVersion(sourceFile = COMPATIBILITY_SOURCE) {
  const source = fs.readFileSync(sourceFile, 'utf8');
  const match = source.match(/CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!match) {
    throw new Error(`Could not find CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION in ${sourceFile}`);
  }
  return match[1];
}

function issueMarker(version) {
  return `<!-- ${ISSUE_MARKER_PREFIX}:${version} -->`;
}

function buildIssueTitle(latestVersion) {
  return `${ISSUE_TITLE_PREFIX} ${latestVersion}`;
}

function buildIssueBody({ latestVersion, testedVersion, packageName = CLAUDE_CODE_NPM_PACKAGE }) {
  return [
    issueMarker(latestVersion),
    '',
    `Claude Code ${latestVersion} is newer than Agent Cockpit's tested Claude Code Interactive version ${testedVersion}.`,
    '',
    'Claude Code Interactive depends on private Claude CLI terminal and transcript behavior, so this version needs explicit validation before the tested-version constant moves forward.',
    '',
    '## Version Details',
    '',
    `- npm package: \`${packageName}\``,
    `- latest published version: \`${latestVersion}\``,
    `- tested Interactive version: \`${testedVersion}\``,
    '',
    '## Validation',
    '',
    '- Run `npm run e2e:claude-interactive:report` with an authenticated real `claude` CLI.',
    '- Run `npm run e2e:claude-interactive-ui:report` with an authenticated real `claude` CLI.',
    '- If both reports pass, update `CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION` and any related specs.',
    '- If compatibility changed, update the adapter and real-Claude compatibility coverage before moving the tested version.',
    '',
  ].join('\n');
}

function repoArgs(repo) {
  return repo ? ['--repo', repo] : [];
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      timeout: options.timeoutMs || EXEC_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || MAX_BUFFER,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || '').trim() || err.message));
      } else {
        resolve(String(stdout || '').trim());
      }
    });
  });
}

async function latestClaudeCodeVersion(runner = execFileText, root = ROOT, env = process.env) {
  const output = await runner('npm', ['view', CLAUDE_CODE_NPM_PACKAGE, 'version'], { cwd: root, env });
  const version = parseVersion(output);
  if (!version) {
    throw new Error(`Could not parse latest Claude Code version from npm output: ${output}`);
  }
  return version;
}

async function findExistingIssue({ runner = execFileText, root = ROOT, env = process.env, repo, title, marker }) {
  const output = await runner('gh', [
    'issue',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title,body,url',
    '--search',
    `"${ISSUE_TITLE_PREFIX}" in:title`,
    ...repoArgs(repo),
  ], { cwd: root, env });

  let issues;
  try {
    issues = JSON.parse(output || '[]');
  } catch (err) {
    throw new Error(`Could not parse gh issue list output: ${err.message}`);
  }

  return issues.find((issue) => issue.title === title || String(issue.body || '').includes(marker)) || null;
}

async function createIssue({ runner = execFileText, root = ROOT, env = process.env, repo, title, body }) {
  return runner('gh', [
    'issue',
    'create',
    '--title',
    title,
    '--body',
    body,
    ...repoArgs(repo),
  ], { cwd: root, env });
}

async function checkClaudeInteractiveRelease({
  root = ROOT,
  env = process.env,
  repo = env.GITHUB_REPOSITORY || null,
  runner = execFileText,
  log = console.log,
} = {}) {
  const testedVersion = readTestedVersion(path.join(root, 'src', 'services', 'backends', 'claudeInteractiveCompatibility.ts'));
  const latestVersion = await latestClaudeCodeVersion(runner, root, env);
  const comparison = compareSemver(latestVersion, testedVersion);

  if (comparison <= 0) {
    log(`Claude Code Interactive is current: tested ${testedVersion}, latest ${latestVersion}.`);
    return { status: 'current', testedVersion, latestVersion };
  }

  const title = buildIssueTitle(latestVersion);
  const marker = issueMarker(latestVersion);
  const body = buildIssueBody({ latestVersion, testedVersion });
  const existing = await findExistingIssue({ runner, root, env, repo, title, marker });

  if (existing) {
    log(`Open issue already exists for Claude Code ${latestVersion}: #${existing.number}`);
    return {
      status: 'existing',
      testedVersion,
      latestVersion,
      issueNumber: existing.number,
      issueUrl: existing.url || null,
    };
  }

  const issueUrl = (await createIssue({ runner, root, env, repo, title, body })).trim();
  log(`Created Claude Code Interactive support issue for Claude Code ${latestVersion}: ${issueUrl}`);
  return { status: 'created', testedVersion, latestVersion, issueUrl };
}

function writeGithubOutput(result, outputFile = process.env.GITHUB_OUTPUT) {
  if (!outputFile) return;
  const lines = [
    `status=${result.status}`,
    `tested_version=${result.testedVersion}`,
    `latest_version=${result.latestVersion}`,
  ];
  if (result.issueNumber) lines.push(`issue_number=${result.issueNumber}`);
  if (result.issueUrl) lines.push(`issue_url=${result.issueUrl}`);
  fs.appendFileSync(outputFile, `${lines.join('\n')}\n`);
}

if (require.main === module) {
  checkClaudeInteractiveRelease()
    .then((result) => {
      writeGithubOutput(result);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

module.exports = {
  CLAUDE_CODE_NPM_PACKAGE,
  ISSUE_MARKER_PREFIX,
  ISSUE_TITLE_PREFIX,
  buildIssueBody,
  buildIssueTitle,
  checkClaudeInteractiveRelease,
  compareSemver,
  findExistingIssue,
  issueMarker,
  latestClaudeCodeVersion,
  parseVersion,
  readTestedVersion,
};
