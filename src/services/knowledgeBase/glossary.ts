export interface GlossaryExpansionTerm {
  term: string;
  expansion: string;
}

export interface GlossaryExpansionMatch {
  term: string;
  expansion: string;
}

export interface GlossaryExpansionResult {
  originalQuery: string;
  expandedQuery: string;
  matches: GlossaryExpansionMatch[];
}

export function expandGlossaryQuery(
  query: string,
  glossary: GlossaryExpansionTerm[],
): GlossaryExpansionResult {
  type Replacement = {
    start: number;
    end: number;
    matched: string;
    term: string;
    expansion: string;
  };

  const replacements: Replacement[] = [];

  const ordered = [...glossary].sort(
    (a, b) => b.term.trim().length - a.term.trim().length || a.term.localeCompare(b.term),
  );

  for (const row of ordered) {
    const term = row.term.trim();
    const expansion = row.expansion.trim();
    if (!term || !expansion) continue;
    const re = termRegex(term);
    let match: RegExpExecArray | null;
    while ((match = re.exec(query)) !== null) {
      const prefix = match[1] ?? '';
      const matched = match[2] ?? '';
      const start = match.index + prefix.length;
      const end = start + matched.length;
      if (!matched || replacements.some((r) => start < r.end && end > r.start)) continue;
      replacements.push({ start, end, matched, term, expansion });
    }
  }

  let expandedQuery = query;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    expandedQuery = `${expandedQuery.slice(0, replacement.start)}${replacement.matched} (${replacement.expansion})${expandedQuery.slice(replacement.end)}`;
  }

  const seen = new Set<string>();
  const matches: GlossaryExpansionMatch[] = [];
  for (const { term, expansion } of replacements) {
    const key = `${term}\0${expansion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ term, expansion });
  }

  return {
    originalQuery: query,
    expandedQuery,
    matches,
  };
}

function termRegex(term: string): RegExp {
  const escaped = escapeRegExp(term).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^A-Za-z0-9_])(${escaped})(?=$|[^A-Za-z0-9_])`, 'gi');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
