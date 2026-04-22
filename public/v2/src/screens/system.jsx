/* global React, Ico */

function System(){
  return (
    <div className="sys-page">
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
        <span style={{color:"#02A6F5"}}>{Ico.brand(28)}</span>
        <span style={{fontFamily:"JetBrains Mono,monospace",fontSize:11,letterSpacing:".16em",textTransform:"uppercase",color:"#95A0B0"}}>Design System · v0.1</span>
      </div>
      <h1 className="sys-h1">Agent Cockpit — tokens &amp; components</h1>
      <p className="sys-sub">
        Copy-pasteable CSS variables, type scale, spacing, and component specs.
        Three directions share the same token names; swap the <code>data-direction</code> attribute on the frame root to switch palettes.
      </p>

      <div className="sys-grid">

        {/* Colors */}
        <div className="sys-card span-12">
          <h4>Colors · Direction A · dark &amp; light</h4>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}}>
            {[
              {title:"Dark",theme:"dark",dir:"editorial"},
              {title:"Light",theme:"light",dir:"editorial"}
            ].map((g,gi)=>(
              <div key={gi} data-direction={g.dir} data-theme={g.theme==="light"?undefined:"dark"}
                   style={{background:"var(--bg)",borderRadius:12,padding:14,border:"1px solid var(--border)"}}>
                <div style={{fontFamily:"JetBrains Mono,monospace",fontSize:10.5,letterSpacing:".12em",textTransform:"uppercase",color:"var(--text-3)",marginBottom:10}}>{g.title}</div>
                <div className="swatches">
                  {[
                    {v:"--bg",n:"bg"},
                    {v:"--bg-sunk",n:"bg-sunk"},
                    {v:"--surface",n:"surface"},
                    {v:"--surface-2",n:"surface-2"},
                    {v:"--text",n:"text"},
                    {v:"--text-2",n:"text-2"},
                    {v:"--text-3",n:"text-3"},
                    {v:"--border",n:"border"},
                    {v:"--accent",n:"accent"},
                    {v:"--status-running",n:"running"},
                    {v:"--status-awaiting",n:"awaiting"},
                    {v:"--status-done",n:"done"},
                    {v:"--status-error",n:"error"},
                    {v:"--status-subagent",n:"subagent"},
                  ].map(s=>(
                    <div className="swatch" key={s.v}>
                      <div className="chip" style={{background:`var(${s.v})`}}/>
                      <div className="lbl" style={{color:"var(--text-3)"}}>
                        <b style={{color:"var(--text)"}}>{s.n}</b>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Type */}
        <div className="sys-card span-6">
          <h4>Type</h4>
          <div className="type-sample">
            <div className="tag">prose · Instrument Serif · 46/1.1 · -0.015em</div>
            <div style={{fontFamily:"Instrument Serif,serif",fontSize:38,letterSpacing:"-.015em",lineHeight:1.1,color:"#F2ECE0"}}>
              Piloting long-running agents, calmly.
            </div>
          </div>
          <div className="type-sample">
            <div className="tag">ui / headline · General Sans 600 · 20/1.2</div>
            <div style={{fontFamily:"General Sans,sans-serif",fontSize:20,fontWeight:600,color:"#F2ECE0"}}>Refactor auth middleware</div>
          </div>
          <div className="type-sample">
            <div className="tag">ui / body · General Sans 500 · 14/1.55</div>
            <div style={{fontFamily:"General Sans,sans-serif",fontSize:14,lineHeight:1.55,color:"#C7BFB1"}}>
              Removed legacy helper, updated nine imports, and ran typecheck — green. Queued two follow-ups to reduce risk of regression in the billing route.
            </div>
          </div>
          <div className="type-sample">
            <div className="tag">mono · JetBrains Mono 500 · 11/1.4</div>
            <div style={{fontFamily:"JetBrains Mono,monospace",fontSize:11,color:"#8F877A"}}>
              services/kb/search.ts · 142 entries · 02:14 elapsed
            </div>
          </div>
        </div>

        {/* Spacing */}
        <div className="sys-card span-6">
          <h4>Spacing · 4-step</h4>
          {[
            ["s-2",4],["s-4",8],["s-6",12],["s-8",16],["s-10",20],["s-12",24],["s-16",32],["s-20",40],
          ].map(([n,px])=>(
            <div className="scale-row" key={n}>
              <span><b>{n}</b> · {px}px</span>
              <span className="bar" style={{width:px*3}}/>
            </div>
          ))}
          <div style={{marginTop:14,fontFamily:"JetBrains Mono,monospace",fontSize:10.5,color:"#95A0B0",letterSpacing:".12em",textTransform:"uppercase"}}>Radius scale</div>
          {[["r-xs",4],["r-sm",7],["r-md",11],["r-lg",14],["r-xl",20]].map(([n,px])=>(
            <div className="scale-row" key={n}>
              <span><b>{n}</b> · {px}px</span>
              <span style={{display:"inline-block",height:18,width:60,background:"#13151B",border:"1px solid rgba(255,255,255,.08)",borderRadius:px}}/>
            </div>
          ))}
        </div>

        {/* Status palette */}
        <div className="sys-card span-6">
          <h4>Status · dots, borders, small fills only</h4>
          <div style={{display:"grid",gap:10}}>
            {[
              {n:"running · cyan",v:"var(--status-running)",hex:"#02A6F5"},
              {n:"awaiting · amber",v:"var(--status-awaiting)",hex:"#E8A33D"},
              {n:"done · green",v:"var(--status-done)",hex:"#3FB27F"},
              {n:"error · red",v:"var(--status-error)",hex:"#E5484D"},
              {n:"subagent · purple",v:"var(--status-subagent)",hex:"#8B72E0"},
            ].map(s=>(
              <div key={s.n} style={{display:"grid",gridTemplateColumns:"16px 1fr auto",alignItems:"center",gap:10,fontFamily:"JetBrains Mono,monospace",fontSize:11.5,color:"#CFD5DF"}}>
                <span style={{width:10,height:10,borderRadius:999,background:s.v,display:"inline-block"}}/>
                <span>{s.n}</span>
                <span style={{color:"#7A8597"}}>{s.hex}</span>
              </div>
            ))}
          </div>
          <div style={{marginTop:12,fontSize:11.5,color:"#8a8e98",lineHeight:1.5}}>
            Status colors appear on 6–10px dots, 2–3px left borders, and low-alpha chip fills — never as flood fills on message bubbles.
          </div>
        </div>

        {/* Components */}
        <div className="sys-card span-6">
          <h4>Components · primary elements</h4>
          <div style={{display:"grid",gap:10}} data-direction="editorial" data-theme="dark">
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button className="btn primary">Approve plan</button>
              <button className="btn">Reject</button>
              <button className="btn ghost">Cancel</button>
              <button className="btn danger">Archive</button>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <span className="topic-chip">#search</span>
              <span className="topic-chip" style={{color:"var(--status-awaiting)",borderColor:"color-mix(in oklch, var(--status-awaiting), transparent 70%)"}}>awaiting</span>
              <span className="topic-chip" style={{color:"var(--status-running)",borderColor:"color-mix(in oklch, var(--status-running), transparent 70%)"}}>● streaming</span>
              <span className="topic-chip" style={{color:"var(--status-done)",borderColor:"color-mix(in oklch, var(--status-done), transparent 70%)"}}>✓ done</span>
            </div>
            <div className="stream-head" style={{margin:0}}>
              <span className="ring"/>
              <span className="time">02:14</span>
              <span>·</span>
              <span className="curr">running <b>grep</b> on <code style={{fontFamily:"var(--mono-font)"}}>services/kb/search.ts</code></span>
            </div>
          </div>
        </div>

        {/* Motion */}
        <div className="sys-card span-12">
          <h4>Motion · easings + durations</h4>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,fontFamily:"JetBrains Mono,monospace",fontSize:11.5,color:"#95A0B0"}}>
            <div><b style={{color:"#CFD5DF"}}>--dur-1 · 120ms</b><div style={{marginTop:4}}>icon hover, dot pulse tick</div></div>
            <div><b style={{color:"#CFD5DF"}}>--dur-2 · 200ms</b><div style={{marginTop:4}}>panel open, toggle</div></div>
            <div><b style={{color:"#CFD5DF"}}>--dur-3 · 320ms</b><div style={{marginTop:4}}>modal enter, page enter</div></div>
            <div style={{gridColumn:"1 / -1",borderTop:"1px dashed rgba(255,255,255,.08)",paddingTop:10}}><b style={{color:"#CFD5DF"}}>--easing · cubic-bezier(.2,.7,.2,1)</b><div style={{marginTop:4,maxWidth:640}}>Single ease curve everywhere. No bounce, no spring. Streaming dot uses a 1.8s pulse at infinite; spinner ring rotates at 1.1s linear.</div></div>
          </div>
        </div>

      </div>
    </div>
  );
}

window.System = System;
