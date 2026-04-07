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
      state.BACKEND_MODELS[b.id] = b.models || null;
    }
    populateBackendSelects();
    populateModelSelect();
  } catch (err) {
    console.error('[loadBackends]', err);
    // Fallback so the UI still works
    state.CHAT_BACKENDS = [{ id: 'claude-code', label: 'Claude Code' }];
    populateBackendSelects();
    populateModelSelect();
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

/**
 * Populate the model dropdown based on the currently selected backend.
 * If the backend has no models array, hide the dropdown.
 */
export function populateModelSelect(selectedModel) {
  const modelSelect = document.getElementById('chat-model-select');
  if (!modelSelect) return;

  const backendSelect = document.getElementById('chat-backend-select');
  const backendId = backendSelect?.value || (state.CHAT_BACKENDS[0]?.id || 'claude-code');
  const models = state.BACKEND_MODELS[backendId];

  if (!models || models.length === 0) {
    modelSelect.style.display = 'none';
    modelSelect.innerHTML = '';
    return;
  }

  modelSelect.style.display = '';
  const current = selectedModel || modelSelect.value;
  modelSelect.innerHTML = models.map(m => {
    const costLabel = m.costTier === 'high' ? ' \u25cf' : m.costTier === 'low' ? ' \u25cb' : '';
    return `<option value="${esc(m.id)}"${m.default ? ' data-default="true"' : ''}>${esc(m.label)}${costLabel}</option>`;
  }).join('');

  // Restore previous selection, or use model from conversation, or default
  if (current && [...modelSelect.options].some(o => o.value === current)) {
    modelSelect.value = current;
  } else {
    const defaultModel = models.find(m => m.default);
    if (defaultModel) modelSelect.value = defaultModel.id;
  }
}

export function getBackendIcon(backendId) {
  return state.BACKEND_ICONS[backendId] || DEFAULT_BACKEND_ICON;
}

export function getBackendCapabilities(backendId) {
  return state.BACKEND_CAPABILITIES[backendId] || {};
}
