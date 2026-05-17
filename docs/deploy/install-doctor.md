# Install Doctor

Install Doctor is the setup diagnostic surface used by the welcome flow and
install-state APIs. It checks whether the local Agent Cockpit install has the
runtime, process manager, build assets, optional backend CLIs, and optional
document tools needed for the selected workflows.

## Where It Appears

The desktop welcome screen reads Install Doctor status after owner setup. It
groups checks into required install readiness, backend CLIs, optional document
tools, mobile build status, update-channel metadata, and platform-specific
startup checks.

The API endpoint is:

```text
GET /api/chat/install/doctor
```

## Required Checks

Required checks include:

- Node.js 22+ or an installer-managed private runtime;
- npm;
- local PM2;
- writable data directory;
- desktop web build presence.

Required failures make the install status an error.

## Optional Checks

Optional checks include:

- Claude Code CLI;
- OpenAI Codex CLI;
- Kiro CLI;
- Pandoc;
- LibreOffice;
- mobile PWA build;
- update-channel metadata;
- Windows logon startup registration.

Missing optional tools produce warnings, not hard install failures. Users only
need to install the backend CLIs and document tools they plan to use.

## Assisted Actions

Some checks expose allowlisted install actions. The browser never sends shell
command text to the server. It sends an action id, and the server runs the
predefined command when no active conversation is running.

On Windows, Claude Code and Codex install actions use Agent Cockpit's per-user
`cli-tools` prefix and the installer-recorded private Node runtime when present.
That keeps the welcome flow independent of global Node/npm/PM2 installs.

## Related Specs

- [API endpoints](../spec-api-endpoints.md)
- [Frontend behavior](../spec-frontend.md)
- [Backend services](../spec-backend-services.md)
- [Testing](../spec-testing.md)
