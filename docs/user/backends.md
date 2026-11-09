# Supported Backends

Agent Cockpit wraps local command-line AI tools. The CLI must be installed and
authenticated on the same machine that runs the Agent Cockpit server.

| Backend | CLI | Best For | Notes |
| --- | --- | --- | --- |
| Claude Code | `claude` | Planning, tool-heavy coding, plan mode | Supports token and cost reporting, plan mode, subagents, and mid-turn input. |
| OpenAI Codex | `codex` | Fast coding iteration and goal-mode workflows | Uses Codex App Server, supports subagents, goal controls, token usage, and full local execution defaults. |
| Cortex Code (CoCo) | `cortex` | Snowflake-backed coding, chat and tool-enabled processors | Native ACP; verified on 1.2.35/macOS arm64. Shared terminal auth, questions/plans, PNG OCR; strict Memory on the exact retained macOS arm64 build; goals/subagents/steering and pricing remain gated. |
| Grok Build | `grok` | Coding, native goals, plan approval and subagents | Uses ACP plus native extensions; reuses terminal login, reports model usage/cost and optional account billing. |
| Kiro | `kiro-cli` | ACP-based workflows and Kiro-specific projects | Uses ACP over stdin/stdout and reports credits/context percentage rather than token cost. |
| OpenCode | `opencode` | Multi-provider coding through DeepSeek, Groq, Gemini, OpenRouter, and similar providers | Self-configured provider credentials and model routing. Supports thinking, tool activity, and session resume. |

For the full feature matrix, see [BACKENDS.md](../../BACKENDS.md).

## Claude Code

Install and authenticate Claude Code using Anthropic's documented CLI flow.
Agent Cockpit runs Claude through its own backend adapter and does not require
users to edit personal Claude settings for permissions or attribution.

Claude-specific features include:

- plan mode;
- token and USD cost reporting when exposed by the CLI;
- subagent and tool visualization;
- mid-turn user input;
- workspace instruction compatibility checks.

## OpenAI Codex

Install Codex with npm when needed:

```bash
npm install -g @openai/codex
```

Then authenticate with `codex login` or configure the environment expected by
the Codex CLI.

Agent Cockpit defaults Codex interactive threads to full local execution:

- `CODEX_APPROVAL_POLICY=never`
- `CODEX_SANDBOX_MODE=danger-full-access`

Use stricter environment settings only when you intentionally want a restricted
deployment.

## Kiro

Install and authenticate `kiro-cli` on the server machine before selecting Kiro
as a backend. Agent Cockpit talks to Kiro through ACP, keeps the process alive
with an idle timeout, and resumes sessions across server restarts when the
backend supports it.

## OpenCode

Install and configure [OpenCode](https://opencode.ai/docs/cli/) on the server
machine before selecting OpenCode as a backend. OpenCode is a CLI harness:
providers such as DeepSeek, Groq, Gemini, and OpenRouter stay inside OpenCode's
own provider/model configuration instead of becoming separate Agent Cockpit
harnesses.

Agent Cockpit profiles can select an OpenCode provider and discover models with
`opencode models`. Conversations stream through `opencode run --format json`,
surface visible thinking and tool activity, and resume later turns through
OpenCode session ids.

OpenCode profiles are self-configured in Agent Cockpit's first implementation.
Agent Cockpit can check whether the CLI is available, but it does not manage
OpenCode provider login or API keys. OpenCode does not currently support
subagents, goal mode, plan mode, mid-turn user input, or interactive user
questions through Agent Cockpit.

For local open-source models, configure Ollama as a persistent OpenCode provider
and use an Agent Cockpit OpenCode profile with provider `ollama`; see
[Open Source Models With Ollama And OpenCode](ollama-opencode.md).

Image and PDF one-shot workflows, including attachment OCR and Knowledge Base
image conversion, require an OpenCode model that reports the required media
input capability. Text-only OpenCode models still work for normal chat and
text-based context workflows.

## Grok Build

Install the official CLI on the server machine and authenticate:

```bash
npm install -g @xai-official/grok
grok login
```

The native installer from the [Grok Build docs](https://docs.x.ai/build/overview)
also works. Agent Cockpit finds `~/.grok/bin/grok` even when it is not on the
server `PATH`, and the CLI updates list in Settings → CLI Profiles updates that
install with `grok update`.

Select **Grok Build** in Settings → CLI Profiles → Harness. A self-configured
profile reuses your existing terminal authentication. Welcome can check that
login or start `grok login --device-auth`; its setup profile also shares your
normal `~/.grok` login. Explicit account profiles can use a separate config
directory mapped to `GROK_HOME`.

To use an xAI API key instead of a login, add `XAI_API_KEY` to an account
profile's environment overrides. A cached login in that profile's Grok home
takes precedence over the key. **Check CLI** can only report the key as
configured because Agent Cockpit does not spend a paid request to test it; the
first real request shows whether the key works.

Grok supports thinking, tools, grouped subagents, questions, plan approval,
mid-turn input, native goal controls, and later session recovery. Goal token
budgets are soft and execution can exceed them. The usage display distinguishes
reported model cost from optional subscription/account balances; missing quota
fields remain hidden. Image/PDF tasks currently require `grok-4.7`. Native
memory is disabled in Cockpit sessions; use Cockpit Memory and Workspace Context.
An interrupted active turn is not automatically reattached or replayed.

Compatibility is verified with Grok Build 1.0.52 on macOS arm64. Native Windows
and Linux compatibility, and authorization with a real valid API key, still need
validation.

## Backend Switching

Backend selection is per conversation. New conversations remember the currently
selected default, and existing conversation context remains in Agent Cockpit's
workspace storage regardless of which backend produced it.

Provider-neutral context features such as Memory, Knowledge Base, Workspace
Context, and Workspace Routines are designed to make switching backends useful
instead of starting from an empty prompt every time.

## Concurrent Conversations On The Same Repo

Backend choice does not change how the CLI sees the filesystem. When two
conversations run against the same Git workspace at the same time, the CLI
processes share that workspace folder by default. To give each conversation an
isolated checkout and session branch, enable
[Worktree Isolation](worktree-isolation.md) on the workspace. This works the
same way for every supported backend.

## Cortex Code (CoCo)

Install the official standalone CLI on the server and select a named Snowflake
connection in Settings → CLI Profiles. Normal setup shares terminal credentials;
the dedicated panel can check saved access or transfer a native OAuth URL and
complete loopback redirect from a browser on another machine. Successful fresh
inference is required; model discovery is not login proof. The actual human
remote-browser run through Cockpit remains an acceptance gate.

See [Cortex Code setup and limits](cortex-code.md) for installation, the exact
authentication steps, supported workflows, image/model requirements, updates and
migration. Native Windows/Linux acceptance is pending. Strict Memory can select
CoCo on the exact verified macOS arm64 build; tool-enabled workflows retain
their independent capability checks.
