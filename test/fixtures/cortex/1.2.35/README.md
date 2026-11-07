# Cortex Code 1.2.35 native protocol excerpts

Sanitized, ordered excerpts from real authenticated ACP probes on macOS arm64
on November 2, 2026 (some UTC capture timestamps fall on November 3).
Distribution: `1.2.35+191333.f82de3d91715`.
Later follow-up captures carry their own dates in the rows and source metadata.
See [the evaluation](../../../../docs/research/cortex-code-acp-evaluation.md)
and [the implementation plan](../../../../docs/design/cortex-code-implementation-plan.md).

These are protocol evidence, not a runnable mock agent or a complete session
recording. `direction: out` means client to CLI; `in` means CLI to client.
The `frame` member is the native JSON-RPC object. File order is wire order.
Client and reverse-request IDs occupy independent namespaces; reverse ID `0`
must not be treated as absent. Excerpts may start/end mid-session.

| File | Behavior to preserve |
|---|---|
| `session-config.json` | Initialization, native agent version mismatch, session creation, unsupported `session/set_model`, successful `session/set_config_option` |
| `file-shell.json` | Thinking, file and shell tools, ordinary allow-once reverse RPCs, progress/outcomes, context snapshots and final billing counters |
| `questions.json` | Two sequential questions in one native tool, request ID 0, options and typed free-form reply metadata |
| `plan-entry.json` | November 7, 2026 standard-chat entry permission: approve/decline enters planning, distinct from proceed/keep_planning execution approval |
| `plan-revision.json` | Rejection with feedback, failed activity during valid revision, second plan/approval, execution after approval |
| `load-replay.json` | Native history replay before load response, then an independent new prompt/result |
| `load-missing.json` | November 6, 2026 native load of a synthetic missing UUID; exact version-bound recovery classifier |
| `auth-error.json` | Missing connection reported as assistant text plus `end_turn` without usage |
| `api-error.json` | Service HTTP 408 reported as assistant text plus `end_turn` without usage |

Sanitization replaces native session/tool identities, local user/workspace paths,
account identifiers and endpoint URLs. Model option lists are sampled to Auto
and the tested `claude-sonnet-4-6`; they are not an account capability catalog.
Question text, file contents and commands were synthetic fixture tasks. Original
OAuth URLs/codes/state, credentials, connection files and raw stderr are excluded.
Token numbers remain native measurements and are not fixtures for dollar pricing.

Do not regenerate expected frames from adapter code. New version evidence must
come from real native probes with provenance, an explicit review of behavioral
differences, and a separate version directory. Temporary original captures are
private evidence and must not be committed. Runtime `cortex --version` is the
compatibility version; native ACP `agentInfo.version` is insufficient.
