/* global React, ReactDOM, ChatScreen, PlanScreen, SidebarScreen, KbScreen, FilesScreen,
   EmptyChat, KbUpload, KbEntries, KbReflections, MobileScreen,
   Settings, LongConv, MultiStream, ErrorChat, SessionExpired, System, Ico */
const { useState, useEffect } = React;

const SLIDES = [
  { id:"overview",   group:"Intro",       title:"Full-Surface · Direction A (Editorial + Cockpit)", render:(p)=><OverviewSlide {...p}/>, hidden:true },
  { id:"chat-empty", group:"Chat",        title:"01 · Chat · empty state",                       render:()=><Frame><EmptyChat/></Frame> },
  { id:"chat-mid",   group:"Chat",        title:"02 · Chat · mid-stream",                        render:()=><Frame><ChatScreen/></Frame> },
  { id:"chat-plan",  group:"Chat",        title:"03 · Chat · plan approval + clarifying",        render:()=><Frame><PlanScreen/></Frame> },
  { id:"chat-long",  group:"Chat",        title:"04 · Chat · long conversation · collapsed groups", render:()=><Frame><LongConv/></Frame> },
  { id:"chat-multi", group:"Chat",        title:"05 · Overview · multiple parallel conversations", render:()=><Frame><MultiStream/></Frame> },
  { id:"chat-err",   group:"Chat",        title:"06 · Chat · stream error + WS disconnected",    render:()=><Frame><ErrorChat/></Frame> },
  { id:"sidebar",    group:"Sidebar",     title:"07 · Sidebar · running group + workspaces",     render:()=><Frame><SidebarScreen/></Frame> },
  { id:"kb-upload",  group:"Knowledge",   title:"08 · KB · upload &amp; ingestion",               render:()=><Frame><KbUpload/></Frame> },
  { id:"kb-entries", group:"Knowledge",   title:"09 · KB · entries list",                         render:()=><Frame><KbEntries/></Frame> },
  { id:"kb-graph",   group:"Knowledge",   title:"10 · KB · synthesis graph",                      render:()=><Frame><KbScreen/></Frame> },
  { id:"kb-refl",    group:"Knowledge",   title:"11 · KB · reflections",                          render:()=><Frame><KbReflections/></Frame> },
  { id:"files",      group:"Workspace",   title:"12 · Files · tree + editor",                     render:()=><Frame><FilesScreen/></Frame> },
  { id:"settings",   group:"Settings",    title:"13 · Settings · 5 tabs",                         render:()=><Frame><Settings/></Frame> },
  { id:"expired",    group:"System",      title:"14 · Session expired · drafts preserved",        render:()=><Frame><SessionExpiredWrap/></Frame> },
  { id:"mobile",     group:"Mobile",      title:"15 · Mobile narrow width",                        render:()=><Frame mobile><MobileScreen/></Frame> },
  { id:"system",     group:"System",      title:"16 · Design system · tokens &amp; components",   render:()=><System/>, raw:true },
];

const TWEAK_DEFAULS = /*EDITMODE-BEGIN*/{
  "direction": "editorial",
  "theme": "dark",
  "density": "default",
  "radius": "moderate",
  "slide": "chat-mid"
}/*EDITMODE-END*/;

function SessionExpiredWrap(){
  // Put the expired overlay on top of a chat frame for context
  return (
    <div style={{position:"relative",width:"100%",height:"100%"}}>
      <div style={{position:"absolute",inset:0,opacity:.45}}><ChatScreen/></div>
      <SessionExpired/>
    </div>
  );
}

function Frame({ children, mobile }){
  return (
    <div className={`surface-frame ${mobile?"mobile":""}`}>
      {children}
    </div>
  );
}

