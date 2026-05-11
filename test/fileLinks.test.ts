/* eslint-disable @typescript-eslint/no-var-requires */

const {
  resolveConversationArtifactHref,
  resolveLocalFileHref,
} = require('../web/AgentCockpitWeb/src/fileLinks.ts');

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
    expect(resolveLocalFileHref('file:///Users/daronyondem/github/agent-cockpit/web/AgentCockpitWeb/src/shell.jsx:12', workspace)).toEqual({
      filePath: '/Users/daronyondem/github/agent-cockpit/web/AgentCockpitWeb/src/shell.jsx',
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

describe('FileLinkUtils.resolveConversationArtifactHref', () => {
  const convId = '6f14cda2-4dec-4e36-bf2f-156cd7d6a6ed';
  const artifactPath = `/Users/daronyondem/Sites/agent-cockpit/data/chat/artifacts/${convId}/pasted-text-20260430-132313.txt`;

  test('resolves absolute artifact paths for the active conversation', () => {
    expect(resolveConversationArtifactHref(artifactPath, convId)).toEqual({
      filePath: artifactPath,
      filename: 'pasted-text-20260430-132313.txt',
      line: null,
      column: null,
    });
  });

  test('resolves encoded file URLs with line suffixes', () => {
    const href = `file:///Users/daronyondem/Sites/agent-cockpit/data/chat/artifacts/${convId}/My%20Notes.txt:12:3`;
    expect(resolveConversationArtifactHref(href, convId)).toEqual({
      filePath: `/Users/daronyondem/Sites/agent-cockpit/data/chat/artifacts/${convId}/My Notes.txt`,
      filename: 'My Notes.txt',
      line: 12,
      column: 3,
    });
  });

  test('rejects non-artifact links and artifacts outside the active conversation', () => {
    expect(resolveConversationArtifactHref('https://example.com/file.txt', convId)).toBeNull();
    expect(resolveConversationArtifactHref('/Users/daronyondem/Sites/agent-cockpit/data/chat/artifacts/other/notes.txt', convId)).toBeNull();
    expect(resolveConversationArtifactHref(`/Users/daronyondem/Sites/agent-cockpit/data/chat/artifacts/${convId}/nested/notes.txt`, convId)).toBeNull();
    expect(resolveConversationArtifactHref(`/Users/daronyondem/Sites/agent-cockpit/data/chat/artifacts/${convId}/../secret.txt`, convId)).toBeNull();
  });
});
