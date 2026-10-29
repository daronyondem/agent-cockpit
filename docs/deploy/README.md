# Agent Cockpit Deploy Guide

Agent Cockpit is a local server application. The production installers set up
that server, write runtime config, register current-user session startup, start
PM2, and open first-run owner setup.

## Install

- [macOS install](macos.md)
- [Linux install](linux.md)
- [Windows install](windows.md)
- [Development setup](../reference/development.md)

## Configure Access

- [Security and owner auth](security.md)
- [Remote access](remote-access.md)

## Maintain

- [Install Doctor](install-doctor.md)
- [Updates](updates.md)
- [Environment variables](../reference/environment-variables.md)
- [Data layout](../reference/data-layout.md)

## Repair And Failure Recovery

Rerun the platform installer with the same install directory and release version
to repair an installation. Repairs preserve custom environment settings, owner
data, CLI profiles, secrets, the original install date, and completed welcome
setup. Omit the port option to retain an existing configured port.

Production replacements are prepared separately before activation. A failed
download, checksum check, or dependency install does not replace the active
release. If activation or readiness fails, the installer attempts to restore the
previous release, manifest, helper scripts, and startup registration. It does not
revert user data or external changes made by a running application.

Stage diagnostics are saved at `<install-root>/logs/install.log`; setup tokens
are printed to the terminal but are not written to this log. If rollback reports
an error, keep that log and the previous release directory rather than deleting
the installation. Required failures exit nonzero. Missing optional backend CLIs
do not require you to install or log in to unused backends.

The manual-start option (`--no-auto-start` or Windows `-NoAutoStart`) also removes
an existing managed startup entry. It does not stop the current session.
On every platform it leaves another installation's startup entry unchanged, and
automatic startup refuses to replace an entry owned by a different install.
Directory aliases are recognized as the same installation. If restoring a
task fails during rollback, the installer warns and still attempts to restart
the previous app.

Repair recognizes directory aliases and can recover a running installation
with a corrupt install manifest by checking live PM2 ownership. POSIX startup
helpers retain the selected `PM2_HOME` even when the login environment differs
from the terminal used to install.

Failed preparation directories are cleaned up without removing earlier working
releases. After failed activation, a candidate is retained if its process stop
or removal cannot be confirmed safe, or if it is still selected. Keep retained
candidates for recovery until the active installation is known to be healthy.

## Important Deployment Boundaries

- Agent Cockpit runs on the same machine as the upstream CLIs.
- The normal production path is a local server, not hosted SaaS.
- The first owner account should be created before exposing the server. If it
  must be exposed first, configure `AUTH_SETUP_TOKEN`.
- PM2 is the supported process manager for persistent local server operation.
- Platform startup entries launch PM2 as the installing user: macOS LaunchAgent,
  Linux systemd user unit, and Windows ONLOGON scheduled task.
