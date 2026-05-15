# Release Notes Generation Prompt

Use this prompt when preparing a production release. The goal is to produce the
source-controlled per-release document under `docs/releases/` before the GitHub
Release workflow runs.

## Prompt

You are preparing Agent Cockpit release notes for version `<version>`.

Generate `docs/releases/v<version>.md` from repository evidence. Do not ask the
human to draft the notes. The human only reviews the generated document before
the release workflow is triggered.

Gather evidence from:

- The previous production GitHub Release and tag.
- Merge commits on `main` between the previous release tag and the target source
  ref.
- Merged pull requests in that range, including titles, bodies, labels, and file
  changes when relevant.
- Issues closed between the previous release and the target source ref, plus any
  issues referenced by the merged pull requests.
- `git diff --stat`, `git diff --name-status`, and targeted reads of high-signal
  source, spec, test, workflow, installer, and documentation changes.

Write for two audiences:

- **Shipped For Users**: end-user value. Explain what a user can now do, what is
  easier, safer, faster, clearer, or more reliable. Avoid implementation-only
  wording unless the user directly experiences it.
- **Developer Details**: precise engineering summary for maintainers. Include
  changed subsystems, specs, tests, workflows, installer/update behavior, ADRs,
  migrations, compatibility notes, and risk or rollback notes when relevant.

Required document shape:

```md
# Agent Cockpit v<version>

## Shipped For Users

- ...

## Developer Details

- ...

## Verification

- ...

## Source Links

- Previous release: ...
- Compare: ...
- Pull requests: ...
- Issues: ...
```

Rules:

- Do not mention AI assistants, agents, automation, generated output, or tooling
  authorship in the document.
- Do not include `TODO` or `TBD`; resolve uncertainty before release.
- Do not inflate internal maintenance into user-facing shipped items.
- Do not list version-bump-only commits unless they affect the shipped release.
- Prefer grouped bullets over a raw commit list.
- Link PRs and issues where they explain the change.
- If a code change has no user-facing effect, keep it in **Developer Details**.
- If a behavior changed, make sure the relevant spec file already reflects the
  new behavior before finalizing the release doc.
