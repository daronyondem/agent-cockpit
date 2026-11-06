# Cortex Code profile, transport and runtime foundations

[← Back to index](SPEC.md)

**Implemented scope:** P1 contract/profile and P2 transport/runtime foundations,
November 6, 2026. Native runtime smoke passed on CoCo 1.2.35, macOS arm64.
**Runtime status:** No Cortex Code adapter is registered in `server.ts` yet.
CoCo is not an executable chat/processor/auth/update option in this slice.
See [the implementation tracker](design/cortex-code-implementation-plan.md),
[native evaluation](research/cortex-code-acp-evaluation.md), and
[Proposed ADR-0093](adr/0093-integrate-cortex-code-through-its-native-acp-interface.md).

## Identity and profile data

`CliHarness` recognizes `cortex-code`. Physical harness identity and the eventual
backend ID are the same. Display name is **Cortex Code (CoCo)**; the native
executable is `cortex`. A CoCo profile does not use Claude Code's protocol,
provider configuration, Ultracode mode or Codex's service tier.

The server profile type is declared in `src/types/cliProfiles.ts`, re-exported
through `src/types/index.ts`. Browser profile projection lives in
`src/contracts/responses.ts`. New profile-specific data is:

```ts
cortexCode?: {
  connection: string;
}
```

`connection` is an existing named Snowflake connection, never copied connection
contents or credentials. `cortexCode` may be omitted for an incomplete setup
draft. If present, the object must contain exactly `connection`; the name must
be a string with at least one non-whitespace character and no Unicode control
characters (Cc, U+0000–001F and U+007F–009F). Preserve the complete valid string
verbatim, including spaces and quotes, because it is a native connection name.
Runtime invocation passes it as an argument-array value, never shell text.

`src/contracts/cliProfiles.ts::parseCortexCodeProfileConfig()` owns that check
and returns only `{connection}`. Errors name fields/rules without echoing values.
Settings/draft request validation calls it for supplied CoCo configuration and
rejects `cortexCode` attached to a different harness. Legacy `vendor` is accepted
only as the existing compatibility fallback when `harness` is absent.
Unknown fields such as `account`, `user`, `password` or `token` are rejected.
No new account credentials or environment fields are added to browser responses.

`SettingsService` uses the same parser during persistence normalization, so
direct service callers cannot store unknown credential fields in this object.
A failed save leaves the existing atomic settings file unchanged. Saving a
CoCo profile preserves its existing command override and supported string env
values, strips unrelated Claude/OpenCode/protocol metadata, and retains the
connection object on edit/read/save and legacy identity migration. Existing
profile env/command behavior is unchanged; this field is not an auth store.

## Resolution, defaults and setup identities

`src/services/cliProfiles.ts` recognizes CoCo in supported-harness checks,
backend-to-harness mapping, profile backend selection and deterministic IDs:

- `server-configured-cortex-code`: generated as **Cortex Code (CoCo) (Server
  Configured)**, initially without a connection until configured.
- `setup-cortex-code-account` and `setup-cortex-code-account-*`: existing setup
  account naming convention, recognized only when `authMode === 'account'`.

`hasRequiredCliProfileConfig(profile)` is a pure completeness check: true for
existing harnesses, and true for CoCo only when the shared connection parser
succeeds. It does not check executable installation, login or adapter availability.
An unconfigured CoCo profile is retained for setup but excluded from automatic
default selection. Explicit invalid/incomplete CoCo default profile IDs are
cleared during settings normalization; other existing configured defaults and
legacy identity migration remain unchanged. A persisted legacy
`defaultBackend:'cortex-code'` can generate an incomplete server-configured
profile, but cannot promote it as `defaultCliProfileId` or execute it.

`resolveCliProfileRuntime()` rejects an incomplete or invalid CoCo selection
with **Cortex Code requires a CLI Profile with a valid named Snowflake
connection.** This applies to explicit profile selection and legacy backend-only
resolution, including absent server-configured profiles. Existing missing and
disabled profile errors take precedence. A complete profile resolves identity,
ID and profile only; the caller must still obtain a registered backend adapter.

Normal setup profiles remove `configDir` and case-insensitive `SNOWFLAKE_HOME`
env overrides in settings normalization/read migration, retaining connection
selection and unrelated env values. This prepares future shared terminal auth.
Explicit non-setup profiles retain their configured home metadata; this slice
does not certify account isolation. CoCo auth routes/jobs and
Welcome connection selection remain later phases. CLI Update label/command
maps recognize the expanded type, but CoCo is excluded from update targets and
no CoCo executable is launched by CLI Update.

## Shared execution and interaction capabilities

Server and browser `BackendCapabilities` add two optional members:

```ts
planRevision?: boolean;
oneShot?: {
  restrictedText: boolean;
  toolEnabled: boolean;
  sequential: boolean;
};
```

