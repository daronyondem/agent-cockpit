---
id: 0090
title: Represent Claude Code Bedrock as a CLI profile provider
status: Accepted
date: 2026-06-13
supersedes: []
superseded-by: null
tags: [backend, cli-profiles, claude-code]
affects:
  - src/types/cliProfiles.ts
  - src/services/settingsService.ts
  - src/services/backends/claudeCode.ts
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
---

## Context

Claude Code can run through Anthropic's normal model aliases or through AWS
Bedrock. Bedrock requires `--model` to receive an inference profile ID or ARN,
such as `global.anthropic.claude-fable-5`, while Agent Cockpit's normal Claude
model picker stores aliases such as `claude-fable-5`.

Users also need AWS runtime configuration (`CLAUDE_CODE_USE_BEDROCK`, region,
profile, bearer token, etc.) to remain flexible and secret-friendly. That
runtime configuration already belongs in CLI profile environment overrides, but
model routing needs a structured, user-friendly shape so the chat picker can
show names like "Fable 5 - Global" while invoking the exact Bedrock inference
profile ID.

## Decision

Represent Bedrock as a Claude Code CLI profile provider:
`cliProfile.claudeCode.provider` is either `anthropic` or `bedrock`, defaulting
to `anthropic` for existing profiles. Provider stays on the CLI profile rather
than becoming a global backend because it changes the behavior of a specific
Claude CLI account/config/env runtime.

For Bedrock profiles, keep AWS/Claude runtime values in the existing
`cliProfile.env` JSON and store model routing under
`cliProfile.claudeCode.bedrock.inferenceProfiles[]`. Each row has a friendly
`name`, executable `inferenceProfileId`, optional `baseModelId`, and optional
`default`. The friendly name is shown in the model picker; the inference profile
ID or ARN is stored/sent as the model value. `baseModelId` is explicit so Agent
Cockpit can inherit known Claude family, capability, cost-tier, and effort
metadata without guessing from provider-specific strings.

Claude Code `getMetadata({ cliProfile })` projects Bedrock inference profiles
into `ModelOption[]`. Runtime streaming and one-shot calls pass the selected
inference profile ID directly to `claude --model` and use the mapped base model
only for local capability/effort/Ultracode gating.

## Alternatives Considered

- **Put Bedrock on a separate backend id**: Rejected because the same Claude CLI
  binary, account profile, command override, config directory, env, auth checks,
  plan usage, and update behavior still belong to the physical Claude Code
  profile. A separate backend would duplicate identity and confuse profile
  selection.
- **Store inference profile mappings in environment JSON**: Rejected because the
  model picker needs structured labels/defaults/base-model metadata, while env
  JSON should remain focused on runtime credentials and process settings.
- **Infer base Claude models from Bedrock IDs**: Rejected because inference
  profile names and ARNs are provider-defined strings. An explicit
  `baseModelId` keeps capability and effort behavior predictable and lets
  unknown profiles remain selectable with conservative text-only metadata.
- **Automatically migrate env-only Bedrock profiles**: Rejected for the first
  implementation because existing env combinations vary, and automatic
  conversion could create misleading model rows. Settings can warn users and
  let them add explicit inference profiles.

## Consequences

- + Bedrock profiles can show friendly model names while invoking the exact
  Bedrock inference profile ID/ARN required by Claude Code.
- + Existing Anthropic Claude Code profiles keep their model catalog and runtime
  behavior through the default `anthropic` provider.
- + AWS runtime secrets stay in environment overrides and are not duplicated in
  structured profile rows.
- - Users must configure inference profile rows explicitly for Bedrock chat
  usability; env-only Bedrock profiles are not auto-converted.
- ~ Usage pricing can use existing pattern matching for the MVP, but a future
  explicit `pricingModelId` snapshot field would make Bedrock cost attribution
  more robust.

## References

- [Data Models spec](../spec-data-models.md)
- [API Endpoints spec](../spec-api-endpoints.md)
- [Backend Services spec](../spec-backend-services.md)
- [Frontend spec](../spec-frontend.md)
