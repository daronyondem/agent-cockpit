# Cortex Code (CoCo) ACP evaluation

**Evaluated:** 2026-11-02, with UTC evidence dated 2026-11-03.
**Repository revision:** `11d14825e955f6c83364c3917558b4d3068a4bac`.
**CLI:** Cortex Code `1.2.35`, distribution
`1.2.35+191333.f82de3d91715`, from Snowflake's stable installer.
**Platform:** macOS 26.5 (25F71), arm64; Node 26.0.0 for Cockpit's MCP shims.
**Status:** Authenticated native protocol evaluation. Cortex Code is **not yet
an implemented Agent Cockpit harness**. These results do not establish
desktop/mobile integration or native Windows/Linux compatibility.

Implementation work is tracked separately in the proposed
[CoCo harness implementation plan](../design/cortex-code-implementation-plan.md).

CoCo can support a dedicated Cockpit adapter through `cortex acp serve`.
Real requests verified chat, thinking, tool events, file operations, shell
execution, questions, revised plan approval, image input, persisted-session
reload, cancellation, context instructions, and Cockpit's MCP shims. There
are material differences from Kiro/Grok ACP: model/effort configuration uses
`configOptions`, incoming ACP `mcpServers` is ignored, and some terminal
failures arrive as ordinary text with an `end_turn` result.

Core integration is feasible. Strict tool-free processors, crash cleanup,
failure classification, account isolation beyond the negative fixture, and
application/browser integration still require implementation and verification.

## Evidence and scope

The probes ran against a real authenticated Snowflake connection and model
service. File operations used synthetic temporary workspaces, not the project
checkout. Inference primarily used the account-advertised
`claude-sonnet-4-6` model with low effort; the initial smoke request used `auto`.
Other advertised models were not individually certified.

Temporary Python probes and private JSONL wire logs are retained locally at
`/tmp/cockpit-coco-evaluation.f5tGSY`. They are research tools, not a retained
repository e2e suite or part of normal CI. The probe files are `probe.py`,
`core.py`, `interactions.py`, `advanced.py`, `lifecycle.py`, `mcp.py`,
`restrictions.py`, `guards.py`, `isolation.py`, `instructions.py`, and
`verify.py`. The local verifier checked 32 assertions across positive results
and expected compatibility gaps; this is not a claim that all capabilities passed.
Their account-specific configuration and raw logs must not be published.
No user credentials, OAuth codes, account identifiers, or production Memory/KB
records are included in this report.

The Memory/KB checks used the **unmodified production stdio shims**
`src/services/memoryMcp/stub.cjs` and
`src/services/kbSearchMcp/stub.cjs`, backed by temporary localhost HTTP fixtures
that validated their token headers. They establish native tool discovery,
execution, argument forwarding, and result delivery. They do not establish
the real Memory processor, KB databases, digestion/dreaming, Workspace Context
maintenance, or Routine service workflows.

## Verified capability matrix

