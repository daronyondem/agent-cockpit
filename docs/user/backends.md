# Supported Backends

Agent Cockpit wraps local command-line AI tools. The CLI must be installed and
authenticated on the same machine that runs the Agent Cockpit server.

| Backend | CLI | Best For | Notes |
| --- | --- | --- | --- |
| Claude Code | `claude` | Planning, tool-heavy coding, plan mode | Supports token and cost reporting, plan mode, subagents, and mid-turn input. |
| OpenAI Codex | `codex` | Fast coding iteration and goal-mode workflows | Uses Codex App Server, supports subagents, goal controls, token usage, and full local execution defaults. |
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
vendors.

Agent Cockpit profiles can select an OpenCode provider and discover models with
`opencode models`. Conversations stream through `opencode run --format json`,
surface visible thinking and tool activity, and resume later turns through
OpenCode session ids.

OpenCode profiles are self-configured in Agent Cockpit's first implementation.
Agent Cockpit can check whether the CLI is available, but it does not manage
OpenCode provider login or API keys. OpenCode does not currently support
subagents, goal mode, plan mode, mid-turn user input, or interactive user
questions through Agent Cockpit.

Image and PDF one-shot workflows, including attachment OCR and Knowledge Base
image conversion, require an OpenCode model that reports the required media
input capability. Text-only OpenCode models still work for normal chat and
text-based context workflows.

## Backend Switching

Backend selection is per conversation. New conversations remember the currently
selected default, and existing conversation context remains in Agent Cockpit's
workspace storage regardless of which backend produced it.

Provider-neutral context features such as Memory, Knowledge Base, and Workspace
Context are designed to make switching backends useful instead of starting from
an empty prompt every time.

## Concurrent Conversations On The Same Repo

Backend choice does not change how the CLI sees the filesystem. When two
conversations run against the same Git workspace at the same time, the CLI
processes share that workspace folder by default. To give each conversation an
isolated checkout and session branch, enable
[Worktree Isolation](worktree-isolation.md) on the workspace. This works the
same way for every supported backend.
