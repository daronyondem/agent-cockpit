# Linux Install

The validated Linux production path is a shell installer tested on Ubuntu 24.04
LTS x64. It downloads the latest GitHub Release, verifies checksums, installs a
private Node.js runtime when needed, installs dependencies, writes local runtime
config, starts Agent Cockpit through local PM2, and opens or prints the
first-run owner setup URL. It also writes a systemd user unit so Agent Cockpit
starts again when your user session starts after a restart.

```bash
curl -fsSL https://github.com/daronyondem/agent-cockpit/releases/latest/download/install-linux.sh -o /tmp/install-agent-cockpit.sh
bash /tmp/install-agent-cockpit.sh --channel production
```

## Supported Platform

Linux support is validated on Ubuntu 24.04 LTS x64. Other glibc-based x64
distributions may work but are not part of the manual release test matrix.
Alpine/musl Linux, NixOS, WSL, Linux arm64, and 32-bit Linux are not supported
by the first Linux installer.

## Dev Channel

Dev installs track `main`:

```bash
bash /tmp/install-agent-cockpit.sh --channel dev
```

## Runtime Requirements

Manual development installs require Node.js 22+. The Linux release installer can
install a private official Node.js Linux x64 runtime automatically when Node/npm
are missing or too old.

The installer does not use `apt`, `dnf`, `snap`, Flatpak, AppImage, `.deb`, or
`.rpm` packaging. It uses the same local server model as macOS: versioned
release directories, a `current` symlink, mutable data under the install root,
and PM2 for runtime supervision.

## Startup

By default the installer writes
`${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/agent-cockpit.service` and
`<install-root>/bin/start-agent-cockpit.sh`. The user unit runs the helper for
`default.target`; the helper starts Agent Cockpit through local PM2 and saves
PM2 state. Pass `--no-auto-start` to skip systemd user-unit registration.

## Manual Release Test

Before treating Linux support as release-ready, manually test on a fresh Ubuntu
24.04 LTS Desktop x64 VM:

1. Install with the production command above.
2. Confirm setup opens in the browser, or that the printed setup URL works.
3. Create the owner account.
4. Confirm `/v2/` and `/mobile/` load.
5. Confirm Install Doctor reports `node`, `npm`, and `pm2` as ready.
6. Re-run the installer or update flow on a test release and confirm data is
   preserved.

## More Detail

- [Deployment spec](../spec-deployment.md)
- [ADR-0071: Linux production installs](../adr/0071-support-linux-production-installs.md)
- [ADR-0075: POSIX user-session autostart](../adr/0075-register-user-session-autostart-for-posix-installers.md)
