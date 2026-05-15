#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function normalizeVersion(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('Missing required --version value');
  }
  const version = value.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return version;
}

function normalizeHeading(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const target = normalizeHeading(heading);
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/);
    if (match && normalizeHeading(match[1]) === target) {
      start = i + 1;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join('\n').trim();
}

function assertUsableSection(name, content, options = {}) {
  if (!content || !content.trim()) {
    throw new Error(`Release notes document must include a non-empty "## ${name}" section`);
  }
  if (/\b(TODO|TBD)\b/i.test(content)) {
    throw new Error(`Release notes "## ${name}" section still contains TODO/TBD placeholder text`);
  }
  if (options.requireList && !/^\s*[-*]\s+\S/m.test(content)) {
    throw new Error(`Release notes "## ${name}" section must include at least one bullet`);
  }
}

function buildDocUrl(repo, version, docRelPath) {
  return `https://github.com/${repo}/blob/v${version}/${docRelPath}`;
}

function renderReleaseNotes(options) {
  const root = path.resolve(options.root || process.cwd());
  const version = normalizeVersion(options.version);
  const repo = options.repo || process.env.GITHUB_REPOSITORY || 'daronyondem/agent-cockpit';
  const docRelPath = `docs/releases/v${version}.md`;
  const docPath = path.join(root, docRelPath);

  if (!fs.existsSync(docPath)) {
    throw new Error(`Missing release notes document: ${docRelPath}`);
  }

  const markdown = fs.readFileSync(docPath, 'utf8');
  const shipped = extractSection(markdown, 'Shipped For Users');
  const developerDetails = extractSection(markdown, 'Developer Details');

  assertUsableSection('Shipped For Users', shipped, { requireList: true });
  assertUsableSection('Developer Details', developerDetails);

  const docUrl = buildDocUrl(repo, version, docRelPath);
  return [
    `Agent Cockpit production release v${version}.`,
    '',
    '## Shipped For Users',
    '',
    shipped,
    '',
    '## Developer Details',
    '',
    `See [${docRelPath}](${docUrl}) for implementation details, verification, and source links.`,
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    out: path.join(process.cwd(), 'dist', 'release', 'github-release-notes.md'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--version') {
      args.version = next;
      i += 1;
    } else if (arg === '--root') {
      args.root = next;
      i += 1;
    } else if (arg === '--out') {
      args.out = next;
      i += 1;
    } else if (arg === '--repo') {
      args.repo = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/render-release-notes.js --version <version> [options]

Options:
  --root <path>     Repository root. Defaults to the current directory.
  --out <path>      Output Markdown file. Defaults to dist/release/github-release-notes.md.
  --repo <owner/repo>
                   GitHub repository used for the developer-details link.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const notes = renderReleaseNotes(args);
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, notes);
  console.log(`GitHub release notes: ${outPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  buildDocUrl,
  extractSection,
  normalizeVersion,
  renderReleaseNotes,
};