function OverviewSlide({ onGoto }){
  const groups = {};
  SLIDES.forEach((s,i)=>{
    if (s.hidden) return;
    (groups[s.group] = groups[s.group] || []).push({...s, idx:i});
  });
  return (
    <div className="ov-page">
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
        <span style={{color:"#02A6F5"}}>{Ico.brand(28)}</span>
        <span className="ov-eyebrow">Agent Cockpit · Redesign · Round 2</span>
      </div>
      <h1 className="ov-h1">Full-surface mockups.</h1>
      <p className="ov-sub">
        Every primary screen and state from the brief, in the chosen direction
        (Editorial + Cockpit). Use the arrows below, <span className="u-mono" style={{fontSize:11,opacity:.8}}>←/→</span> on
        the keyboard, or the contents index to jump around.
        Toggle <b>Tweaks</b> in the toolbar to try other themes, densities, radii, and directions.
      </p>
      <div className="ov-grid">
        {Object.entries(groups).map(([g, items]) => (
          <div key={g} className="ov-col">
            <h4>{g}</h4>
            {items.map(it => (
              <button key={it.id} className="ov-item" onClick={()=>onGoto(it.idx)}>
                <span className="ov-num u-mono">{String(it.idx).padStart(2,"0")}</span>
                <span dangerouslySetInnerHTML={{__html: it.title.replace(/^\d+\s*·\s*/, "")}}/>
                <span className="ov-arrow">→</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="ov-foot">
        <span className="u-mono">tokens · src/tokens.css</span>
        <span className="u-mono">components · src/screens/*.jsx</span>
        <span className="u-mono">type · General Sans · JetBrains Mono · Instrument Serif</span>
      </div>
    </div>
  );
}

function useTweaks(){
  const [state, setState] = useState({ ...TWEAK_DEFAULS, __edit:false });
  useEffect(() => {
    const onMsg = (e) => {
      if (!e.data) return;
      if (e.data.type === "__activate_edit_mode") setState(s => ({...s, __edit:true}));
      if (e.data.type === "__deactivate_edit_mode") setState(s => ({...s, __edit:false}));
    };
    window.addEventListener("message", onMsg);
    window.parent.postMessage({type:"__edit_mode_available"}, "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const update = (patch) => {
    setState(s => ({...s, ...patch}));
    const persistable = {...patch};
    delete persistable.__edit;
    if (Object.keys(persistable).length){
      window.parent.postMessage({type:"__edit_mode_set_keys", edits: persistable}, "*");
    }
  };
  return [state, update];
}

function TweaksPanel({ state, update }){
  if (!state.__edit) return null;
  const Opt = ({ k, v, label }) => (
    <button aria-pressed={state[k] === v} onClick={() => update({[k]: v})}>{label}</button>
  );
  return (
    <div className="tweaks">
      <h4>Tweaks</h4>
      <div className="row">
        <label>Theme</label>
        <div className="opts">
          <Opt k="theme" v="light" label="Light"/>
          <Opt k="theme" v="dark"  label="Dark"/>
        </div>
      </div>
      <div className="row">
        <label>Density</label>
        <div className="opts">
          <Opt k="density" v="compact"  label="Compact"/>
          <Opt k="density" v="default"  label="Default"/>
          <Opt k="density" v="spacious" label="Spacious"/>
        </div>
      </div>
      <div className="row">
        <label>Radius</label>
        <div className="opts">
          <Opt k="radius" v="sharp"    label="Sharp"/>
          <Opt k="radius" v="moderate" label="Mod"/>
          <Opt k="radius" v="soft"     label="Soft"/>
        </div>
      </div>
      <div className="row">
        <label>Direction</label>
        <div className="opts">
          <Opt k="direction" v="editorial" label="A"/>
          <Opt k="direction" v="terminal"  label="B"/>
          <Opt k="direction" v="paper"     label="C"/>
        </div>
      </div>
    </div>
  );
}

function App(){
  const [state, update] = useTweaks();
  const { direction, theme, density, radius } = state;

  // slide navigation with localStorage persistence
  const initial = React.useMemo(()=> {
    try {
      const v = localStorage.getItem("ac_slide");
      if (v != null) {
        const n = parseInt(v, 10);
        if (!isNaN(n) && n >= 0 && n < SLIDES.length) return n;
      }
    } catch {}
    const ix = SLIDES.findIndex(s=> s.id === state.slide);
    return ix >= 0 ? ix : 2; // chat-mid default
  }, []);
  const [idx, setIdx] = useState(initial);
  useEffect(()=> {
    try { localStorage.setItem("ac_slide", String(idx)); } catch {}
    update({ slide: SLIDES[idx].id });
    window.postMessage({slideIndexChanged: idx}, "*");
    // scroll reset
    const el = document.querySelector(".deck-view");
    if (el) el.scrollTop = 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  // Prototype-only deck API so preview screens (e.g. Settings X button)
  // can navigate back without prop-drilling. Removed once Settings becomes
  // a real overlay on top of the chat screen.
  useEffect(()=> {
    window.__acDeck = {
      goto: (i) => setIdx(Math.max(0, Math.min(SLIDES.length - 1, i|0))),
      gotoId: (id) => {
        const i = SLIDES.findIndex(s => s.id === id);
        if (i >= 0) setIdx(i);
      },
    };
  }, []);

  useEffect(()=> {
    const onKey = (e)=>{
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === "ArrowRight" || e.key === "j") setIdx(i=> Math.min(i+1, SLIDES.length-1));
      if (e.key === "ArrowLeft"  || e.key === "k") setIdx(i=> Math.max(i-1, 0));
      if (e.key === "Home") setIdx(0);
      if (e.key === "End")  setIdx(SLIDES.length-1);
    };
    window.addEventListener("keydown", onKey);
    return ()=> window.removeEventListener("keydown", onKey);
  }, []);

  const slide = SLIDES[idx];
  const labelProps = { "data-screen-label": `${String(idx).padStart(2,"0")} ${slide.group}`};

  return (
    <div className="deck"
      data-direction={direction}
      data-theme={theme}
      data-density={density}
      data-radius={radius}
      {...labelProps}
    >
      <header className="deck-head">
        <div className="deck-title">
          <span style={{color:"#02A6F5",display:"inline-flex"}}>{Ico.brand(18)}</span>
          <b>Agent Cockpit</b>
          <span className="u-mono deck-group">· {slide.group}</span>
          <span className="deck-slide-title" dangerouslySetInnerHTML={{__html: slide.title}}/>
        </div>
        <div className="deck-ctrls">
          <div className="seg" role="group">
            <button aria-pressed={theme==="light"} onClick={()=>update({theme:"light"})}>Light</button>
            <button aria-pressed={theme==="dark"}  onClick={()=>update({theme:"dark"})}>Dark</button>
          </div>
          <div className="seg" role="group" aria-label="Direction">
            <button aria-pressed={direction==="editorial"} onClick={()=>update({direction:"editorial"})}>A Editorial</button>
            <button aria-pressed={direction==="terminal"}  onClick={()=>update({direction:"terminal"})}>B Terminal</button>
            <button aria-pressed={direction==="paper"}     onClick={()=>update({direction:"paper"})}>C Paper</button>
          </div>
          <div className="deck-counter u-mono">
            {String(idx + 1).padStart(2,"0")} / {String(SLIDES.length).padStart(2,"0")}
          </div>
        </div>
      </header>

      <main className="deck-view">
        {slide.raw ? slide.render({onGoto:setIdx}) : slide.render({onGoto:setIdx})}
      </main>

      <nav className="deck-nav">
        <button className="nav-btn" onClick={()=>setIdx(0)} title="First">⇤</button>
        <button className="nav-btn" onClick={()=>setIdx(i=>Math.max(0,i-1))}>← Prev</button>
        <div className="nav-scrubber">
          {SLIDES.map((s,i)=>(
            <button
              key={s.id}
              className={`dot ${i===idx?"active":""} ${s.hidden?"hidden":""}`}
              onClick={()=>setIdx(i)}
              title={s.title.replace(/<[^>]+>/g,"")}
            />
          ))}
        </div>
        <button className="nav-btn" onClick={()=>setIdx(i=>Math.min(SLIDES.length-1,i+1))}>Next →</button>
        <button className="nav-btn" onClick={()=>setIdx(SLIDES.length-1)} title="Last">⇥</button>
      </nav>

      <TweaksPanel state={state} update={update}/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
