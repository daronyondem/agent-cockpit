# Usage Cost Estimation Implementation Review Report

Date: 2026-05-20

## Scope

This report covers the implementation of Usage cost estimation for subscription
CLI backends. The shipped behavior:

- Keeps provider-reported nonzero dollars as **Cost** (`usage.costUsd`,
  `costSource: "reported"`).
- Calculates fallback API-equivalent **Estimated Cost**
  (`usage.estimatedCostUsd`, `costSource: "estimated"`) for zero-cost
  subscription CLI usage when tokens or credits match a pricing entry.
- Persists `estimatedCostUsd` and `costSnapshot` historically so later pricing
  changes do not reprice old usage.
- Stores release-owned built-in pricing in
  `src/services/usagePricing/catalog.default.json`.
- Stores user overrides in `data/chat/usage-pricing-overrides.json` so releases
  do not overwrite local choices.
- Exposes pricing catalog/override APIs and updates desktop/mobile Usage UI.

Official pricing references checked during implementation:

- OpenAI API pricing: <https://openai.com/api/pricing/>
- Anthropic Claude pricing: <https://platform.claude.com/docs/en/about-claude/pricing>
- Kiro pricing/overage credits: <https://kiro.dev/pricing/>

## Phase Reviews

### Phase 1: Pricing Catalog, Contracts, Estimator, Tests

| Cycle | Impact | Finding | Implementation |
|---|---:|---|---|
| 1 | None | Catalog shape, runtime validator, provider mapping, and estimator path were internally consistent. | No change. |
| 2 | Medium | `gpt-5.5*` would have priced unknown future/mini variants at the full GPT-5.5 rate. | Narrowed to exact `gpt-5.5` and explicit `gpt-5.5-codex`; added a no-match test for `gpt-5.5-mini`. |
| 3 | Medium | Override-driven estimates could stamp the built-in catalog version instead of the effective override version. | Added `catalogVersion` plumbing through estimator snapshots and override tests. |
| 4 | Medium | Lazy enrichment could reprice rows that already had a persisted estimate. | Estimator now preserves existing `costSource: "estimated"` plus `estimatedCostUsd`; added coverage. |
| 5 | None | Token and credit math matched the contract. | No change. |
| 6 | None | Provider-reported nonzero `costUsd` remained authoritative. | No change. |
| 7 | None | Runtime catalog validator rejected malformed token/credit entries. | No change. |
| 8 | None | Browser-safe contract file did not import server-only modules. | No change. |
| 9 | None | Snapshot fields captured source URL, dates, rates, provider, and model. | No change. |
| 10 | Low | Family model patterns remain best-effort until providers rename models. | Left as documented tradeoff; source metadata is visible in every snapshot. |

### Phase 2: Ledger/Data Model Integration and Lazy Historical Enrichment

| Cycle | Impact | Finding | Implementation |
|---|---:|---|---|
| 1 | Medium | Lazy enrichment did not migrate legacy day-level `backends` buckets. | Added `normalizeDayRecords()` and coverage for legacy buckets. |
| 2 | Medium | Reported/unpriced rows could persist noisy `estimatedCostUsd: 0`. | `applyCostEstimate()` now writes estimate fields only for estimated rows. |
| 3 | Medium | Mixed legacy rows with both `records` and `backends` could leave stale legacy data. | Enrichment now merges legacy data into `records[]` and removes stale `backends`. |
| 4 | None | Conversation, session, and ledger totals use the enriched usage object. | No change. |
| 5 | None | Aggregation preserves provider-reported and estimated values separately. | No change. |
| 6 | None | Ledger writes remain serialized through the existing mutex. | No change. |
| 7 | None | Existing provider-reported rows are not converted to estimates. | No change. |
| 8 | None | Cost snapshots survive accumulation for daily aggregate rows. | No change. |
| 9 | None | Kiro credit metadata now enters the ledger while context-only metadata is skipped. | No change. |
| 10 | Low | Aggregate `costSnapshot` is the latest applied provenance for an aggregate row. | Accepted; the historical dollar amount is persisted, and per-event provenance was not introduced. |

