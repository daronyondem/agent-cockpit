import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

function loadMobileAppModel(): Record<string, any> {
  const sourcePath = path.join(ROOT, 'mobile/AgentCockpitPWA/src/appModel.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transformed = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      isolatedModules: true,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  const sandbox = {
    exports: module.exports,
    module,
    URL,
    document: {
      createElement: jest.fn(),
      body: { append: jest.fn() },
    },
  };
  vm.runInNewContext(transformed, sandbox, { filename: sourcePath });
  return module.exports;
}

describe('mobile app model helpers', () => {
  const model = loadMobileAppModel();

  test('parses uploaded and delivered file markers without leaking marker text into previews', () => {
    const parsed = model.parseMessageFiles([
      'Here is the result.',
      '',
      '<!-- FILE_DELIVERY:/tmp/report.md -->',
      '[Uploaded files: /tmp/image.png, notes.txt]',
    ].join('\n'));

    expect(parsed).toEqual({
      text: 'Here is the result.',
      deliveredPaths: ['/tmp/report.md'],
      uploadedPaths: ['/tmp/image.png', 'notes.txt'],
    });
    expect(model.displayMessagePreview('<!-- FILE_DELIVERY:/tmp/report.md -->')).toBe('File: report.md');
    expect(model.displayMessagePreview('[Uploaded files: /tmp/image.png, notes.txt]')).toBe('2 attachments: image.png, notes.txt');
  });

  test('normalizes reset session list items with explicit null fields for shared contracts', () => {
    const sessions = [{
      number: 1,
      sessionId: 'old-session',
      startedAt: '2026-05-01T00:00:00.000Z',
      endedAt: null,
      messageCount: 2,
      summary: null,
      isCurrent: true,
    }];
    const response = {
      conversation: { currentSessionId: 'new-session' },
      newSessionNumber: 2,
      archivedSession: {
        number: 1,
        sessionId: 'old-session',
        startedAt: '2026-05-01T00:00:00.000Z',
        endedAt: '2026-05-01T01:00:00.000Z',
        messageCount: 2,
        summary: '',
      },
    };

    expect(model.updateSessionsAfterReset(sessions, response)).toEqual([
      expect.objectContaining({ number: 1, endedAt: '2026-05-01T01:00:00.000Z', summary: null, isCurrent: false }),
      expect.objectContaining({ number: 2, sessionId: 'new-session', endedAt: null, summary: null, isCurrent: true }),
    ]);
  });

  test('projects conversations into shared list items with null last-message and usage fields', () => {
    const conversation = {
      id: 'conv-1',
      title: 'Empty',
      backend: 'codex',
      workingDir: '/tmp/workspace',
      workspaceHash: 'hash-1',
      messages: [],
      archived: false,
    };

    expect(model.conversationListItemFromConversation(conversation)).toEqual(expect.objectContaining({
      id: 'conv-1',
      lastMessage: null,
      usage: null,
      messageCount: 0,
    }));
  });
});
