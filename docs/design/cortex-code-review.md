# Cortex Code implementation review

Prepared for C59, 2026-11-08. This is local review/PR preparation. No PR, push,
merge, release, production restart or new version certification is authorized
by this artifact. The branch is `feature/cortex-code-preparation`, based at
11d14825e955f6c83364c3917558b4d3068a4bac. Validation is recorded in the final
section.

## Implemented scope and ownership review

| Boundary | Review result |
|---|---|
| Harness/profile contracts | Canonical `harness:'cortex-code'`; named connection config is browser-safe; draft/incomplete profiles cannot become defaults. Models/effort remain profile-local and discovery is not auth evidence. |
| Runtime and protocol | Dedicated cortex modules, captured realpath/version, per-conversation leases, replay suppression, reusable shutdown, descendant identity cleanup and safe-boundary MCP/token refresh. No production Grok/Kiro imports or generic ACP refactor. |
| Authentication | Create-only native TOML, shared terminal credentials, native manual OAuth/PTY, exact callback generation/state/issuer/owner and fresh inference. Human remote handoff C26 and account isolation remain unclaimed. |
| Chat and clients | Existing REST/WS/storage/artifact facades; opaque decision ownership, queues/Stop/reconnect, context vs token usage, unavailable cost, scoped attachments and invocation-only OCR overrides. |
| Processors | Explicit tool-enabled selection and one deadline, no retry/replay, headless human gates fail, missing saved choices retained. C35 adds a separate verified headless strict Memory path on the exact macOS arm64 build; chat can still use another eligible processor. |
| Platform lifecycle | Optional official standalone install, narrow proven macOS update layout, passive full-bundle import checks and reserved runtime exclusions. Ubuntu preparation is not a native pass. Windows x64 runtime is implemented with simulated tests; native acceptance remains pending and install/update remain manual. |
| Compatibility and reporting | Isolated synthetic data, PM2 browser fixtures, fixed native checks, bounded deadlines/cleanup and private raw evidence. A subset pass or expected-auth failure is never full capability/auth certification. |

ADR-0099 describes these ownership boundaries, rejected alternatives and
consequences, including C54/C55/C56. It remains **Proposed** until merge under
ADR-0001's lifecycle. No superseding ADR is needed: the final implementation
keeps the original native ACP/shared-auth/strict-role scope decisions. Deferred
features require new evidence/contracts rather than implied acceptance.

## Mobile PWA review

Mobile shares the browser-safe profile/role/media/usage contracts and preserves
profile selection, current draft/attachment ownership, exact decision IDs,
queue suspension at Stop, current socket/conversation identity, history/modal
stacking and download access. Native C43–C46/C54/C55 probes cover those browser
outcomes with production assets in private PM2 fixtures. No mobile source, PWA
metadata, persisted schema or user flow changes in C56–C59; the new backend
integration guards protect both clients. Physical iOS/Android devices remain
outside acceptance. Full Jest must finish before rebuilding/browser probes.

## Residual gates

- C26: a human completes the real remote-browser OAuth handoff through Cockpit.
- C52: actual Ubuntu 24.04 x64 install/auth/user-service/cache/update/cleanup.
- C53: native Windows executable/auth/PowerShell/ConPTY/process/update acceptance.
  Runtime implementation and simulated tests are complete; other harness wrappers
  and appDir activation are unchanged. See [Windows preparation](../research/cortex-code-windows-acceptance.md).
- C56 features are explicitly deferred: native goals/subagent cards/steering,
  broader media/generation, billing and account isolation. This is a scope
  decision, not feature implementation. See [unlock criteria](../research/cortex-code-capability-decisions.md).
- macOS x64, physical devices, fresh OS-login/public-release/private-Node
  bootstrap and downloaded/new CLI versions are not implied by scoped macOS
  arm64 fixtures. Historical C49 auth failures/C51 activation drift retain
  unproven causes. No later pass retroactively closes those observations.

## Prepared PR text

Title: **Add Cortex Code CLI harness with shared Snowflake setup**