### Phase 3: Override Store and API

| Cycle | Impact | Finding | Implementation |
|---|---:|---|---|
| 1 | Medium | Duplicate override IDs could surface as a server error. | Added duplicate-id validation returning `400`. |
| 2 | Medium | A corrupt override file could block startup/catalog reads. | Store now logs and ignores corrupt overrides without overwriting the user file. |
| 3 | None | Effective catalog ordering correctly puts overrides before built-ins. | No change. |
| 4 | None | Save replaces the full override catalog instead of merging partial rows. | No change. |
| 5 | None | Clear writes an empty override catalog and leaves built-ins intact. | No change. |
| 6 | None | API mutations are CSRF-protected. | No change. |
| 7 | None | API response shape is shared with the browser-safe contract. | No change. |
| 8 | None | Store writes use `atomicWriteFile`. | No change. |
| 9 | None | Override cache is primed during service initialization. | No change. |
| 10 | Low | Invalid override files are not surfaced in the UI beyond empty overrides. | Accepted for this scope; file is preserved for manual recovery. |

### Phase 4: Desktop Usage UI

| Cycle | Impact | Finding | Implementation |
|---|---:|---|---|
| 1 | Medium | The chart could default to empty **Cost** when only estimates existed. | Reload now switches default metric to **Estimated Cost** only when reported cost is zero and estimates exist. |
| 2 | Medium | Blank optional cache-rate inputs saved as zero and made cache traffic free. | Blank optional cache fields are omitted so the estimator falls back to input rate. |
| 3 | Medium | Auto-switching the metric through an effect could prevent manual **Cost** selection. | Auto-switch moved into reload only. |
| 4 | None | Stat cards show combined headline with explicit Cost/Estimated Cost split. | No change. |
| 5 | None | Backend/model table keeps separate Cost and Estimated Cost columns. | No change. |
| 6 | None | Daily breakdown keeps separate Cost and Estimated Cost columns. | No change. |
| 7 | None | Pricing override table edits token and credit entries without nested cards. | No change. |
| 8 | None | Save/reset actions call the new API helpers. | No change. |
| 9 | None | Destructive clear remains scoped to usage ledger, not pricing overrides. | No change. |
| 10 | None | Static frontend route coverage guards the UI/API wiring. | No change. |

### Phase 5: Mobile PWA Usage Display

| Cycle | Impact | Finding | Implementation |
|---|---:|---|---|
| 1 | None | Mobile current-session usage bar needed a separate estimate surface. | Added a fourth **Estimated Cost** cell. |
| 2 | None | CSS grid needed a stable fourth column. | Updated `.usage-bar` to `repeat(4, minmax(0, 1fr))`. |
| 3 | None | Mobile receives `sessionUsage` from existing usage frames. | No change. |
| 4 | None | Mobile does not need pricing override management in this scope. | No change. |
| 5 | None | Static test covers the label and grid. | No change. |
| 6 | None | Mobile typecheck passed. | No change. |
| 7 | None | Mobile production build passed. | No change. |
| 8 | None | The added cell does not require API changes. | No change. |
| 9 | None | Desktop-only pricing editor remains documented as Settings UI. | No change. |
| 10 | None | No high/medium mobile findings remained. | No change. |

### Phase 6: Specs, ADR, Source Verification, Final-Phase Checks

