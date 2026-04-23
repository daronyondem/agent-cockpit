/* eslint-disable @typescript-eslint/no-explicit-any */

import { attachmentFromPath, parseUploadedFilesTag, normalizeMessageQueue } from '../src/services/chatService';

describe('attachment + queue helpers', () => {
  test('attachmentFromPath infers kind from extension', () => {
    expect(attachmentFromPath('/a/b/photo.png').kind).toBe('image');
    expect(attachmentFromPath('/a/b/report.pdf').kind).toBe('pdf');
    expect(attachmentFromPath('/a/b/notes.md').kind).toBe('md');
    expect(attachmentFromPath('/a/b/hello.ts').kind).toBe('code');
    expect(attachmentFromPath('/a/b/log.txt').kind).toBe('text');
    expect(attachmentFromPath('/a/b/unknownext.xyz').kind).toBe('file');
  });

  test('attachmentFromPath formats size', () => {
    expect(attachmentFromPath('/x/f.bin', 512).meta).toBe('512 B');
    expect(attachmentFromPath('/x/f.bin', 2048).meta).toBe('2.0 KB');
    expect(attachmentFromPath('/x/f.bin', 5 * 1024 * 1024).meta).toBe('5.0 MB');
    expect(attachmentFromPath('/x/f.bin').meta).toBeUndefined();
  });

  test('parseUploadedFilesTag extracts single path', () => {
    const res = parseUploadedFilesTag('hello\n\n[Uploaded files: /tmp/a.pdf]');
    expect(res).not.toBeNull();
    expect(res!.content).toBe('hello');
    expect(res!.attachments).toHaveLength(1);
    expect(res!.attachments[0].kind).toBe('pdf');
    expect(res!.attachments[0].path).toBe('/tmp/a.pdf');
    expect(res!.attachments[0].name).toBe('a.pdf');
  });

  test('parseUploadedFilesTag extracts multiple paths', () => {
    const res = parseUploadedFilesTag('see\n[Uploaded files: /tmp/a.png, /tmp/b.ts]');
    expect(res!.attachments).toHaveLength(2);
    expect(res!.attachments[0].kind).toBe('image');
    expect(res!.attachments[1].kind).toBe('code');
  });

  test('parseUploadedFilesTag returns null when tag absent', () => {
    expect(parseUploadedFilesTag('plain text')).toBeNull();
    expect(parseUploadedFilesTag('')).toBeNull();
  });

  test('normalizeMessageQueue migrates legacy string[] entries', () => {
    const out = normalizeMessageQueue(['just text', 'with files\n\n[Uploaded files: /tmp/x.md]']);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ content: 'just text' });
    expect(out[1].content).toBe('with files');
    expect(out[1].attachments).toHaveLength(1);
    expect(out[1].attachments![0].kind).toBe('md');
  });

  test('normalizeMessageQueue passes through current QueuedMessage[] shape', () => {
    const input = [
      { content: 'one', attachments: [{ name: 'f.pdf', path: '/x/f.pdf', kind: 'pdf', size: 100, meta: '100 B' }] },
      { content: 'two' },
    ];
    const out = normalizeMessageQueue(input);
    expect(out).toHaveLength(2);
    expect(out[0].attachments).toHaveLength(1);
    expect(out[0].attachments![0].path).toBe('/x/f.pdf');
    expect(out[1]).toEqual({ content: 'two' });
  });

  test('normalizeMessageQueue strips empty attachments arrays', () => {
    const out = normalizeMessageQueue([{ content: 'a', attachments: [] }]);
    expect(out[0]).toEqual({ content: 'a' });
  });

  test('normalizeMessageQueue drops malformed entries', () => {
    const out = normalizeMessageQueue([null, 123, { nope: true }, { content: 'ok' }]);
    expect(out).toEqual([{ content: 'ok' }]);
  });

  test('normalizeMessageQueue backfills attachment kind from path when missing', () => {
    const out = normalizeMessageQueue([
      { content: 'x', attachments: [{ name: 'a.png', path: '/x/a.png' }] },
    ]);
    expect(out[0].attachments![0].kind).toBe('image');
  });
});
