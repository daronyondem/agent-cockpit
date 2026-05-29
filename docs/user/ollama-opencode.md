# Open Source Models With Ollama And OpenCode

Agent Cockpit can run local and open-source models through OpenCode when
OpenCode is configured to use Ollama as a model provider. This guide shows the
persistent setup path that works with Agent Cockpit.

## How The Pieces Fit

| Layer | Role |
| --- | --- |
| Ollama | Downloads models and serves them from the local machine. |
| OpenCode | Acts as the CLI backend and sends prompts to configured providers. |
| Agent Cockpit | Starts OpenCode, discovers its provider-scoped model list, and streams the conversation in the browser. |

Agent Cockpit does not talk to Ollama directly for chat. It talks to OpenCode.
Ollama is only the local model runtime behind the OpenCode provider.

## Before You Start

Install these on the same machine that runs the Agent Cockpit server:

- Agent Cockpit.
- [Ollama](https://ollama.com/download).
- [OpenCode](https://opencode.ai/docs/cli/).

Pull only models that fit the machine. Large models can consume a lot of
unified memory or VRAM, and a model that appears in OpenCode still needs to be
pulled in Ollama before it can run.

## 1. Pull A Local Model

Start Ollama if it is not already running:

```bash
ollama serve
```

On macOS, the Ollama desktop app usually starts the server for you.

Pull the model you want to use:

```bash
ollama pull qwen3-coder:30b
```

For a heavier reasoning model on high-memory hardware:

```bash
ollama pull gpt-oss:120b
```

Verify what is available locally:

```bash
ollama list
```

## 2. Configure OpenCode Persistently

Create or edit one of OpenCode's global config files:

```text
~/.config/opencode/opencode.jsonc
~/.config/opencode/opencode.json
```

Add an `ollama` provider. If the file already has a `provider` object, merge
this provider into it instead of replacing existing providers.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen3-coder:30b": {
          "name": "Qwen3 Coder 30B"
        },
        "gpt-oss:120b": {
          "name": "GPT-OSS 120B"
        }
      }
    }
  }
}
```

The model keys must match the tags from `ollama list`. Add or remove entries
for the models you actually want OpenCode and Agent Cockpit to offer.

## Why Not `ollama launch opencode`?

Ollama can start OpenCode with:

```bash
ollama launch opencode --model qwen3-coder:30b
```

That is useful for a one-off terminal session, but it is not the right setup
for Agent Cockpit. Ollama passes that integration config to OpenCode through the
`OPENCODE_CONFIG_CONTENT` environment variable at launch time. The config is
deep-merged for that process, but it is not the persistent OpenCode config that
Agent Cockpit will discover when it starts OpenCode itself.

For Agent Cockpit, use the persistent `~/.config/opencode/opencode.jsonc` or
`opencode.json` configuration above.

## 3. Verify OpenCode Sees The Models

Run:

```bash
opencode models ollama
```

Expected model ids use the `provider/model` shape:

```text
ollama/qwen3-coder:30b
ollama/gpt-oss:120b
```

For full metadata, run:

```bash
opencode models ollama --verbose
```

If `opencode` is installed but not on the server process `PATH`, Agent Cockpit
can usually find common OpenCode install paths such as
`~/.opencode/bin/opencode` on macOS and Linux. If the profile check still fails,
set the OpenCode command path explicitly in the CLI profile.

## 4. Add An OpenCode Profile In Agent Cockpit

Open Agent Cockpit and go to **Settings -> CLI Profiles**.

1. Add or edit a CLI profile.
2. Set the harness to **OpenCode**.
3. Set the OpenCode provider to `ollama`.
4. Run **Check OpenCode**.
5. Save settings.

OpenCode profiles store the provider. Model choice stays in the chat composer
or in the model picker for a processor feature such as Knowledge Base digestion
or Workspace Context.

Start a conversation, select the OpenCode profile, then select a model such as:

```text
ollama/qwen3-coder:30b
```

## 5. Manage Ollama Model Lifecycle

Ollama separates model files on disk from models loaded in memory.

| Command | Purpose |
| --- | --- |
| `ollama list` | Show pulled models on disk. |
| `ollama ps` | Show models currently loaded in memory. |
| `ollama pull <model>` | Download or update a model. |
| `ollama stop <model>` | Unload a loaded model from memory. |
| `ollama rm <model>` | Delete a model from disk. |

The first OpenCode request can be slow because Ollama has to load the model.
After the request finishes, Ollama keeps the model loaded until its idle unload
timer expires unless you changed Ollama's keep-alive behavior.

## Model Capabilities

Local model capabilities are model-specific.

- `qwen3-coder:30b` is a text-only coding model. It does not accept images and
  does not provide OpenAI-style reasoning effort levels.
- `gpt-oss:120b` is a larger general reasoning model. It may be useful for
  analysis-heavy work on machines with enough memory, but it is much heavier
  than 30B-class models.
- OpenCode effort choices appear only when the selected OpenCode model advertises
  supported variants. Many Ollama models will show no effort picker in Agent
  Cockpit.
- Image, PDF, audio, and video workflows require model capability metadata that
  says the input modality is supported. Text-only Ollama models still work for
  normal chat and text-based context workflows.

## Knowledge Base Embeddings Are Separate

Agent Cockpit's Knowledge Base can also use Ollama for embeddings. That is a
separate KB setting and defaults to `nomic-embed-text` when configured.

The OpenCode/Ollama setup in this guide controls chat and processor model
selection through OpenCode. It does not configure KB embeddings.

## Troubleshooting

**`opencode models ollama` says the provider is missing**

Check that the provider is in OpenCode's persistent config file, not only in an
`ollama launch opencode` session. The provider key should be `ollama`.

**The model appears but fails when used**

Run `ollama list` and make sure the exact model tag has been pulled. OpenCode can
list configured models even before Ollama has downloaded them.

**Agent Cockpit cannot find OpenCode**

Run `opencode --version` in a terminal. If that works but Agent Cockpit's check
does not, set the profile command path explicitly. Common macOS/Linux installs
include `~/.opencode/bin/opencode`.

**The first response is slow**

Run `ollama ps` during or after the request. If the model was not loaded, Ollama
is paying the first-load cost. Smaller models and already-loaded models respond
faster.

**The machine runs out of memory**

Stop the loaded model:

```bash
ollama stop qwen3-coder:30b
```

Then choose a smaller model or a smaller quantization.

## Related Docs

- [Supported Backends](backends.md)
- [Knowledge Base](knowledge-base.md)
- [Ollama OpenCode integration](https://docs.ollama.com/integrations/opencode)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [OpenCode providers](https://opencode.ai/docs/providers/)
