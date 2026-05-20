# Updates

Agent Cockpit has two update paths:

- Production installs update from GitHub Releases.
- Dev installs update from `main`.

## Production Installs

Production installers write install metadata that lets Agent Cockpit check the
latest GitHub Release, verify release checksums, stage the next release, and
restart through PM2.

Release artifacts include:

- macOS tarball;
- Linux tarball manifest entry using the same tarball bytes;
- Windows ZIP;
- release manifest;
- SHA256 sums;
- macOS installer;
- Linux installer;
- Windows installer.

## Dev Installs

Dev installs keep the git checkout model: pull from `main`, install
dependencies, rebuild assets when required, and restart the PM2-managed server.

## User-Facing Updates

The UI exposes self-update status and controls when the install state supports
it. Production installs should prefer the release path instead of pulling
directly from `main`.

## More Detail

- [Deployment spec](../spec-deployment.md)
- [Release workflow](../release-workflow.md)
- [Release notes prompt](../release-notes-prompt.md)
