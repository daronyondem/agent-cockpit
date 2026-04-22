/* global React, Sidebar, ToolRow, Ico */
function PlanScreen(){
  return (
    <div className="cockpit">
      <Sidebar activeId="c2"/>
      <section className="main">
        <div className="topbar">
          <div className="crumbs">
            <span>github/agent-cockpit</span>
            <span className="sep">/</span>
            <span className="here">Dark mode toggle — implementation plan</span>
          </div>
          <div className="right">
            <span className="btn ghost u-mono u-warn" style={{fontSize:11}}>● needs you</span>
          </div>
        </div>

        <div className="feed">
          <div className="feed-inner">

            <div className="msg msg-user">
              <span className="avatar">DY</span>
              <div className="body">Add a dark mode toggle to settings, persisted per-user, applied across all pages. Plan first.</div>
            </div>

            <div className="msg msg-agent">
              <span className="avatar">●</span>
              <div className="body">
                <div className="head">
                  <span className="who">Claude Code <span className="model">claude-opus-4.1 · high</span></span>
                  <span>·</span><span>38s ago</span>
                </div>

                <div className="prose">
                  <p>Here's the plan. It splits into 5 phases with concrete files and success criteria. Approve to execute, or send edits to the plan in chat.</p>
                </div>

                <div className="plan">
                  <div className="plan-head">
                    <span style={{width:6,height:6,borderRadius:999,background:"var(--status-awaiting)",boxShadow:"0 0 0 3px color-mix(in oklch, var(--status-awaiting), transparent 80%)"}}/>
                    Plan
                    <span className="plan-chip u-warn" style={{fontFamily:"var(--mono-font)",fontSize:10,letterSpacing:".1em",padding:"2px 7px",borderRadius:4,border:"1px solid color-mix(in oklch, var(--status-awaiting), transparent 70%)",background:"color-mix(in oklch, var(--status-awaiting), transparent 92%)",marginLeft:8}}>NEEDS YOU</span>
                    <span className="spacer"/>
                  </div>
                  <h3 className="plan-title">Add dark mode toggle with system-aware default</h3>
                  <ol className="plan-list">
                    <li><span className="num">01</span><span><b>Create ThemeContext &amp; hook</b> — <code>src/contexts/ThemeContext.tsx</code>, <code>src/hooks/useTheme.ts</code>. localStorage persistence; fallback to <code>prefers-color-scheme</code>.</span></li>
                    <li><span className="num">02</span><span><b>Update app shell</b> — wrap <code>App.tsx</code>, add <code>data-theme</code> attribute on <code>&lt;html&gt;</code>.</span></li>
                    <li><span className="num">03</span><span><b>Light theme stylesheet</b> — new <code>theme-light.css</code>; invert 12 tokens, verify contrast on Button, Input, Card, Modal.</span></li>
                    <li><span className="num">04</span><span><b>Settings toggle UI</b> — radio group in <code>Settings / General</code>: System · Light · Dark.</span></li>
                    <li><span className="num">05</span><span><b>Tests</b> — unit test persistence; visual regression pass.</span></li>
                  </ol>
                  <div className="plan-actions">
                    <span className="u-mono u-dim" style={{fontSize:11}}>est. 14 min · 9 files · 2 new</span>
                    <span className="spacer"/>
                    <button className="btn">{Ico.edit(12)} Edit plan</button>
                    <button className="btn danger">{Ico.x(12)} Reject</button>
                    <button className="btn primary">{Ico.check(13)} Approve &amp; run</button>
                  </div>
                </div>

                {/* clarifying question inline */}
                <div className="plan" style={{borderTopColor:"var(--accent)", marginTop:14}}>
                  <div className="plan-head" style={{color:"var(--accent)"}}>
                    <span style={{width:6,height:6,borderRadius:999,background:"var(--accent)"}}/>
                    Clarifying question
                    <span className="spacer"/>
                  </div>
                  <h3 className="plan-title">Should the toggle live in Settings, or also in the top-bar?</h3>
                  <div className="prose" style={{marginTop:4}}>
                    <p>Top-bar placement is faster but increases chrome. If you want both, I'll add a compact switch next to the avatar menu as well.</p>
                  </div>
                  <div className="plan-actions">
                    <button className="btn">Settings only</button>
                    <button className="btn">Both</button>
                    <button className="btn ghost">Answer in chat…</button>
                  </div>
                </div>

              </div>
            </div>

          </div>
        </div>

        <div className="composer">
          <div className="composer-inner">
            <div className="composer-box">
              <div className="composer-area u-dim">Answer the plan above to continue.</div>
              <div className="composer-foot">
                <div className="picks">
                  <span className="pick"><span>Backend</span> <b>Claude Code</b></span>
                  <span className="pick"><span>Model</span> <b>opus-4.1</b></span>
                </div>
                <span className="hint">⌘ + Enter to send</span>
                <button className="send" disabled style={{opacity:.45}}>{Ico.arrow(14)}</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
window.PlanScreen = PlanScreen;
