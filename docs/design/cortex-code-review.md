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
| Processors | Explicit tool-enabled selection and one deadline, no retry/replay, headless human gates fail, missing saved choices retained. Strict Memory stays unavailable; governed chat Memory uses another eligible processor. |
| Platform lifecycle | Optional official standalone install, narrow proven macOS update layout, passive full-bundle import checks and reserved runtime exclusions. Ubuntu preparation is not a native pass; Windows runtime remains unimplemented. |
| Compatibility and reporting | Isolated synthetic data, PM2 browser fixtures, fixed native checks, bounded deadlines/cleanup and private raw evidence. A subset pass or expected-auth failure is never full capability/auth certification. |

ADR-0093 describes these ownership boundaries, rejected alternatives and
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
- C35/G1: a complete native zero-tool boundary, then real strict Memory workflows.
- C52: actual Ubuntu 24.04 x64 install/auth/user-service/cache/update/cleanup.
- C53: native Windows runtime implementation and executable/auth/process/update
  acceptance, preserving other harness wrappers and macOS behavior.
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
ownership. CoCo cost remains unavailable; strict Memory and unverified native
features stay gated. Optional installation, version-limited macOS updates and
full-data migration checks preserve shared auth and existing release behavior.

Validation: see the final C58 evidence below and the
compatibility specification (`docs/spec-testing.md`). Native acceptance is pinned
CoCo 1.2.35/macOS arm64, with synthetic isolated data and PM2 browser fixtures.
Routine outreach is a stub. Human OAuth, strict Memory and native other-platform
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
C52 and C53 still open. ADR-0093 stays Proposed. PR text is ready locally;
publication, merge and release remain separate requested actions.