| Cycle | Impact | Finding | Implementation |
|---|---:|---|---|
| 1 | High | Official Anthropic pricing verification found newer Opus 4.5/4.6/4.7 models are $5/$25 per MTok, while the broad `claude-opus-4*` entry would price them at deprecated Opus 4/4.1 $15/$75 rates. | Replaced the broad Opus pattern with specific current and deprecated entries; added Opus 4.6, Opus 4.1, and Haiku 4.5 tests. |
| 2 | Medium | Data layout docs had duplicate `└──` entries for usage files. | Fixed the file-tree branch. |
| 3 | Medium | Frontend spec still described `Cost | Tokens` and a single Cost table column. | Updated Usage tab spec for Cost, Estimated Cost, pricing overrides, and split tables. |
| 4 | Medium | Mobile PWA spec did not mention the new Estimated Cost cell. | Updated mobile implemented-slice text. |
| 5 | Medium | Testing/coverage docs omitted the new pricing tests and endpoint coverage. | Updated `spec-testing.md` and `spec-coverage.md`. |
| 6 | Medium | ADR scaffold lacked rationale, status, alternatives, and affected paths. | Filled ADR-0069 and marked it Accepted. |
| 7 | None | API endpoint spec already covered usage-pricing routes and lazy enrichment semantics after updates. | No change. |
| 8 | None | AGENTS.md did not need updates because this did not create a recurring agent workflow or architecture rule beyond the feature ADR/specs. | No change. |
| 9 | None | Provider source URLs and verification dates are present in built-in entries. | No change after Anthropic URL normalization. |
| 10 | None | Phase 6 docs matched the implemented code paths. | No change. |

## Final Full-Codepath Reviews

| Cycle | Impact | Finding | Implementation |
|---|---:|---|---|
| 1 | Medium | Desktop current-session context chip still showed only provider-reported `costUsd`, so Codex/Kiro sessions could look costless outside the Usage tab. | Added estimated-cost suffix support and tooltip **Estimated Cost** rows in `chip-renderers.jsx`; updated static test and frontend spec. |
| 2 | None | Historical estimate preservation path remained covered by estimator and ledger tests. | No change. |
| 3 | None | Override precedence and release boundary remained covered by store/API tests. | No change. |
| 4 | None | Contract validation returns `400` for malformed/duplicate override requests. | No change. |
| 5 | None | Optional cache-rate UI cleaning still omits blanks instead of saving zero. | No change. |
| 6 | None | Mobile PWA impact remained limited to the usage bar and build/typecheck passed. | No change. |
| 7 | None | Specs, coverage map, and ADR refer to the implemented source/test paths. | No change. |
| 8 | None | Provider source verification after the Anthropic pattern fix found no further high/medium catalog issues. | No change. |
| 9 | None | Browser-safe contracts and frontend imports respect the existing ownership boundaries. | No change. |
| 10 | Medium | `web:budget` failed by 0.2 KiB after adding context-chip estimate support. | Compacted chip cost helpers without changing behavior; reran `web:build`, `web:budget`, and frontend static tests successfully. |

## Verification

Passed during implementation:

- `npm test -- test/usagePricing.test.ts --runInBand`
- `npm test -- test/frontendRoutes.test.ts --runInBand`
- `npm run typecheck`
- `npm run web:typecheck`
- `npm run mobile:typecheck`
- `npm run web:build`
- `npm run mobile:build`
- `npm run web:budget`
- `npm test -- test/usagePricing.test.ts test/usagePricingStore.test.ts test/chat.usageLedgerStore.test.ts test/chatService.usage.test.ts test/chat.rest.test.ts test/frontendRoutes.test.ts --runInBand`
- `npm test -- test/workspaceContext.service.test.ts --runInBand`

Repository-level checks passed after this report was added:

- `npm run maintainability:check`
- `npm run spec:drift`
- `npm run adr:lint`

Full-suite check notes:

- `npm test -- --runInBand` failed outside this feature in
  `test/claudePlanUsage.test.ts` with a mocked `fs/promises.readFile` recursive
  call stack, plus an asynchronous Workspace Context warning after tests
  completed.
- `npm test` failed twice outside this feature in
  `test/workspaceContext.service.test.ts` due parallel/scheduler timing around
  zero-source scan state; the same Workspace Context suite passed in isolation
  with `--runInBand`.

## Residual Risks

- Built-in pricing defaults are manually verified before releases; they can lag
  provider changes until the next catalog update.
- User overrides intentionally shadow built-ins and are never overwritten by
  releases, so a stale override can continue to produce stale estimates.
- Estimated Cost is API-equivalent accounting, not a provider bill. Subscription
  plans, included usage, bonus credits, taxes, and custom contracts are outside
  the estimate unless the user encodes them as overrides.
- The unrelated full-suite Workspace Context timing failure remains outside this
  feature; its suite passes in isolation, but default parallel `npm test` still
  failed during verification.
