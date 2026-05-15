# Release Workflow

This document covers the release-prep procedure that happens before the manual
GitHub Actions release workflow is triggered. The action packages and publishes
the release. Release notes are prepared and committed before that point.

## Ownership

Release preparation is agent-owned. When asked to prepare a release, the coding
agent creates the per-release document from repository evidence and shares it
with the human for review. The human should not have to draft the release notes
from scratch.

Use [release-notes-prompt.md](release-notes-prompt.md) as the generation prompt.

## Per-Release Document

Each production release must have:

```text
docs/releases/v<version>.md
```

The document must include non-empty `## Shipped For Users` and
`## Developer Details` sections. `## Shipped For Users` must contain at least one
bullet and must describe end-user value, not only internal implementation work.

The GitHub Release description is rendered from this source-controlled document
by `npm run release:notes`. The published description includes the user-facing
shipped bullet list without section headings and a link back to the full
developer detail document.

## Agent Prep Steps

1. Determine the target version, target source ref, and whether the release is a
   prerelease.
2. Find the previous production release and tag with `gh release list` and
   `gh release view`.
3. Gather evidence between the previous release tag and target source ref:
   merged PRs, closed issues, merge commits, `git diff --stat`,
   `git diff --name-status`, and targeted code/spec/test reads for changed
   subsystems.
4. Generate `docs/releases/v<version>.md` using
   [release-notes-prompt.md](release-notes-prompt.md).
5. Validate the GitHub Release body locally:

```bash
npm run release:notes -- --version <version> --out /tmp/agent-cockpit-release-notes.md
```

6. Commit the release document and any release-workflow changes before triggering
   the GitHub Actions release workflow.
7. Share the generated document with the human for review. Apply requested edits
   before running the release workflow.

## Publishing

After review, trigger `.github/workflows/release.yml` with:

- `version`: semantic version, with or without a leading `v`
- `source_ref`: the reviewed commit, branch, or tag to package
- `prerelease`: whether the GitHub Release should be marked as a prerelease
- `smoke_only`: when true, run pre-publish validation and skip GitHub Release
  creation; default false

The workflow always runs a Windows smoke job before publishing. For real
releases, it also validates that `docs/releases/v<version>.md` exists in the
selected source ref, renders `dist/release/github-release-notes.md`, and passes
that file to `gh release create --notes-file`. The Windows smoke job parses
`install-windows.ps1`, runs Windows-focused installer/doctor/install-state tests
plus the Windows-named update-service tests, builds the web and mobile assets
required by release packaging, and packages the release on `windows-latest` to
verify the Windows ZIP and installer manifest entries before assets are uploaded.
It also runs
`install-windows.ps1` in dev mode against a temporary checkout, forces a private
Node runtime, uses an install path containing spaces, confirms the ONLOGON
scheduled task exists, probes `/auth/setup`, and stops PM2 before the publish job
can start.

## Post-Release Checks

After the workflow succeeds:

1. Open the GitHub Release and confirm the shipped user-facing bullet list is readable.
2. Confirm the developer-details link resolves to
   `docs/releases/v<version>.md` at the release tag.
3. Confirm release assets are present: tarball, Windows ZIP,
   `release-manifest.json`, `SHA256SUMS`, `install-macos.sh`, and
   `install-windows.ps1`.
4. Confirm the README release badge points at the new version.
