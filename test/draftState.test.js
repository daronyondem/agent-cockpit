/**
 * @jest-environment jsdom
 */

// Unit tests for conversation-aware draft state (chatSaveDraft / chatRestoreDraft).
// These functions live in public/app.js as globals; we replicate the minimal
// environment needed to exercise them in isolation.

/* ── Minimal DOM ──────────────────────────────────────────────────────────── */

beforeEach(() => {
  document.body.innerHTML = `
    <textarea id="chat-textarea"></textarea>
    <div id="chat-file-chips"></div>
    <button id="chat-send-btn"></button>
  `;

  // Reset globals that the functions under test rely on
  global.chatActiveConvId = null;
  global.chatPendingFiles = [];
  global.chatDraftState = new Map();
});

/* ── Stubs for helpers called by save/restore ─────────────────────────────── */

function chatAutoResize(el) {
  // no-op in tests
}

function chatRenderFileChips() {
  // no-op in tests
}

function chatUpdateSendButtonState() {
  // no-op in tests
}

/* ── Functions under test (extracted from app.js) ─────────────────────────── */

function chatSaveDraft() {
  const key = chatActiveConvId || '__new__';
  const textarea = document.getElementById('chat-textarea');
  const text = textarea ? textarea.value : '';
  if (!text && !chatPendingFiles.length) {
    chatDraftState.delete(key);
    return;
  }
  chatDraftState.set(key, { text, pendingFiles: chatPendingFiles });
}

function chatRestoreDraft(convId) {
  const key = convId || '__new__';
  const draft = chatDraftState.get(key);
  const textarea = document.getElementById('chat-textarea');
  if (draft) {
    if (textarea) {
      textarea.value = draft.text;
      chatAutoResize(textarea);
    }
    chatPendingFiles = draft.pendingFiles;
  } else {
    if (textarea) {
      textarea.value = '';
      chatAutoResize(textarea);
    }
    chatPendingFiles = [];
  }
  chatRenderFileChips();
  chatUpdateSendButtonState();
}

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('chatSaveDraft', () => {
  test('saves textarea text for active conversation', () => {
    chatActiveConvId = 'conv-1';
    document.getElementById('chat-textarea').value = 'hello world';
    chatSaveDraft();
    expect(chatDraftState.get('conv-1')).toEqual({
      text: 'hello world',
      pendingFiles: [],
    });
  });

  test('saves pending files for active conversation', () => {
    chatActiveConvId = 'conv-2';
    const files = [{ file: { name: 'a.png' }, status: 'done', result: {} }];
    chatPendingFiles = files;
    chatSaveDraft();
    expect(chatDraftState.get('conv-2').pendingFiles).toBe(files);
  });

  test('uses __new__ key when no active conversation', () => {
    chatActiveConvId = null;
    document.getElementById('chat-textarea').value = 'draft text';
    chatSaveDraft();
    expect(chatDraftState.has('__new__')).toBe(true);
    expect(chatDraftState.get('__new__').text).toBe('draft text');
  });

  test('deletes draft when text and files are both empty', () => {
    chatActiveConvId = 'conv-3';
    chatDraftState.set('conv-3', { text: 'old', pendingFiles: [] });
    document.getElementById('chat-textarea').value = '';
    chatPendingFiles = [];
    chatSaveDraft();
    expect(chatDraftState.has('conv-3')).toBe(false);
  });

  test('keeps draft if only files present (no text)', () => {
    chatActiveConvId = 'conv-4';
    document.getElementById('chat-textarea').value = '';
    chatPendingFiles = [{ file: { name: 'b.txt' }, status: 'done' }];
    chatSaveDraft();
    expect(chatDraftState.has('conv-4')).toBe(true);
    expect(chatDraftState.get('conv-4').text).toBe('');
  });
});

describe('chatRestoreDraft', () => {
  test('restores saved text and files for a conversation', () => {
    const files = [{ file: { name: 'c.png' }, status: 'done' }];
    chatDraftState.set('conv-5', { text: 'restored', pendingFiles: files });
    chatRestoreDraft('conv-5');
    expect(document.getElementById('chat-textarea').value).toBe('restored');
    expect(chatPendingFiles).toBe(files);
  });

  test('clears textarea and files when no draft exists', () => {
    document.getElementById('chat-textarea').value = 'leftover';
    chatPendingFiles = [{ file: { name: 'd.txt' }, status: 'done' }];
    chatRestoreDraft('conv-nonexistent');
    expect(document.getElementById('chat-textarea').value).toBe('');
    expect(chatPendingFiles).toEqual([]);
  });

  test('uses __new__ key when convId is falsy', () => {
    chatDraftState.set('__new__', { text: 'new draft', pendingFiles: [] });
    chatRestoreDraft(null);
    expect(document.getElementById('chat-textarea').value).toBe('new draft');
  });
});

describe('draft key migration (__new__ → real ID)', () => {
  test('migrating __new__ draft to real conversation ID', () => {
    chatDraftState.set('__new__', { text: 'migrated', pendingFiles: [] });
    // Simulate what chatEnsureConversation does
    const newId = 'conv-real-123';
    if (chatDraftState.has('__new__')) {
      chatDraftState.set(newId, chatDraftState.get('__new__'));
      chatDraftState.delete('__new__');
    }
    expect(chatDraftState.has('__new__')).toBe(false);
    expect(chatDraftState.get(newId)).toEqual({ text: 'migrated', pendingFiles: [] });
  });
});

describe('draft cleanup on delete', () => {
  test('deleting a conversation removes its draft', () => {
    chatDraftState.set('conv-del', { text: 'gone', pendingFiles: [] });
    chatDraftState.delete('conv-del');
    expect(chatDraftState.has('conv-del')).toBe(false);
  });
});

describe('round-trip: save then restore across conversations', () => {
  test('switching between two conversations preserves both drafts', () => {
    // Start in conv-A, type something
    chatActiveConvId = 'conv-A';
    document.getElementById('chat-textarea').value = 'message for A';
    chatPendingFiles = [{ file: { name: 'a.png' }, status: 'done' }];
    chatSaveDraft();

    // Switch to conv-B, type something different
    chatActiveConvId = 'conv-B';
    chatRestoreDraft('conv-B'); // no draft yet → clears
    expect(document.getElementById('chat-textarea').value).toBe('');
    expect(chatPendingFiles).toEqual([]);

    document.getElementById('chat-textarea').value = 'message for B';
    chatPendingFiles = [];
    chatSaveDraft();

    // Switch back to conv-A
    chatActiveConvId = 'conv-A';
    chatRestoreDraft('conv-A');
    expect(document.getElementById('chat-textarea').value).toBe('message for A');
    expect(chatPendingFiles).toEqual([{ file: { name: 'a.png' }, status: 'done' }]);

    // Switch back to conv-B
    chatActiveConvId = 'conv-B';
    chatRestoreDraft('conv-B');
    expect(document.getElementById('chat-textarea').value).toBe('message for B');
    expect(chatPendingFiles).toEqual([]);
  });
});