Agent Cockpit can now run Cortex Code alongside its existing CLI harnesses.
Profiles select a native Snowflake connection, reuse terminal login or use the
dedicated manual OAuth handoff, and verify saved access with fresh inference.

The dedicated ACP adapter supports durable chat, thinking/tools, questions and
revised plans, resume, delivered files and managed Memory/KB MCP. Tool-enabled
sequential processors power KB, Workspace Context, Routines and verified PNG OCR.
Desktop/mobile preserve decision, queue, Stop, reconnect, usage and attachment
ownership. CoCo cost remains unavailable. Strict Memory uses the verified
headless path on the exact macOS arm64 build; other unverified features stay gated. Optional installation, version-limited macOS updates and
full-data migration checks preserve shared auth and existing release behavior.

Validation: see the final C58 evidence below and the
compatibility specification (`docs/spec-testing.md`). Native acceptance is pinned
CoCo 1.2.35/macOS arm64, with synthetic isolated data and PM2 browser fixtures.
Routine outreach is a stub. Human OAuth and native other-platform
acceptance remain separate as listed above. No release/version bump is included.

## Final C58 validation

Completed on the 1.2.35+191333.f82de3d91715/macOS arm64/Darwin 25.5.0 baseline,
Node 26.0.0. Full source was frozen for V8 collection. Final raised-threshold
run: **180 suites / 3,005 tests passed**, three opt-in suites / 20 tests skipped.
Statements/lines 88.75% (56,049/63,153), branches 77.04% (13,372/17,356),
functions 93.94% (2,853/3,037). Floors are now 88.72 statements/lines, 77.00
branches and 93.90 functions; the full suite passed after raising them.

| Native catalog | Result | Projected report under /tmp |
|---|---|---|
| Backend: runtime/events/processors | 3/3, no omissions | `cockpit-cortex-backend-compat-KQ61M1/compatibility-report.json` |
| UI: auth/interactions/queue/usage/mobile | 5/5, no omissions | `cockpit-cortex-ui-compat-nv602C/compatibility-report.json` |
| Separate empty-auth control | 1/1 | `cockpit-cortex-auth-control-compat-yAZdSm/compatibility-report.json` |

All three fresh reports record revision 1faa675 with dirty working-tree state,
all observed processes/private PM2 drained, and unchanged native activation and
retained executable. UI builds ran after final Jest. Native current auth and
inference worked; C26's human handoff remains separate from synthetic lifecycle
checks. Share only projected reports; raw logs/settings/screenshots stay private.

C55's complete chat/KB/Context/Routine/mobile workflow 5/5 remains recorded in
`/tmp/cockpit-cortex-workflows-compat-nlmgTo/compatibility-report.json`.
`git diff --exit-code 1faa675 -- src server.ts web mobile scripts package.json`
confirmed no production runtime/client/script/package changes in C56–C59.
C55 workflow acceptance is retained rather than rerun; no fresh install/update,
new OS/private Node, cross-account or real outreach claim is added.

Root/web/mobile and strict native-script types, zero-warning lint,
maintainability, 189-route spec drift and 92 ADR checks pass. Both clients were
rebuilt; desktop JS 913.8/914 KiB and CSS 202.3/230 KiB meet budget. Added local
Markdown targets resolve. The two new integration guards passed in the focused
6-suite/53-test run and full coverage. No other harness protocol changed, and
no Codex native suite is invented as part of this validation.

C56–C59 review/preparation is complete with the four tracker items C26, C35,
C52 and C53 still open. ADR-0099 stays Proposed. PR text is ready locally;
publication, merge and release remain separate requested actions.

## C53 autonomous follow-up (2026-11-09)

Windows x64 runtime implementation and simulated-platform verification are
complete within [the preparation scope](../research/cortex-code-windows-acceptance.md).
Standalone discovery, literal hidden launch, case-insensitive env/auth ownership,
passive doctor/import/update handling and focused Windows process cleanup are
implemented. Native Windows PowerShell/ConPTY/auth/process/install/update
acceptance is still pending; C53 stays unchecked. Windows install/update remain
manual. No other harness wrapper, appDir activation, mobile source, persisted
schema or PWA behavior changes.

