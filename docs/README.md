# Agent Cockpit Documentation

Agent Cockpit is a local browser cockpit for CLI-based AI agents. It gives you a
browser interface for Claude Code, OpenAI Codex, and Kiro while keeping
conversations, memory, knowledge-base material, and workspace context on your
machine.

Use this page as the public documentation entry point. The implementation
specification remains in [SPEC.md](SPEC.md).

## User Guide

Start here if you are installing or using Agent Cockpit.

- [User Guide](user/README.md)
- [Quickstart](user/quickstart.md)
- [Supported backends](user/backends.md)
- [Memory](user/memory.md)
- [Knowledge Base](user/knowledge-base.md)
- [Workspace Context](user/workspace-context.md)
- [Worktree Isolation](user/worktree-isolation.md)
- [Mobile PWA](user/mobile-pwa.md)

## Deploy Guide

Use these docs when setting up, exposing, updating, or troubleshooting the local
server.

- [Deploy Guide](deploy/README.md)
- [macOS install](deploy/macos.md)
- [Windows install](deploy/windows.md)
- [Remote access](deploy/remote-access.md)
- [Security and owner auth](deploy/security.md)
- [Install Doctor](deploy/install-doctor.md)
- [Updates](deploy/updates.md)

## Reference

Technical reference for advanced users and contributors.

- [Reference](reference/README.md)
- [Environment variables](reference/environment-variables.md)
- [Data layout](reference/data-layout.md)
- [Backend capabilities](reference/backend-capabilities.md)
- [Development](reference/development.md)
- [Testing](reference/testing.md)

## Project Sources Of Truth

- [Specification](SPEC.md) describes implemented behavior.
- [Architecture Decision Records](adr/README.md) describe major decisions and
  rejected alternatives.
- [Product positioning](product-positioning.md) defines public message
  architecture.
- [Release workflow](release-workflow.md) describes production release
  preparation.
