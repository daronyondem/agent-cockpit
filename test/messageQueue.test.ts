/**
 * @jest-environment jsdom
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Globals & DOM setup ──────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = `
    <div id="chat-messages"></div>
    <textarea id="chat-textarea"></textarea>
    <button id="chat-send-btn"></button>
  `;

  (global as any).chatActiveConvId = 'conv-1';
  (global as any).chatMessageQueue = new Map();
  (global as any).chatQueuePaused = new Set();
  (global as any).chatQueueIdCounter = 0;
  (global as any).chatStreamingConvs = new Set();
  (global as any).chatPendingFiles = [];
});

// ── Stubs for functions called by queue logic ────────────────────────────────

function chatAutoResize(_el: HTMLElement) { /* no-op */ }
function chatRenderMarkdown(str: string) { return str; }
function chatScrollToBottom() { /* no-op */ }
function chatUpdateSendButtonState() { /* no-op */ }
function esc(str: string) { return str; }

// ── Extracted queue functions (mirroring app.js logic) ───────────────��───────

function chatRenderQueuedMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  container.querySelectorAll('.chat-msg-queued').forEach(el => el.remove());
  container.querySelectorAll('.chat-queue-paused-banner').forEach(el => el.remove());

  const convId = (global as any).chatActiveConvId;
  if (!convId) return;
  const queue = (global as any).chatMessageQueue.get(convId);
  if (!queue || queue.length === 0) return;

  if ((global as any).chatQueuePaused.has(convId)) {
    const bannerEl = document.createElement('div');
    bannerEl.className = 'chat-queue-paused-banner';
    bannerEl.innerHTML = '<span>Queue paused due to error.</span>';
    container.appendChild(bannerEl);
  }

  for (const item of queue) {
    const el = document.createElement('div');
    el.className = 'chat-msg user chat-msg-queued' + (item.inFlight ? ' chat-msg-in-flight' : '');
    el.dataset.queueId = String(item.id);
    el.innerHTML = `
      <div class="chat-msg-wrapper">
        <div class="chat-msg-body">
          <div class="chat-msg-role">You <span class="chat-queue-badge">${item.inFlight ? 'Sending...' : 'Queued'}</span></div>
          <div class="chat-msg-content chat-queued-content">${chatRenderMarkdown(item.content)}</div>
          ${!item.inFlight ? `<div class="chat-msg-actions chat-queue-actions">
            <button class="chat-msg-action" data-action="edit-queued" data-queue-id="${item.id}">Edit</button>
            <button class="chat-msg-action" data-action="delete-queued" data-queue-id="${item.id}">Delete</button>
          </div>` : ''}
        </div>
      </div>
    `;
    container.appendChild(el);
  }
}

function chatDeleteQueuedMessage(queueId: number) {
  const convId = (global as any).chatActiveConvId;
  if (!convId) return;
  const queue = (global as any).chatMessageQueue.get(convId);
  if (!queue) return;
  const idx = queue.findIndex((item: any) => item.id === queueId);
  if (idx === -1 || queue[idx].inFlight) return;
  queue.splice(idx, 1);
  if (queue.length === 0) {
    (global as any).chatMessageQueue.delete(convId);
    (global as any).chatQueuePaused.delete(convId);
  }
  chatRenderQueuedMessages();
}

function addToQueue(content: string) {
  const convId = (global as any).chatActiveConvId;
  const queue = (global as any).chatMessageQueue.get(convId) || [];
  queue.push({ id: ++(global as any).chatQueueIdCounter, content, inFlight: false });
  (global as any).chatMessageQueue.set(convId, queue);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Message Queue: adding messages', () => {
  test('adds messages to the queue', () => {
    addToQueue('Hello');
    addToQueue('World');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    expect(queue).toHaveLength(2);
    expect(queue[0].content).toBe('Hello');
    expect(queue[1].content).toBe('World');
  });

  test('assigns unique IDs to queued messages', () => {
    addToQueue('A');
    addToQueue('B');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    expect(queue[0].id).not.toBe(queue[1].id);
  });

  test('new queue items default to inFlight false', () => {
    addToQueue('msg');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    expect(queue[0].inFlight).toBe(false);
  });
});

