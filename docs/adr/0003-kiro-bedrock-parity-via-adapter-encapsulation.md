---
id: 0003
title: Encapsulate Bedrock parity quirks inside the Kiro adapter
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [backends, kiro, bedrock, adapter, historical]
affects:
  - docs/notes-kiro-bedrock-parity.md
  - src/services/backends/kiro.ts
  - src/services/knowledgeBase/ingestion/pageConversion.ts
  - test/kiroBackend.test.ts
---

## Context

`agent-cockpit` was originally built around the Claude Code CLI (direct Anthropic API). When the Kiro CLI was added as a second backend, several behaviors that "just worked" in Claude Code broke under Kiro despite both backends nominally exposing Opus 4.7. The gaps trace to two separate divergences:

1. **Bedrock vs Anthropic-API limits.** Bedrock's deployment of Opus 4.7 is stricter than the Anthropic-hosted endpoint. It rejects RGBA PNGs at any size and rejects any image whose long edge exceeds 1568 px, where the Anthropic API accepts RGBA up to 2576 px.
2. **CLI transport differences.** Claude Code uses newline-delimited JSON over stdio with explicit `result` events. Kiro uses ACP/JSON-RPC, which has its own quirks: `fs_read` of an image base64-inlines the bytes into the transcript (overflowing the prompt budget), `session/prompt` never emits `turn_end` (the response body's `stopReason` is the real signal), `session/set_model` is silently ignored on bad input (must race against a timeout), and JSON-RPC error responses' `data` field carries Bedrock's actual diagnostic but the original adapter dropped it.

The total surface is seven concrete findings (catalogued in `docs/notes-kiro-bedrock-parity.md`). The architectural question this ADR answers is *where* the parity workarounds live — inside the adapter, or threaded through every caller.

## Decision

**All Kiro/Bedrock parity workarounds are encapsulated inside the Kiro adapter (`src/services/backends/kiro.ts`).** Callers — KB ingestion's `runOneShot`, OCR helpers, the chat path — pass plain text prompts and a `workingDir`, exactly the same shape they pass to the Claude Code adapter. They never see RGBA detection, JPEG re-encoding, basename token matching, the 5-image attachment cap, the 1568 px dimension cap, the `stopReason` end-of-turn convention, or the `session/set_model` 5-second race.

Concretely the adapter owns:

- `pngHasAlpha()` + `reencodeForKiro()`: detect RGBA / oversized images and re-encode as JPEG @ q92 over a white background, downscaled to `KIRO_MAX_LONG_EDGE_PX = 1568`.
- `collectImageContentBlocks()`: scan `workingDir`, attach up to `MAX_IMAGE_ATTACHMENTS = 5` images mentioned by basename in the prompt, as proper ACP `{type: 'image'}` content blocks (bypassing `fs_read`'s inlining path entirely).
- `basenameAppearsAsToken()`: token-boundary match so `page-0042.png` doesn't match the longer `page-0042.png.ai.png` (which would attach both files and blow the 10 MB cap).
- JSON-RPC error formatting that preserves `code` and `data` (sliced to 500 chars) and `stderr` (sliced to 200 chars).
- Treating `session/prompt`'s response (its `stopReason`) as the authoritative end-of-turn signal, with a defensive `turn_end` notification handler funnelling into the same termination.
- A 5-second `Promise.race` around `session/set_model`, swallowing timeouts and falling through to the default model.

**The KB ingestion downscale cap stays at `MAX_LONG_EDGE_PX = 2576`** (correct for the Anthropic API). The Kiro adapter re-downscales to 1568 px on its own. We do **not** lower the global cap to satisfy the worst backend.

A Jest suite (`test/kiroBackend.test.ts`) locks the parity workarounds in place: `pngHasAlpha`, `reencodeForKiro`, `collectImageContentBlocks` (basename token matching, 5-image cap, MIME mapping, re-encode integration), and the 13-entry pinned model list. Removing any of these tests is a tell that someone is regressing parity.

## Alternatives Considered

- **Push image-shape constraints up into KB ingestion** (lower `MAX_LONG_EDGE_PX` to 1568, pre-flatten to JPEG before any backend sees it). Rejected: degrades Claude Code quality (the primary backend) for no Kiro gain — the Kiro adapter would still need to re-downscale because the cap could change again, and Claude Code would lose the extra 1008 px of resolution for nothing.
- **Add a "backend capabilities" interface and have callers branch on it** (e.g. `if (backend.maxImageEdge < 2576) downscale; if (!backend.acceptsRGBA) flatten`). Rejected: leaks Bedrock-specific knowledge into every caller, multiplies complexity, and creates a maintenance burden whenever Bedrock loosens a limit. Adapter encapsulation keeps the parity gap invisible above the adapter boundary.
- **Use Kiro's native `fs_read` Image mode** (the obvious path that the documentation suggests). Rejected: empirically base64-inlines the image bytes into the transcript, which overflows the model's prompt budget even on a 1 MB PNG. Building proper ACP `{type: 'image'}` content blocks ourselves bypasses this entirely.
- **Match basenames with a simple `prompt.includes(basename)` check.** Rejected: substring matching attaches sibling files (`page-0042.png` matches inside `page-0042.png.ai.png`), exceeding the 10 MB attachment cap. Token-boundary matching (the characters before/after must not be filename characters) is the minimum correct implementation.
- **Use a regex like `\bpage-0042\.png\b` for the boundary check.** Rejected: word boundaries treat `.` as a non-word character, so `\b` matches between `g` and `.` and `.` and `p`, which doesn't capture our intent. A forward-scan with explicit character classes is clearer and handles overlapping matches cleanly.
- **Wait for an explicit `session/update.turn_end` notification per the ACP spec.** Rejected: empirically Kiro never emits it; the adapter would wait forever. The `session/prompt` response body's `stopReason` is the real signal. We keep a defensive `turn_end` handler in case Kiro starts emitting it later.
- **Block indefinitely on `session/set_model` and let a higher-level timeout catch it.** Rejected: silent ignores aren't surfaced anywhere else in the stack and would leave the user staring at an unmoving spinner. A 5-second adapter-internal race with a user-visible warning (chat path) or silent fall-through (one-shot) keeps the failure local and explainable.
- **Drop the JSON-RPC `code` and `data` fields** (the original adapter behavior). Rejected: Bedrock packs the meaningful diagnostic (validation error class, model ID, request ID) into `data` and uses a generic `message`. Without `data`, every Bedrock failure surfaces as an indistinguishable `Internal error`, making debugging impossible.
- **Retry on Bedrock validation errors.** Rejected: if the re-encode + downscale didn't fix it, retrying with the same input won't either. Surface the error verbatim (with `data`) so the user can act on it.

## Consequences

- + Above the adapter boundary, all backends look the same — callers pass `(prompt, workingDir)` and don't care whether they're talking to Claude Code or Kiro. New callers (e.g. future KB pipeline stages) inherit the parity workarounds for free.
- + The seven workarounds are co-located in one file, with a paired notes doc that explains the symptom, root cause, and fix for each. A future contributor who sees `reencodeForKiro` doesn't have to re-derive why it exists.
- + The Jest suite makes regression visible: tests reference specific Bedrock behaviors so deleting them announces what is being broken.
- - The Kiro adapter is now significantly more complex than the Claude Code adapter (two re-encode helpers, a working-directory scan, a token-boundary matcher, error formatting, two timeout races). This complexity is justified but isn't free — any future backend additions should follow the same encapsulation pattern rather than spreading their quirks.
- - The 1568 px / RGBA / `fs_read`-bypass workarounds are dead code the moment Bedrock catches up to Anthropic-API limits. We accept the carrying cost; removing them prematurely re-breaks parity. Open-question §6 of the notes doc tracks this.
- - The 5-image attachment cap silently drops images 6+ when the prompt mentions many filenames. We chose a hard cap over surfacing an error because KB ingestion paths only mention 1–3 images per prompt in practice; if that ever changes, we'll see truncation in the meta.json telemetry.
- ~ The adapter applies the same re-encode policy to every Kiro model, including non-Anthropic open-weight models (DeepSeek, MiniMax, GLM, Qwen). This is safe but possibly over-strict. Untested per open-question §6.

## References

- docs/notes-kiro-bedrock-parity.md — the living catalogue of all seven findings, with code refs, root causes, and PR history
- PR #223 — `fix(kiro): attach image content blocks to ACP session/prompt` (findings 3.2, 3.7)
- PR #224 — `fix(kiro): require token-boundary match for image basename attach` (finding 3.3)
- PR #225 — `fix(kiro): re-encode RGBA/oversized images for Bedrock + surface ACP error data` (findings 3.1, 3.4)
- ADR-0002 — Hybrid AI-assisted KB ingestion (the pipeline that surfaced these parity failures)
