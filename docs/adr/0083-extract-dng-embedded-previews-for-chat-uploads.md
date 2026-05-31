---
id: 0083
title: Extract DNG embedded previews for chat uploads
status: Accepted
date: 2026-05-31
supersedes: []
superseded-by: null
tags:
  - chat
  - uploads
  - mobile-pwa
  - images
affects:
  - src/routes/chat/uploadRoutes.ts
  - src/services/chat/dngPreview.ts
  - src/services/chat/uploadImageNormalization.ts
  - test/dngPreview.test.ts
  - test/chat.rest.test.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
---

## Context

iPhone RAW photo uploads from the mobile PWA can arrive as `.dng` files. Before this decision, conversation uploads saved those files as ordinary artifacts and returned them as `kind: "file"`. Harnesses could not treat that path as image input, and attempts to inspect the upload produced server errors or unusable file references instead of a model-readable image.

Agent Cockpit runs on macOS, Windows, and Linux, so the solution cannot depend on macOS-only ImageIO/`sips` behavior or a user-installed RAW converter. Full RAW demosaic also carries higher CPU/memory cost and would require a heavier decoder dependency. The immediate product need is to give the harness a visually useful image from common iPhone DNG uploads, not to preserve RAW-editing fidelity.

## Decision

Conversation upload handling extracts the embedded JPEG preview from `.dng` files and returns that preview as the uploaded attachment. The original DNG remains in the conversation artifact directory, but clients receive only a generated sibling named `<original>.dng.preview.jpg`.

The DNG parser supports baseline TIFF/DNG files with `II`/`MM` byte order and TIFF magic `42`. It scans IFD0, linked IFDs, and SubIFDs within bounded limits, selects the largest readable single-strip JPEG preview, and skips linear raw subimages such as `PhotometricInterpretation=34892`. The generated JPEG sidecar is capped to a 2576 px long edge; previews above that cap are decoded and re-encoded as JPEG quality 92 through the existing `@napi-rs/canvas` dependency. HEIC/HEIF conversion is out of scope for this decision.

Deleting a generated `.dng.preview.jpg` attachment also best-effort deletes the paired original DNG. Malformed DNG files or files without a readable embedded JPEG preview return a DNG-specific `400` response rather than a generic `500`.

## Alternatives Considered

- **Full RAW demosaic with LibRaw or LibRaw WASM**: rejected for the first implementation because it is heavier, slower, and consumes substantially more memory for iPhone ProRAW-sized files. It also solves more than the current chat-attachment need.
- **macOS `sips`/ImageIO conversion**: rejected because Agent Cockpit is cross-platform and must behave consistently on macOS, Windows, and Linux.
- **System tools such as ImageMagick, darktable, RawTherapee, or dcraw**: rejected as the default because they would add installer, doctor, and platform-packaging complexity and would not be reliably present on user machines.
- **Convert DNG preview JPEGs to PNG**: rejected because the embedded preview is already a photographic JPEG; PNG would usually increase bytes without adding useful detail for harness vision.
- **Return the original DNG plus the preview**: rejected for the chat attachment response because the harness should receive one clear image path. Keeping the original on disk preserves traceability without making the model choose between RAW and preview.

## Consequences

- + iPhone RAW uploads become harness-readable without a platform-specific dependency.
- + The upload route returns a normal JPEG image attachment, so existing image/OCR/send/queue behavior continues to work.
- + Original RAW files remain available on disk while the attachment exists.
- - The visual content comes from the camera-generated preview, not from a freshly demosaiced RAW interpretation.
- - DNG variants without single-strip embedded JPEG previews remain unsupported and return `400`.
- ~ The 2576 px cap matches the existing Claude/KB vision cap; backend-specific lower caps, such as Kiro's 1568 px Bedrock path, remain adapter-owned.

## References

- [API endpoint spec](../spec-api-endpoints.md#38-file-upload)
- [Backend services spec](../spec-backend-services.md)
- [Mobile PWA spec](../spec-mobile-pwa.md)
- [Testing spec](../spec-testing.md)
