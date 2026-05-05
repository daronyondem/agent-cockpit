---
id: 0030
title: Normalize generated artifacts across CLI backends
status: Accepted
date: 2026-05-05
supersedes: []
superseded-by: null
tags: [backend, frontend, mobile-pwa, cli-profiles]
affects:
  - src/types/index.ts
  - src/routes/chat.ts
  - src/services/chatService.ts
  - src/services/backends/codex.ts
  - public/v2/src/streamStore.js
  - public/v2/src/shell.jsx
  - mobile/AgentCockpitPWA/src/App.tsx
  - mobile/AgentCockpitPWA/src/types.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
---

## Context

Assistant-generated files and images can arrive outside the assistant text
stream. Codex image generation is the concrete failure case: the backend
reported an `imageGeneration` tool item and wrote/returned image bytes, but the
final assistant text was empty. Agent Cockpit persisted no assistant message and
the desktop UI had no renderable file card until the user asked a follow-up
question and the CLI emitted a `FILE_DELIVERY` marker.

The prior file-delivery path was prompt- and text-marker-based:
`<!-- FILE_DELIVERY:/absolute/path -->` in assistant text renders a workspace
file card. That works for explicit deliverable files when the model follows the
prompt, but it is not a reliable transport for backend-native generated assets,
and it points at workspace files rather than conversation-scoped artifacts.

The fix needs to work across CLI vendors without making the frontend understand
each vendor's protocol. It also needs to share the existing authenticated
conversation-file endpoint so desktop and mobile clients can preview, download,
and share the same artifact.

## Decision

Add a vendor-neutral `artifact` stream event and a persisted
`{ type: 'artifact', artifact: ConversationArtifact }` assistant content block.

Backend adapters may yield an artifact event with `sourcePath` or `dataBase64`
plus optional `filename`, `mimeType`, `title`, and `sourceToolId`.
`processStream` owns normalization: it calls `ChatService.createConversationArtifact`,
which copies/decodes the bytes into `data/chat/artifacts/{conversationId}/`,
sanitizes/collision-suffixes the filename, infers kind/MIME metadata, appends an
artifact content block, and forwards a normalized `{ type: 'artifact', artifact }`
frame to clients.

Artifact-only turns count as real assistant output. If no text or result body
arrives, `processStream` still saves a final assistant message with the artifact
block and a legacy `content` fallback such as `Generated file: Generated image`.

Codex implements the first producer: completed `imageGeneration` items keep the
existing `ImageGen` tool card, then emit an artifact event from embedded base64
image data when present, or from profile-scoped `CODEX_HOME/generated_images`
fallback files. Claude Code, Kiro, and future adapters can use the same event;
the existing `FILE_DELIVERY` marker remains supported for text-delivered files.

## Alternatives Considered

- **Keep relying on `FILE_DELIVERY` markers**: rejected because backend-native
  image generation can complete with no assistant text, so there is no marker to
  parse. It also leaves generated assets outside conversation artifact storage.
- **Teach the frontend to inspect vendor-specific tool events**: rejected
  because every UI client would need Codex/Kiro/Claude protocol knowledge and
  future vendors would require client changes.
- **Write generated files into the workspace and synthesize a marker**: rejected
  because generated images are conversation outputs, not project source files,
  and some conversations may not have a safe writable workspace path for this
  purpose.

## Consequences

- + Generated images/files render on the first assistant turn even when final
  text is empty.
- + Desktop and mobile use the same `ConversationArtifact` content block and
  existing `GET /conversations/:id/files/:filename` endpoint.
- + Backend adapters get one shared contract for generated artifacts, while
  marker-based file delivery remains backward-compatible.
- - The stream contract, persistence model, desktop renderer, and mobile PWA all
  need to understand one new content block variant.
- ~ Conversation artifacts are copied from vendor storage, so generated outputs
  may exist both in a CLI profile cache and under `data/chat/artifacts/{convId}`.

## References

- [API Endpoints](../spec-api-endpoints.md)
- [Backend Services](../spec-backend-services.md)
- [Data Models](../spec-data-models.md)
- [Frontend Behavior](../spec-frontend.md)
- [Mobile PWA Client](../spec-mobile-pwa.md)
