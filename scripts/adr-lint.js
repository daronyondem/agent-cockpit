// Validate every ADR file: frontmatter, filename, paths, sections.
// Exits non-zero if any ADR fails validation.

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./lib/adr-frontmatter');

const ROOT = path.join(__dirname, '..');
const ADR_DIR = path.join(ROOT, 'docs', 'adr');

const REQUIRED_FIELDS = ['id', 'title', 'status', 'date', 'supersedes', 'superseded-by', 'tags', 'affects'];
const VALID_STATUS = ['Proposed', 'Accepted', 'Deprecated', 'Superseded'];
const REQUIRED_SECTIONS = ['## Context', '## Decision', '## Alternatives Considered', '## Consequences', '## References'];

function lintFile(file) {
  const errors = [];
  const fp = path.join(ADR_DIR, file);
  const content = fs.readFileSync(fp, 'utf8');

  const nameMatch = file.match(/^(\d{4})-([a-z0-9-]+)\.md$/);
  if (!nameMatch) {
    errors.push('filename does not match NNNN-kebab-case.md');
    return errors;
  }

  const fm = parseFrontmatter(content);
  if (!fm) {
    errors.push('missing or malformed frontmatter');
    return errors;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in fm)) errors.push(`missing required frontmatter field: ${field}`);
  }

  if (fm.id && fm.id !== nameMatch[1]) {
    errors.push(`frontmatter id (${fm.id}) does not match filename id (${nameMatch[1]})`);
  }

  if (fm.status && !VALID_STATUS.includes(fm.status)) {
    errors.push(`invalid status: ${fm.status} (expected one of: ${VALID_STATUS.join(', ')})`);
  }

  if (fm.status === 'Superseded' && !fm['superseded-by']) {
    errors.push('status is Superseded but superseded-by is not set');
  }
  if (fm['superseded-by'] != null && fm.status !== 'Superseded') {
    errors.push('superseded-by is set but status is not Superseded');
  }
  if (fm['superseded-by']) {
    const supId = String(fm['superseded-by']).padStart(4, '0');
    const found = fs.readdirSync(ADR_DIR).some(f => f.startsWith(`${supId}-`));
    if (!found) errors.push(`superseded-by references unknown ADR ${fm['superseded-by']}`);
  }

  // Historical ADRs are archival snapshots; their original `affects` references may
  // point at files that were deliberately removed by later accepted decisions.
  const isHistorical = Array.isArray(fm.tags) && fm.tags.includes('historical');
  if (Array.isArray(fm.affects) && !isHistorical) {
    for (const p of fm.affects) {
      const abs = path.join(ROOT, p);
      if (!fs.existsSync(abs)) errors.push(`affects: path does not exist: ${p}`);
    }
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) errors.push(`missing required section: ${section}`);
  }

  return errors;
}

function main() {
  if (!fs.existsSync(ADR_DIR)) {
    console.error(`ADR directory not found: ${ADR_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(ADR_DIR)
    .filter(f => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('_'));

  let totalErrors = 0;
  for (const file of files) {
    const errors = lintFile(file);
    if (errors.length === 0) {
      console.log(`[ok]   ${file}`);
    } else {
      console.log(`[fail] ${file}`);
      for (const e of errors) console.log(`       - ${e}`);
      totalErrors += errors.length;
    }
  }

  if (totalErrors > 0) {
    console.error(`\n${totalErrors} ADR lint error(s) across ${files.length} file(s).`);
    process.exit(1);
  }
  console.log(`\nAll ${files.length} ADR(s) valid.`);
}

main();
