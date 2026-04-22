/* global React, Sidebar */
function SidebarScreen(){
  return (
    <div className="sidebar-frame">
      <Sidebar/>
      <div className="hint">
        <h4>Sidebar — grouped by workspace</h4>
        <p className="u-dim" style={{maxWidth:340,lineHeight:1.55}}>
          Running conversations pin to the top with inline mini-progress (current tool, elapsed). Rows are fixed-height so streaming updates don't reflow the list.
        </p>
        <div className="u-mono u-dim" style={{fontSize:11,marginTop:8,lineHeight:1.7}}>
          Status dots:<br/>
          <span className="u-accent">●</span> running &nbsp; <span className="u-warn">●</span> awaiting &nbsp; <span className="u-ok">●</span> done &nbsp; <span className="u-err">●</span> errored
        </div>
      </div>
    </div>
  );
}
window.SidebarScreen = SidebarScreen;