| Area | Result | Evidence and boundary |
|---|---|---|
| Shared authentication | Passed | Remote-browser OAuth completed; a fresh process reused saved credentials; real inference subsequently passed. |
| Basic text | Passed | Exact `COCO_READY` response and `end_turn`. |
| Models and effort | Passed for tested selections | Model catalog arrived in session `configOptions`; model and `thought_level` changes were accepted, followed by successful inference. |
| Thinking | Passed | Native `agent_thought_chunk` updates during file, question, and planning requests. |
| Native tools | Passed | Read a random fixture value, wrote its exact contents, and verified the result with shell execution. |
| Questions | Passed | Single selection, two sequential questions in one tool invocation, and a free-text answer returned through native reverse RPCs. |
| Plans | Passed | Approval executed the fixture; rejection with feedback produced a revised plan and a second approval request. The output file was absent at both decisions and present only after approval. |
| History reload | Passed | A fresh process loaded a prior session and correctly recalled a random nonce not repeated in the new prompt. |
| Cancellation | Passed | `session/cancel` returned `cancelled` in about one second, stopped the sleeping shell fixture, prevented its later output, and allowed a subsequent turn. |
| Abrupt root exit | Cleanup gap | Killing the CLI root alone left its shell descendant alive. The probe explicitly cleaned it up. Later history reload succeeded without retrying the interrupted command. |
| MCP through ACP session fields | Failed | `session/new.mcpServers` was accepted but its tools were unavailable. Installed `newSession`/`loadSession` code does not consume that field. |
| MCP through an explicit native plugin | Passed | Memory note/search and KB `search_entries` reached the real shims and authenticated HTTP fixtures; both opaque search values reached the answer. |
| MCP credential replacement | Passed | A fresh process loaded the earlier native session with a new fixture endpoint/token and successfully used the replacement credentials. |
| Image input | Passed on tested model | Explicit ACP PNG content correctly identified a blue square and a green circle. |
| Workspace instructions | Passed | A synthetic `AGENTS.md` pointer caused the agent to read a separate context markdown file and return its hidden random marker. |
| Restricted text execution | Partial | Text worked; an explicit unmatched allowlist blocked tested reads/writes, but tool declarations and calls remained. A universal `*` disallow rule did not disable tools. |
| Empty auth/config home | Negative inference passed | Session creation succeeded, but inference returned a connection error when `SNOWFLAKE_HOME` pointed to an empty directory. Session creation alone is not an authentication check. |
| Session close | Passed | `session/close` returned successfully. |

Native goal control, subagent execution/demultiplexing, mid-turn steering,
audio/video/PDF support, billing reconciliation, two real accounts,
credential expiry/refresh, and native Windows/Linux behavior were not certified.

## Authentication and future Cockpit setup

The user successfully authenticated from another machine using CoCo's own
manual OAuth support. The approved product direction is to offer this mechanism
in future Agent Cockpit setup, alongside the harness integration.

1. Install the official CLI and create/select a normal Snowflake connection.
   The tested connection used `authenticator = "OAUTH_AUTHORIZATION_CODE"`
   and `client_store_temporary_credential = true`.
2. Launch the interactive CLI with `CORTEX_OAUTH_MANUAL=1`, for example:

   ```sh
   CORTEX_OAUTH_MANUAL=1 cortex --no-auto-update -c <connection_name>
   ```

3. CoCo prints a Snowflake authorization URL using PKCE S256 and a loopback
   callback. Open that URL in the user's browser on another machine.
4. After sign-in, the browser redirects to
   `http://127.0.0.1:<port>/?code=...&state=...&iss=...`. Failure to load that
   page on the other machine is expected. Copy the complete URL back to the
   waiting CLI.
5. CoCo delivers the redirect to its local callback listener, exchanges the
   code, and completes login. A fresh CLI process reused the saved credentials.

The default browser wait was **120000 ms**. The first returned redirect arrived
after that attempt expired. Setting `browserActionTimeout = 600000` in the
selected `connections.toml` section gave the successful attempt a ten-minute
window. The installed CLI accepts this field and passes it to the Snowflake
SDK. Do not reuse the code/state from an expired attempt.

Future setup should expose a copyable authorization URL and a field for the
returned redirect, keep the native login process alive, and support cancellation
and retry. Match the returned loopback port and state to the active job; do not
forward arbitrary pasted URLs. Keep codes and credential material out of saved
job history and logs. Normal setup should reuse the terminal's Snowflake
configuration/authentication rather than silently creating an isolated account
home. Explicit account-profile isolation needs separate tests.

Do not report success from `initialize`, `authenticate`, or `session/new` alone.
The installed ACP `authenticate` handler is a no-op, and an empty-config process
could create a session before failing its first inference. Verify the native
Snowflake connection and actual request capability from a fresh process. Account
model access and successful login are separate conditions.

An interrupted native login also left an account-scoped `oac_login_*.lock` file
that delayed the next process. A stale lock was removed only after proving its
recorded owner process had exited; a later attempt also recovered a stale lock
itself. Never remove a live login's lock or run competing setup jobs for the same
connection without evaluating native coordination.

## Transport, configuration, and event mapping

Use the native command order:

