/* global React, Sidebar, Ico */

function StreamErrorCard(){
  return (
    <div className="err-card">
      <div className="err-head">
        <span className="dot" style={{background:"var(--status-error)"}}/>
        Stream error
        <span className="spacer"/>
        <span className="u-mono u-dim" style={{fontSize:10.5}}>ETIMEDOUT · 504 · upstream</span>
      </div>
      <div className="prose" style={{fontFamily:"var(--prose-font)",fontSize:15,lineHeight:1.55}}>
        <p>Upstream <code>grep</code> timed out after 30s. Last 142 tokens were preserved.</p>
      </div>
      <div className="err-actions">
        <span className="u-mono u-dim" style={{fontSize:11}}>Retrying in <b className="u-warn">3s</b> · attempt 2/5</span>
        <span className="spacer"/>
        <button className="btn ghost">Cancel retry</button>
        <button className="btn">Retry now</button>
      </div>
    </div>
  );
}

function WSBanner(){
  return (
    <div className="ws-banner">
      {Ico.wifiOff(14)}
      <span>WebSocket disconnected — reconnecting in <b className="u-warn">2s</b> · attempt 3/∞</span>
      <span className="spacer"/>
      <span className="u-mono u-dim" style={{fontSize:10.5}}>drafts &amp; queue preserved</span>
      <button className="btn ghost" style={{padding:"3px 8px"}}>Reconnect now</button>
    </div>
  );
}

function SessionExpired(){
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="overlay-mark">{Ico.brand(36)}</div>
        <div className="overlay-eyebrow">Session expired</div>
        <h2 className="overlay-title">You've been signed out.</h2>
        <p className="overlay-body">
          Your current draft, pending file attachments, and message queue are
          <b> preserved locally</b>. Sign in again to pick up exactly where you left off.
        </p>
        <div className="overlay-saved">
          <div><span>Draft</span><b>“then run the snapshot script…”</b></div>
          <div><span>Attachments</span><b>2 files · 14.2 KB</b></div>
          <div><span>Queue</span><b>2 messages</b></div>
        </div>
        <div className="overlay-actions">
          <button className="btn ghost">Save draft to file</button>
          <button className="btn primary">Sign in</button>
        </div>
      </div>
    </div>
  );
}

