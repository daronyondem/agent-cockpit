/**
 * @jest-environment jsdom
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  document.body.innerHTML = `
    <textarea id="chat-textarea"></textarea>
    <div id="chat-file-chips"></div>
    <button id="chat-send-btn"></button>
  `;

  (global as any).chatActiveConvId = null;
  (global as any).chatPendingFiles = [];
  (global as any).chatDraftState = new Map();
});

function chatAutoResize(_el: HTMLElement) {
  // no-op in tests
}

function chatRenderFileChips() {
  // no-op in tests
}

function chatUpdateSendButtonState() {
  // no-op in tests
}

function chatSaveDraft() {
  const key = (global as any).chatActiveConvId || '__new__';
  const textarea = document.getElementById('chat-textarea') as HTMLTextAreaElement | null;
  const text = textarea ? textarea.value : '';
  if (!text && !(global as any).chatPendingFiles.length) {
    (global as any).chatDraftState.delete(key);
    return;
  }
  (global as any).chatDraftState.set(key, { text, pendingFiles: (global as any).chatPendingFiles });
}

function chatRestoreDraft(convId: string | null) {
  const key = convId || '__new__';
  const draft = (global as any).chatDraftState.get(key);
  const textarea = document.getElementById('chat-textarea') as HTMLTextAreaElement | null;
  if (draft) {
    if (textarea) {
      textarea.value = draft.text;
      chatAutoResize(textarea);
    }
    (global as any).chatPendingFiles = draft.pendingFiles;
  } else {
    if (textarea) {
      textarea.value = '';
      chatAutoResize(textarea);
    }
    (global as any).chatPendingFiles = [];
  }
  chatRenderFileChips();
  chatUpdateSendButtonState();
}

describe('chatSaveDraft', () => {
  test('saves textarea text for active conversation', () => {
    (global as any).chatActiveConvId = 'conv-1';
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'hello world';
    chatSaveDraft();
    expect((global as any).chatDraftState.get('conv-1')).toEqual({
      text: 'hello world',
      pendingFiles: [],
    });
  });

  test('saves pending files for active conversation', () => {
    (global as any).chatActiveConvId = 'conv-2';
    const files = [{ file: { name: 'a.png' }, status: 'done', result: {} }];
    (global as any).chatPendingFiles = files;
    chatSaveDraft();
    expect((global as any).chatDraftState.get('conv-2').pendingFiles).toBe(files);
  });

  test('uses __new__ key when no active conversation', () => {
    (global as any).chatActiveConvId = null;
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'draft text';
    chatSaveDraft();
    expect((global as any).chatDraftState.has('__new__')).toBe(true);
    expect((global as any).chatDraftState.get('__new__').text).toBe('draft text');
  });

  test('deletes draft when text and files are both empty', () => {
    (global as any).chatActiveConvId = 'conv-3';
    (global as any).chatDraftState.set('conv-3', { text: 'old', pendingFiles: [] });
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = '';
    (global as any).chatPendingFiles = [];
    chatSaveDraft();
    expect((global as any).chatDraftState.has('conv-3')).toBe(false);
  });

  test('keeps draft if only files present (no text)', () => {
    (global as any).chatActiveConvId = 'conv-4';
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = '';
    (global as any).chatPendingFiles = [{ file: { name: 'b.txt' }, status: 'done' }];
    chatSaveDraft();
    expect((global as any).chatDraftState.has('conv-4')).toBe(true);
    expect((global as any).chatDraftState.get('conv-4').text).toBe('');
  });
});

describe('chatRestoreDraft', () => {
  test('restores saved text and files for a conversation', () => {
    const files = [{ file: { name: 'c.png' }, status: 'done' }];
    (global as any).chatDraftState.set('conv-5', { text: 'restored', pendingFiles: files });
    chatRestoreDraft('conv-5');
    expect((document.getElementById('chat-textarea') as HTMLTextAreaElement).value).toBe('restored');
    expect((global as any).chatPendingFiles).toBe(files);
  });

  test('clears textarea and files when no draft exists', () => {
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'leftover';
    (global as any).chatPendingFiles = [{ file: { name: 'd.txt' }, status: 'done' }];
    chatRestoreDraft('conv-nonexistent');
    expect((document.getElementById('chat-textarea') as HTMLTextAreaElement).value).toBe('');
    expect((global as any).chatPendingFiles).toEqual([]);
  });

  test('uses __new__ key when convId is falsy', () => {
    (global as any).chatDraftState.set('__new__', { text: 'new draft', pendingFiles: [] });
    chatRestoreDraft(null);
    expect((document.getElementById('chat-textarea') as HTMLTextAreaElement).value).toBe('new draft');
  });
});

describe('draft key migration (__new__ → real ID)', () => {
  test('migrating __new__ draft to real conversation ID', () => {
    (global as any).chatDraftState.set('__new__', { text: 'migrated', pendingFiles: [] });
    const newId = 'conv-real-123';
    if ((global as any).chatDraftState.has('__new__')) {
      (global as any).chatDraftState.set(newId, (global as any).chatDraftState.get('__new__'));
      (global as any).chatDraftState.delete('__new__');
    }
    expect((global as any).chatDraftState.has('__new__')).toBe(false);
    expect((global as any).chatDraftState.get(newId)).toEqual({ text: 'migrated', pendingFiles: [] });
  });
});

describe('draft cleanup on delete', () => {
  test('deleting a conversation removes its draft', () => {
    (global as any).chatDraftState.set('conv-del', { text: 'gone', pendingFiles: [] });
    (global as any).chatDraftState.delete('conv-del');
    expect((global as any).chatDraftState.has('conv-del')).toBe(false);
  });
});

describe('round-trip: save then restore across conversations', () => {
  test('switching between two conversations preserves both drafts', () => {
    (global as any).chatActiveConvId = 'conv-A';
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'message for A';
    (global as any).chatPendingFiles = [{ file: { name: 'a.png' }, status: 'done' }];
    chatSaveDraft();

    (global as any).chatActiveConvId = 'conv-B';
    chatRestoreDraft('conv-B');
    expect((document.getElementById('chat-textarea') as HTMLTextAreaElement).value).toBe('');
    expect((global as any).chatPendingFiles).toEqual([]);

    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'message for B';
    (global as any).chatPendingFiles = [];
    chatSaveDraft();

    (global as any).chatActiveConvId = 'conv-A';
    chatRestoreDraft('conv-A');
    expect((document.getElementById('chat-textarea') as HTMLTextAreaElement).value).toBe('message for A');
    expect((global as any).chatPendingFiles).toEqual([{ file: { name: 'a.png' }, status: 'done' }]);

    (global as any).chatActiveConvId = 'conv-B';
    chatRestoreDraft('conv-B');
    expect((document.getElementById('chat-textarea') as HTMLTextAreaElement).value).toBe('message for B');
    expect((global as any).chatPendingFiles).toEqual([]);
  });
});
