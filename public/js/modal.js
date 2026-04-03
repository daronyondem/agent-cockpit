import { esc } from './utils.js';

// ── Modal helper ──────────────────────────────────────────────────────────────

export function chatShowModal(title, bodyHtml) {
  chatCloseModal();
  const overlay = document.createElement('div');
  overlay.className = 'chat-modal-overlay';
  overlay.id = 'chat-modal-overlay';
  overlay.innerHTML = `
    <div class="chat-modal">
      <div class="chat-modal-header">
        <div class="chat-modal-title">${esc(title)}</div>
        <button class="chat-modal-close" id="chat-modal-close-btn">\u2715</button>
      </div>
      ${bodyHtml}
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) chatCloseModal(); });
  document.body.appendChild(overlay);
  document.getElementById('chat-modal-close-btn').addEventListener('click', chatCloseModal);
}

export function chatCloseModal() {
  const overlay = document.getElementById('chat-modal-overlay');
  if (overlay) overlay.remove();
}
