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

## Cortex Code native environment

CoCo requires no new global Cockpit secret. Store a named connection in the CLI
profile; native Snowflake configuration owns credentials. Normal setup retains
the server user's terminal HOME and Snowflake home. Executable/update discovery
is separate from account configuration.

| Variable | Cockpit behavior |
| --- | --- |
| `SNOWFLAKE_HOME` | Native connection/config home; normally `~/.snowflake`. Explicit non-setup profile `configDir` maps here. Separate-home/two-account isolation is not certified. Setup profiles retain shared terminal auth instead of creating isolated homes. |
| `CORTEX_OAUTH_MANUAL` | Managed native runtime/login sets `1` for the manual URL/loopback redirect handoff. OAuth URLs/state/codes belong only to the active job. |
| `CORTEX_ENABLE_MEMORY` | Managed runtime forces `0`; use Cockpit Memory MCP with an eligible separate processor. |
| `CORTEX_ACP_TEST_MODE` | Managed runtime forces `0`. Fake native mode is never authentication/compatibility evidence. |

Developer-only `CORTEX_CODE_E2E=1` authorizes real compatibility runs;
`CORTEX_TEST_COMMAND` and `CORTEX_TEST_CONNECTION` optionally select the retained
executable and saved connection. They are not production setup requirements.
The expected-failure auth-control catalog never selects a saved connection.
See [the testing specification](../spec-testing.md#coco-consolidated-compatibility-runners-p9-c54).
