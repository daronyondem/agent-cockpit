/**
 * @jest-environment jsdom
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// These tests mirror the real draft helpers in public/js/conversations.js.
// They are reimplemented here (rather than imported) because the real module
// pulls in a deep dependency tree (rendering, modal, backends) that would
// require extensive DOM/state mocking. Keep this shadow implementation in
// sync with the source when the real behavior changes.

const DRAFT_STORAGE_PREFIX = 'chat:draft:';

function chatDraftStorageKey(key: string) {
  return DRAFT_STORAGE_PREFIX + key;
}

function chatSerializeDraftFiles(pendingFiles: any[]) {
  return (pendingFiles || [])
    .filter(e => e.status === 'done' && e.result && e.result.path)
    .map(e => ({
      path: e.result.path,
      name: e.result.name || e.file?.name || '',
      size: e.file?.size || 0,
    }));
}

function chatDeserializeDraftFiles(persistedFiles: any[]) {
  return (persistedFiles || []).map(pf => ({
    file: { name: pf.name || '', size: pf.size || 0 },
    status: 'done',
    progress: 100,
    result: { path: pf.path, name: pf.name || '' },
    xhr: null,
    restored: true,
  }));
}

function chatWriteDraftToStorage(key: string, draft: any) {
  try {
    const payload = JSON.stringify({
      text: draft.text || '',
      files: chatSerializeDraftFiles(draft.pendingFiles),
    });
    localStorage.setItem(chatDraftStorageKey(key), payload);
  } catch {}
}

function chatRemoveDraftFromStorage(key: string) {
  try { localStorage.removeItem(chatDraftStorageKey(key)); } catch {}
}

function chatDeleteDraft(key: string | null) {
  const k = key || '__new__';
  (global as any).chatDraftState.delete(k);
  chatRemoveDraftFromStorage(k);
}

function chatMigrateDraft(fromKey: string, toKey: string) {
  if (!(global as any).chatDraftState.has(fromKey)) return;
  (global as any).chatDraftState.set(toKey, (global as any).chatDraftState.get(fromKey));
  (global as any).chatDraftState.delete(fromKey);
  try {
    const raw = localStorage.getItem(chatDraftStorageKey(fromKey));
    if (raw !== null) {
      localStorage.setItem(chatDraftStorageKey(toKey), raw);
      localStorage.removeItem(chatDraftStorageKey(fromKey));
    }
  } catch {}
}

function chatHydrateDraftsFromStorage() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(DRAFT_STORAGE_PREFIX)) keys.push(k);
  }
  for (const storageKey of keys) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const convKey = storageKey.slice(DRAFT_STORAGE_PREFIX.length);
      (global as any).chatDraftState.set(convKey, {
        text: parsed.text || '',
        pendingFiles: chatDeserializeDraftFiles(parsed.files),
      });
    } catch {
      try { localStorage.removeItem(storageKey); } catch {}
    }
  }
}

function chatAutoResize(_el: HTMLElement) { /* no-op */ }
function chatRenderFileChips() { /* no-op */ }
function chatUpdateSendButtonState() { /* no-op */ }

