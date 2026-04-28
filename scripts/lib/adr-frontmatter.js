// Minimal YAML frontmatter parser tailored to ADR shape.
// Supported: scalar key:value, `null`, inline `[]`, inline `[a, b]`, multi-line `- item` lists.
// Not a general YAML parser — keep ADR frontmatter to the documented shape.

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let listKey = null;
  for (const raw of lines) {
    if (/^\s+-\s+/.test(raw)) {
      if (listKey) fm[listKey].push(raw.replace(/^\s+-\s+/, '').trim());
      continue;
    }
    listKey = null;
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val === '') {
      fm[key] = [];
      listKey = key;
    } else if (val === 'null' || val === '~') {
      fm[key] = null;
    } else if (val === '[]') {
      fm[key] = [];
    } else if (/^\[(.*)\]$/.test(val)) {
      fm[key] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      const unquoted = val.replace(/^["'](.*)["']$/, '$1');
      fm[key] = unquoted;
    }
  }
  return fm;
}

module.exports = { parseFrontmatter };
