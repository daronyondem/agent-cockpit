# Cortex Code remaining capability decisions

Reviewed 2026-11-08 for C56. The compatibility target remains CoCo
1.2.35+191333.f82de3d91715 on macOS arm64. These are scope decisions for the
implemented Cockpit adapter, not claims that the native product lacks features.
Current upstream documentation may describe a newer release than this target.

## Decisions and requirements to revisit

| Capability | Decision for the current implementation | Evidence and prerequisite to enable |
|---|---|---|
| Native goals (G6) | Deferred; `goals:false`. All five goal HTTP actions reject before adapter/native invocation. No synthesized goal loop or budget. | A versioned native API and notifications plus real set/status/clear/pause/resume, budget, autonomous completion, restart, cancel and descendant-drain evidence. Planning approval is a different feature. |
| Subagent cards/background delegation (G7) | Deferred; `agents:false`. Generic native tool activity does not imply child-session support. | Stable child/parent identity, per-child demultiplexing, foreground/background finalization, late events, usage attribution, cancellation and shutdown tests through both clients. Current descendant cleanup is not semantic subagent certification. |
| Unsolicited mid-turn steering | Deferred; `stdinInput:false`. Exact pending decision replies remain supported; ordinary follow-ups use queues. | A versioned native steering method, ownership/acknowledgement semantics and actual prompt/input/Stop/reconnect races with no duplicate prompt. Never reuse a permission answer as steering. |
| Native PDF, audio and video input (G4) | Deferred; no advertised transport. Unsupported uploads cannot reach `session/prompt`. | Separate byte/path/model/transport validation and real direct-media inference on each claimed CLI/model. KB PDF/Office rasterization to PNG does not establish native PDF input. |
| Additional image models/formats and media generation (G4) | Deferred. Native PNG input is enabled only for claude-sonnet-4-6 on 1.2.35; existing text-file references and explicitly delivered artifacts remain supported. | Per-format/model native evidence, bounded resource handling and source ownership. Delivering a generated file is not an advertised model media-generation capability. `auto` is not image-certified. |
| Snowflake cost, quota and billing (G10) | Deferred. Show tokens/cache/context and cost unavailable; retain `costSource:'none'`, no inherited Anthropic/OpenAI price or free-usage claim. | Documented/native account usage with attributable model, units, cache/Auto semantics and real reconciliation. Implement any future calculator under usagePricing with provider-specific rules. No account ledger, SQL or billing query was run for this review. |
| Account isolation/expiry/refresh (G5) | Deferred. Normal setup shares terminal credentials and selects a named connection. Explicit custom home fields remain experimental; no automatic isolated setup or two-account claim. | Two real accounts under the actual server user, fresh/expired credentials, refresh/cache/Keychain ownership, concurrent profiles, logout/update/restart behavior and unchanged other-account access. An empty home or distinct profile ID is not isolation proof. |
| Strict zero-tool processors (G1/C35) | Enabled 2026-11-09 only on macOS arm64 / 1.2.35+191333.f82de3d91715 through native headless JSONL. Memory governance/extraction/consolidation passed; titles/summaries retain deterministic fallbacks. | [C35 evidence](cortex-code-restricted-processors.md): exact deny names plus isolated config/cwd, empty catalog preflight and nine actual zero-schema/resource requests across native Memory workflows, hostile/ambient inputs, sequential continuity and active cancel/fresh inference. Other builds/platforms need new proof. |

The original C56 review changed no capability flags. The subsequent C35
implementation enables only the restricted scope in the row above. Existing adapters,
account configuration and shared terminal auth remain intact. C26's actual
human remote-browser handoff and C52/C53's native OS acceptance stay open.

## Source review

The [Snowflake ACP documentation](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-acp)
describes session configuration, streamed updates and cancellation. This does
not supply this project with verified goal/child/steering contracts for 1.2.35.
Its current startup/auth descriptions differ from the retained empty-home
fixture; recorded version-specific behavior governs the adapter.

[Code mode](https://docs.snowflake.com/en/user-guide/cortex-code/code-mode)
retains coding tools, including file and shell operations. It is not a zero-tool
boundary. No global mode/settings change was made to try to enable strict Memory.

The [CoCo cost documentation](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code#cost)
describes Snowflake-specific billing arrangements. That is not per-turn charge
reconciliation for this account/CLI; Cockpit's unknown-cost policy is retained.

## Verification and ownership

- `test/cortexIntegration.test.ts`: all goal actions reject without invoking
  adapter goal methods or starting native work; uploaded PDF/audio/video produce
  a terminal unsupported-format error and no native prompt/tool/usage. Existing
  interaction/queue tests retain valid decisions while rejecting steering.
- `test/cortexBackend.test.ts`, model/attachment/event/processor-selection suites:
  conservative metadata, deterministic fallback, strict role rejection,
  version/model/PNG gates, unknown cost and native ownership.
- C54/C55 native reports establish enabled chat/workflows, not these deferred
  features. The [testing spec](../spec-testing.md) records exact scopes.

To revisit a row, add focused contracts and tests plus real versioned evidence
before changing shared capability projections or client controls. Do not turn
a documentation update, model-family name, native terminal command or successful
ACP initialization into a capability claim.
