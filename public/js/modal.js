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

// ── App dialogs (replacements for browser alert / confirm / prompt) ──────────
// Each returns a Promise and renders a themed overlay at z-index 450 so it sits
// above the settings modal (400) but below the session-expired overlay (500).

let _activeDialog = null; // only one dialog at a time

function _dismissDialog(result) {
  if (!_activeDialog) return;
  const { overlay, resolve } = _activeDialog;
  _activeDialog = null;
  overlay.remove();
  resolve(result);
}

function _createDialogOverlay(innerHtml) {
  // Close any existing dialog first.
  if (_activeDialog) _dismissDialog(undefined);

  const overlay = document.createElement('div');
  overlay.className = 'chat-dialog-overlay';
  overlay.innerHTML = `<div class="chat-dialog">${innerHtml}</div>`;

  // Backdrop click → dismiss (cancel for confirm/prompt, ok for alert).
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && _activeDialog) {
      _dismissDialog(_activeDialog.backdropResult);
    }
  });

  // Keyboard: Escape dismisses.
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _activeDialog) {
      e.stopPropagation();
      _dismissDialog(_activeDialog.backdropResult);
    }
  });

  document.body.appendChild(overlay);
  return overlay;
}

/**
 * App-styled replacement for `window.alert()`.
 * Shows a message with an OK button. Returns a Promise<void>.
 */
export function chatShowAlert(message, { title = 'Error' } = {}) {
  return new Promise((resolve) => {
    const overlay = _createDialogOverlay(`
      <div class="chat-dialog-title">${esc(title)}</div>
      <div class="chat-dialog-message">${esc(message)}</div>
      <div class="chat-dialog-actions">
        <button class="chat-dialog-btn chat-dialog-btn-primary" data-dialog-action="ok">OK</button>
      </div>
    `);
    _activeDialog = { overlay, resolve, backdropResult: undefined };
    const okBtn = overlay.querySelector('[data-dialog-action="ok"]');
    okBtn.addEventListener('click', () => _dismissDialog(undefined));
    okBtn.focus();
  });
}

/**
 * App-styled replacement for `window.confirm()`.
 * Shows a message with Cancel / Confirm buttons. Returns Promise<boolean>.
 */
export function chatShowConfirm(message, { title = 'Confirm', confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive = false } = {}) {
  return new Promise((resolve) => {
    const btnClass = destructive
      ? 'chat-dialog-btn chat-dialog-btn-danger'
      : 'chat-dialog-btn chat-dialog-btn-primary';
    const overlay = _createDialogOverlay(`
      <div class="chat-dialog-title">${esc(title)}</div>
      <div class="chat-dialog-message">${esc(message)}</div>
      <div class="chat-dialog-actions">
        <button class="chat-dialog-btn" data-dialog-action="cancel">${esc(cancelLabel)}</button>
        <button class="${btnClass}" data-dialog-action="confirm">${esc(confirmLabel)}</button>
      </div>
    `);
    _activeDialog = { overlay, resolve, backdropResult: false };
    overlay.querySelector('[data-dialog-action="cancel"]')
      .addEventListener('click', () => _dismissDialog(false));
    overlay.querySelector('[data-dialog-action="confirm"]')
      .addEventListener('click', () => _dismissDialog(true));
    // Enter on the confirm button, but also allow pressing Enter
    // anywhere in the dialog (except when focus is on Cancel).
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && _activeDialog) {
        const focused = document.activeElement;
        if (!focused || !focused.matches('[data-dialog-action="cancel"]')) {
          e.preventDefault();
          _dismissDialog(true);
        }
      }
    });
    overlay.querySelector('[data-dialog-action="confirm"]').focus();
  });
}

/**
 * App-styled replacement for `window.prompt()`.
 * Shows a text input with Cancel / OK buttons. Returns Promise<string|null>.
 */
export function chatShowPrompt(message, { title = '', defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = _createDialogOverlay(`
      ${title ? `<div class="chat-dialog-title">${esc(title)}</div>` : ''}
      <div class="chat-dialog-message">${esc(message)}</div>
      <input class="chat-dialog-input" type="text" value="${esc(defaultValue)}" />
      <div class="chat-dialog-actions">
        <button class="chat-dialog-btn" data-dialog-action="cancel">Cancel</button>
        <button class="chat-dialog-btn chat-dialog-btn-primary" data-dialog-action="ok">OK</button>
      </div>
    `);
    _activeDialog = { overlay, resolve, backdropResult: null };
    const input = overlay.querySelector('.chat-dialog-input');
    overlay.querySelector('[data-dialog-action="cancel"]')
      .addEventListener('click', () => _dismissDialog(null));
    overlay.querySelector('[data-dialog-action="ok"]')
      .addEventListener('click', () => _dismissDialog(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _dismissDialog(input.value); }
    });
    input.focus();
    input.select();
  });
}
