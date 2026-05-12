---
id: 0056
title: Adopt Apache 2.0 repository license
status: Accepted
date: 2026-05-12
supersedes: []
superseded-by: null
tags: [licensing, distribution]
affects:
  - LICENSE
  - README.md
  - package.json
  - package-lock.json
  - mobile/AgentCockpitPWA/package.json
  - mobile/AgentCockpitPWA/package-lock.json
---

## Context

Agent Cockpit is moving from an ambiguous repository licensing state to an
explicit open-source license. The project is positioned as a local-first,
vendor-neutral substrate: users run it on machines they control, keep their
conversation and knowledge data on disk, and can switch AI backends without
resetting accumulated context.

The licensing model needs to support trust, inspection, modification,
redistribution, and broad adoption without adding friction for individual users,
companies, or future packaging work. The repository also needs machine-readable
SPDX metadata in its package manifests so downstream tools can detect the
license consistently.

## Decision

Agent Cockpit is licensed under the Apache License, Version 2.0.

The repository carries the full Apache-2.0 license text in `LICENSE`, declares
`Apache-2.0` in the root and mobile package manifests, and documents the license
from the README.

## Alternatives Considered

- **No explicit license**: rejected because public source without a license is
  ambiguous for users and contributors and does not clearly permit normal
  open-source use.
- **AGPL-3.0**: rejected because it protects against closed hosted forks, but
  adds more adoption friction than this project currently needs. Agent Cockpit's
  near-term value is trust, portability, and self-hosted use rather than
  preventing commercial hosted derivatives.
- **Source-available or noncommercial licensing**: rejected because it would not
  be open source and would conflict with the repository's trust and adoption
  goals.

## Consequences

- + Users and companies can inspect, run, modify, redistribute, and package
  Agent Cockpit under a widely understood OSI-approved license.
- + The license includes an explicit patent grant and leaves trademark rights
  ungranted except as needed to describe origin.
- - Apache-2.0 does not require hosted or proprietary derivatives to publish
  their modifications.
- ~ Commercial offerings, hosted control-plane services, support, and
  methodology content can still be licensed separately because the Apache-2.0
  grant applies to the repository code, not every future product or brand asset.

## References

- [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0.html)
- [README License section](../../README.md#license)
