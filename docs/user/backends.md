# Supported Backends

Agent Cockpit wraps local command-line AI tools. The CLI must be installed and
authenticated on the same machine that runs the Agent Cockpit server.

| Backend | CLI | Best For | Notes |
| --- | --- | --- | --- |
| Claude Code | `claude` | Planning, tool-heavy coding, plan mode | Supports token and cost reporting, plan mode, subagents, and mid-turn input. |
| OpenAI Codex | `codex` | Fast coding iteration and goal-mode workflows | Uses Codex App Server, supports subagents, goal controls, token usage, and full local execution defaults. |
| Grok Build | `grok` | Coding, native goals, plan approval and subagents | Uses ACP plus native extensions; reuses terminal login, reports model usage/cost and optional account billing. |
| Kiro | `kiro-cli` | ACP-based workflows and Kiro-specific projects | Uses ACP over stdin/stdout and reports credits/context percentage rather than token cost. |
| OpenCode | `opencode` | Multi-provider coding through DeepSeek, Groq, Gemini, OpenRouter, and similar providers | Self-configured provider credentials and model routing. Supports thinking, tool activity, and session resume. |
| GitHub Copilot | `copilot` | Coding with account-dependent Copilot models | SDK chat, guided shared login, questions/steering, grouped subagents, native goals, usage/quota and verified attachments. [Known gaps](../reference/backend-capabilities.md#copilot-known-capability-gaps) apply. |

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

## GitHub Copilot

Install the GitHub Copilot CLI on the server machine:

```bash
npm install -g @github/copilot
```

Use **Settings → CLI Profiles → Authenticate** to start Copilot's device-code
login, then open the displayed URL and enter its code. **Cancel** stops the
login. You can also run `copilot login` (or start `copilot` and use `/login`)
in a terminal. Agent Cockpit reuses the server's native CLI credentials.
Use **Check GitHub Copilot** on the profile to check installation,
credentials and model catalog access. Credentials can be recognized while
catalog access is denied; Settings reports that distinction and the returned
error. This check does not run paid inference or prove access to every model.
Authentication succeeds only after a fresh process verifies credentials and
model catalog access. If the CLI needs interactive credential-storage consent,
finish login in a terminal. Custom providers use their server-configured provider
credentials instead of this GitHub login. Environment tokens take precedence.
Multiple named profiles share the same terminal login; they are not independent
accounts.

For a custom OpenAI-compatible, Anthropic or Azure endpoint, configure the
provider in the server's environment; Copilot profile cards do not offer
per-profile environment overrides. See the
[Copilot server variables](../reference/environment-variables.md#github-copilot-server-configuration).
Provider availability and media support are separate checks.

Agent Cockpit uses owned SDK chat sessions with visible thinking, tools,
questions, steering, grouped delegated work and later-session resume. Opaque
custom command overrides retain JSONL compatibility. The picker discovers models
for the selected runtime and marks its curated fallback when discovery is unavailable.
The default **auto** choice lets Copilot route requests; explicit model and effort
choices depend on the selected runtime, subscription and administrator policy.

SDK profiles support goals through the shared goal composer. Pause stops owned
work and keeps the objective. Resume requires a **Fresh AI credit limit** greater
than zero; this starts a new native credit window. The goal strip labels any
reported window as **AI credits**, separately from tokens and USD. Clear is
unavailable in Copilot CLI 1.0.105. Plan mode remains unavailable in Cockpit.

The usage panel shows live fresh input, output, cache read/write and measured
context usage. Token and premium-request counters reconcile across resume and
final summaries. AI credits and premium requests have separate labels; partial
credit readings are reported subtotals, and unavailable readings are not zero.
USD cost/estimates stay unavailable. Account quota is profile-scoped and labels
stale data and measurement times. When the native compatibility API does not
establish quota units, the panel says so. Custom providers have no Copilot account
quota. Account readings can lag current activity; missing data does not block chat.

Chat uploads use explicit SDK file attachments. Media requires a verified model
and provider: custom OpenAI-compatible `gpt-6.1-sol` supports images, while
custom Anthropic `claude-sonnet-4.6` supports images and PDFs. Hosted SDK PDF
input remains gated pending separate qualification. Unsupported uploads keep
your draft/files and show a selection error. Unknown/automatic selections do
not inherit media from a model name or native vision flag.

One-shot workflows, including attachment OCR and Knowledge Base image conversion,
retain `copilot --attachment` and independently verified media selections.
Native tools can return image/file bytes as persistent artifact cards with
preview and download/share on desktop/mobile. Completed outputs survive Stop
and reload; stopped desktop output may be inside its expandable progress group.
Ordinary requested file delivery remains supported. Native image
generation is unavailable.

Text-only one-shot jobs, such as title generation, run with no tools exposed.
CLI updates stay under Agent Cockpit's update controls rather than being
downloaded implicitly during a chat turn.
Non-npm installations offer **Run updater**, but do not receive background
update-available notifications.

Copilot also runs Cockpit Memory, Workspace Context, Knowledge Base and enabled
Workspace Routines. Native application checks cover governed note save/search,
Context maintenance and reset finalization, KB digestion/gleaning/dreaming,
fresh-chat KB recall, Routine artifacts/history, cancellation and retry. These
use the real CLI with fixed local model replies and temporary auth/data; they
verify integration rather than hosted-model judgment.

### Known Copilot limitations

- All profiles share terminal authentication; separate accounts per profile are
  unavailable. Guided login exists, but successful hosted OAuth, expired-login
  and two-account behavior have not been qualified with real accounts.
- Native plan approval and goal Clear are unavailable. Goal pause/resume works;
  resume starts a fresh AI-credit window rather than a Codex token budget.
- Native image generation is unavailable. Hosted SDK PDFs, custom OpenAI PDFs
  and unverified provider/model media combinations stay disabled. Returned image
  artifacts do not imply image-generation support.
- Interrupted active turns are not reattached or automatically replayed after a
  server restart. A later prompt can resume saved session history.
- USD costs are unavailable; native tokens, premium requests, AI credits and
  available account quota keep their own units. Native-memory import is also
  unavailable; use Cockpit Memory MCP and Workspace Context.
- Mobile PWA users select shared profiles and have chat, goal, usage and artifact
  controls. Guided authentication and Memory administration use the full web
  app; the PWA has no dedicated CLI-profile auth/account-management screen or
  Memory panels/live Memory bubbles.
- Windows native SDK qualification currently fails during headless startup
  (`Copilot runtime did not announce a port`). The Windows process-fixture job
  passes, but that does not establish working native Copilot sessions. macOS and
  Ubuntu SDK/browser checks pass with fixed local model replies; full platform
  authentication/application qualification remains separate.

These are the documented scope of this integration, not promises of complete
Codex parity. See [the capability and qualification reference](../reference/backend-capabilities.md#copilot-known-capability-gaps)
for the SDK/JSONL differences, tested versions and remaining hosted/platform
evidence limits.

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
