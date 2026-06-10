---
id: 0087
title: Use type-aware ESLint for promise correctness
status: Accepted
date: 2026-06-10
supersedes: []
superseded-by: null
tags: [tooling, testing]
affects:
  - eslint.config.mjs
  - package.json
  - package-lock.json
  - .github/workflows/test.yml
  - .github/workflows/release.yml
  - AGENTS.md
  - docs/agent-project-memory.md
  - docs/spec-testing.md
  - docs/reference/testing.md
---

## Context

Agent Cockpit did not have an ESLint gate. TypeScript strict mode checks static
types, and `scripts/check-maintainability.js` checks project-specific
boundaries such as backend console usage and frontend/server import boundaries,
but neither catches unhandled promises in async-heavy code. That leaves a real
defect class in PTY lifecycles, stream finalizers, durable queues, timers,
fire-and-forget persistence, and browser event handlers.

The codebase also has existing dynamic JSON and CLI protocol surfaces where
the broader type-aware recommended rule set produces high-volume findings that
are not part of the promise-correctness problem. A first ESLint gate must avoid
repo-wide formatting churn or a broad safety cleanup that would obscure the
behavioral changes under review.

## Decision

Add a root flat `eslint.config.mjs` and root `npm run lint` script. The gate
uses root-installed `eslint`, `@eslint/js`, `typescript-eslint`, and
`eslint-plugin-react-hooks`. The root package owns the lint tooling for the
root server/test code, desktop web app, and mobile PWA; the mobile package does
not install its own ESLint stack.

ESLint owns promise-correctness rules and React hook-order checks:

- `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`, `@typescript-eslint/await-thenable`, and `@typescript-eslint/no-unnecessary-type-assertion` are errors in type-aware TypeScript blocks.
- `react-hooks/rules-of-hooks` is an error for web and mobile React sources.
- `react-hooks/exhaustive-deps` remains a warning because the existing React code uses intentional dependency idioms that should not be mechanically rewritten in this change.

Plain JS/CJS/MJS tooling and web JS/JSX use `eslint:recommended` as warnings.
Other TypeScript recommended rules are disabled in the initial gate because
they are noisy against existing dynamic protocol code and are outside the
promise-correctness scope. Existing project-specific maintainability rules stay
in `scripts/check-maintainability.js`; ESLint does not duplicate console policy
or frontend import-boundary policy.

The PR and release workflows run `npm run lint` after typecheck/build checks and
before maintainability/spec drift checks. The command fails on lint errors.
Current warnings are allowed and grouped as React exhaustive-deps warnings,
stale historical disable comments, and JS `eslint:recommended` findings.

## Alternatives Considered

- **Prettier plus stylistic linting**: Rejected because this change targets correctness, and repo-wide formatting would create blame churn without addressing unhandled promises.
- **Keep relying on TypeScript and review**: Rejected because strict typechecking does not report floating promises or promise-returning callbacks passed to void-typed APIs.
- **Enable the full type-aware recommended rule set as errors immediately**: Rejected because the current codebase has many legacy dynamic JSON/CLI findings unrelated to promise correctness. Enforcing them in the first gate would turn the change into a broad refactor.
- **Move existing maintainability checks into ESLint**: Rejected because `scripts/check-maintainability.js` already owns custom repository policies and moving them would double-source boundary rules.

## Consequences

- + CI now fails on unhandled promises, promise-returning void callbacks, await-on-non-thenable mistakes, unnecessary assertions, and invalid React hook ordering.
- + Intentional fire-and-forget work must be marked with `void`, making the lifecycle decision visible in review.
- - The initial gate still emits warnings for existing React dependency, stale disable, and JS recommended findings; those require separate cleanup if the project wants a zero-warning lint run.
- ~ The broader type-aware recommended rules are installed but not enforced yet. Future PRs can promote specific rules once their finding volume is reviewed.

## References

- Refs #423.
- [Testing & CI/CD spec](../spec-testing.md)