`stdinInput` describes unsolicited steering. A harness may set it false while
supporting pending user-question and plan responses. This foundation defines
eligibility; routing and UI use of those distinctions are later implementation.

The browser-safe `src/contracts/backendCapabilities.ts` owns the pure
`checkBackendRoleEligibility(metadata, request)` function. Its metadata input
uses only `id`, `label`, `capabilities` and `models`, allowing both server and
browser DTOs without server-only imports. Request variants are:

```ts
{ role: 'chat' | 'questionReply' | 'planReply' | 'planRevision' | 'steering' }
// or:
{
  role: 'restrictedText' | 'toolEnabled';
  sequential?: boolean;
  modality?: 'text' | 'image' | 'audio' | 'pdf' | 'video';
  modelId?: string | null;
}
```

The return is `{ok:true}` or `{ok:false, reason, message}`. Failure reasons are
`backend-unavailable`, `unsupported-role`, `unsupported-sequential`, or the
existing media reasons `missing-backend-transport`, `missing-model` and
`missing-model-modality`.

| Request | Eligibility rule |
|---|---|
| Any request without metadata | Unavailable. Callers supply metadata from a registered adapter; this helper does not discover/launch one. |
| Chat | Present adapter metadata. This does not prove authentication or installation. |
| Question reply | `userQuestions === true`, independently of `stdinInput`. |
| Plan reply | `planMode === true`, independently of `stdinInput`. |
| Plan revision | `planMode === true` and explicit `planRevision:true`; absent flag preserves current Grok-only revision support. Explicit false overrides that fallback. |
| Steering | `stdinInput === true`. |
| Restricted text/tool-enabled one-shot | With `oneShot` present, the requested field must be exactly true. CoCo fails closed when the whole object is absent. Other existing harnesses retain legacy one-shot eligibility when it is absent. |
| Sequential one-shot | The base restricted/tool-enabled role must pass and `sequential === true`; existing harnesses with absent `oneShot` retain their legacy sequential behavior. |
| Non-text one-shot media | The role must pass, then require both the backend's modality transport and the selected/default model's explicit input capability. Unknown/Auto model modalities fail closed. |

The existing pure media helpers now live in this same browser-safe module:
`checkOneShotMediaInput`, `oneShotMediaTransports`, `selectModelOption`, and
`modelSupportsInputModality`. `src/services/backends/mediaCapabilities.ts`
remains their compatibility re-export facade. Existing upload/OCR and KB
ingestion callers keep their current media checks through that path. A missing
explicit model must not silently select a different media model.

This phase adds the shared policy but does not wire it into every processor/UI
selector. Such enforcement remains in P6/P7; no CoCo adapter is available to
bypass the gates meanwhile. The strict native zero-tool boundary is unverified,
so future CoCo metadata must explicitly deny `restrictedText` until certified.
Unknown Snowflake pricing and unsupported native goals/subagents remain outside
this foundation; token/media/goal capabilities are not inferred from model names.

## Workspace instructions

`WorkspaceInstructionStore` adds CoCo to harness labels and maps it to the
existing `agents` source, `AGENTS.md`. It adds no fourth instruction source,
CoCo-specific instruction file or managed block. CoCo is covered whenever
`AGENTS.md` exists; it is missing when only Claude/Kiro instruction sources exist.
Existing pointer creation first creates `AGENTS.md` and then covers CoCo,
Codex, OpenCode and Grok together. Existing files/user content are not overwritten.
Compatibility status lists CoCo without implying runtime availability.

## Native transport and runtime ownership

P2 introduces four independent CoCo modules under `src/services/backends/`:
`cortexProtocol.ts` owns JSONL RPC, `cortexProcess.ts` owns descendant cleanup,
`cortexRuntime.ts` owns executable/environment/startup and a single session,
and `cortexSessions.ts` owns conversation leases, discovery and generations.
They do not import Grok/Kiro implementations. Domain wire/config/identity shapes
live in declaration-only `src/types/cortex.ts` and the server type barrel.
These are internal foundations; no adapter is registered, no routes are added,
and no new runnable capabilities are advertised yet. Event/interactions/model
mapping is P3; durable ChatService, external-session persistence and plugin
integration remain P5. The native runtime API is not a tool-free processor.

### Executable, environment and startup

`resolveCortexRuntime(options)` requires an enabled CoCo profile with the P1
validated connection, a workspace ID and cwd. It resolves cwd to an absolute
path, uses the profile command override or `cortex`, and invokes the existing
POSIX CLI command resolver (PATH and common install locations). The discovered
executable is pinned to an absolute path. Its real path, size and mtime are part
of the runtime fingerprint, so replacing the native install invalidates reuse.
An invalid/missing executable fails without echoing its path or profile values.
Windows runtime launch is explicitly refused in this phase. macOS arm64 is the
native acceptance baseline; Linux launch code remains uncertified.