```sh
cortex acp serve -c <connection_name> -w <temporary_or_workspace_directory>
```

Putting `--no-auto-update` **before** `acp serve` in the tested build selected
the regular terminal path and emitted terminal escape sequences on stdout.
The clean `cortex acp serve ...` invocation negotiated ACP version 1. The
adapter must keep stdout exclusively for protocol frames. The reported
`agentInfo.version` was `1.0.0`, so compatibility evidence must use
`cortex --version` and the installed distribution version instead.

`initialize` advertised `loadSession`, session list/close/fork, and image prompt
support. `session/new` and `session/load` returned `configOptions`, including
`model`, `mode`, `thought_level`, and `_restricted_session_scope`. The tested
account returned 33 model/Auto entries; availability is account-specific.

Set values through:

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "<native session id>",
    "configId": "thought_level",
    "value": "low"
  }
}
```

The tested mode values were `standard`, `plan`, and advertised `bypass`.
The effort catalog included `auto`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max`; only low effort was exercised explicitly. The Kiro-style
`session/set_model` request returned JSON-RPC `-32601` (method not found).
Do not expose native SQL restricted-scope changes as ordinary composer effort
or model changes: the option describes shared connection privileges.

Observed `session/update` variants included `agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
`available_commands_update`, `session_info_update`, and `usage_update`.
Tool calls carry their native identifier, title, kind, status, and raw input;
completion updates include content and raw output. File-edit updates can carry
diff blocks, but the probes primarily exercised new-file writes rather than
certifying every edit/diff variant.

Questions and plan decisions use reverse `session/request_permission` RPCs,
including request ID **0**. Preserve the request ID until a decision arrives.
Question requests include `_meta.questionIndex` and `_meta.totalQuestions`;
free-form options contain `_meta.freeForm`. Return a selection in
`result.outcome`, with optional `outcome._meta.freeFormText` for typed input.
The observed wire bridge selected one option per question; multi-select
semantics were not verified.

Plan confirmation has `toolCall.kind: "switch_mode"`, with `proceed` and
`keep_planning` option IDs. Revision feedback also uses
`outcome._meta.freeFormText`. The preceding plan update carries
`_meta.kind: "plan_document"` and `_meta.planDocument` with the complete plan.
Approval-request tool IDs differ from the native `exit_plan_mode` activity ID;
question IDs likewise differ from the underlying tool activity. Keep interaction
ownership separate from the tool-event map.

`session/load` replayed user/assistant/tool history before the next turn.
Suppress that replay when restoring an existing Cockpit transcript, then stream
only the new response. The nonce-recall probe confirmed actual continuity.
History reload does not establish in-flight turn reattachment; leave that
capability unsupported.

## MCP injection without changing user configuration

CoCo 1.2.35 ignored ACP `mcpServers` during new/load. A temporary explicit
native plugin worked, using `--plugin-dir <path>` together with
`--only-explicit-plugins`, `--only-explicit-skills`, and
`--only-explicit-mcp-servers` for the isolated probes.

The plugin had `.cortex-plugin/plugin.json` with `name`, `version`, and an
inline `mcpServers` map. Each stdio server used the existing Cockpit shim,
Node's executable path, and an environment object. The fixture's bearer token
was inherited through a runtime environment variable and referenced as
`${COCO_TEST_TOKEN}` in the plugin file rather than embedded in it.
Normal deployment should preserve separate Memory/KB token scopes.

CoCo prefixed names with the plugin and server identity, for example
`mcp__cockpit-probe-agent-cockpit-memory__memory_search`. It discovered deferred
tools through `tool_search`, and could execute them through
`direct_tool_calling`. Normalize both wrappers and nested native tool events;
do not mistake the wrapper for a second independently billed operation.

All three expected HTTP operations reached the fixture with valid token
headers. The marker responses reached the assistant. Repeating with a new
token/endpoint passed, including loading the earlier native session in a fresh
process. This gives an empirically supported refresh strategy: respawn with
updated process/plugin configuration and load the saved native session. Do not
assume `session/load.mcpServers` can refresh a resident process.

This approach uses CoCo's native MCP support and existing Cockpit shims; it does
not require a Cockpit-side MCP aggregator. Evaluate the owning modules and ADR
before implementing temporary-plugin lifecycle and per-conversation refresh.

## Usage, failures, and processor boundaries

Successful `session/prompt` results included `usage.inputTokens`,
`outputTokens`, `cachedReadTokens`, `cachedWriteTokens`, and `totalTokens`.
In observed responses, total tokens included all four components. Keep their
cache categories separate and avoid double counting intermediate updates.
`usage_update` notifications contained context-size/used snapshots, not those
billing counters. No dollar cost or account-charge reconciliation was verified;
Snowflake billing must not inherit direct Anthropic/OpenAI prices merely from
the selected model name.

Two failures demonstrated that `stopReason: "end_turn"` is insufficient:

- A service HTTP 408 during the first plan-revision probe appeared only as an
  `agent_message_chunk` containing `Error: Error: API error 408...`; the prompt
  result contained `end_turn` without usage. An independent synthetic revision
  probe subsequently passed both decisions and file verification.
- Empty `SNOWFLAKE_HOME` allowed session creation, then produced a connection
  error as an ordinary message chunk with `end_turn` on inference.

These cases supplied no dedicated structured terminal error frame. An adapter
needs a deliberate, version-tested failure policy. A rejected plan also produces
a failed tool update during an otherwise successful revision, so treating every
failed tool as a terminal backend error would be wrong.

For restricted calls, `--disallowed-tools "*"` did **not** remove native tools:
the model successfully wrote the synthetic forbidden file after the fixture
client approved its request. The installed matcher treats complete tool names
differently from argument globs. An explicit unmatched `--allowed-tools` entry
blocked tested read/write operations, but `direct_tool_calling` still executed
and read/write calls were still emitted as failed activities. This is not a
verified zero-tool definition path.

Keep CoCo unavailable for strict tool-free Memory/other processors until a
native solution is validated, including native/deferred tools, MCP, hooks,
slash commands, and sequential calls. A text-wrapped slash-command fixture
produced text without creating its requested file, but that single case is not
general slash-command containment evidence. Tool-enabled chat and the MCP
results above do not settle this processor boundary.

## Implementation and verification gates

- Add a dedicated `cortex-code` harness/backend with focused transport, event,
  runtime, interaction, model, usage, and plugin-configuration modules. Keep
  `ChatService` and browser-safe stream contracts as the existing boundaries.
- Add connection-aware profiles, setup jobs using the verified native OAuth
  handoff, executable/version detection, and future installer/update support.
  Preserve normal shared auth; validate real expiry and two-account isolation.
- Supervise owned process groups/descendants even after the root exits.
  Healthy cancellation passed; root-only termination did not. Never
  automatically retry interrupted tool work.
- Verify real Cockpit persistence, token expiry/renewal, Memory/KB governance,
  tool-enabled one-shots, and Workspace Context/Routine service execution after
  an adapter exists. The current HTTP fixtures are not those workflows.
- Add a pinned opt-in native compatibility suite with framing/error fixtures,
  replay suppression, pending-interaction cleanup, usage completeness, and
  process ownership tests. Current research probes do not replace it.
- Exercise desktop and mobile profile/model/effort selection, OAuth URL copying
  and redirect submission, questions/free text, plan revision, abort/reload,
  artifacts, and usage. No current PWA behavior or built assets changed in this
  evaluation; supported-client parity remains an implementation requirement.
- Keep goals, subagents, untested media, active-turn reattachment, and strict
  tool-free processors gated until their behavior is actually verified. Revisit
  ADR and `AGENTS.md` requirements before a cross-subsystem implementation PR.

## Phase 0 follow-up — 2026-11-05

The implementation preparation is now recorded in
[Proposed ADR-0093](../adr/0093-integrate-cortex-code-through-its-native-acp-interface.md).
Seven [sanitized native protocol excerpts](../../test/fixtures/cortex/1.2.35/README.md)
preserve initialization/configuration, tools/usage, questions/free text,
revised plans, load replay and terminal error-as-text shapes. These excerpts
are selected evidence, not a complete mock agent or integrated adapter suite.

An opt-in reproducible probe now lives at
[`scripts/probe-cortex-phase0.ts`](../../scripts/probe-cortex-phase0.ts):

```sh
CORTEX_PHASE0=1 CORTEX_TEST_CONNECTION='<existing named connection>' \
  ./node_modules/.bin/tsx scripts/probe-cortex-phase0.ts
