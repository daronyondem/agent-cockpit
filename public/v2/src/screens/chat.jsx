/* global React, Sidebar, ToolRow, Breadcrumb, Ico */

function ChatScreen(){
  return (
    <div className="cockpit with-rail">
      <Sidebar activeId="c1"/>

      <section className="main">
        <div className="topbar">
          <div className="crumbs">
            <span>github/agent-cockpit</span>
            <span className="sep">/</span>
            <span className="here">KB search performance · 1.1k entries</span>
          </div>
          <div className="right">
            <span className="btn ghost u-mono" style={{fontSize:11}}>67% context · 20.4k</span>
            <button className="btn ghost">↓ Download</button>
            <button className="btn ghost">↺ Reset</button>
            <button className="btn ghost danger">Archive</button>
          </div>
        </div>

        <div className="feed">
          <div className="feed-inner">

            {/* USER turn */}
            <div className="msg msg-user">
              <span className="avatar">DY</span>
              <div className="body">
                You did this against the <code>Desktop/test2-workspace</code> workspace, correct?
                Also: can you verify the digestion pipeline handled files over 400 KB?
              </div>
            </div>

            {/* progress breadcrumb collapses completed sub-turns */}
            <Breadcrumb steps={[
              {done:true,label:"read workspace.json"},
              {done:true,label:"ran 2 queries"},
              {done:true,label:"edited 1 file"},
              {done:false,label:"searching entries"},
            ]}/>

            {/* AGENT streaming turn */}
            <div className="msg msg-agent">
              <span className="avatar">●</span>
              <div className="body">
                <div className="head">
                  <span className="who">Claude Code <span className="model">claude-opus-4.1 · high</span></span>
                  <span>·</span><span>just now</span>
                </div>

                {/* live status strip */}
                <div className="stream-head">
                  <span className="ring"/>
                  <span className="time">02:14</span>
                  <span>·</span>
                  <span className="curr">working · <b>grep</b> on <code>services/kb/search.ts</code></span>
                  <span className="spacer"/>
                  <span className="u-dim">step 7 of 8</span>
                  <button>Stop</button>
                </div>

                {/* thinking — collapsed */}
                <div className="thinking">
                  <span className="dot"/>
                  Thinking · 42s
                  <span className="u-dim" style={{marginLeft:6}}>expand</span>
                </div>

                {/* answered above, continues prose */}
                <div className="prose">
                  <p>Yes — confirmed from the script output:</p>
                </div>

                {/* sequential tool card */}
                <div className="tools">
                  <div className="tools-head">
                    <span>Sequential · 4 tools</span>
                    <span className="spacer"/>
                    <span className="tag">workspace · test2</span>
                  </div>
                  <ToolRow state="done" name="read_file" arg="data/workspaces/test2/meta.json" ms="32ms"/>
                  <ToolRow state="done" name="run_sql" arg="SELECT count(*) FROM entries WHERE needs_synthesis=1" ms="104ms"/>
                  <ToolRow state="done" name="read_file" arg="services/kb/digest.ts (128 lines)" ms="18ms"/>
                  <ToolRow state="run"  name="grep"      arg={"\"filesize_bytes > 400_000\" services/kb/"} ms="…"/>
                </div>

                {/* parallel tool card */}
                <div className="tools parallel">
                  <span className="rail"/>
                  <div className="tools-head">
                    <span>Parallel · 3 tools</span>
                    <span className="spacer"/>
                    <span className="tag parallel">fan-out</span>
                  </div>
                  <ToolRow state="done" name="read_file" arg="business-001.txt" ms="8ms"/>
                  <ToolRow state="done" name="read_file" arg="entertainment-014.txt" ms="11ms"/>
                  <ToolRow state="done" name="read_file" arg="sport-022.txt" ms="9ms"/>
                </div>

                {/* subagent */}
                <div className="subagent">
                  <div className="subagent-head">
                    <span className="chip">subagent</span>
                    <span className="title">digestion-auditor — verifying entry counts across 3 topics</span>
                    <span className="elapsed">0:41 · 6 tools</span>
                    {Ico.chevD(12)}
                  </div>
                  <div className="tools" style={{border:0,margin:0,borderRadius:0}}>
                    <ToolRow state="done" name="run_sql" arg="GROUP BY topic" ms="44ms"/>
                    <ToolRow state="done" name="read_file" arg="synthesis/topic-map.json" ms="6ms"/>
                    <ToolRow state="run"  name="compute_stats" arg="per-topic integrity vector" ms="…"/>
                  </div>
                </div>

                <div className="prose" style={{marginTop:10}}>
                  <p><strong>Before ingest:</strong> 0 / 433 entries pending synthesis (gate closed).</p>
                  <p><strong>After ingest:</strong> 433 entries pending synthesis (gate open). Topics &amp; connections untouched — the 163 topics and 85 connections from cycle 1 persist.</p>
                </div>

                {/* file delivery card */}
                <div className="file-card">
                  <span className="fi">{Ico.file(14)}</span>
                  <span>
                    <div className="name">services/kb/digest.ts</div>
                    <div className="diff"><span className="add">+42</span> <span className="del">−7</span> · just now</div>
                  </span>
                  <span style={{display:"inline-flex",gap:6}}>
                    <button className="btn ghost">{Ico.diff(12)} Diff</button>
                    <button className="btn">Open</button>
                  </span>
                </div>

                <div className="prose" style={{marginTop:8}}>
                  <p>Next: trigger dream in the UI. When it finishes, run the snapshot again and we'll compare to cycle 1.</p>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* composer with queued messages */}
        <div className="composer">
          <div className="composer-inner">
            <div className="composer-box">
              <div className="composer-area">Message Agent Cockpit…</div>
              <div className="composer-queue">
                <div className="q">
                  <span className="tag">queued</span>
                  <span>Then run the snapshot script again and diff against cycle 1.</span>
                  <span className="actions">
                    <button className="iconbtn">{Ico.edit(12)}</button>
                    <button className="iconbtn">{Ico.x(12)}</button>
                  </span>
                </div>
                <div className="q">
                  <span className="tag">queued</span>
                  <span>Also: email me the summary when done.</span>
                  <span className="actions">
                    <button className="iconbtn">{Ico.edit(12)}</button>
                    <button className="iconbtn">{Ico.x(12)}</button>
                  </span>
                </div>
              </div>
              <div className="composer-foot">
                <div className="picks">
                  <span className="pick"><span>Backend</span> <b>Claude Code</b> {Ico.chevD(10)}</span>
                  <span className="pick"><span>Model</span> <b>opus-4.1</b> {Ico.chevD(10)}</span>
                  <span className="pick"><span>Effort</span> <b>high</b> {Ico.chevD(10)}</span>
                </div>
                <span className="attach">
                  <button className="btn ghost" style={{padding:"4px 8px"}}>{Ico.paperclip(12)}</button>
                </span>
                <span className="hint">⌘ + Enter to send</span>
                <button className="send stop">{Ico.stop(14)}</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* RIGHT RAIL — persistent instrumentation */}
      <aside className="rail">
        <h5>This run</h5>
        <div className="card">
          <div className="kv"><span>Elapsed</span><b>02:14</b></div>
          <div className="kv"><span>Tools</span><b>11 · 4 parallel</b></div>
          <div className="kv"><span>Tokens</span><b>18.4k in · 3.2k out</b></div>
          <div className="kv"><span>Cost</span><b>$0.42</b></div>
          <div className="kv"><span>Queued</span><b>2 messages</b></div>
        </div>

        <h5>Files touched</h5>
        <div className="card" style={{padding:0}}>
          <div className="tool done"><span className="marker"/><span><span className="name">digest.ts</span> <span className="arg">+42 −7</span></span><span className="ms">M</span><span/></div>
          <div className="tool done"><span className="marker"/><span><span className="name">search.ts</span> <span className="arg">+0 −0</span></span><span className="ms">R</span><span/></div>
          <div className="tool done"><span className="marker"/><span><span className="name">meta.json</span> <span className="arg">+1 −1</span></span><span className="ms">M</span><span/></div>
        </div>

        <h5>Subagents</h5>
        <div className="card">
          <div className="kv"><span>digestion-auditor</span><b className="u-accent">running</b></div>
          <div className="kv"><span>doc-scraper</span><b>done</b></div>
        </div>

        <h5>Workspace</h5>
        <div className="card">
          <div className="kv"><span>Path</span><b className="u-mono" style={{fontSize:10.5}}>~/test2-workspace</b></div>
          <div className="kv"><span>KB entries</span><b>433</b></div>
          <div className="kv"><span>Files</span><b>204</b></div>
        </div>
      </aside>
    </div>
  );
}
window.ChatScreen = ChatScreen;