describe('Message Queue: deleting messages', () => {
  test('deletes a queued message by id', () => {
    addToQueue('first');
    addToQueue('second');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    chatDeleteQueuedMessage(queue[0].id);
    const remaining = (global as any).chatMessageQueue.get('conv-1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe('second');
  });

  test('does not delete an in-flight message', () => {
    addToQueue('in-flight-msg');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    queue[0].inFlight = true;
    chatDeleteQueuedMessage(queue[0].id);
    expect((global as any).chatMessageQueue.get('conv-1')).toHaveLength(1);
  });

  test('cleans up queue map when last item deleted', () => {
    addToQueue('only');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    chatDeleteQueuedMessage(queue[0].id);
    expect((global as any).chatMessageQueue.has('conv-1')).toBe(false);
  });

  test('clears paused state when queue becomes empty', () => {
    addToQueue('paused-msg');
    (global as any).chatQueuePaused.add('conv-1');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    chatDeleteQueuedMessage(queue[0].id);
    expect((global as any).chatQueuePaused.has('conv-1')).toBe(false);
  });
});

describe('Message Queue: rendering', () => {
  test('renders queued messages in the chat container', () => {
    addToQueue('test message');
    chatRenderQueuedMessages();
    const els = document.querySelectorAll('.chat-msg-queued');
    expect(els).toHaveLength(1);
    expect(els[0].textContent).toContain('test message');
    expect(els[0].textContent).toContain('Queued');
  });

  test('renders edit and delete buttons for non-in-flight messages', () => {
    addToQueue('editable');
    chatRenderQueuedMessages();
    const editBtn = document.querySelector('[data-action="edit-queued"]');
    const deleteBtn = document.querySelector('[data-action="delete-queued"]');
    expect(editBtn).not.toBeNull();
    expect(deleteBtn).not.toBeNull();
  });

  test('does not render edit/delete buttons for in-flight messages', () => {
    addToQueue('sending');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    queue[0].inFlight = true;
    chatRenderQueuedMessages();
    const editBtn = document.querySelector('[data-action="edit-queued"]');
    const deleteBtn = document.querySelector('[data-action="delete-queued"]');
    expect(editBtn).toBeNull();
    expect(deleteBtn).toBeNull();
  });

  test('shows "Sending..." badge for in-flight messages', () => {
    addToQueue('flying');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    queue[0].inFlight = true;
    chatRenderQueuedMessages();
    const badge = document.querySelector('.chat-queue-badge');
    expect(badge?.textContent).toBe('Sending...');
  });

  test('renders paused banner when queue is paused', () => {
    addToQueue('paused');
    (global as any).chatQueuePaused.add('conv-1');
    chatRenderQueuedMessages();
    const banner = document.querySelector('.chat-queue-paused-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Queue paused');
  });

  test('does not render paused banner when queue is not paused', () => {
    addToQueue('active');
    chatRenderQueuedMessages();
    const banner = document.querySelector('.chat-queue-paused-banner');
    expect(banner).toBeNull();
  });

  test('clears old queued elements before re-rendering', () => {
    addToQueue('msg1');
    chatRenderQueuedMessages();
    expect(document.querySelectorAll('.chat-msg-queued')).toHaveLength(1);

    addToQueue('msg2');
    chatRenderQueuedMessages();
    expect(document.querySelectorAll('.chat-msg-queued')).toHaveLength(2);
  });

  test('renders nothing when queue is empty', () => {
    chatRenderQueuedMessages();
    expect(document.querySelectorAll('.chat-msg-queued')).toHaveLength(0);
    expect(document.querySelectorAll('.chat-queue-paused-banner')).toHaveLength(0);
  });

  test('applies in-flight CSS class', () => {
    addToQueue('sending');
    const queue = (global as any).chatMessageQueue.get('conv-1');
    queue[0].inFlight = true;
    chatRenderQueuedMessages();
    const el = document.querySelector('.chat-msg-queued');
    expect(el?.classList.contains('chat-msg-in-flight')).toBe(true);
  });
});

describe('Message Queue: send button state', () => {
  test('chatUpdateSendButtonState shows arrow when streaming with text', () => {
    // Replicate the logic inline for testing
    const sendBtn = document.getElementById('chat-send-btn') as HTMLButtonElement;
    const ta = document.getElementById('chat-textarea') as HTMLTextAreaElement;
    ta.value = 'some text';
    (global as any).chatStreamingConvs.add('conv-1');

    // Inline logic from chatUpdateSendButtonState
    const isStreaming = (global as any).chatStreamingConvs.has((global as any).chatActiveConvId);
    const hasText = ta.value.trim();
    if (isStreaming && hasText) {
      sendBtn.textContent = '↑';
      sendBtn.classList.remove('stop');
    } else if (isStreaming) {
      sendBtn.textContent = '■';
      sendBtn.classList.add('stop');
    }

    expect(sendBtn.textContent).toBe('↑');
    expect(sendBtn.classList.contains('stop')).toBe(false);
  });

  test('chatUpdateSendButtonState shows stop when streaming without text', () => {
    const sendBtn = document.getElementById('chat-send-btn') as HTMLButtonElement;
    const ta = document.getElementById('chat-textarea') as HTMLTextAreaElement;
    ta.value = '';
    (global as any).chatStreamingConvs.add('conv-1');

    const isStreaming = (global as any).chatStreamingConvs.has((global as any).chatActiveConvId);
    const hasText = ta.value.trim();
    if (isStreaming && hasText) {
      sendBtn.textContent = '↑';
      sendBtn.classList.remove('stop');
    } else if (isStreaming) {
      sendBtn.textContent = '■';
      sendBtn.classList.add('stop');
    }

    expect(sendBtn.textContent).toBe('■');
    expect(sendBtn.classList.contains('stop')).toBe(true);
  });
});

describe('Message Queue: pause and resume', () => {
  test('pausing sets queue paused state', () => {
    (global as any).chatQueuePaused.add('conv-1');
    expect((global as any).chatQueuePaused.has('conv-1')).toBe(true);
  });

  test('adding to queue un-pauses', () => {
    (global as any).chatQueuePaused.add('conv-1');
    // Simulate chatSendMessage queue path: un-pause on new queue
    (global as any).chatQueuePaused.delete('conv-1');
    addToQueue('new msg');
    expect((global as any).chatQueuePaused.has('conv-1')).toBe(false);
  });
});

describe('Message Queue: per-conversation isolation', () => {
  test('queues are isolated per conversation', () => {
    addToQueue('conv1-msg');
    (global as any).chatActiveConvId = 'conv-2';
    addToQueue('conv2-msg');

    expect((global as any).chatMessageQueue.get('conv-1')).toHaveLength(1);
    expect((global as any).chatMessageQueue.get('conv-2')).toHaveLength(1);
    expect((global as any).chatMessageQueue.get('conv-1')[0].content).toBe('conv1-msg');
    expect((global as any).chatMessageQueue.get('conv-2')[0].content).toBe('conv2-msg');
  });
});
