# Agent Cockpit Deploy Guide

Agent Cockpit is a local server application. The production installers set up
that server, write runtime config, start PM2, and open first-run owner setup.

## Install

- [macOS install](macos.md)
- [Windows install](windows.md)
- [Development setup](../reference/development.md)

## Configure Access

- [Security and owner auth](security.md)
- [Remote access](remote-access.md)

## Maintain

- [Install Doctor](install-doctor.md)
- [Updates](updates.md)
- [Environment variables](../reference/environment-variables.md)
- [Data layout](../reference/data-layout.md)

## Important Deployment Boundaries

- Agent Cockpit runs on the same machine as the vendor CLIs.
- The normal production path is a local server, not hosted SaaS.
- The first owner account should be created before exposing the server. If it
  must be exposed first, configure `AUTH_SETUP_TOKEN`.
- PM2 is the supported process manager for persistent local server operation.
