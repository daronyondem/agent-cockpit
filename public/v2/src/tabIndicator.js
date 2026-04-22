/* Browser tab status indicator (v2 port of legacy public/js/tab-indicator.js).
   Overlays a coloured dot on the favicon to reflect whether any conversation
   is streaming. "done" / "error" states only surface when a stream ends while
   the tab is hidden, so a user working in another tab is notified without the
   badge flickering for visible work.

   Data source: StreamStore.convStates() + subscribeGlobal. No title prefix
   (legacy dropped that — favicon dot is the single tab indicator). */

(function(){
  const FAVICON_HREF = '/favicon.svg';
  const DOT_COLORS = {
    running: '#3b82f6',
    done:    '#22c55e',
    error:   '#ef4444',
  };

  let _currentState = 'idle';
  let _baseImg = null;
  let _baseImgPromise = null;
  let _pendingErrorFlag = false;
  let _prevErrorIds = new Set();
  let _initialized = false;

  function loadBaseImage(){
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

  function renderFavicon(s){
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

  function applyState(s){
    if (_currentState === s) return;
    _currentState = s;
    renderFavicon(s);
  }

  function isHidden(){
    return document.visibilityState === 'hidden';
  }

  function recompute(){
    const store = window.StreamStore;
    if (!store || typeof store.convStates !== 'function') return;
    const states = store.convStates();
    let streamingCount = 0;
    const errorIds = new Set();
    for (const id of Object.keys(states)) {
      const ui = states[id];
      if (ui === 'streaming') streamingCount++;
      if (ui === 'error') errorIds.add(id);
    }
    for (const id of errorIds) {
      if (!_prevErrorIds.has(id)) _pendingErrorFlag = true;
    }
    _prevErrorIds = errorIds;

    if (streamingCount > 0) { applyState('running'); return; }
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

  function onVisibilityChange(){
    if (isHidden()) return;
    if (_currentState === 'done' || _currentState === 'error') {
      applyState('idle');
    }
    _pendingErrorFlag = false;
  }

  function init(){
    if (_initialized) return;
    _initialized = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    loadBaseImage().catch(() => {});
    if (window.StreamStore && typeof window.StreamStore.subscribeGlobal === 'function') {
      window.StreamStore.subscribeGlobal(recompute);
    }
    recompute();
  }

  window.TabIndicator = { init };
  init();
})();
