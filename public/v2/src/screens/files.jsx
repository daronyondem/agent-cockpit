/* global React, Ico */
function FilesScreen(){
  return (
    <div className="fx">
      <div className="fx-top">
        <span className="u-mono u-dim" style={{fontSize:11}}>Files</span>
        <span className="path">
          Desktop<span className="slash">/</span>test-workspace<span className="slash">/</span><span style={{color:"var(--text)"}}>src</span>
        </span>
        <span style={{marginLeft:"auto",display:"flex",gap:6}}>
          <button className="btn ghost" style={{padding:"4px 8px"}}>{Ico.up(12)} Up</button>
          <button className="btn ghost" style={{padding:"4px 8px"}}>{Ico.folder(12)} New folder</button>
          <button className="btn ghost" style={{padding:"4px 8px"}}>{Ico.file(12)} New file</button>
          <button className="btn primary" style={{padding:"4px 10px"}}>{Ico.up(12)} Upload</button>
        </span>
      </div>

      <div className="fx-tree">
        <div className="row folder"><span>{Ico.chevD(12)}</span>{Ico.folder(12)}<span>src</span></div>
        <div className="row indent1"><span/>{Ico.file(12)}<span>main.ts</span></div>
        <div className="row indent1 active"><span/>{Ico.file(12)}<span>SAMPLE_PLAN.md</span></div>
        <div className="row indent1"><span/>{Ico.file(12)}<span>story-themes-…md</span></div>
        <div className="row indent1"><span/>{Ico.file(12)}<span>story-thought-…md</span></div>
        <div className="row indent1"><span/>{Ico.file(12)}<span>untitled.md</span></div>
        <div className="row folder"><span>{Ico.chev(12)}</span>{Ico.folder(12)}<span>contexts</span></div>
        <div className="row folder"><span>{Ico.chev(12)}</span>{Ico.folder(12)}<span>hooks</span></div>
        <div className="row folder"><span>{Ico.chev(12)}</span>{Ico.folder(12)}<span>styles</span></div>
        <div className="row folder"><span>{Ico.chev(12)}</span>{Ico.folder(12)}<span>components</span></div>
      </div>

      <div className="fx-edit">
        <div className="fx-edit-head">
          <span className="filename">SAMPLE_PLAN.md</span>
          <span className="u-mono u-dim" style={{fontSize:10.5}}>1.4 KB · markdown</span>
          <span className="spacer" style={{flex:1}}/>
          <span className="saved dirty">● unsaved</span>
          <button className="btn ghost">{Ico.edit(12)} Read-only</button>
          <button className="btn">↓ Download</button>
          <button className="btn primary">Save</button>
        </div>
        <div className="fx-edit-body">
          <div className="line"><span className="ln">1</span><span><span className="kw"># Implementation Plan</span>: Add Dark Mode Toggle</span></div>
          <div className="line"><span className="ln">2</span><span/></div>
          <div className="line"><span className="ln">3</span><span><span className="kw">## Overview</span></span></div>
          <div className="line"><span className="ln">4</span><span>Add a dark mode toggle to app settings that persists user preference and applies theme across all pages.</span></div>
          <div className="line"><span className="ln">5</span><span/></div>
          <div className="line"><span className="ln">6</span><span><span className="kw">## Critical Files</span></span></div>
          <div className="line"><span className="ln">7</span><span>- <span className="str">src/contexts/ThemeContext.tsx</span> <span className="com"># create</span></span></div>
          <div className="line"><span className="ln">8</span><span>- <span className="str">src/hooks/useTheme.ts</span> <span className="com"># create</span></span></div>
          <div className="line"><span className="ln">9</span><span>- <span className="str">src/styles/themes.css</span></span></div>
          <div className="line"><span className="ln">10</span><span>- <span className="str">src/App.tsx</span></span></div>
          <div className="line"><span className="ln">11</span><span/></div>
          <div className="line"><span className="ln">12</span><span><span className="kw">## Phase 1</span>: Context &amp; Hook</span></div>
          <div className="line"><span className="ln">13</span><span>1. Create <span className="str">ThemeContext.tsx</span> with theme state</span></div>
          <div className="line"><span className="ln">14</span><span>2. Store current theme <span className="punc">(</span><span className="num">light</span> <span className="punc">|</span> <span className="num">dark</span> <span className="punc">|</span> <span className="num">system</span><span className="punc">)</span></span></div>
          <div className="line"><span className="ln">15</span><span>3. Persist via <span className="str">localStorage</span></span></div>
          <div className="line"><span className="ln">16</span><span>4. Expose via <span className="str">useTheme()</span> hook</span></div>
          <div className="line"><span className="ln">17</span><span/></div>
          <div className="line"><span className="ln">18</span><span><span className="kw">## Phase 2</span>: Settings toggle UI</span></div>
          <div className="line"><span className="ln">19</span><span>Render radio group: System · Light · Dark.</span></div>
        </div>
        <div className="fx-edit-foot">
          <span>Ln 12, Col 14</span>
          <span>·</span><span>UTF-8</span>
          <span>·</span><span>LF</span>
          <span style={{marginLeft:"auto"}}>Last edit · 2m ago · agent</span>
        </div>
      </div>
    </div>
  );
}
window.FilesScreen = FilesScreen;
