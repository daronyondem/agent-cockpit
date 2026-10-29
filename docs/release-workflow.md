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
4. Run dependency audit checks for both package roots:
   `npm audit` and `npm audit --prefix mobile/AgentCockpitPWA`. Do not proceed
   with undocumented moderate-or-higher findings; either remediate them or link
   the release notes/prep record to the issue that documents the accepted
   exposure and follow-up plan.
5. Generate `docs/releases/v<version>.md` using
   [release-notes-prompt.md](release-notes-prompt.md).
6. Validate the GitHub Release body locally:

```bash
npm run release:notes -- --version <version> --out /tmp/agent-cockpit-release-notes.md
```

7. Commit the release document and any release-workflow changes before triggering
   the GitHub Actions release workflow.
8. Share the generated document with the human for review. Apply requested edits
   before running the release workflow.

## Publishing

After review, trigger `.github/workflows/release.yml` with:

- `version`: semantic version, with or without a leading `v`
- `source_ref`: the reviewed commit, branch, or tag to package
- `prerelease`: whether the GitHub Release should be marked as a prerelease
- `smoke_only`: when true, run pre-publish validation and skip GitHub Release
  creation; default false

The `candidate` job normalizes the version, runs the existing type/build/lint/
test/ADR gates, and packages one candidate on Ubuntu 24.04. Real releases also
validate the release document and render `github-release-notes.md`; smoke-only
runs do not require release notes. The complete candidate is uploaded once.

The reusable `install-smoke.yml` gate downloads that candidate on Ubuntu 24.04
x64, Windows x64, macOS arm64 (`macos-15`), and macOS x64 (`macos-15-intel`).
Each runs with system Node and with an installer-managed private Node runtime.
The runner executes the candidate's bundled production installer against those
exact archives, checks expected version, required Install Doctor checks, desktop
and mobile assets, same-version repair, data/config/onboarding preservation,
manual-start opt-out, and generated stop/start helpers. It uses isolated
temporary homes, data, auth, PM2, and ports. Startup-registration checks are
CI-only and are cleaned up. The Ubuntu system-runtime job also runs Playwright
owner/welcome and post-repair mobile checks without any live backend account.
Reports and browser failure artifacts are uploaded even when a job fails.
The runner checks live process ownership and PID changes, verifies
corrupt-manifest repair, proves stopping releases the port, and starts the
helper with inherited `PM2_HOME` removed. Windows task cleanup uses installer
ownership checks rather than blindly deleting a task with the same name.

Publishing depends on the candidate and all native gates. It downloads the
already-tested candidate and creates the GitHub Release without rebuilding or
repackaging it. `smoke_only` runs the same native matrix but never publishes.

Relevant installation PRs run `install.yml`: one candidate build plus a smaller
system-runtime matrix on Ubuntu 24.04, Windows, and macOS arm64. The normal PR
test workflow remains responsible for the complete backend regression suite.

### Disposable-Machine Startup Checklist

Native registration checks do not prove startup after a real login. Before
claiming a newly changed startup mechanism is validated, install on a disposable
supported machine, log out/reboot and log in as the installing user, and check:

1. The expected version serves desktop and mobile after login, with a minimal
   terminal PATH and no global Node/npm/PM2 when using the private runtime.
2. No admin service or no-login startup was added; Windows shows no persistent
   Node console window.
3. Rerunning with manual startup removes the managed entry, and the next login
   does not start the app. A failed replacement retains the previous startup.

## Post-Release Checks

After the workflow succeeds:

1. Open the GitHub Release and confirm the shipped user-facing bullet list is readable.
2. Confirm the developer-details link resolves to
   `docs/releases/v<version>.md` at the release tag.
3. Confirm release assets are present: tarball, Windows ZIP,
   `release-manifest.json`, `SHA256SUMS`, `install-macos.sh`,
   `install-linux.sh`, and `install-windows.ps1`.
4. Confirm the README release badge points at the new version.
