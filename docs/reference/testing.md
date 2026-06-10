# Testing

Tests use Jest for the main suite and separate commands for web, mobile, and
real-CLI compatibility checks.

## Common Checks

```bash
npm run typecheck
npm run lint
npm test
npm run maintainability:check
npm run spec:drift
```

## Web And Mobile

```bash
npm run web:typecheck
npm run web:build
npm run web:budget
npm run mobile:typecheck
npm run mobile:build
```

## Claude Code Interactive Compatibility

These suites require an authenticated real `claude` CLI and are intentionally
not part of normal CI:

```bash
npm run e2e:claude-interactive:report
npm run e2e:claude-interactive-ui:report
```

Review the Claude Code Interactive compatibility guidance in [AGENTS.md](../../AGENTS.md)
before changing that backend path.
