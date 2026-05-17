# Environment Variables

This page summarizes the most common Agent Cockpit environment variables. The
complete implementation contract lives in [spec-deployment.md](../spec-deployment.md)
and [spec-server-security.md](../spec-server-security.md).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | No | `3334` | Server listen port. |
| `SESSION_SECRET` | Yes | none | Secret for signing session cookies. Installers generate this. |
| `AGENT_COCKPIT_DATA_DIR` | No | `data` | Mutable data root for chat data, sessions, auth state, install manifest, and update artifacts. |
| `AUTH_DATA_DIR` | No | `data/auth` | First-party owner auth state directory. |
| `AUTH_SETUP_TOKEN` | Recommended for remote setup | none | Token required to create the first owner account from a non-localhost request. |
| `AUTH_ENABLE_LEGACY_OAUTH` | No | `false` | Enables legacy Google/GitHub OAuth routes. |
| `DEFAULT_WORKSPACE` | No | `~/.openclaw/workspace` | Default working directory for CLI processes. |
| `BASE_PATH` | No | empty | URL base path for reverse proxy deployments. |
| `KIRO_ACP_IDLE_TIMEOUT_MS` | No | `3600000` | Idle timeout before killing the Kiro ACP process. |
| `CODEX_IDLE_TIMEOUT_MS` | No | `600000` | Idle timeout before killing the Codex app-server process. |
| `CODEX_APPROVAL_POLICY` | No | `never` | Codex approval policy for interactive threads. |
| `CODEX_SANDBOX_MODE` | No | `danger-full-access` | Codex sandbox mode for interactive threads. |
| `LOG_LEVEL` | No | `info` | Server log threshold. |

## Codex Defaults

Agent Cockpit treats Codex as a trusted local backend by default:

```env
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX_MODE=danger-full-access
```

Set stricter values only when you intentionally want a restricted deployment.
