// ─── Workspace memory panel ──────────────────────────────────────────────────
// Read-only viewer for the captured workspace memory snapshot served by
// `GET /api/chat/workspaces/:hash/memory`. Triggered from the inline
// `memory_update` pill that streaming.js drops into the chat timeline.

import { state, chatFetch, chatApiUrl } from './state.js';
import { esc } from './utils.js';
import { chatShowModal, chatCloseModal } from './modal.js';

const TYPE_LABELS = {
  user: 'User',
  feedback: 'Feedback',
  project: 'Project',
  reference: 'Reference',
  unknown: 'Other',
};

const TYPE_ORDER = ['user', 'feedback', 'project', 'reference', 'unknown'];

export async function chatOpenMemoryPanel() {
  const conv = state.chatActiveConv;
  if (!conv) return;
  const hash = conv.workspaceHash;
  if (!hash) {
    chatShowModal('Workspace Memory', `<div class="chat-modal-body"><p style="color:var(--muted);">No workspace is associated with this conversation.</p></div>`);
    return;
  }

  // Show a loading shell immediately so the user gets feedback even if the
  // fetch is slow.
  chatShowModal('Workspace Memory', `
    <div class="chat-modal-body chat-memory-modal">
      <div class="chat-memory-loading">Loading workspace memory…</div>
    </div>
  `);

  let snapshot = null;
  let errorMsg = null;
  try {
    const res = await chatFetch(chatApiUrl(`/workspaces/${encodeURIComponent(hash)}/memory`));
    if (res.status === 404) {
      // No snapshot captured yet — that's normal, not an error.
    } else if (!res.ok) {
      errorMsg = `Failed to load memory (HTTP ${res.status})`;
    } else {
      const body = await res.json();
      snapshot = body.snapshot || null;
    }
  } catch (err) {
    errorMsg = `Failed to load memory: ${err.message}`;
  }

  // Modal may have been closed by the user while we were fetching.
  const overlay = document.getElementById('chat-modal-overlay');
  if (!overlay) return;
  const body = overlay.querySelector('.chat-modal-body');
  if (!body) return;

  body.innerHTML = renderMemoryBody(snapshot, errorMsg, hash);
  wireMemoryBody(body, hash);
}

function renderMemoryBody(snapshot, errorMsg, hash) {
  if (errorMsg) {
    return `<div class="chat-memory-empty"><p style="color:var(--danger);">${esc(errorMsg)}</p>${refreshButtonHtml()}</div>`;
  }
  if (!snapshot || !Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    return `<div class="chat-memory-empty">
      <p>No memory has been captured for this workspace yet.</p>
      <p style="color:var(--muted);font-size:12px;">Memories are captured automatically when the CLI writes to its memory directory during a stream, or on session reset.</p>
      ${refreshButtonHtml()}
    </div>`;
  }

  const grouped = {};
  for (const t of TYPE_ORDER) grouped[t] = [];
  for (const f of snapshot.files) {
    const bucket = grouped[f.type] || grouped.unknown;
    bucket.push(f);
  }

  const groupsHtml = TYPE_ORDER
    .filter((t) => grouped[t].length > 0)
    .map((t) => `
      <div class="chat-memory-group">
        <div class="chat-memory-group-header">${esc(TYPE_LABELS[t])} <span class="chat-memory-group-count">${grouped[t].length}</span></div>
        <ul class="chat-memory-file-list">
          ${grouped[t].map((f) => renderFileEntry(f)).join('')}
        </ul>
      </div>
    `).join('');

  const captured = snapshot.capturedAt ? new Date(snapshot.capturedAt).toLocaleString() : 'unknown';
  return `
    <div class="chat-memory-meta">
      <span><strong>Source:</strong> ${esc(snapshot.sourceBackend || 'unknown')}</span>
      <span><strong>Captured:</strong> ${esc(captured)}</span>
      <span><strong>Files:</strong> ${snapshot.files.length}</span>
      ${refreshButtonHtml()}
    </div>
    <div class="chat-memory-groups">${groupsHtml}</div>
  `;
}

function renderFileEntry(file) {
  const heading = file.name || file.filename;
  const sub = file.description || '';
  return `
    <li class="chat-memory-file">
      <button type="button" class="chat-memory-file-toggle" data-filename="${esc(file.filename)}">
        <div class="chat-memory-file-heading">${esc(heading)}</div>
        ${sub ? `<div class="chat-memory-file-desc">${esc(sub)}</div>` : ''}
        <div class="chat-memory-file-name">${esc(file.filename)}</div>
      </button>
      <pre class="chat-memory-file-body" hidden>${esc(file.content || '')}</pre>
    </li>
  `;
}

function refreshButtonHtml() {
  return `<button type="button" class="chat-memory-refresh">Refresh</button>`;
}

function wireMemoryBody(body, hash) {
  body.querySelectorAll('.chat-memory-file-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pre = btn.parentElement.querySelector('.chat-memory-file-body');
      if (!pre) return;
      pre.hidden = !pre.hidden;
      btn.classList.toggle('expanded', !pre.hidden);
    });
  });
  body.querySelectorAll('.chat-memory-refresh').forEach((btn) => {
    btn.addEventListener('click', () => {
      chatCloseModal();
      chatOpenMemoryPanel();
    });
  });
}