The child receives the server environment plus profile overrides. Force
`CORTEX_ENABLE_MEMORY=0`, `CORTEX_ACP_TEST_MODE=0`, and `CORTEX_OAUTH_MANUAL=1`.
The first disables managed native memory; the second prevents fake-agent mode;
the third prevents unexpected browser opening. Normal terminal auth is retained.
Setup account profiles ignore configDir and profile env keys matching
`SNOWFLAKE_HOME` case-insensitively, preserving the server's shared home.
Explicit non-setup configDir expands `~` and maps to absolute `SNOWFLAKE_HOME`;
explicit env otherwise remains intact. Auth scope never selects an executable.
An empty-home negative probe is not proof of complete two-account isolation.

Launch uses `spawn` with no shell, detached POSIX process ownership and three
piped streams. Exact argv is:

```text
acp serve -c <literal connection> -w <absolute cwd>
  --only-explicit-plugins --only-explicit-skills --only-explicit-mcp-servers
  [--plugin-dir <absolute private directory>]
```

The pluginDir hook accepts a future runtime-owned directory; P2 does not create
or inject MCP plugins. ACP initialization sends protocolVersion 1, clientInfo
`{name:'agent-cockpit',version:'1'}`, and clientCapabilities with file read/write
and terminal all false. Reject other negotiated protocol versions. Do not call
the native no-op `authenticate` handler. Startup requests have a 45-second
deadline. Actual auth requires successful inference, not initialize/session/new.

`cortexVersion` runs the same executable with `--version`, a 20-second timeout
and 64 KiB output limit. Parse `Cortex Code v<semver>`; never use the agentInfo
version (1.0.0 in the tested binary). P2 reports the discovered version and does
not claim compatibility certification for untested versions. Do not prepend
`--no-auto-update`: in 1.2.35 that selects terminal behavior. The verified ACP
dispatcher exits before the normal updater, and explicit plugin discovery
suppresses managed plugin updates. Discovery switches omit ambient plugins,
global skills and user MCP; bundled/project skills remain. This is not a sandbox.

### JSONL and reverse requests

`CortexAcpClient` decodes split UTF-8 and multiple newline frames, ignores blank
lines, and limits each complete or buffered frame to 32 MiB. It requires a
JSON-RPC 2.0 object: method frames have object params when present and no
result/error; response frames have a valid ID and exactly one of result/error.
Errors require an integer code and string message. Malformed JSON/envelopes,
terminal output and oversized frames terminate the runtime without echoing
input. Client requests use incrementing numeric IDs; reverse requests preserve
their exact string/number IDs including 0 in a separate pending set. A response
with string ID `"1"` cannot complete client request 1. Unknown late responses are
ignored. RPC errors preserve code/message/data as server-only `CortexRpcError`
for later version-specific classification; they do not alone kill the transport.

Subscribers return true to claim a reverse request. The first owner wins;
unclaimed requests receive -32601 even when notification subscribers exist.
`respond`/`reject` accept an outstanding ID once and return false after ownership
ends. Duplicate outstanding reverse IDs or subscriber exceptions fail closed.
No permissions are implicitly approved by these foundations.

Timeout closes the whole runtime because tools may still be running. It rejects
all pending RPCs, clears reverse ownership/listeners and performs cleanup once;
there is no retry. EOF (including a truncated final frame), stdout close, pipe
errors, spawn failure and process exit do the same. Exit is observed separately
from stream close because descendants may retain stdout. `closed` resolves to
the terminal Error; `close()` returns the idempotent cleanup Promise. Diagnostics
drain stderr and expose only byte count plus a login-prompt boolean. A private
2 KiB matching tail is discarded on close. Raw stderr, malformed frames, env,
connection names, OAuth URLs and credentials are never logged by these modules.

### Sessions, cancellation and generations

`CortexSessions.acquire(conversationId, options)` reserves ownership before its
first await. A second acquire for an active conversation is rejected; independent
conversations can start concurrently. Callers must release the acquired runtime
in their turn's finally block. There is no automatic prompt queue here; existing
ChatService queuing is connected later. Reuse requires an identical SHA-256
fingerprint of executable identity, exact argv, sorted effective env, profile ID,
workspace ID and caller-supplied instruction/plugin `contextKey`. Sensitive
values occur only as inputs to an unlogged digest. Profile, connection, cwd,
workspace, env, executable or managed-context changes close the old session and
spawn another. A changed requested native session ID also invalidates reuse.