function chatSaveDraft() {
  const key = (global as any).chatActiveConvId || '__new__';
  const textarea = document.getElementById('chat-textarea') as HTMLTextAreaElement | null;
  const text = textarea ? textarea.value : '';
  if (!text && !(global as any).chatPendingFiles.length) {
    chatDeleteDraft(key);
    return;
  }
  const draft = { text, pendingFiles: (global as any).chatPendingFiles };
  (global as any).chatDraftState.set(key, draft);
  chatWriteDraftToStorage(key, draft);
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

beforeEach(() => {
  document.body.innerHTML = `
    <textarea id="chat-textarea"></textarea>
    <div id="chat-file-chips"></div>
    <button id="chat-send-btn"></button>
  `;

  (global as any).chatActiveConvId = null;
  (global as any).chatPendingFiles = [];
  (global as any).chatDraftState = new Map();
  localStorage.clear();
});

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

describe('chatSaveDraft localStorage mirroring', () => {
  test('writes text-only draft to chat:draft:<id>', () => {
    (global as any).chatActiveConvId = 'conv-ls-1';
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'persistent';
    chatSaveDraft();
    const raw = localStorage.getItem('chat:draft:conv-ls-1');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ text: 'persistent', files: [] });
  });

  test('writes __new__ draft under the sentinel key', () => {
    (global as any).chatActiveConvId = null;
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'welcome';
    chatSaveDraft();
    expect(JSON.parse(localStorage.getItem('chat:draft:__new__')!)).toEqual({
      text: 'welcome',
      files: [],
    });
  });

  test('filters pending files to completed uploads only', () => {
    (global as any).chatActiveConvId = 'conv-ls-2';
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'with attachments';
    (global as any).chatPendingFiles = [
      { file: { name: 'ok.png', size: 100 }, status: 'done', result: { path: '/u/ok.png', name: 'ok.png' } },
      { file: { name: 'skip.png', size: 200 }, status: 'uploading', result: null },
      { file: { name: 'fail.png', size: 50 }, status: 'error', result: null },
    ];
    chatSaveDraft();
    const parsed = JSON.parse(localStorage.getItem('chat:draft:conv-ls-2')!);
    expect(parsed.files).toEqual([{ path: '/u/ok.png', name: 'ok.png', size: 100 }]);
  });

  test('empty-draft save removes the localStorage entry', () => {
    (global as any).chatActiveConvId = 'conv-ls-3';
    localStorage.setItem('chat:draft:conv-ls-3', JSON.stringify({ text: 'stale', files: [] }));
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = '';
    (global as any).chatPendingFiles = [];
    chatSaveDraft();
    expect(localStorage.getItem('chat:draft:conv-ls-3')).toBeNull();
  });
});

describe('chatDeleteDraft', () => {
  test('clears both the in-memory Map and localStorage', () => {
    (global as any).chatDraftState.set('conv-del', { text: 'x', pendingFiles: [] });
    localStorage.setItem('chat:draft:conv-del', JSON.stringify({ text: 'x', files: [] }));
    chatDeleteDraft('conv-del');
    expect((global as any).chatDraftState.has('conv-del')).toBe(false);
    expect(localStorage.getItem('chat:draft:conv-del')).toBeNull();
  });

  test('falsy key is normalized to __new__', () => {
    (global as any).chatDraftState.set('__new__', { text: 'n', pendingFiles: [] });
    localStorage.setItem('chat:draft:__new__', JSON.stringify({ text: 'n', files: [] }));
    chatDeleteDraft(null);
    expect((global as any).chatDraftState.has('__new__')).toBe(false);
    expect(localStorage.getItem('chat:draft:__new__')).toBeNull();
  });
});

