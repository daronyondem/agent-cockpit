/* global React */
function KbScreen(){
  // pseudo-random nodes for a force-graph look
  const nodes = [];
  const rng = (() => { let s = 7; return () => { s = (s*9301 + 49297) % 233280; return s/233280; }; })();
  const palette = ["var(--accent)","var(--status-done)","var(--status-awaiting)","var(--status-subagent)","var(--status-error)"];
  for (let i=0;i<80;i++){
    nodes.push({
      x: 8 + rng()*84,
      y: 10 + rng()*78,
      r: 1.2 + rng()*3.8,
      c: palette[Math.floor(rng()*palette.length)],
    });
  }
  const edges = [];
  for (let i=0;i<60;i++){
    const a = Math.floor(rng()*nodes.length);
    const b = Math.floor(rng()*nodes.length);
    if (a!==b) edges.push([a,b]);
  }

  return (
    <div className="kb-shell">
      <div className="kb-top">
        <span style={{display:"inline-flex",alignItems:"center",gap:8}}>
          <span style={{width:18,height:18,borderRadius:4,background:"var(--accent-soft)",display:"inline-flex",alignItems:"center",justifyContent:"center",color:"var(--accent)"}}>◎</span>
          <span className="title">Knowledge Base</span>
        </span>
        <span className="ws">Desktop/test2-workspace</span>
        <span className="u-mono u-dim" style={{fontSize:10.5}}>204 files · 433 entries · 1 folder</span>
        <span style={{marginLeft:"auto",display:"flex",gap:6}}>
          <button className="btn ghost">↓ Download</button>
          <button className="btn ghost">↺ Reset</button>
          <button className="btn">Close</button>
        </span>
      </div>

      <div className="kb-tabs">
        <div className="kb-tab">Raw · 204</div>
        <div className="kb-tab">Entries · 433</div>
        <div className="kb-tab active">Synthesis · 163</div>
        <div className="kb-tab">Reflections</div>
        <div className="kb-tab">Settings</div>
      </div>

      <div className="kb-status">
        <span className="kb-pill ok"><span className="dot"/>Theme</span>
        <span className="kb-pill"><span className="dot"/>No Dream (all visited)</span>
        <span className="kb-pill run"><span className="dot"/>Last sync 15s ago · 433 digesting</span>
        <span className="kb-pill ok"><span className="dot"/>Routing</span>
        <span className="kb-pill ok"><span className="dot"/>Verification</span>
        <span className="kb-pill warn"><span className="dot"/>Synthesis 2/4</span>
        <span className="kb-pill"><span className="dot"/>Discovery</span>
        <span className="kb-pill"><span className="dot"/>Reflection</span>
        <span className="kb-pill ok"><span className="dot"/>TLS</span>
      </div>

      <div className="kb-body" style={{position:"relative"}}>
        <div className="kb-canvas">
          <svg viewBox="0 0 100 90" preserveAspectRatio="xMidYMid meet">
            {edges.map(([a,b],i) => {
              const na = nodes[a], nb = nodes[b];
              return <line key={i} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
                stroke="currentColor" strokeWidth=".12" opacity=".22"/>;
            })}
            {nodes.map((n,i) => (
              <g key={i}>
                <circle cx={n.x} cy={n.y} r={n.r*1.8} fill={n.c} opacity=".12"/>
                <circle cx={n.x} cy={n.y} r={n.r} fill={n.c}/>
              </g>
            ))}
          </svg>
        </div>
        <div className="kb-right">
          <h6>Selected node</h6>
          <div className="entity">KB search performance</div>
          <div style={{fontFamily:"var(--mono-font)",fontSize:11,color:"var(--text-3)",lineHeight:1.6}}>
            Topic cluster · #22<br/>
            12 linked entries<br/>
            3 cross-topic links<br/>
            <span className="u-accent">28 inbound · 14 outbound</span>
          </div>
          <div style={{marginTop:14,paddingTop:10,borderTop:"1px solid var(--border)"}}>
            <h6>Nearest</h6>
            <div style={{fontSize:12,lineHeight:1.8,color:"var(--text-2)"}}>
              <div>· entry merging gate</div>
              <div>· topic cluster #17</div>
              <div>· digest throughput</div>
              <div>· snapshot script</div>
            </div>
          </div>
        </div>
      </div>

      <div className="kb-legend">
        <span className="lg"><span className="dot" style={{background:"var(--accent)"}}/>Entry</span>
        <span className="lg"><span className="dot" style={{background:"var(--status-awaiting)"}}/>Topic cluster</span>
        <span className="lg"><span className="dot" style={{background:"var(--status-subagent)"}}/>Concept</span>
        <span className="lg"><span className="dot" style={{background:"var(--status-done)"}}/>Same-topic link</span>
        <span className="lg"><span className="dot" style={{background:"var(--status-error)"}}/>Cross-topic link</span>
        <span style={{marginLeft:"auto",opacity:.7}}>Labels auto-hidden · hover a node to reveal</span>
      </div>
    </div>
  );
}
window.KbScreen = KbScreen;
