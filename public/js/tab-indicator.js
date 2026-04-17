// ─── Browser tab status indicator ────────────────────────────────────────────
// Updates document.title and favicon (with a colored dot-badge overlay) to
// reflect whether any conversation is streaming. "done" / "error" states only
// appear when a stream ends while the tab is hidden, so a user working in
// another tab is notified without the indicator flickering for visible work.

import { state } from './state.js';

const FAVICON_HREF = 'favicon.svg';
const BASE_TITLE_FALLBACK = 'Agent Cockpit';

const DOT_COLORS = {
  running: '#3b82f6',
  done: '#22c55e',
  error: '#ef4444',
};

const TITLE_PREFIX = {
  idle: '',
  running: '\u23F3 ',
  done: '\u2705 ',
  error: '\u26A0\uFE0F ',
};

let _currentState = 'idle';
let _baseTitle = BASE_TITLE_FALLBACK;
let _baseImg = null;
let _baseImgPromise = null;
let _pendingErrorFlag = false;
let _initialized = false;

function loadBaseImage() {
  if (_baseImg) return Promise.resolve(_baseImg);
  if (_baseImgPromise) return _baseImgPromise;
  _baseImgPromise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { _baseImg = img; resolve(img); };
    img.onerror = reject;
    img.src = FAVICON_HREF;
  });
  return _baseImgPromise;
}

function renderFavicon(s) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (s === 'idle') { link.href = FAVICON_HREF; return; }
  loadBaseImage().then((img) => {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, size, size);
    const r = size * 0.22;
    const cx = size - r - 2;
    const cy = size - r - 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = DOT_COLORS[s];
    ctx.fill();
    link.href = canvas.toDataURL('image/png');
  }).catch(() => {});
}

function applyState(s) {
  if (_currentState === s) return;
  _currentState = s;
  document.title = TITLE_PREFIX[s] + _baseTitle;
  renderFavicon(s);
}

function isHidden() {
  return document.visibilityState === 'hidden';
}

// Called by streaming.js whenever chatStreamingConvs changes. Reads the set
// as the source of truth for whether work is active; tracks an error flag
// independently so a failure during one of multiple concurrent streams can
// still surface once the last stream completes.
export function chatTabOnStreamChange({ error = false } = {}) {
  if (error) _pendingErrorFlag = true;
  const count = state.chatStreamingConvs.size;
  if (count > 0) {
    applyState('running');
    return;
  }
  if (!isHidden()) {
    applyState('idle');
    _pendingErrorFlag = false;
    return;
  }
  if (_pendingErrorFlag) {
    applyState('error');
    _pendingErrorFlag = false;
  } else {
    applyState('done');
  }
}

function onVisibilityChange() {
  if (isHidden()) return;
  if (_currentState === 'done' || _currentState === 'error') {
    applyState('idle');
  }
}

export function chatInitTabIndicator() {
  if (_initialized) return;
  _initialized = true;
  _baseTitle = document.title || BASE_TITLE_FALLBACK;
  document.addEventListener('visibilitychange', onVisibilityChange);
  loadBaseImage().catch(() => {});
}
