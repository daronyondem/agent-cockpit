# Cortex Code profile and capability foundations

[← Back to index](SPEC.md)

**Implemented scope:** P1 contract/profile foundations, November 6, 2026.
**Runtime status:** No Cortex Code adapter is registered in `server.ts` yet.
CoCo is not an executable chat/processor/auth/update option in this slice.
See [the implementation tracker](design/cortex-code-implementation-plan.md),
[native evaluation](research/cortex-code-acp-evaluation.md), and
[Proposed ADR-0093](adr/0093-integrate-cortex-code-through-its-native-acp-interface.md).

## Identity and profile data

`CliHarness` recognizes `cortex-code`. Physical harness identity and the eventual
backend ID are the same. Display name is **Cortex Code (CoCo)**; the future
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
Any eventual invocation must pass it as an argument-array value, not shell text.

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
does not implement or certify account isolation. CoCo auth routes/jobs and
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

Desktop/mobile receive additive type fields and share the pure contract module;
no composer/setup controls, mobile assets, PWA metadata or browser interaction
behavior changes in this phase. Existing frontend typechecks must remain valid.
Native CLI compatibility suites are not replaced by these foundation tests.
