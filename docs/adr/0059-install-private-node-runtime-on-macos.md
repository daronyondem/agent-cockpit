---
id: 0059
title: Install private Node runtime on macOS
status: Accepted
date: 2026-05-14
supersedes: []
superseded-by: null
tags:
  - deployment
  - installer
  - macos
  - node
affects:
  - README.md
  - scripts/install-macos.sh
  - scripts/package-release.js
  - src/services/installStateService.ts
  - src/services/updateService.ts
  - src/services/installDoctorService.ts
  - src/types/index.ts
  - src/contracts/install.ts
  - web/AgentCockpitWeb/src/updateModal.jsx
  - test/installStateService.test.ts
  - test/macosInstallerScript.test.ts
  - test/releasePackage.test.ts
  - test/updateService.test.ts
  - test/helpers/chatEnv.ts
  - test/chat.rest.test.ts
  - test/installDoctorService.test.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-deployment.md
  - docs/spec-frontend.md
  - docs/spec-coverage.md
  - docs/spec-testing.md
---

## Context

The first macOS installer expected Node.js 22+ and npm to already exist on the
host. It could run `brew install node` behind `--install-node`, but that did not
help a truly fresh Mac because Homebrew itself is not part of a default macOS
install.

Agent Cockpit's Mac install goal is a minimal terminal bootstrap followed by
browser-based setup. Asking normal users to install Homebrew or understand Node
before Agent Cockpit can start adds avoidable friction and makes the fresh-Mac
path fail before the product UI can help.

The installer and updater still need Node/npm for `npm ci`, build fallback
commands, PM2 startup through `npx`, and later self-update dependency
installation. Any installer-managed runtime therefore needs to be visible during
install, inside the PM2-managed server process, and inside the production
self-update path before dependency installation.

## Decision

The macOS installer treats an existing Node.js 22+/npm installation as usable,
but it no longer assumes one exists. When Node.js 22+ or npm is missing, the
installer downloads the latest official Node.js 22 macOS tarball for the
detected architecture from Node.org, verifies it against Node's
`SHASUMS256.txt`, and extracts it under the Agent Cockpit install root:

```text
<install-root>/runtime/node-v<version>
<install-root>/runtime/node -> node-v<version>
```

The installer prepends `<install-root>/runtime/node/bin` for install-time
`node`, `npm`, and `npx` commands. When it installs this private runtime, it also
persists the resulting `PATH` in generated `.env` and `ecosystem.config.js` so
the PM2-managed server, restart script, and app self-update path continue to find
the same Node/npm tools. The installer also writes `nodeRuntime` metadata to
`install.json` so update and diagnostic surfaces know whether Agent Cockpit is
using `system` Node or an installer-owned `private` runtime.

Production release manifests declare the required Node runtime derived from root
`package.json` `engines.node`:

```json
{
  "requiredRuntime": {
    "node": {
      "engine": ">=22",
      "minimumMajor": 22
    }
  }
}
```

During production self-update, Agent Cockpit verifies that the current runtime
satisfies the release's required Node major before running `npm ci`. If the
current runtime is too old, the updater downloads the latest official tarball for
that major from Node.org, verifies it against `SHASUMS256.txt`, updates
`<install-root>/runtime/node`, prepends that runtime to the update process
`PATH`, persists the runtime `PATH` into the copied `.env` and
`ecosystem.config.js`, records the bundled npm version when observable, and
records a visible update step before continuing. Existing installs that used
system Node migrate to this private runtime when a release raises the required
major. Agent Cockpit does not mutate global system Node.

`--install-node` remains accepted as an explicit form of the default behavior.
`--no-install-node` opts out and makes missing/old Node.js a hard error for users
who want to manage Node themselves.

## Alternatives Considered

- **Require users to install Node manually**: rejected because it breaks the
  fresh-Mac install promise and leaves non-developer users outside the guided
  welcome flow.
- **Install Homebrew, then install Node through Homebrew**: rejected because it
  mutates more global machine state than Agent Cockpit needs, adds another large
  prerequisite, and still requires Homebrew-specific failure handling.
- **Always use the private runtime even when system Node is valid**: rejected for
  now because existing developer machines already have suitable Node/npm
  installations, and avoiding unnecessary downloads keeps repeat installs
  faster. The private runtime remains the fallback when the host cannot satisfy
  the runtime requirement.
- **Let npm fail when the Node major is too old during update**: rejected because
  it fails late, produces npm-oriented errors, and can leave users unsure whether
  the release, dependency install, or local machine is at fault.

## Consequences

- + Fresh Macs can run the installer without preinstalling Homebrew or Node.
- + Production installs get a predictable Node/npm toolchain without global
  system mutation when the host does not already provide one.
- + The installer can still use a developer-managed Node runtime on machines that
  already satisfy the required major version.
- + A future release can raise `engines.node` to a new major and existing
  production installs can install or update private Node before app dependencies
  are installed.
- - Agent Cockpit now owns part of the Node runtime lifecycle for machines that
  use the private runtime. The updater handles major upgrades, while patch-level
  refresh policy remains tied to releases that require or trigger a runtime
  update.
- ~ The runtime is intentionally private to the Agent Cockpit install root. It is
  not added to the user's shell profile and does not replace system Node.

## References

- [ADR-0054: Adopt Mac installer and release channels](0054-adopt-mac-installer-and-release-channels.md)
- [Deployment and Operations](../spec-deployment.md)
- [Testing and CI/CD](../spec-testing.md)
