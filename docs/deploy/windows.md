# Windows Install

The supported Windows production path is a per-user PowerShell installer. It
installs under `%LOCALAPPDATA%\Agent Cockpit`, verifies GitHub Release
checksums, installs a private Node.js runtime when needed, uses install-local
PM2 state, registers a current-user logon scheduled task, starts Agent Cockpit
in the background without a visible Node console window, and opens first-run
owner setup in the browser.

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -Command "iwr https://github.com/daronyondem/agent-cockpit/releases/latest/download/install-windows.ps1 -OutFile $env:TEMP\install-agent-cockpit.ps1; & $env:TEMP\install-agent-cockpit.ps1 -Channel production"
```

## Dev Channel

Dev installs track `main`:

```powershell
& $env:TEMP\install-agent-cockpit.ps1 -Channel dev
```

## Runtime Model

The Windows installer is intentionally user-logon based. It does not install a
Windows Service and does not run before any Windows user has logged in.

When the welcome screen installs Claude Code or Codex on Windows, it installs
the CLI into Agent Cockpit's per-user `cli-tools` prefix and Agent Cockpit runs
the installed package entrypoint directly before falling back to npm command
shims. No global Node/npm/PM2 install is required.

## After Install

1. Create the first owner account.
2. Confirm backend CLI detection in the welcome/setup flow.
3. Use the same owner account from desktop and mobile browsers.

## More Detail

- [Deployment spec](../spec-deployment.md)
- [ADR-0063: Per-user Windows installer](../adr/0063-adopt-per-user-windows-installer.md)
