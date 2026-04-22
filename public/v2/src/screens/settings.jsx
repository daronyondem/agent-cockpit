/* global React, Ico */

/* ============================================================
   Additional CSS for round 2 — appended via <style> tag from app2
   ============================================================ */

function Settings(){
  const [tab, setTab] = React.useState("general");
  const tabs = [
    { id:"general",  label:"General",     ico: Ico.settings },
    { id:"usage",    label:"Usage & cost",ico: Ico.zap },
    { id:"server",   label:"Server",      ico: Ico.globe },
    { id:"instr",    label:"Workspace instructions", ico: Ico.edit },
    { id:"kb",       label:"Workspace KB",ico: Ico.book },
  ];
  const closeSettings = () => {
    if (window.__acDeck) window.__acDeck.gotoId("chat-mid");
  };
  return (
    <div className="modal-shell">
      <div className="modal-scrim" onClick={closeSettings}/>
      <div className="modal modal-lg">
        <div className="modal-head">
          <div className="modal-title">Settings</div>
          <div className="u-dim u-mono" style={{fontSize:11}}>workspace · github/agent-cockpit</div>
          <span className="spacer" style={{flex:1}}/>
          <button className="iconbtn-lg" onClick={closeSettings} title="Close (returns to chat)">{Ico.x(14)}</button>
        </div>
        <div className="modal-body-split">
          <nav className="modal-nav">
            {tabs.map(t => (
              <button key={t.id}
                className={`mnav ${tab===t.id?"active":""}`}
                onClick={()=>setTab(t.id)}>
                {t.ico(13)}<span>{t.label}</span>
              </button>
            ))}
          </nav>
          <div className="modal-pane">
            {tab==="general" && <SettingsGeneral/>}
            {tab==="usage"   && <SettingsUsage/>}
            {tab==="server"  && <SettingsServer/>}
            {tab==="instr"   && <SettingsInstr/>}
            {tab==="kb"      && <SettingsKB/>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }){
  return (
    <div className="field">
      <label>{label}</label>
      {hint && <div className="hint">{hint}</div>}
      <div className="field-input">{children}</div>
    </div>
  );
}
function Seg({ value, onChange, options }){
  return (
    <div className="seg seg-inline">
      {options.map(o =>
        <button key={o.v} aria-pressed={value===o.v} onClick={()=>onChange && onChange(o.v)}>{o.l}</button>
      )}
    </div>
  );
}

function SettingsGeneral(){
  const [theme, setTheme] = React.useState("system");
  const [send, setSend]   = React.useState("ctrl");
  return (
    <div className="pane">
      <h3 className="pane-title">General</h3>
      <Field label="Appearance" hint="Theme follows your OS by default. Override here — both themes are fully designed.">
        <Seg value={theme} onChange={setTheme} options={[
          {v:"system",l:"System"},{v:"light",l:"Light"},{v:"dark",l:"Dark"}]}/>
      </Field>
      <Field label="Send behavior" hint="How Enter behaves inside the composer. Shift+Enter always inserts a newline.">
        <Seg value={send} onChange={setSend} options={[
          {v:"enter",l:"Enter to send"},{v:"ctrl",l:"⌘/Ctrl+Enter to send"}]}/>
      </Field>
      <Field label="Default backend" hint="Used when starting a new conversation. Per-conversation override stays.">
        <div className="sel">Claude Code {Ico.chevD(12)}</div>
      </Field>
      <div className="grid-2">
        <Field label="Default model"><div className="sel">opus-4.1 {Ico.chevD(12)}</div></Field>
        <Field label="Default effort"><div className="sel">high {Ico.chevD(12)}</div></Field>
      </div>
      <Field label="Tab favicon status" hint="Favicon mirrors the active conversation's state while this tab is inactive.">
        <label className="toggle"><input type="checkbox" defaultChecked/><span className="tgl"/><span>Enabled</span></label>
      </Field>
      <div className="pane-foot">
        <span className="u-dim u-mono" style={{fontSize:11}}>v2.8.0 · local · 127.0.0.1:4173</span>
        <span style={{flex:1}}/>
        <button className="btn ghost">Restore defaults</button>
        <button className="btn primary">Save</button>
      </div>
    </div>
  );
}

function SettingsUsage(){
  const days = [32,18,44,29,62,51,73,40,58,81,66,48,90,72];
  const max = Math.max(...days);
  return (
    <div className="pane">
      <h3 className="pane-title">Usage & cost</h3>
      <div className="stat-grid">
        <div className="stat"><div className="lbl">Today</div><div className="num">$3.42</div><div className="sub u-dim">18.4k in · 9.1k out</div></div>
        <div className="stat"><div className="lbl">This week</div><div className="num">$28.17</div><div className="sub u-dim">142k tokens</div></div>
        <div className="stat"><div className="lbl">Month</div><div className="num">$94.03</div><div className="sub u-dim">7 conversations</div></div>
        <div className="stat"><div className="lbl">Avg · run</div><div className="num">$0.41</div><div className="sub u-dim">2:08 runtime</div></div>
      </div>

      <div className="pane-block">
        <div className="pane-block-head">
          <span>Last 14 days</span>
          <span className="spacer"/>
          <span className="seg seg-inline"><button aria-pressed="true">Cost</button><button>Tokens</button><button>Runs</button></span>
        </div>
        <div className="bars">
          {days.map((v,i)=>(
            <div key={i} className="bar" style={{height: `${(v/max)*100}%`}} title={`Day ${i+1}: $${v/10}`}/>
          ))}
        </div>
      </div>

      <div className="pane-block">
        <div className="pane-block-head"><span>By conversation</span></div>
        <table className="tbl">
          <thead><tr><th>Conversation</th><th>Workspace</th><th>Tokens</th><th>Cost</th></tr></thead>
          <tbody>
            <tr><td>KB search performance</td><td className="u-mono u-dim">agent-cockpit</td><td>42.1k</td><td>$1.84</td></tr>
            <tr><td>Dark mode toggle plan</td><td className="u-mono u-dim">agent-cockpit</td><td>18.2k</td><td>$0.72</td></tr>
            <tr><td>Refactor auth middleware</td><td className="u-mono u-dim">agent-cockpit</td><td>63.5k</td><td>$2.41</td></tr>
            <tr><td>Azure cross-region inference</td><td className="u-mono u-dim">Daron-Life-Gen</td><td>11.0k</td><td>$0.48</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsServer(){
  return (
    <div className="pane">
      <h3 className="pane-title">Server</h3>
      <Field label="Local address">
        <div className="input-ro u-mono">http://127.0.0.1:4173</div>
      </Field>
      <Field label="Tunnel" hint="Expose the cockpit over a tunnel so you can pilot your local agents from any browser.">
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <label className="toggle"><input type="checkbox" defaultChecked/><span className="tgl"/><span>Enabled</span></label>
          <div className="input-ro u-mono" style={{flex:1}}>https://daron-cockpit.tun.sh</div>
          <button className="btn ghost">{Ico.copy(12)}</button>
        </div>
      </Field>
      <Field label="Auth" hint="Require a passcode for tunnel access. Local access remains unauthenticated.">
        <div className="input-ro u-mono">••••••••  <span className="u-dim" style={{marginLeft:10}}>6/6</span></div>
      </Field>
      <div className="pane-block">
        <div className="pane-block-head"><span>Status</span></div>
        <div className="card-row"><span className="dot-ok"/><span>API</span><span className="spacer"/><span className="u-mono u-dim">9ms · 127.0.0.1</span></div>
        <div className="card-row"><span className="dot-ok"/><span>WebSocket</span><span className="spacer"/><span className="u-mono u-dim">connected · 4 clients</span></div>
        <div className="card-row"><span className="dot-warn"/><span>Backend · Claude Code</span><span className="spacer"/><span className="u-mono u-dim">rate limit 82%</span></div>
        <div className="card-row"><span className="dot-ok"/><span>Storage · data/</span><span className="spacer"/><span className="u-mono u-dim">2.1 GB · 2.8k files</span></div>
      </div>
      <div className="pane-foot">
        <button className="btn ghost">Restart server</button>
        <span style={{flex:1}}/>
        <button className="btn">Export config</button>
      </div>
    </div>
  );
}
function SettingsInstr(){
  return (
    <div className="pane">
      <h3 className="pane-title">Workspace instructions</h3>
      <Field label="Appended to every conversation" hint="These stay local to this workspace. Combine with the agent's built-in system prompt.">
        <textarea className="ta" rows={12} defaultValue={`Prefer TypeScript. Never edit files under \`vendor/\` or \`dist/\`.\nAlways run \`pnpm typecheck\` before claiming a task is done.\nWhen making UI changes, keep the sidebar width at 260px — layout math depends on it.`}/>
      </Field>
      <div className="pane-foot">
        <span className="u-dim u-mono" style={{fontSize:11}}>saved 2m ago · stored at <code>data/workspaces/agent-cockpit/instructions.md</code></span>
        <span style={{flex:1}}/>
        <button className="btn">Save</button>
      </div>
    </div>
  );
}
function SettingsKB(){
  return (
    <div className="pane">
      <h3 className="pane-title">Workspace KB &amp; memory</h3>
      <div className="pane-block">
        <div className="pane-block-head"><span>Knowledge base</span></div>
        <div className="kv-list">
          <div><span>Files</span><b>204</b></div>
          <div><span>Entries</span><b>433</b></div>
          <div><span>Topics</span><b>163</b></div>
          <div><span>Cross-topic links</span><b>85</b></div>
          <div><span>Last digest</span><b className="u-mono">14:03 · cycle 2</b></div>
        </div>
      </div>

      <Field label="Digest CLI">
        <div className="sel">Claude Code {Ico.chevD(12)}</div>
      </Field>
      <div className="grid-2">
        <Field label="Digest model"><div className="sel">claude-4.1 {Ico.chevD(12)}</div></Field>
        <Field label="Digest effort"><div className="sel">high {Ico.chevD(12)}</div></Field>
      </div>
      <div className="grid-2">
        <Field label="Dreaming CLI"><div className="sel">Claude Code {Ico.chevD(12)}</div></Field>
        <Field label="Dreaming effort"><div className="sel">high {Ico.chevD(12)}</div></Field>
      </div>
      <Field label="Convert PPTX slides to images" hint="Uses LibreOffice if installed. Off by default.">
        <label className="toggle"><input type="checkbox" defaultChecked/><span className="tgl"/><span>Enabled</span></label>
      </Field>
      <div className="pane-foot">
        <button className="btn ghost danger">{Ico.trash(12)} Reset memory</button>
        <span style={{flex:1}}/>
        <button className="btn">Save</button>
      </div>
    </div>
  );
}

window.Settings = Settings;