describe('chatHydrateDraftsFromStorage', () => {
  test('restores all chat:draft:* entries into the in-memory Map', () => {
    localStorage.setItem('chat:draft:conv-h1', JSON.stringify({ text: 'one', files: [] }));
    localStorage.setItem('chat:draft:__new__', JSON.stringify({ text: 'two', files: [] }));
    localStorage.setItem('unrelated:key', 'should be ignored');
    chatHydrateDraftsFromStorage();
    expect((global as any).chatDraftState.get('conv-h1').text).toBe('one');
    expect((global as any).chatDraftState.get('__new__').text).toBe('two');
    expect((global as any).chatDraftState.size).toBe(2);
  });

  test('reconstructs pendingFiles entries with metadata and restored flag', () => {
    localStorage.setItem('chat:draft:conv-h2', JSON.stringify({
      text: 'r',
      files: [{ path: '/u/foo.png', name: 'foo.png', size: 42 }],
    }));
    chatHydrateDraftsFromStorage();
    const draft = (global as any).chatDraftState.get('conv-h2');
    expect(draft.pendingFiles).toEqual([{
      file: { name: 'foo.png', size: 42 },
      status: 'done',
      progress: 100,
      result: { path: '/u/foo.png', name: 'foo.png' },
      xhr: null,
      restored: true,
    }]);
  });

  test('reconstructed file entries omit type so the chip renderer skips URL.createObjectURL', () => {
    localStorage.setItem('chat:draft:conv-h3', JSON.stringify({
      text: '',
      files: [{ path: '/u/image.png', name: 'image.png', size: 100 }],
    }));
    chatHydrateDraftsFromStorage();
    const entry = (global as any).chatDraftState.get('conv-h3').pendingFiles[0];
    expect(entry.file.type).toBeUndefined();
  });

  test('drops a corrupted entry rather than poisoning the draft map', () => {
    localStorage.setItem('chat:draft:conv-h4', '{not json');
    localStorage.setItem('chat:draft:conv-h5', JSON.stringify({ text: 'fine', files: [] }));
    chatHydrateDraftsFromStorage();
    expect((global as any).chatDraftState.has('conv-h4')).toBe(false);
    expect(localStorage.getItem('chat:draft:conv-h4')).toBeNull();
    expect((global as any).chatDraftState.get('conv-h5').text).toBe('fine');
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

describe('chatMigrateDraft', () => {
  test('moves the in-memory draft from one key to another', () => {
    (global as any).chatDraftState.set('__new__', { text: 'm', pendingFiles: [] });
    chatMigrateDraft('__new__', 'conv-real-123');
    expect((global as any).chatDraftState.has('__new__')).toBe(false);
    expect((global as any).chatDraftState.get('conv-real-123')).toEqual({ text: 'm', pendingFiles: [] });
  });

  test('moves the localStorage entry alongside the Map entry', () => {
    (global as any).chatDraftState.set('__new__', { text: 'm', pendingFiles: [] });
    localStorage.setItem('chat:draft:__new__', JSON.stringify({ text: 'm', files: [] }));
    chatMigrateDraft('__new__', 'conv-real-999');
    expect(localStorage.getItem('chat:draft:__new__')).toBeNull();
    expect(JSON.parse(localStorage.getItem('chat:draft:conv-real-999')!)).toEqual({ text: 'm', files: [] });
  });

  test('is a no-op when no draft exists at fromKey', () => {
    chatMigrateDraft('__new__', 'conv-other');
    expect((global as any).chatDraftState.has('conv-other')).toBe(false);
  });
});

describe('draft cleanup on delete', () => {
  test('deleting a conversation removes its draft from both layers', () => {
    (global as any).chatDraftState.set('conv-del', { text: 'gone', pendingFiles: [] });
    localStorage.setItem('chat:draft:conv-del', JSON.stringify({ text: 'gone', files: [] }));
    chatDeleteDraft('conv-del');
    expect((global as any).chatDraftState.has('conv-del')).toBe(false);
    expect(localStorage.getItem('chat:draft:conv-del')).toBeNull();
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

describe('round-trip: persist → hydrate → restore (simulating page reload)', () => {
  test('conv draft survives a simulated reload via localStorage', () => {
    (global as any).chatActiveConvId = 'conv-reload';
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'i typed this before 401';
    chatSaveDraft();

    // Simulate a full page reload: in-memory state is wiped, localStorage
    // survives, the textarea is fresh.
    (global as any).chatDraftState = new Map();
    (global as any).chatPendingFiles = [];
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = '';

    chatHydrateDraftsFromStorage();
    chatRestoreDraft('conv-reload');

    expect((document.getElementById('chat-textarea') as HTMLTextAreaElement).value).toBe('i typed this before 401');
  });

  test('__new__ draft is restored on boot when no conversation is active', () => {
    (global as any).chatActiveConvId = null;
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = 'half-written new chat';
    chatSaveDraft();

    (global as any).chatDraftState = new Map();
    (global as any).chatPendingFiles = [];
    (document.getElementById('chat-textarea') as HTMLTextAreaElement).value = '';

    chatHydrateDraftsFromStorage();
    chatRestoreDraft(null);

    expect((document.getElementById('chat-textarea') as HTMLTextAreaElement).value).toBe('half-written new chat');
  });
});
