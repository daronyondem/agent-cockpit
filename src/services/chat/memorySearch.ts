import type {
  MemoryFile,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryStatus,
  MemoryType,
} from '../../types';
import { memorySourceFromFilename, normalizeMemorySource } from './memoryMetadata';

export const MEMORY_SEARCH_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with',
]);

export function tokenizeMemorySearch(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || [];
  return matches
    .map((token) => token.replace(/^_+|_+$/g, ''))
    .filter((token) => token.length >= 2 && !MEMORY_SEARCH_STOPWORDS.has(token));
}

function memorySearchText(file: MemoryFile): string {
  return [
    file.name || '',
    file.name || '',
    file.description || '',
    file.description || '',
    file.description || '',
    file.type,
    file.filename,
    file.content || '',
  ].join('\n');
}

function normalizeMemorySearchField(value: string | null | undefined): string {
  return tokenizeMemorySearch(value || '').join(' ');
}

function memorySearchExactBoost(file: MemoryFile, normalizedQuery: string, queryTerms: string[]): number {
  if (!normalizedQuery) return 0;
  let boost = 0;
  const fields = [
    { value: file.name, exact: 6, contains: 3, term: 0.5 },
    { value: file.description, exact: 4, contains: 2, term: 0.35 },
    { value: file.filename, exact: 3, contains: 1.5, term: 0.25 },
  ];

  for (const field of fields) {
    const normalized = normalizeMemorySearchField(field.value);
    if (!normalized) continue;
    if (normalized === normalizedQuery) {
      boost += field.exact;
    } else if (normalized.includes(normalizedQuery)) {
      boost += field.contains;
    }
    const tokens = new Set(normalized.split(' ').filter(Boolean));
    const matchedTerms = queryTerms.filter((term) => tokens.has(term)).length;
    boost += matchedTerms * field.term;
  }

  return boost;
}

function memorySearchTypeBoost(
  file: MemoryFile,
  queryTerms: string[],
  allowedTypes: Set<MemoryType> | null,
): number {
  let boost = 0;
  if (allowedTypes?.has(file.type)) boost += 0.75;
  if (queryTerms.includes(file.type)) boost += 2;
  return boost;
}

function memorySearchTimestamp(file: MemoryFile): number {
  const raw = file.metadata?.updatedAt || file.metadata?.createdAt || '';
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : 0;
}

export function memorySearchSnippet(content: string, queryTerms: string[]): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const lower = compact.toLowerCase();
  let index = -1;
  for (const term of queryTerms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  const start = index === -1 ? 0 : Math.max(0, index - 90);
  const end = Math.min(compact.length, start + 260);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

export function searchMemoryFiles(files: MemoryFile[], options: MemorySearchOptions): MemorySearchResult[] {
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  const queryTerms = [...new Set(tokenizeMemorySearch(query))];
  if (queryTerms.length === 0) return [];
  const normalizedQuery = queryTerms.join(' ');

  const limit = Number.isInteger(options.limit)
    ? Math.max(1, Math.min(20, options.limit || 5))
    : 5;
  const allowedTypes: Set<MemoryType> | null = options.types && options.types.length
    ? new Set(options.types)
    : null;
  const allowedStatuses = options.statuses && options.statuses.length
    ? new Set(options.statuses)
    : new Set<MemoryStatus>(['active', 'redacted']);

  const searchableFiles = files
    .filter((file) => file.metadata)
    .filter((file) => allowedStatuses.has(file.metadata!.status))
    .filter((file) => !allowedTypes || allowedTypes.has(file.type));
  if (searchableFiles.length === 0) return [];

  const docs = searchableFiles.map((file) => {
    const tokens = tokenizeMemorySearch(memorySearchText(file));
    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    return { file, tokens, counts };
  });
  const avgLen = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / Math.max(1, docs.length);
  const k1 = 1.2;
  const b = 0.75;

  const scored = docs.map((doc) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.counts.get(term) || 0;
      if (tf === 0) continue;
      const df = docs.reduce((count, candidate) => count + (candidate.counts.has(term) ? 1 : 0), 0);
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const lenNorm = k1 * (1 - b + b * (doc.tokens.length / Math.max(1, avgLen)));
      score += idf * ((tf * (k1 + 1)) / (tf + lenNorm));
    }
    score += memorySearchExactBoost(doc.file, normalizedQuery, queryTerms);
    score += memorySearchTypeBoost(doc.file, queryTerms, allowedTypes);
    return { ...doc, score, updatedAtMs: memorySearchTimestamp(doc.file) };
  })
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || b.updatedAtMs - a.updatedAtMs || a.file.filename.localeCompare(b.file.filename))
    .slice(0, limit);

  return scored.map((doc) => {
    const metadata = doc.file.metadata!;
    return {
      filename: doc.file.filename,
      entryId: metadata.entryId,
      name: doc.file.name,
      description: doc.file.description,
      type: doc.file.type,
      source: normalizeMemorySource(doc.file.source, memorySourceFromFilename(doc.file.filename)),
      status: metadata.status,
      score: Math.round(doc.score * 1000) / 1000,
      snippet: memorySearchSnippet(doc.file.content, queryTerms),
      content: doc.file.content,
      metadata,
    };
  });
}
