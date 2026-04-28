// Scaffold a new ADR with the next available ID.
// Usage: npm run adr:new -- "Short title in present tense"

const fs = require('fs');
const path = require('path');

const ADR_DIR = path.join(__dirname, '..', 'docs', 'adr');

function kebab(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function nextId() {
  const ids = fs.readdirSync(ADR_DIR)
    .map(f => f.match(/^(\d{4})-/))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  return ids.length === 0 ? 1 : Math.max(...ids) + 1;
}

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function main() {
  const title = process.argv.slice(2).join(' ').trim();
  if (!title) {
    console.error('Usage: npm run adr:new -- "Short title in present tense"');
    process.exit(1);
  }
  const slug = kebab(title);
  if (!slug) {
    console.error('Title produced an empty slug. Use plain-language characters.');
    process.exit(1);
  }
  const id = String(nextId()).padStart(4, '0');
  const filename = `${id}-${slug}.md`;
  const filepath = path.join(ADR_DIR, filename);

  const body = `---
id: ${id}
title: ${title}
status: Proposed
date: ${today()}
supersedes: []
superseded-by: null
tags: []
affects: []
---

## Context

<Why this decision needs to be made. Constraints, prior state, problem being solved.>

## Decision

<What we decided, in present tense.>

## Alternatives Considered

- **Option A**: <description>. Rejected because <reason>.
- **Option B**: <description>. Rejected because <reason>.

## Consequences

- + <Positive outcome>
- - <Negative outcome / cost>
- ~ <Neutral or known tradeoff>

## References

- <Related ADRs, PRs, issues, SPEC sections>
`;

  fs.writeFileSync(filepath, body, { flag: 'wx' });
  console.log(`Created ${path.relative(process.cwd(), filepath)}`);
}

main();
