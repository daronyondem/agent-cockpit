# Cortex Code zero-tool processors (G1/C35)

Verified 2026-11-09 on macOS arm64, Node 26.0.0, standalone distribution
`1.2.35+191333.f82de3d91715`. C35 is implemented for this exact scope. Other
builds and platforms fail closed. The initial ACP allowlist experiments remain
valid historical failures; the successful path uses native headless JSONL.

## Why the new experiment succeeded

The native tool deny matcher compares exact names. A literal `*` is not a
wildcard, and an approval allowlist leaves tool declarations in model context.
The retained binary registers 47 tool names and separately injects `skill`.
Cockpit supplies all 48 exact names to `--disallowed-tools`, including deferred
tool discovery, direct/programmatic calls, shell, files, SQL, agents, questions,
plans and scheduling. The names are owned by `cortexRestrictedPolicy.ts`.

The [official CLI reference](https://docs.snowflake.com/en/user-guide/cortex-code/cli-reference)
describes removal from context for `--disallowed-tools`; it is distinct from
automatic permission approval. Native evidence on the retained build, rather
than documentation for a newer release, establishes this implementation.

Tools are only part of the boundary. Each job uses a private 0700 temporary
`CORTEX_HOME` **and cwd**, ignoring the requested execution workspace. Normal
`HOME`, `SNOWFLAKE_HOME` and selected connection retain native terminal auth.
This separates CoCo configuration/history from authentication; it is not a
two-account isolation claim. Prompts must contain their required source text.
No normal configuration, credential or application Memory files are changed.

Private settings disable automatic updates. Private `hooks.json` contains
`disableAllHooks:true`; native hook loading uses that file independently of
`--setting-sources`. Cockpit forces standard agent mode through both env and
CLI, disables bundled skills using `__all__`, auto-applied profiles and managed
Snowflake MCP, and passes:

```text
--no-auto-update -c <connection> -w <private-root>
--setting-sources "" --no-mcp
--only-explicit-plugins --only-explicit-skills --only-explicit-profiles
--mode standard --output-format stream-json --input-format stream-json
[--model <selected-model>] [--effort <selected-effort>]
--disallowed-tools <48 exact tool names>
```

Arbitrary processor input is encoded as a JSON string after a fixed plain-text
instruction. Native slash/shell dispatch never receives command-prefixed input.
No MCP manifest, tools, attachments or permission broker is provided.

## Runtime checks and ownership

`cortexRestricted.ts` resolves the profile with the shared runtime resolver,
pins the executable realpath, passively checks `--no-auto-update --version`,
and checks sibling `cortex-version.txt` against the full certified distribution.
Only macOS arm64 is admitted. CoCo's headless init reports an unrelated
`claude_code_version` of `1.0.0`; it is not the CLI compatibility version.

`cortexRestrictedStream.ts` validates a single native session and requires empty
`tools`, `skills`, `plugins`, `mcp_servers` and `slash_commands` arrays before
sending the first prompt. It permits text/thinking assistant content and context
snapshots. Tool/control frames, unexpected sessions/events, duplicate result
UUIDs, denied permissions, unsuccessful/multi-turn results, malformed or
oversized frames and incomplete usage all fail the job. Results must have all
four finite nonnegative native token buckets; no price or ledger is invented.

Default/false `allowTools` selects this path. Explicit true retains the existing
ACP processor path; ordinary chat also remains ACP. One deadline covers version
detection, startup and every sequential prompt. Calls never retry or replay.
Timeout, abort, shutdown, protocol failures and success all await owned process
cleanup before removing the private home and resolving/rejecting the job.
Shutdown is reusable. Native state is ephemeral, with no durable session resume.
Reserved `cockpit-cortex-restricted-XXXXXX` directories are excluded on export
and rejected on import, including empty directories.

Static `restrictedText` eligibility is true on macOS arm64; actual invocation
still checks the selected executable/build. Other platforms retain false. A
saved profile is never replaced or automatically selected. Titles/summaries
retain their deterministic fallbacks. This change enables existing Memory
governance, extraction, consolidation proposals and rewrite drafts; it does not
change chat goals, agents, steering, media, account isolation or pricing.

## Native evidence

Run against shared saved terminal auth:

```sh
CORTEX_RESTRICTED_PROBE=1 npx tsx scripts/probe-cortex-restricted.ts
# Or the supervised, metadata-validating workflow catalog:
CORTEX_CODE_E2E=1 npm run e2e:cortex-code-workflows -- --probe restricted
```

The probe uses real Cockpit Memory services, temporary application settings/data,
an in-process HTTP fixture and native CoCo. Working SessionStart hook and stdio
MCP canaries run in a positive control. The restricted path then runs with
ambient hook/MCP/skill/command fixtures and hostile slash/read/write text.
It verifies sequential nonce recall, no secret-file disclosure, no forbidden
file and no hook/MCP canary invocation.

For this opt-in probe only, native `CORTEX_CODE_EVAL_MODE=true` records outgoing
request debug data under the private home. Before normal production cleanup,
the probe projects counts for `tools`, `tool_resources`, `mcp_servers` and
`skills`; raw bodies and account metadata are deleted with that home. It does
not infer tool counts from an allowlist or rejected permission request.

The supervised selected catalog passed 1/1 (selected 1/6) at
`/tmp/cockpit-cortex-workflows-compat-wCFaWK/compatibility-report.json`. Its
native report is `restricted/tmp/cockpit-cortex-c35-takaDz/report.json`, with
8 inference jobs, one empty-connection negative control and **9 actual requests**,
all with zero tool definitions/resources. All 14 required checks passed, including
working native MCP initialize/tools-list and positive tool-schema capture.
Actual HTTP Memory governance persisted an entry; real session extraction,
consolidation proposal, rewrite draft and application passed. Cancellation
waited for a captured active request, drained/removed its private home, then
fresh exact-response inference succeeded. CLI executable stats and normal
activation were unchanged. The empty connection home failed before any model
request; this is missing-configuration evidence, not expired-credential or
account-isolation certification. A sanitized projection is committed as
[`restricted-report.json`](../../test/fixtures/cortex/1.2.35/restricted-report.json).

The first service probe `/tmp/cockpit-cortex-c35-nwUwVP/report.json` stopped
after proposal generation because the probe passed a draft directly instead
of `{draft}` to the service. Its initialized `toolOperations` field was not an
operation measurement and is not evidence. Correcting the harness produced
the successful run above; failed evidence is retained separately.

This is versioned service/process evidence, not a new browser, physical mobile,
Linux/Windows or human OAuth acceptance claim. C26, C52 and C53 remain pending.
See the [runtime spec](../spec-cortex-code.md#restricted-text-processors-p6-c35)
and [implementation tracker](../design/cortex-code-implementation-plan.md).


## Final regression evidence

The final frozen V8 run passed **185 suites / 3,061 tests**, with the existing
three opt-in suites / 20 tests skipped. Statements/lines: 88.79%
(56,362/63,471); branches: 77.31% (13,617/17,612); functions: 93.98%
(2,873/3,057). Committed floors rise from 88.74/77.12/93.90 to
88.78/77.30/93.95. Two earlier frozen collections measured 88.80 and 88.79
lines; an initial 88.80 floor trial missed by 0.01, so the final raised floor
uses the observed baseline range. The final suite passed those floors after
the result-tail and disappearing-executable fixes.

Backend/web/mobile and strict probe typechecks, zero-warning lint,
maintainability/spec/ADR gates, production builds and the unchanged web bundle
budget passed. No new browser/mobile acceptance is implied by the selected
service probe. The complete six-workflow catalog was not rerun in this change.