function LongConv(){
  return (
    <div className="cockpit">
      <Sidebar/>
      <section className="main">
        <div className="topbar">
          <div className="crumbs">
            <span>github/agent-cockpit</span><span className="sep">/</span>
            <span className="here">Refactor auth middleware · 148 messages</span>
          </div>
          <div className="right">
            <span className="btn ghost u-mono" style={{fontSize:11}}>92% context · 28.4k</span>
            <button className="btn ghost">↓ Download</button>
          </div>
        </div>

        <div className="feed">
          <div className="feed-inner">
            {/* collapsed turn groups */}
            <div className="group-fold">
              <div className="group-fold-head">
                <span className="marker done"/><span className="group-title">Phase 1 · scaffolding</span>
                <span className="spacer"/><span className="u-mono u-dim" style={{fontSize:10.5}}>12 turns · 38 tools · 4:21</span>
                <button className="btn ghost" style={{padding:"3px 8px"}}>{Ico.chevD(12)} Expand</button>
              </div>
              <div className="group-fold-preview">
                Created middleware skeleton, moved handlers, deleted legacy helper. Tests green.
              </div>
            </div>
            <div className="group-fold">
              <div className="group-fold-head">
                <span className="marker done"/><span className="group-title">Phase 2 · migration</span>
                <span className="spacer"/><span className="u-mono u-dim" style={{fontSize:10.5}}>18 turns · 74 tools · 9:04</span>
                <button className="btn ghost" style={{padding:"3px 8px"}}>{Ico.chevD(12)} Expand</button>
              </div>
              <div className="group-fold-preview">
                Migrated 11 routes. One ambiguity surfaced on <code>/billing</code>, you decided to keep legacy.
              </div>
            </div>
            <div className="group-fold">
              <div className="group-fold-head">
                <span className="marker done"/><span className="group-title">Phase 3 · tests</span>
                <span className="spacer"/><span className="u-mono u-dim" style={{fontSize:10.5}}>9 turns · 22 tools · 3:10</span>
                <button className="btn ghost" style={{padding:"3px 8px"}}>{Ico.chevD(12)} Expand</button>
              </div>
              <div className="group-fold-preview">All 64 tests pass.</div>
            </div>

            {/* current turn expanded */}
            <div className="msg msg-user">
              <span className="avatar">DY</span>
              <div className="body">Now remove the legacy helper file and update imports.</div>
            </div>
            <div className="msg msg-agent">
              <span className="avatar">●</span>
              <div className="body">
                <div className="head"><span className="who">Claude Code <span className="model">opus-4.1 · high</span></span><span>·</span><span>just now</span></div>
                <div className="prose"><p>Removed <code>src/legacy/auth-helper.ts</code>, updated 9 imports, ran typecheck — green.</p></div>
              </div>
            </div>
          </div>
        </div>

        {/* jump-to-latest pill */}
        <button className="jump">
          {Ico.down(12)} Jump to latest · 3 new
        </button>

        <div className="composer">
          <div className="composer-inner">
            <div className="composer-box">
              <div className="composer-area">Message Agent Cockpit…</div>
              <div className="composer-foot">
                <div className="picks">
                  <span className="pick"><span>Backend</span> <b>Claude Code</b></span>
                </div>
                <span className="hint">⌘+Enter to send</span>
                <button className="send">{Ico.arrow(14)}</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function MultiStream(){
  return (
    <div className="cockpit">
      <Sidebar/>
      <section className="main">
        <div className="topbar">
          <div className="crumbs"><span className="here">Overview — 3 conversations working</span></div>
        </div>
        <div className="feed" style={{padding:"24px 0"}}>
          <div className="feed-inner" style={{maxWidth:880}}>
            <h1 style={{fontFamily:"var(--prose-font)",fontSize:34,fontWeight:500,letterSpacing:"-.01em",margin:"10px 0 8px"}}>3 agents working</h1>
            <p className="u-dim" style={{fontSize:13.5,lineHeight:1.55,maxWidth:560}}>
              Parallel conversations across your workspaces. Click any card to focus; the rest keep streaming in the background.
            </p>

            <div className="multi-grid">
              <div className="multi-card working">
                <div className="mh">
                  <span className="dot"/>
                  <span className="title">KB search performance</span>
                  <span className="elapsed u-mono">02:14</span>
                </div>
                <div className="ws u-mono">github/agent-cockpit</div>
                <div className="curr">
                  <span className="ring-sm"/>
                  <span>running <b>grep</b> on <code>services/kb/search.ts</code></span>
                </div>
                <div className="steps u-mono u-dim">step 7 of 8 · 11 tools · 4 parallel</div>
                <div className="foot">
                  <span className="u-dim">queue · 2</span>
                  <span className="spacer"/>
                  <button className="btn ghost" style={{padding:"3px 8px"}}>Open</button>
                </div>
              </div>

              <div className="multi-card awaiting">
                <div className="mh">
                  <span className="dot"/>
                  <span className="title">Dark mode toggle — plan</span>
                  <span className="elapsed u-mono u-warn">NEEDS YOU</span>
                </div>
                <div className="ws u-mono">github/agent-cockpit</div>
                <div className="curr"><span>Plan ready · approve to continue</span></div>
                <div className="steps u-mono u-dim">5 phases · 9 files · est. 14 min</div>
                <div className="foot">
                  <button className="btn" style={{padding:"3px 8px"}}>Review plan</button>
                  <span className="spacer"/>
                  <button className="btn primary" style={{padding:"3px 10px"}}>Approve</button>
                </div>
              </div>

              <div className="multi-card working">
                <div className="mh">
                  <span className="dot"/>
                  <span className="title">Refactor auth middleware</span>
                  <span className="elapsed u-mono">12:48</span>
                </div>
                <div className="ws u-mono">github/agent-cockpit</div>
                <div className="curr">
                  <span className="ring-sm"/>
                  <span>editing <code>middleware/auth.ts</code> <span className="u-ok">+128</span> <span className="u-err">−64</span></span>
                </div>
                <div className="steps u-mono u-dim">phase 3 of 4 · 74 tools · 0 parallel</div>
                <div className="foot"><span className="u-dim">subagent · doc-scraper</span><span className="spacer"/><button className="btn ghost" style={{padding:"3px 8px"}}>Open</button></div>
              </div>

              <div className="multi-card error">
                <div className="mh">
                  <span className="dot"/>
                  <span className="title">Update for Aswath</span>
                  <span className="elapsed u-mono u-err">ERR</span>
                </div>
                <div className="ws u-mono">Daron-Life-Gen</div>
                <div className="curr"><span className="u-err">Rate limit · retry in 42s</span></div>
                <div className="steps u-mono u-dim">failed at step 3 · backend Claude Code</div>
                <div className="foot">
                  <button className="btn ghost danger" style={{padding:"3px 8px"}}>Archive</button>
                  <span className="spacer"/>
                  <button className="btn" style={{padding:"3px 10px"}}>Retry</button>
                </div>
              </div>
            </div>

            <h3 style={{marginTop:28,fontFamily:"var(--prose-font)",fontSize:20,fontWeight:500}}>Recent</h3>
            <div className="recent-list">
              <div className="rr"><span className="dot done"/><span>Assessing mobile app curves</span><span className="u-dim u-mono" style={{marginLeft:"auto",fontSize:11}}>3h · 18 tools · $1.08</span></div>
              <div className="rr"><span className="dot done"/><span>Spec req</span><span className="u-dim u-mono" style={{marginLeft:"auto",fontSize:11}}>2d · 6 tools · $0.21</span></div>
              <div className="rr"><span className="dot done"/><span>Fact-check cloud AI colors</span><span className="u-dim u-mono" style={{marginLeft:"auto",fontSize:11}}>2d · 4 tools · $0.12</span></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* Stream error demo embedded in a chat frame */
function ErrorChat(){
  return (
    <div className="cockpit">
      <Sidebar/>
      <section className="main">
        <WSBanner/>
        <div className="topbar" style={{borderTop:"1px solid var(--border)"}}>
          <div className="crumbs"><span>github/agent-cockpit</span><span className="sep">/</span><span className="here">KB search performance</span></div>
          <div className="right"><span className="btn ghost u-mono u-err" style={{fontSize:11}}>● stream error</span></div>
        </div>
        <div className="feed">
          <div className="feed-inner">
            <div className="msg msg-user">
              <span className="avatar">DY</span>
              <div className="body">Grep for filesize_bytes &gt; 400_000 under services/kb</div>
            </div>
            <div className="msg msg-agent">
              <span className="avatar">●</span>
              <div className="body">
                <div className="head"><span className="who">Claude Code</span><span>·</span><span>1m ago</span></div>
                <div className="prose"><p>Starting search across the services/kb directory.</p></div>
                <StreamErrorCard/>
              </div>
            </div>
          </div>
        </div>
        <div className="composer">
          <div className="composer-inner">
            <div className="composer-box">
              <div className="composer-area u-dim">Reconnecting — send is paused.</div>
              <div className="composer-foot">
                <span className="hint">⌘+Enter to send</span>
                <button className="send" disabled style={{opacity:.45}}>{Ico.arrow(14)}</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

window.LongConv = LongConv;
window.MultiStream = MultiStream;
window.ErrorChat = ErrorChat;
window.SessionExpired = SessionExpired;
