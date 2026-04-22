/**
 * @jest-environment jsdom
 */

// Replicates the state-machine logic of public/v2/src/tabIndicator.js so the
// transitions can be exercised without a module bundler. If the real module
// changes, mirror the change here.

type TabState = 'idle' | 'running' | 'done' | 'error';

function createTabIndicator(opts: {
  streamingConvs: Set<string>;
  isHidden: () => boolean;
}) {
  let current: TabState = 'idle';
  let pendingError = false;

  function apply(s: TabState) { current = s; }

  function onStreamChange({ error = false }: { error?: boolean } = {}) {
    if (error) pendingError = true;
    if (opts.streamingConvs.size > 0) {
      apply('running');
      return;
    }
    if (!opts.isHidden()) {
      apply('idle');
      pendingError = false;
      return;
    }
    if (pendingError) {
      apply('error');
      pendingError = false;
    } else {
      apply('done');
    }
  }

  function onVisibilityChange() {
    if (opts.isHidden()) return;
    if (current === 'done' || current === 'error') apply('idle');
  }

  return {
    onStreamChange,
    onVisibilityChange,
    getState: () => current,
  };
}

describe('tab-indicator state machine', () => {
  it('starts idle', () => {
    const streaming = new Set<string>();
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => false });
    expect(ti.getState()).toBe('idle');
  });

  it('goes running when a conversation starts streaming', () => {
    const streaming = new Set<string>();
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => false });
    streaming.add('c1');
    ti.onStreamChange();
    expect(ti.getState()).toBe('running');
  });

  it('returns to idle when the last stream ends while tab is visible', () => {
    const streaming = new Set<string>();
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => false });
    streaming.add('c1');
    ti.onStreamChange();
    streaming.delete('c1');
    ti.onStreamChange();
    expect(ti.getState()).toBe('idle');
  });

  it('goes to done when the last stream ends while tab is hidden', () => {
    const streaming = new Set<string>();
    let hidden = false;
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => hidden });
    streaming.add('c1');
    ti.onStreamChange();
    hidden = true;
    streaming.delete('c1');
    ti.onStreamChange();
    expect(ti.getState()).toBe('done');
  });

  it('goes to error when the last stream ends with an error while tab is hidden', () => {
    const streaming = new Set<string>();
    let hidden = false;
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => hidden });
    streaming.add('c1');
    ti.onStreamChange();
    hidden = true;
    streaming.delete('c1');
    ti.onStreamChange({ error: true });
    expect(ti.getState()).toBe('error');
  });

  it('does not surface error when stream ends with error but tab is visible', () => {
    const streaming = new Set<string>();
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => false });
    streaming.add('c1');
    ti.onStreamChange();
    streaming.delete('c1');
    ti.onStreamChange({ error: true });
    expect(ti.getState()).toBe('idle');
  });

  it('stays running while any of multiple concurrent streams is active', () => {
    const streaming = new Set<string>();
    let hidden = true;
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => hidden });
    streaming.add('c1');
    ti.onStreamChange();
    streaming.add('c2');
    ti.onStreamChange();
    streaming.delete('c1');
    ti.onStreamChange();
    expect(ti.getState()).toBe('running');
    streaming.delete('c2');
    ti.onStreamChange();
    expect(ti.getState()).toBe('done');
  });

  it('preserves an error from an earlier stream until all streams end', () => {
    const streaming = new Set<string>();
    let hidden = true;
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => hidden });
    streaming.add('c1');
    ti.onStreamChange();
    streaming.add('c2');
    ti.onStreamChange();
    streaming.delete('c1');
    ti.onStreamChange({ error: true });
    expect(ti.getState()).toBe('running');
    streaming.delete('c2');
    ti.onStreamChange();
    expect(ti.getState()).toBe('error');
  });

  it('clears done back to idle when the tab becomes visible', () => {
    const streaming = new Set<string>();
    let hidden = true;
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => hidden });
    streaming.add('c1');
    ti.onStreamChange();
    streaming.delete('c1');
    ti.onStreamChange();
    expect(ti.getState()).toBe('done');
    hidden = false;
    ti.onVisibilityChange();
    expect(ti.getState()).toBe('idle');
  });

  it('clears error back to idle when the tab becomes visible', () => {
    const streaming = new Set<string>();
    let hidden = true;
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => hidden });
    streaming.add('c1');
    ti.onStreamChange();
    streaming.delete('c1');
    ti.onStreamChange({ error: true });
    expect(ti.getState()).toBe('error');
    hidden = false;
    ti.onVisibilityChange();
    expect(ti.getState()).toBe('idle');
  });

  it('keeps running when the tab becomes visible mid-stream', () => {
    const streaming = new Set<string>();
    let hidden = true;
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => hidden });
    streaming.add('c1');
    ti.onStreamChange();
    hidden = false;
    ti.onVisibilityChange();
    expect(ti.getState()).toBe('running');
  });

  it('resets error flag after consuming it so a subsequent clean run ends idle', () => {
    const streaming = new Set<string>();
    let hidden = true;
    const ti = createTabIndicator({ streamingConvs: streaming, isHidden: () => hidden });
    streaming.add('c1');
    ti.onStreamChange();
    streaming.delete('c1');
    ti.onStreamChange({ error: true });
    expect(ti.getState()).toBe('error');
    hidden = false;
    ti.onVisibilityChange();
    expect(ti.getState()).toBe('idle');
    hidden = true;
    streaming.add('c2');
    ti.onStreamChange();
    streaming.delete('c2');
    ti.onStreamChange();
    expect(ti.getState()).toBe('done');
  });
});