Preparation sends `session/new {cwd,mcpServers:[]}` or
`session/load {sessionId,cwd,mcpServers:[]}`, retains the native ID, and stores
raw configOptions. Notification replay during load is suppressed at the runtime
subscription boundary; reverse requests still need an explicit owner. No native
missing-session recovery or interrupted-prompt replay is implemented here.
`discover` uses a unique temporary lease and closes it after returning version
and raw configOptions; each call uses its own profile. No global catalog cache,
stale-model fallback or model mapping exists in P2. Catalog/startup failures
reject. Discovery or session creation does not establish authentication.

`CortexRuntime.prompt` requires preparation and permits one pending prompt.
The default deadline is 300 seconds; callers can override it. `cancel()` sends
the `session/cancel` notification and waits up to 3 seconds for prompt settlement.
A healthy completion preserves the session; rejection or an unresponsive CLI
terminates the runtime and its owned processes. Interrupted work is never retried.
Idle close requests `session/close` with a 2-second deadline, then always tears
down the transport. Closing is idempotent and forbids new prompts. Busy close
terminates directly rather than waiting for a graceful idle response.

`reset` deletes ownership before disposal. `evictIdle(idleMs,now)` closes only
released leases; P2 exposes the operation without installing an idle scheduler.
`shutdown` increments the generation, clears ownership and disposes all current
entries. A late version probe/startup cannot reinsert an old entry: it closes
as soon as a client/runtime appears. Initialization/session failures also close.
Shutdown is reusable, not a permanent disabled state. The eventual adapter's
`shutdown()` will delegate here; a lifecycle-only test adapter verifies the real
`BackendRegistry.shutdownAll()` boundary without registering CoCo in server.ts.

### Owned process cleanup

The POSIX scope samples `ps -axo pid=,ppid=,pgid=,lstart=` every 250 ms. Each
enumeration has a 750 ms deadline and 8 MiB bound. It retains PID/start identities
for the root and transitive children, including children in detached sessions,
and continues tracking children of observed owned descendants after root exit.
Only matching current identities can be signalled. A whole process group is
signalled only when its current leader is verified as owned; otherwise signal
matching members individually. Reused PIDs and unrelated siblings are excluded.
Stop is awaitable/idempotent: send TERM, poll up to 2 seconds, then KILL remaining
owned work and poll up to 1 second. Surviving counts are logged without command
or account data. Enumeration failure during stop falls back only to the live
child's root group/direct kill, never remembered descendant PIDs.

This is userspace cleanup, not OS containment. Descendants that detach and lose
all observed ancestry between snapshots can escape tracking, and lstart has the
platform's timestamp precision. Native evidence deliberately waits for ownership
observation before killing the root. Full finalization/background-delegation
policy remains a later release gate; do not infer that P2 supports subagents.

## Verification and client impact

- `test/cortexProfiles.test.ts`: connection request validation, literal name
  preservation, credential-field rejection, profile/default/runtime resolution,
  draft persistence, direct-save atomic rejection, setup shared-home migration
  and explicit-home retention.
- `test/backendCapabilities.test.ts`: shared role/interaction eligibility,
  fail-closed CoCo processor policy, legacy behavior, sequential and model/media
  checks; existing `test/mediaCapabilities.test.ts` verifies the facade behavior.
- `test/chatService.workspace.test.ts`: CoCo coverage and shared pointer repair
  without overwriting user instructions.
- Existing settings/auth/CLI update/contract suites protect other harnesses;
  CLI update tests explicitly verify no target/command for CoCo profiles yet.
- `test/cortexProtocol.test.ts`: split/large/multiple frames, exact ID namespaces,
  reverse ownership, malformed/oversized frames, timeout, EOF/pipe/exit failures,
  RPC error metadata, listener failure and private stderr diagnostics.
- `test/cortexRuntime.test.ts`: exact invocation/version, shared auth resolution,
  fingerprint changes, load replay, prompt/cancel/close ownership, profile-scoped
  discovery, startup/reset races, idle eviction and reusable registry shutdown.
- `test/cortexProcess.test.ts`: detached resistant child cleanup after root exit,
  unrelated process survival, reused identities, enumeration failure and no-PID
  spawn failure. These process tests exercise real local Node processes on POSIX.
- `scripts/probe-cortex-runtime.ts`: opt-in real runtime acceptance described in
  [testing](spec-testing.md#coco-p2-native-runtime-smoke). CoCo 1.2.35 on macOS
  arm64 passed managed/authenticated inference, cancel/subsequent turn, saved
  session load, root-exit descendant cleanup, empty-auth inference failure and
  reusable shutdown on November 6, 2026. It uses the dedicated production
  foundations, rather than Phase 0's Grok research helpers. No browser/route or
  full ChatService integration is implied by this smoke result.

Desktop/mobile receive additive type fields and share the pure contract module;
no composer/setup controls, mobile assets, PWA metadata or browser interaction
behavior changes in this phase. Existing frontend typechecks must remain valid.
Native CLI compatibility suites are not replaced by these foundation tests.