```

Optional `CORTEX_TEST_COMMAND` and `CORTEX_TEST_MODEL` select the executable and
model. The probe requires real 1.2.35 on macOS, makes real inference requests,
uses the selected connection's saved credentials, writes only synthetic fixture
workspaces, and emits a private summary report under the OS temporary directory.
It uses the existing Grok RPC/process helpers only as research scaffolding;
there is no production CoCo-to-Grok dependency or registered CoCo adapter.

The successful run at `2026-11-05T23:28:51Z`–`23:30:10Z` used Node 26.0.0,
macOS arm64, CoCo 1.2.35, revision
`083d4e360b13a96bc912aa076d9778141aa0645e` with the preflight files uncommitted.
Private summary: `cockpit-cortex-phase0-tW3jZ3/report.json` under the OS temporary
directory. The runner prints the complete local evidence path.

| Check | Result | Consequence |
|---|---|---|
| Direct ACP startup and workspace instructions | Clean JSON-RPC, no stderr/login prompt, exact instruction marker and successful real inference | Native launch is suitable for the dedicated adapter. |
| Native cancel and next turn | `cancelled`, sleeper exited, subsequent exact response succeeded, delayed file absent past its intended write time | Healthy cancellation/session reuse reconfirmed. The recorded 5136 ms includes the follow-up request, not cancellation latency alone. |
| Forced root exit with descendant ownership | Existing process-scope pattern stopped the native sleeper after root `SIGKILL`; unrelated process survived; delayed file remained absent past its write time | Research validates the macOS cleanup pattern; implementation still needs dedicated lifecycle acceptance. |
| Explicit unmatched tool allowlist | Tested read/write blocked, but three native tool calls emitted | Strict tool-free CoCo processors remain unavailable. |
| Empty Snowflake home | Session/configuration creation succeeded; inference returned a connection error with `end_turn`, no usage, no waiting login wizard; prompt completed in 2 ms | Verification must make a real request; classify this error instead of treating `end_turn` as success. This fixture does not simulate every expired-token path. |

Installed-source inspection corroborated the runtime policy:

- The ACP subcommand dispatcher returns before the main terminal launch/update
  path. Its handler does not accept the global auto-update option. Use the
  direct `acp serve` invocation; do not prepend `--no-auto-update`.
- `--only-explicit-plugins` skips ambient plugin discovery and the handler's
  managed-plugin auto-update call. The selected initial managed policy combines
  it with `--only-explicit-skills` and `--only-explicit-mcp-servers`, plus the
  generated Cockpit plugin when available. This intentionally limits ambient
  extensions while preserving normal Snowflake credentials; project/bundled
  skills still remain. No global user configuration was changed.
- `getToolDefinitionsForApiWithOptions` consults native `toolsEnabled`, but the
  ACP command builder does not expose that switch. Declaration policy filtering
  examines disallowed patterns, not the allowlist. Therefore an unmatched
  allowlist is not evidence that the model received zero tool definitions.

The code-path inspection is version-specific evidence, not a guarantee of future
CLI update behavior or complete hook/skill isolation. Default delegation/late
work, system-prompt envelopes, expired-token flows, other OSes, and actual
Cockpit adapter execution remain gates in the implementation plan. Phase 0
changes no desktop/mobile UI or assets.

## Official references

- [ACP support](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-acp)
- [CLI reference](https://docs.snowflake.com/en/user-guide/cortex-code/cli-reference)
- [CLI installation](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli)
- [MCP support](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-mcp)
- [Native plugin layout](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-plugins)

The installed binary and real wire behavior take precedence over assumptions
drawn from documentation for a different CLI version.
