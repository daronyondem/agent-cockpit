# Cortex Code (CoCo)

Agent Cockpit supports Cortex Code as a CLI harness through native ACP. The
tested baseline is **CoCo 1.2.35 on macOS arm64**. Native Ubuntu and Windows
acceptance is pending; Windows x64 runtime code is implemented with simulated
tests and remains uncertified. Windows installation and updates are manual.
Physical
iOS/Android devices and newer CLI releases are not certified by these tests.

## Install and select a profile

Install the [official standalone CoCo CLI](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli)
on the machine running the Cockpit server. Welcome and Install Doctor offer the
official optional installation action on eligible POSIX systems. A successful
install/version check does not prove login or native platform compatibility.
The official installer can also set up shell completion. Do not assume CoCo is
an npm package.

Check the installed version without requesting an automatic update:

```sh
cortex --no-auto-update --version
```

In **Settings → CLI Profiles**, add or expand a profile and select
**Cortex Code (CoCo)** as the Harness. Its **Cortex Code setup** section appears
inside that card. Choose an existing named Snowflake connection, or use **Create OAuth connection**
and **Save connection** to create a new one with your account and user. Existing
connection entries/comments are preserved; an existing name is never overwritten.
The profile stores the connection name. Native Snowflake configuration owns
credentials. An unconfigured profile cannot become the default.

Use **Check Cortex login** in the same card to verify saved access with
fresh-process inference. Check/authenticate saves the current settings first and
uses that exact profile; it does not create another setup profile or change your
default selection.
Model discovery and finding connections alone do not establish authentication.
Normal setup shares the server user's terminal Snowflake credentials. A separate
profile or named connection is not a promise of account/cache isolation.

## Authenticate using a browser on another machine

The dedicated setup panel implements the native manual OAuth handoff:

1. Select the connection and click **Authenticate Cortex**.
2. Copy the complete **Native login URL** into a browser on your other machine
   and sign in before the deadline shown in Cockpit.
3. The browser redirects to `http://127.0.0.1:<port>/?code=…&state=…&iss=…`.
   A connection error on the browser machine is expected. Copy the complete
   address, paste it into **Complete redirect URL**, and click **Submit redirect**.
4. Wait for fresh-process verification to finish. If the job expires or you
   cancel it, start a new job and use its new URL/redirect.

URLs and redirects belong to that active login job. Do not place them in chat,
screenshots, logs or persistent configuration. The earlier direct-CLI human
handoff succeeded, and automated Cockpit ownership/lifecycle checks pass. The
actual human remote-browser run through this Cockpit panel remains C26 pending;
the instructions describe the implemented flow, not a completed acceptance claim.

## Choose models and workflows

Choose the profile in the desktop or mobile composer, then choose from the
connection's discovered models and effort values. Catalogs are profile-specific;
the harness stays CoCo regardless of the selected model vendor.

The **Effort** control includes levels such as **High**, **Xhigh**, and **Max**
when the native CLI advertises them. On mobile, open **Run Settings** to select
the level. If a saved model is no longer available, select a current model from
the list to restore effort choices; Cockpit retains the saved effort visibly
rather than silently replacing it. If model discovery is unavailable, refresh
or check Cortex login in Settings.

Verified workflows include durable chat, thinking/tools, questions, plan approval
and revision, saved-session resume, file delivery, Memory/KB MCP access, KB
ingestion/digestion/gleaning/dreaming, Workspace Context and Routines. Queues,
Stop, reconnect, history and mobile OCR have native browser coverage. Routine
outreach acceptance uses a stub, not a real delivered message.

In **Settings → Memory**, CoCo can now be selected for governance, extraction
and consolidation on macOS arm64 with the exact standalone build
`1.2.35+191333.f82de3d91715`. Restricted jobs run with zero tool definitions in
a private native configuration; another build/platform is rejected. Model and
effort use the saved Memory choices. Titles/summaries retain their existing
fallbacks. Tool-enabled KB, Context and Routine processors select CoCo independently. Missing/disabled saved choices
remain visible and require an explicit change; Cockpit does not silently switch
the account or harness. KB embeddings need configured Ollama; Office conversion
needs Pandoc/LibreOffice as described in the KB setup docs.

Native image/OCR input currently requires PNG and the tested
`claude-sonnet-4-6` model/1.2.35 combination. KB conversion prepares PNG from
supported document/image sources while preserving originals. This does not
enable direct native PDF/audio/video input. OCR model/effort choices apply to
that OCR invocation without changing the stored chat selection.

Tokens include cache buckets; context occupancy is a separate snapshot. Cost
shows unavailable because Snowflake charges have not been reconciled. It is not
free usage and does not use direct model-vendor rates.

## Stop, updates and migration

Stop drains native work. Resume or a new explicit message may load the saved
session, but interrupted work is never automatically resent. Goals, subagent
cards, unsolicited mid-turn steering, broader media and account isolation are
deferred; see the [capability decisions](../research/cortex-code-capability-decisions.md).

Cockpit-managed updates are limited to the verified macOS 1.2.35 standard
activation layout at `~/.local/bin/cortex`. Other versions/layouts/platforms need
manual review; a downloaded/current upstream version is not automatically
certified. Keep normal native settings/auth and rerun compatibility checks when
changing CLI versions.

Full-data export/import preserves Cockpit profiles and selections. External
executables and Snowflake homes are not included. Restore the CLI and connection
on the destination, review absolute paths and use **Check Cortex login**; passive
import checks never start login or inference. See [data layout](../reference/data-layout.md).

For exact runtime contracts, see [the CoCo spec](../spec-cortex-code.md). Developer
verification commands and fixture prerequisites are in [the testing spec](../spec-testing.md#coco-complete-workflow-fixtures-p9-c55).