Final frozen full V8: **183 suites / 3,028 tests passed**, 3 opt-in suites / 20
tests skipped, 88.75% statements/lines (56,136/63,247), 77.21% branches
(13,488/17,467) and 93.94% functions (2,857/3,041). Coverage floors are raised to
88.74% statements/lines and 77.12% branches; functions remain 93.90%. The focused
20-suite/219-test Windows/macOS regression run and final Windows-specific
3-suite/21-test run pass. Backend/web/mobile types, zero-warning lint,
maintainability, spec and ADR checks pass.

Fresh native macOS runtime subset **1/1, selected 1/3** passed on retained
1.2.35+191333.f82de3d91715:
`/tmp/cockpit-cortex-backend-compat-ggqgeH/compatibility-report.json`.
It records c51c44e with dirty working-tree state, owned process/private PM2 drain,
unchanged native activation/executable and fresh authenticated inference.
Events/processors were omitted; this is not a full catalog pass. C53 runtime
changes mean the earlier C55 report remains historical workflow evidence,
rather than a fresh complete-workflow acceptance claim for this tree.

After final Jest, both production clients rebuilt and the native desktop/mobile
queue subset **1/1, selected 1/5** passed:
`/tmp/cockpit-cortex-ui-compat-tkx841/compatibility-report.json`.
It covers Stop/descendant drain, reconnect, preserved queues and explicit resume
without interrupted-work replay. Auth/interactions/usage/mobile catalogs were
omitted. Metadata records the same retained CLI, macOS arm64, c51c44e/dirty,
owned/private PM2 drain and unchanged native activation/executable. Desktop
assets meet budget: JS 913.8/914 KiB, CSS 202.3/230 KiB. These scoped native
passes do not close C26/C35/C52/C53 or certify every workflow/platform.

Durable Memory note saved before updating the project mirror:
`notes/note_2026-11-09T11-23-24-140Z_cortex-code-c53-windows.md`.
Working changes are local; no PR, release, production restart or version bump.


## C35 follow-up — 2026-11-09

The earlier review's strict-Memory deferral is superseded for macOS arm64 and
standalone 1.2.35+191333.f82de3d91715. Dedicated restricted controller/policy/JSONL
modules keep ACP chat and tool-enabled work intact. Exact native tool denial,
private configuration/cwd, no hooks/MCP/skills/profiles, empty startup catalogs,
literal prompt wrapping and full-distribution validation form the boundary.
Actual captured zero-schema/resource requests and real Memory governance,
extraction, consolidation proposal/draft/apply, sequential continuity and active
cancel/drain/fresh inference passed. See [C35 evidence](../research/cortex-code-restricted-processors.md).
ADR-0099 remains Proposed; the proven native headless protocol is recorded there
as the reason for this separate restricted boundary.

Mobile impact: processor execution stays server-side; no mobile REST/WS, stream,
attachment, PWA manifest or stored selection schema changes. Existing browser-safe
role metadata drives the desktop Memory selector, whose rendered test verifies
CoCo selection without rewriting saved choices. Both clients retain existing
chat/media gates. Native service evidence is not a new mobile/browser acceptance
claim. C26 human OAuth, C52 Ubuntu and C53 Windows remain the three tracker gates.


C35 final verification: 185 suites / 3,061 tests passed, 20 opt-in tests skipped;
V8 88.79 statements/lines, 77.31 branches, 93.98 functions at raised floors
88.78/77.30/93.95. Native selected restricted catalog passed 14 required checks
at `/tmp/cockpit-cortex-workflows-compat-wCFaWK/compatibility-report.json`, with
nine zero-tool/resource requests, eight inference jobs plus one negative-control
job, working MCP initialize/discovery, shared auth and unchanged activation.
Earlier intermediate probe reports lacked the explicit MCP handshake assertion;
only this final catalog certifies that assertion. Types/lint/maintainability/spec/
ADR and both rebuilt production clients/budget pass. The other five native
workflow probes were outside this run. No release/PR/version bump or normal
server restart was performed. Memory architecture note saved through the tool.
