# Knowledge Base

The Knowledge Base is the long-lived document layer for a workspace. It lets you
upload source material, process it locally, and make it available to supported
AI backends during conversations.

## Supported Sources

Agent Cockpit can ingest PDFs, Word documents, PowerPoints, images, CSV/TSV
files, Markdown, and text-like files. Optional tools such as LibreOffice and
Pandoc expand conversion coverage for office and document formats.

Image conversion and attachment OCR require the selected backend and model to
report image input support. Text-only models can still use text-based Knowledge
Base entries after ingestion.

## What Happens During Ingestion

Agent Cockpit stores the raw file, converts it when needed, extracts structured
entries, organizes topics, and builds local indexes for retrieval.

The goal is not to dump whole documents into prompts. The goal is to retrieve
the right source-backed material when a conversation needs it.

## Good Uses

- codebase documentation;
- research folders;
- meeting notes;
- product specs;
- business or legal reading material;
- personal study notes.

## Data Ownership

Knowledge Base artifacts live under the local Agent Cockpit data directory for
the workspace. The model provider only sees content when a selected backend is
asked to use it during a conversation.
