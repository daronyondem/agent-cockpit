import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractSection, renderReleaseNotes } = require('../scripts/render-release-notes.js');

function writeFile(root: string, relPath: string, content: string) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe('release notes renderer', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('extracts second-level markdown sections', () => {
    const markdown = [
      '# Agent Cockpit v1.2.3',
      '',
      '## Shipped For Users',
      '',
      '- Added a thing.',
      '',
      '### Nested Detail',
      '',
      'Kept with the section.',
      '',
      '## Developer Details',
      '',
      '- Changed code.',
    ].join('\n');

    expect(extractSection(markdown, 'Shipped For Users')).toContain('### Nested Detail');
    expect(extractSection(markdown, 'Developer Details')).toBe('- Changed code.');
  });

  test('renders GitHub release notes from a source-controlled release document', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-release-notes-'));
    tmpRoots.push(root);
    writeFile(root, 'docs/releases/v1.2.3.md', [
      '# Agent Cockpit v1.2.3',
      '',
      '## Shipped For Users',
      '',
      '- Improved setup so new users can finish installation without guessing which CLI auth step is next.',
      '- Added release badges so users can see current health and release availability.',
      '',
      '## Developer Details',
      '',
      '- Updated the release workflow and README documentation.',
      '',
      '## Verification',
      '',
      '- npm test',
    ].join('\n'));

    const notes = renderReleaseNotes({
      root,
      version: 'v1.2.3',
      repo: 'example/agent-cockpit',
    });

    expect(notes).toContain('Agent Cockpit production release v1.2.3.');
    expect(notes).toContain('## Shipped For Users');
    expect(notes).toContain('Improved setup');
    expect(notes).toContain('## Developer Details');
    expect(notes).toContain(
      'https://github.com/example/agent-cockpit/blob/v1.2.3/docs/releases/v1.2.3.md',
    );
    expect(notes).not.toContain('Updated the release workflow');
  });

  test('fails when user-facing shipped notes are missing or placeholders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-release-notes-'));
    tmpRoots.push(root);
    writeFile(root, 'docs/releases/v1.2.3.md', [
      '# Agent Cockpit v1.2.3',
      '',
      '## Shipped For Users',
      '',
      'TODO',
      '',
      '## Developer Details',
      '',
      '- Details.',
    ].join('\n'));

    expect(() => renderReleaseNotes({ root, version: '1.2.3' })).toThrow(
      'still contains TODO/TBD',
    );
  });
});
