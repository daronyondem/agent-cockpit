import {
  extractFileDeliveries,
  extractUploadedFiles,
  hiddenStreamErrorMessageIds,
} from '../web/AgentCockpitWeb/src/chat/messageParsing';

describe('V2 chat message parsing helpers', () => {
  test('extracts file delivery markers and removes them from visible text', () => {
    expect(extractFileDeliveries('done\n<!-- FILE_DELIVERY:/tmp/report.md -->')).toEqual({
      cleaned: 'done\n',
      files: ['/tmp/report.md'],
    });
  });

  test('extracts uploaded file tags from user messages', () => {
    expect(extractUploadedFiles('please read\n[Uploaded files: /tmp/a.pdf, /tmp/b.png]')).toEqual({
      cleaned: 'please read',
      paths: ['/tmp/a.pdf', '/tmp/b.png'],
    });
  });

  test('hides abort markers and the active terminal stream error marker', () => {
    const ids = hiddenStreamErrorMessageIds([
      { id: 'a', role: 'assistant', content: 'Aborted by user', streamError: { message: 'Aborted by user', source: 'abort' } },
      { id: 'u', role: 'user', content: 'retry' },
      { id: 'b', role: 'assistant', content: 'Backend failed', streamError: { message: 'Backend failed', source: 'backend' } },
    ], 'Backend failed', 'backend');

    expect([...ids].sort()).toEqual(['a', 'b']);
  });
});
