# macOS Install

The recommended production path on macOS is the release installer. It downloads
the latest GitHub Release, verifies checksums, installs dependencies, writes
local runtime config, starts Agent Cockpit through local PM2, and opens
first-run owner setup in the browser. It also registers a current-user
LaunchAgent so Agent Cockpit starts again when you log in after a restart.

```bash
curl -fsSL https://github.com/daronyondem/agent-cockpit/releases/latest/download/install-macos.sh -o /tmp/install-agent-cockpit.sh
bash /tmp/install-agent-cockpit.sh --channel production
```

## Dev Channel

Dev installs track `main`:

```bash
bash /tmp/install-agent-cockpit.sh --channel dev
```

## Runtime Requirements

Manual development installs require Node.js 22+. The macOS release installer
can install a private Node.js runtime automatically when Node/npm are missing or
too old.

The installer does not assume Homebrew exists. If it needs a private runtime, it
downloads the official Node.js macOS tarball, verifies checksums, and records
runtime ownership in the install manifest.

## Startup

By default the installer writes
`~/Library/LaunchAgents/com.agent-cockpit.server.plist` and
`<install-root>/bin/start-agent-cockpit.sh`. The LaunchAgent runs the helper at
user login; the helper starts Agent Cockpit through local PM2 and saves PM2
state. Pass `--no-auto-start` to skip LaunchAgent registration.

## After Install

After the browser opens:

1. Create the first owner account.
2. Configure or confirm at least one backend CLI.
3. Open Settings to review security, passkeys, recovery codes, and update
   status.

## More Detail

- [Self-hosting guide](../../ONBOARDING.md)
- [Deployment spec](../spec-deployment.md)
- [ADR-0054: Mac installer and release channels](../adr/0054-adopt-mac-installer-and-release-channels.md)
- [ADR-0059: Private Node runtime on macOS](../adr/0059-install-private-node-runtime-on-macos.md)
- [ADR-0075: POSIX user-session autostart](../adr/0075-register-user-session-autostart-for-posix-installers.md)
