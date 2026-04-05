# Backend Comparison

Agent Cockpit supports multiple CLI backends. Not all backends expose the same metadata, so some features behave differently depending on which backend you use.

| Feature | Claude Code | Kiro | Notes |
|---------|------------|------|-------|
| Token usage tracking | Yes | No | Claude Code reports input, output, and cache token counts. Kiro does not expose token-level metrics; it reports credits and context usage percentage instead. |
| Cost (USD) | Yes | No | Claude Code provides per-message USD cost. Kiro uses a proprietary credits system that is not convertible to USD. |
| Integration protocol | Direct CLI spawn | ACP (JSON-RPC 2.0) | Claude Code is spawned as a standalone CLI process per message. Kiro runs as a persistent ACP server with bidirectional JSON-RPC communication. |
