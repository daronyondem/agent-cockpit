import { state, DEFAULT_BACKEND_ICON, apiUrl } from './state.js';
import { esc } from './utils.js';

export async function loadBackends() {
  try {
    const res = await fetch(apiUrl('/chat/backends'), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Failed to load backends (${res.status})`);
    const data = await res.json();
    state.CHAT_BACKENDS = data.backends.map(b => ({ id: b.id, label: b.label }));
    for (const b of data.backends) {
      state.BACKEND_CAPABILITIES[b.id] = b.capabilities || {};
      state.BACKEND_ICONS[b.id] = b.icon || null;
    }
    populateBackendSelects();
  } catch (err) {
    console.error('[loadBackends]', err);
    // Fallback so the UI still works
    state.CHAT_BACKENDS = [{ id: 'claude-code', label: 'Claude Code' }];
    populateBackendSelects();
  }
}

export function populateBackendSelects() {
  const selects = document.querySelectorAll('#chat-backend-select, #chat-settings-backend');
  for (const sel of selects) {
    const current = sel.value;
    sel.innerHTML = state.CHAT_BACKENDS.map(b =>
      `<option value="${esc(b.id)}">${esc(b.label)}</option>`
    ).join('');
    if (current && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
    }
  }
}

export function getBackendIcon(backendId) {
  return state.BACKEND_ICONS[backendId] || DEFAULT_BACKEND_ICON;
}

export function getBackendCapabilities(backendId) {
  return state.BACKEND_CAPABILITIES[backendId] || {};
}
