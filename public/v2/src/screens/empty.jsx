/* global React, Sidebar, Ico */

function EmptyChat(){
  return (
    <div className="cockpit">
      <Sidebar/>
      <section className="main">
        <div className="topbar">
          <div className="crumbs"><span className="here">New conversation</span></div>
          <div className="right">
            <span className="pick u-mono" style={{padding:"4px 8px",borderRadius:"var(--r-sm)",border:"1px solid var(--border)",background:"var(--surface)",fontSize:11.5}}>
              <span className="u-dim">workspace</span> <b>github/agent-cockpit</b> {Ico.chevD(10)}
            </span>
          </div>
        </div>
        <div className="feed" style={{display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div className="empty-wrap">
            <div className="empty-mark">{Ico.brand(44)}</div>
            <div className="empty-eyebrow u-mono">Agent Cockpit · local</div>
            <h1 className="empty-title">What are we flying today?</h1>
            <p className="empty-sub">
              Start a conversation in <b>github/agent-cockpit</b>.
              Drafts &amp; queued messages are kept locally — nothing leaves this machine unless you send it.
            </p>
            <div className="suggest-grid">
              <button className="suggest">
                <div className="s-head">{Ico.search(13)} <span>Investigate</span></div>
                <div className="s-body">Audit how <code>services/kb/search.ts</code> handles entries larger than 400 KB.</div>
              </button>
              <button className="suggest">
                <div className="s-head">{Ico.edit(13)} <span>Implement</span></div>
                <div className="s-body">Add a dark mode toggle persisted in user settings, system-aware by default.</div>
              </button>
              <button className="suggest">
                <div className="s-head">{Ico.diff(13)} <span>Refactor</span></div>
                <div className="s-body">Extract auth middleware into its own module and update all imports.</div>
              </button>
            </div>
          </div>
        </div>
        <div className="composer">
          <div className="composer-inner">
            <div className="composer-box">
              <div className="composer-area">Message Agent Cockpit… <span className="u-dim" style={{marginLeft:6,fontSize:12}}>Paste files, @-mention a file path, or describe a goal.</span></div>
              <div className="composer-foot">
                <div className="picks">
                  <span className="pick"><span>Backend</span> <b>Claude Code</b> {Ico.chevD(10)}</span>
                  <span className="pick"><span>Model</span> <b>opus-4.1</b> {Ico.chevD(10)}</span>
                  <span className="pick"><span>Effort</span> <b>high</b> {Ico.chevD(10)}</span>
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

function KbUpload(){
  return (
    <div className="kb-shell">
      <div className="kb-top">
        <span style={{display:"inline-flex",alignItems:"center",gap:8}}>{Ico.book(14)}<span className="title">Knowledge Base</span></span>
        <span className="ws">Desktop/test2-workspace</span>
        <span style={{marginLeft:"auto"}}><button className="btn">Close</button></span>
      </div>
      <div className="kb-tabs">
        <div className="kb-tab active">Upload</div>
        <div className="kb-tab">Entries · 433</div>
        <div className="kb-tab">Synthesis · 163</div>
        <div className="kb-tab">Reflections</div>
        <div className="kb-tab">Settings</div>
      </div>
      <div className="kb-status">
        <span className="kb-pill run"><span className="dot"/>Digesting 12 files · ETA 1:42</span>
        <span className="kb-pill ok"><span className="dot"/>Cycle 2 · complete</span>
      </div>
      <div style={{padding:20,overflow:"auto"}}>
        <div className="dropzone">
          <div className="dz-inner">
            <div className="dz-mark">{Ico.upload(22)}</div>
            <div className="dz-title">Drop files or a folder here</div>
            <div className="dz-sub u-dim">Supports .md · .txt · .pdf · .docx · .pptx · .html · .json — up to 50 MB per file</div>
            <div style={{display:"flex",gap:8,marginTop:10}}>
              <button className="btn">{Ico.file(12)} Upload files</button>
              <button className="btn">{Ico.folder(12)} Upload folder</button>
            </div>
          </div>
        </div>

        <h5 className="kb-section">In flight · 3 files</h5>
        <div className="upload-row">
          <span>{Ico.file(14)}</span>
          <span className="nm u-mono">story-themes-epic.md</span>
          <span className="meta u-dim u-mono">42 KB · digesting</span>
          <div className="progress"><i style={{width:"62%",background:"var(--status-running)"}}/></div>
          <button className="btn ghost" style={{padding:"3px 8px"}}>Pause</button>
        </div>
        <div className="upload-row">
          <span>{Ico.file(14)}</span>
          <span className="nm u-mono">research/azure-xregion.pdf</span>
          <span className="meta u-dim u-mono">2.4 MB · queued</span>
          <div className="progress"><i style={{width:"12%",background:"var(--text-3)"}}/></div>
          <button className="btn ghost" style={{padding:"3px 8px"}}>Cancel</button>
        </div>
        <div className="upload-row">
          <span>{Ico.file(14)}</span>
          <span className="nm u-mono">plans/SAMPLE_PLAN.md</span>
          <span className="meta u-ok u-mono">Done · 14 entries</span>
          <div className="progress"><i style={{width:"100%",background:"var(--status-done)"}}/></div>
          <button className="btn ghost" style={{padding:"3px 8px"}}>View</button>
        </div>

        <h5 className="kb-section">Recent · 12 files</h5>
        <div className="upload-row"><span>{Ico.file(14)}</span><span className="nm u-mono">business-001.txt</span><span className="meta u-dim u-mono">2.3 KB · 10m ago · 4 entries</span><span/><button className="btn ghost" style={{padding:"3px 8px"}}>Open</button></div>
        <div className="upload-row"><span>{Ico.file(14)}</span><span className="nm u-mono">business-002.txt</span><span className="meta u-dim u-mono">2.1 KB · 10m ago · 4 entries</span><span/><button className="btn ghost" style={{padding:"3px 8px"}}>Open</button></div>
        <div className="upload-row"><span>{Ico.file(14)}</span><span className="nm u-mono">entertainment-014.txt</span><span className="meta u-dim u-mono">1.6 KB · 12m ago · 3 entries</span><span/><button className="btn ghost" style={{padding:"3px 8px"}}>Open</button></div>
      </div>
    </div>
  );
}

function KbEntries(){
  const topics = ["search","digest","pipeline","ingest","topic-map","routing","reflection","snapshot"];
  const rows = [
    {t:"kb search uses lexical + vector score blended 60/40",top:"search",src:"SAMPLE_PLAN.md",d:"2m ago"},
    {t:"digestion writes to entries.jsonl; synthesis gate lives at column needs_synthesis",top:"digest",src:"digest-notes.md",d:"4m ago"},
    {t:"cycle 2 persists 163 topics from cycle 1; only new entries require resynth",top:"topic-map",src:"snapshot-cycle2.log",d:"8m ago"},
    {t:"entries > 400 KB are split on paragraph boundaries before embedding",top:"pipeline",src:"pipeline.ts",d:"14m ago"},
    {t:"routing ignores stopwords in cross-topic ranking",top:"routing",src:"routing.ts",d:"22m ago"},
    {t:"reflection writes summaries grouped by topic cluster every 50 entries",top:"reflection",src:"reflect.ts",d:"1h ago"},
    {t:"BBC corpus: 100 files each from business, entertainment, sport",top:"ingest",src:"bbc-corpus.txt",d:"3h ago"},
  ];
  return (
    <div className="kb-shell">
      <div className="kb-top">
        <span style={{display:"inline-flex",alignItems:"center",gap:8}}>{Ico.book(14)}<span className="title">Knowledge Base</span></span>
        <span className="ws">Desktop/test2-workspace</span>
        <span style={{marginLeft:"auto"}}><button className="btn">Close</button></span>
      </div>
      <div className="kb-tabs">
        <div className="kb-tab">Upload</div>
        <div className="kb-tab active">Entries · 433</div>
        <div className="kb-tab">Synthesis · 163</div>
        <div className="kb-tab">Reflections</div>
        <div className="kb-tab">Settings</div>
      </div>
      <div className="entries-top">
        <div className="search-input"><span style={{color:"var(--text-3)"}}>{Ico.search(13)}</span><span className="u-dim">Search entries…</span><span className="u-mono u-dim" style={{marginLeft:"auto",fontSize:10.5}}>⌘F</span></div>
        <span className="spacer" style={{flex:1}}/>
        <span className="seg seg-inline" style={{fontSize:11}}>
          <button aria-pressed="true">All</button>
          <button>Pending</button>
          <button>Dreamed</button>
          <button>Orphan</button>
        </span>
      </div>
      <div className="entries-topics">
        {topics.map(t => <span key={t} className="topic-chip">#{t}</span>)}
        <span className="topic-chip more">+11 more</span>
      </div>
      <div style={{overflow:"auto",padding:"0 16px 16px"}}>
        {rows.map((r,i)=>(
          <div key={i} className="entry-row">
            <span className="entry-marker"/>
            <div className="entry-text">
              {r.t}
              <div className="entry-meta u-mono u-dim">
                <span className="topic-chip sm">#{r.top}</span>
                <span>· from {r.src}</span>
                <span>· {r.d}</span>
              </div>
            </div>
            <button className="iconbtn-lg">{Ico.dots(14)}</button>
          </div>
        ))}
        <div className="entries-foot u-mono u-dim">Showing 7 of 433 · page 1 / 62</div>
      </div>
    </div>
  );
}

function KbReflections(){
  return (
    <div className="kb-shell">
      <div className="kb-top">
        <span style={{display:"inline-flex",alignItems:"center",gap:8}}>{Ico.book(14)}<span className="title">Knowledge Base</span></span>
        <span className="ws">Desktop/test2-workspace</span>
        <span style={{marginLeft:"auto"}}><button className="btn">Close</button></span>
      </div>
      <div className="kb-tabs">
        <div className="kb-tab">Upload</div>
        <div className="kb-tab">Entries · 433</div>
        <div className="kb-tab">Synthesis · 163</div>
        <div className="kb-tab active">Reflections</div>
        <div className="kb-tab">Settings</div>
      </div>
      <div style={{overflow:"auto",padding:"18px 24px 24px"}}>
        <div className="reflect-card">
          <div className="r-head"><span className="u-mono u-dim" style={{fontSize:10.5,letterSpacing:".1em"}}>CYCLE 2 · 14:03 · 62 entries</span><span className="spacer" style={{flex:1}}/><span className="topic-chip sm">#topic-map</span></div>
          <h3 className="r-title">The digest pipeline now persists topic identity across cycles.</h3>
          <div className="prose" style={{fontSize:15,lineHeight:1.6}}>
            <p>Of 163 topics carried over, 41 received new entries this cycle; none lost members. 12 cross-topic links strengthened, 3 weakened past the discard threshold and were pruned.</p>
            <p>The <code>needs_synthesis</code> gate stayed closed during ingest; only the final sweep flipped it. This is the behaviour you asked to lock in after cycle 1.</p>
          </div>
          <div className="r-foot u-mono u-dim">linked · 14 entries · 2 topics · 1 plan</div>
        </div>

        <div className="reflect-card">
          <div className="r-head"><span className="u-mono u-dim" style={{fontSize:10.5,letterSpacing:".1em"}}>CYCLE 1 · yesterday · 433 entries</span><span className="spacer" style={{flex:1}}/><span className="topic-chip sm">#ingest</span></div>
          <h3 className="r-title">BBC corpus yields clean topic clusters on the first pass.</h3>
          <div className="prose" style={{fontSize:15,lineHeight:1.6}}>
            <p>Business, entertainment, and sport produced three well-separated clusters with tight intra-cluster connections and sparse cross-links — a good baseline for measuring degradation in later cycles.</p>
          </div>
          <div className="r-foot u-mono u-dim">linked · 100 entries each · 3 topics</div>
        </div>
      </div>
    </div>
  );
}

/* Mobile narrow view */
function MobileScreen(){
  return (
    <div className="mobile-frame">
      <div className="m-top">
        <button className="iconbtn-lg">{Ico.dots(14)}</button>
        <span className="m-title">KB search performance</span>
        <span className="m-elapsed u-mono u-accent">02:14</span>
      </div>
      <div className="m-feed">
        <div className="msg msg-user"><span className="avatar">DY</span><div className="body">Verify digest handled files over 400 KB.</div></div>
        <div className="msg msg-agent"><span className="avatar">●</span>
          <div className="body">
            <div className="head"><span className="who">Claude Code</span></div>
            <div className="stream-head">
              <span className="ring"/>
              <span className="time">02:14</span>
              <span>·</span>
              <span className="curr">working · <b>grep</b></span>
            </div>
            <div className="tools" style={{marginTop:8}}>
              <div className="tools-head"><span>Sequential · 4</span></div>
              <div className="tool done"><span className="marker"/><span><span className="name">read_file</span></span><span/><span/></div>
              <div className="tool done"><span className="marker"/><span><span className="name">run_sql</span></span><span/><span/></div>
              <div className="tool run"><span className="marker"/><span><span className="name">grep</span></span><span/><span/></div>
            </div>
            <div className="prose" style={{fontSize:15,marginTop:10}}>
              <p>Yes — confirmed. 433 entries pending synthesis after ingest.</p>
            </div>
          </div>
        </div>
      </div>
      <div className="m-composer">
        <div className="m-box">
          <div className="m-area">Message Agent Cockpit…</div>
          <div className="m-foot">
            <button className="iconbtn-lg">{Ico.paperclip(13)}</button>
            <span className="pick" style={{fontSize:10.5}}><b>opus-4.1</b></span>
            <span className="spacer" style={{flex:1}}/>
            <button className="send" style={{background:"var(--status-error)"}}>{Ico.stop(13)}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

window.EmptyChat = EmptyChat;
window.KbUpload = KbUpload;
window.KbEntries = KbEntries;
window.KbReflections = KbReflections;
window.MobileScreen = MobileScreen;
