/* eslint-disable @typescript-eslint/no-var-requires */

const { resolveLocalFileHref } = require('../public/v2/src/fileLinks.js');

describe('FileLinkUtils.resolveLocalFileHref', () => {
  const workspace = '/Users/daronyondem/github/agent-cockpit';

  test('resolves Codex-style absolute Markdown hrefs with line numbers', () => {
    expect(resolveLocalFileHref('/Users/daronyondem/github/agent-cockpit/src/routes/chat.ts:42', workspace)).toEqual({
      filePath: '/Users/daronyondem/github/agent-cockpit/src/routes/chat.ts',
      line: 42,
      column: null,
    });
  });

  test('resolves encoded absolute paths and column numbers', () => {
    expect(resolveLocalFileHref('/Users/daronyondem/github/agent-cockpit/My%20File.ts:42:7', workspace)).toEqual({
      filePath: '/Users/daronyondem/github/agent-cockpit/My File.ts',
      line: 42,
      column: 7,
    });
  });

  test('accepts file URLs under the workspace', () => {
    expect(resolveLocalFileHref('file:///Users/daronyondem/github/agent-cockpit/public/v2/src/shell.jsx:12', workspace)).toEqual({
      filePath: '/Users/daronyondem/github/agent-cockpit/public/v2/src/shell.jsx',
      line: 12,
      column: null,
    });
  });

  test('rejects non-local links and paths outside the workspace', () => {
    expect(resolveLocalFileHref('https://example.com/src/routes/chat.ts:42', workspace)).toBeNull();
    expect(resolveLocalFileHref('src/routes/chat.ts:42', workspace)).toBeNull();
    expect(resolveLocalFileHref('/Users/daronyondem/Desktop/notes.md:1', workspace)).toBeNull();
    expect(resolveLocalFileHref('/Users/daronyondem/github/agent-cockpit/../secret.txt:1', workspace)).toBeNull();
  });
});
