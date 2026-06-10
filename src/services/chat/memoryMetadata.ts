import crypto from 'crypto';
import type {
  MemoryEntryMetadata,
  MemoryMetadataIndex,
  MemoryRedaction,
  MemoryScope,
  MemorySource,
  MemoryStatus,
} from '../../types';

/**
 * Turn an arbitrary string into a short, filesystem-safe slug. Used to
 * build memory-note filenames like `note_<timestamp>_<slug>.md`.
 */
export function slugify(input: string): string {
  const cleaned = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'note';
}

export function memoryEntryId(filename: string): string {
  const digest = crypto.createHash('sha256').update(filename).digest('hex').slice(0, 16);
  return `mem_${digest}`;
}

export function normalizeMemorySource(value: unknown, fallback: MemorySource): MemorySource {
  if (value === 'cli-capture' || value === 'memory-note' || value === 'session-extraction') return value;
  return fallback;
}

export function memorySourceFromFilename(filename: string): MemorySource {
  if (filename.startsWith('notes/session_')) return 'session-extraction';
  if (filename.startsWith('notes/')) return 'memory-note';
  return 'cli-capture';
}

export function normalizeMemoryStatus(value: unknown): MemoryStatus {
  if (value === 'active' || value === 'superseded' || value === 'redacted' || value === 'deleted') return value;
  return 'active';
}

export function normalizeMemoryScope(value: unknown): MemoryScope {
  if (value === 'user') return 'user';
  return 'workspace';
}

export function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return strings.length ? strings : undefined;
}

export function normalizeMemoryRedaction(value: unknown): MemoryRedaction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const redaction = value
    .filter((item): item is { kind: string; reason: string } =>
      !!item
      && typeof item === 'object'
      && typeof (item as { kind?: unknown }).kind === 'string'
      && typeof (item as { reason?: unknown }).reason === 'string',
    )
    .map((item) => ({ kind: item.kind, reason: item.reason }));
  return redaction.length ? redaction : undefined;
}

export function emptyMemoryMetadataIndex(now = new Date().toISOString()): MemoryMetadataIndex {
  return {
    version: 1,
    updatedAt: now,
    entries: {},
  };
}

export function normalizeMemoryMetadata(
  raw: unknown,
  fallbackFilename: string,
  fallbackSource: MemorySource,
  now: string,
): MemoryEntryMetadata {
  const candidate = raw && typeof raw === 'object'
    ? raw as Partial<MemoryEntryMetadata>
    : {};
  const filename = typeof candidate.filename === 'string' && candidate.filename
    ? candidate.filename
    : fallbackFilename;
  const createdAt = typeof candidate.createdAt === 'string' && candidate.createdAt
    ? candidate.createdAt
    : now;
  const updatedAt = typeof candidate.updatedAt === 'string' && candidate.updatedAt
    ? candidate.updatedAt
    : createdAt;
  const confidence = typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
    ? candidate.confidence
    : undefined;
  const supersedes = normalizeStringArray(candidate.supersedes);
  const redaction = normalizeMemoryRedaction(candidate.redaction);
  return {
    entryId: typeof candidate.entryId === 'string' && candidate.entryId
      ? candidate.entryId
      : memoryEntryId(filename),
    filename,
    status: normalizeMemoryStatus(candidate.status),
    scope: normalizeMemoryScope(candidate.scope),
    source: normalizeMemorySource(candidate.source, fallbackSource),
    createdAt,
    updatedAt,
    ...(typeof candidate.sourceConversationId === 'string' && candidate.sourceConversationId
      ? { sourceConversationId: candidate.sourceConversationId }
      : {}),
    ...(supersedes ? { supersedes } : {}),
    ...(typeof candidate.supersededBy === 'string' && candidate.supersededBy
      ? { supersededBy: candidate.supersededBy }
      : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(redaction ? { redaction } : {}),
  };
}
