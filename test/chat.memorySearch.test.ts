import type { MemoryFile, MemoryType } from '../src/types';
import {
  memorySearchSnippet,
  searchMemoryFiles,
  tokenizeMemorySearch,
} from '../src/services/chat/memorySearch';
import { memoryEntryId } from '../src/services/chat/memoryMetadata';

function memoryFile(
  filename: string,
  args: {
    name: string;
    description: string;
    type: MemoryType;
    content: string;
    status?: 'active' | 'superseded' | 'redacted' | 'deleted';
    updatedAt?: string;
  },
): MemoryFile {
  return {
    filename,
    name: args.name,
    description: args.description,
    type: args.type,
    content: args.content,
    source: filename.startsWith('notes/') ? 'memory-note' : 'cli-capture',
    metadata: {
      entryId: memoryEntryId(filename),
      filename,
      status: args.status || 'active',
      scope: 'workspace',
      source: filename.startsWith('notes/') ? 'memory-note' : 'cli-capture',
      createdAt: args.updatedAt || '2026-01-01T00:00:00.000Z',
      updatedAt: args.updatedAt || '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('memorySearch', () => {
  test('tokenizeMemorySearch normalizes terms and removes stopwords', () => {
    expect(tokenizeMemorySearch('The TypeScript_and React plan is at _launch_ v2')).toEqual([
      'typescript_and',
      'react',
      'plan',
      'launch',
      'v2',
    ]);
  });

  test('searchMemoryFiles ranks lexical matches and filters status/type', () => {
    const files = [
      memoryFile('notes/typescript.md', {
        name: 'prefers_typescript',
        description: 'user prefers TypeScript examples',
        type: 'user',
        content: 'Use TypeScript examples when the user asks for frontend code.',
      }),
      memoryFile('notes/project.md', {
        name: 'launch_deadline',
        description: 'launch deadline and rollout plan',
        type: 'project',
        content: 'The launch deadline is Friday and the rollout plan needs screenshots.',
      }),
      memoryFile('notes/old.md', {
        name: 'old_typescript_memory',
        description: 'superseded TypeScript preference',
        type: 'user',
        status: 'superseded',
        content: 'Old TypeScript preference that should not be searched by default.',
      }),
    ];

    const defaultResults = searchMemoryFiles(files, {
      query: 'typescript frontend preference',
      limit: 5,
    });
    expect(defaultResults.map((result) => result.filename)).toEqual(['notes/typescript.md']);
    expect(defaultResults[0]).toMatchObject({
      type: 'user',
      status: 'active',
      snippet: expect.stringMatching(/TypeScript/i),
    });

    const supersededResults = searchMemoryFiles(files, {
      query: 'typescript',
      statuses: ['superseded'],
    });
    expect(supersededResults.map((result) => result.filename)).toEqual(['notes/old.md']);

    const projectResults = searchMemoryFiles(files, {
      query: 'deadline',
      types: ['project'],
    });
    expect(projectResults.map((result) => result.filename)).toEqual(['notes/project.md']);
  });

  test('searchMemoryFiles applies exact/type boosts and recency tie-breaks', () => {
    const dense = memoryFile('notes/dense.md', {
      name: 'dense_fruit_note',
      description: 'dense fruit note',
      type: 'user',
      content: 'Apple apple apple apple apple apple apple apple apple.',
    });
    const exact = memoryFile('notes/exact.md', {
      name: 'apple',
      description: 'direct title match',
      type: 'user',
      content: 'Keep this short.',
    });

    expect(searchMemoryFiles([dense, exact], { query: 'apple', limit: 2 }).map((result) => result.filename))
      .toEqual(['notes/exact.md', 'notes/dense.md']);

    const user = memoryFile('notes/user-roadmap.md', {
      name: 'roadmap',
      description: 'shared roadmap',
      type: 'user',
      content: 'Roadmap notes.',
    });
    const project = memoryFile('notes/project-roadmap.md', {
      name: 'roadmap',
      description: 'shared roadmap',
      type: 'project',
      content: 'Roadmap notes.',
    });
    expect(searchMemoryFiles([user, project], { query: 'project roadmap', limit: 2 })[0].filename)
      .toBe('notes/project-roadmap.md');

    const older = memoryFile('notes/tie-old.md', {
      name: 'tie_match',
      description: 'same tie match',
      type: 'feedback',
      content: 'Tie match content.',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = memoryFile('notes/tie-new.md', {
      name: 'tie_match',
      description: 'same tie match',
      type: 'feedback',
      content: 'Tie match content.',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(searchMemoryFiles([older, newer], { query: 'tie match', types: ['feedback'], limit: 2 }).map((result) => result.filename))
      .toEqual(['notes/tie-new.md', 'notes/tie-old.md']);
  });

  test('memorySearchSnippet returns a compact matching window', () => {
    const content = `${'Intro '.repeat(40)}needle appears here ${'tail '.repeat(80)}`;
    const snippet = memorySearchSnippet(content, ['needle']);
    expect(snippet).toContain('needle appears here');
    expect(snippet.startsWith('...')).toBe(true);
    expect(snippet.endsWith('...')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(266);
  });
});
