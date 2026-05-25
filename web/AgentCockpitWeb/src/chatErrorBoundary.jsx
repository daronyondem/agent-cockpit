import React from 'react';

export class ChatErrorBoundary extends React.Component {
  constructor(props){
    super(props);
    this.state = { err: null };
    this.onReload = () => { try { window.location.reload(); } catch(e) {} };
  }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err, info){
    try { console.error('[ChatErrorBoundary]', err, info); } catch(e) {}
  }
  render(){
    if (!this.state.err) return this.props.children;
    const msg = (this.state.err && this.state.err.message) || String(this.state.err);
    return (
      <section className="main main-error">
        <div style={{ maxWidth: 520, margin: '64px auto', padding: 24, textAlign: 'center' }}>
          <h2 style={{ margin: '0 0 8px' }}>Something went wrong</h2>
          <p style={{ color: 'var(--fg-muted)', margin: '0 0 16px', fontSize: 14 }}>
            This conversation failed to render. Try switching to another conversation, or reload the app.
          </p>
          <pre style={{ textAlign: 'left', background: 'var(--bg-muted)', padding: 12, borderRadius: 'var(--r-sm)', fontSize: 12, whiteSpace: 'pre-wrap', margin: '0 0 16px' }}>{msg}</pre>
          <button className="btn primary" onClick={this.onReload}>Reload</button>
        </div>
      </section>
    );
  }
}
