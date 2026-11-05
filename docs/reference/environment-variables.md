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
| `DEFAULT_WORKSPACE` | No | `~/.agent-cockpit/workspace` | Default working directory for CLI processes. |
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

## GitHub Copilot Server Configuration

Copilot profiles reuse the server process's native CLI/provider environment.
Settings does not store profile-local environment or config-directory overrides
for this harness. These variables therefore affect every shared Copilot profile:

| Variable | Meaning |
| --- | --- |
| `COPILOT_HOME` | Native CLI configuration/state home; normally the CLI's `~/.copilot`. Changing it does not establish isolated OS-keychain credentials or independent accounts. |
| `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | Native GitHub credential overrides. Configured tokens take precedence over cached terminal login; guided device login does not replace an environment token. |
| `COPILOT_MODEL` | Default model when the turn omits a model or selects `auto`; an explicit turn selection wins. The effective model still passes catalog/effort/media validation. |
| `COPILOT_PROVIDER_BASE_URL` | Explicit custom-provider endpoint. When set, SDK create/resume receives custom-provider configuration instead of assuming hosted GitHub routing. |
| `COPILOT_PROVIDER_TYPE` | Custom-provider type: `openai` (default), `anthropic` or `azure`. Provider support does not imply verified image/PDF support. |
| `COPILOT_PROVIDER_API_KEY` | Optional custom-provider API key, passed only when configured. Provider credentials remain server configuration rather than GitHub device-login credentials. |

Custom-provider catalogs are marked as fallbacks, Copilot account quota is
unavailable, and guided GitHub login is not used to certify provider keys.
Opaque wrapper commands whose provider environment is hidden retain JSONL
compatibility. See the [runtime contract](../spec-backend-services.md#copilot-sdk-runtime-foundation)
and [known capability gaps](backend-capabilities.md#copilot-known-capability-gaps).
