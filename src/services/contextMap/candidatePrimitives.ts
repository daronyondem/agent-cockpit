export const CONTEXT_MAP_BUILT_IN_ENTITY_TYPES = new Set([
  'person',
  'organization',
  'project',
  'workflow',
  'document',
  'feature',
  'concept',
  'decision',
  'tool',
  'asset',
]);

export const CONTEXT_MAP_TYPE_ALIASES = new Map<string, string>([
  ['company', 'organization'],
  ['team', 'organization'],
  ['institution', 'organization'],
  ['org', 'organization'],
  ['product', 'project'],
  ['repo', 'project'],
  ['repository', 'project'],
  ['feature_proposal', 'feature'],
  ['capability', 'feature'],
  ['product_capability', 'feature'],
  ['subsystem', 'concept'],
  ['component', 'concept'],
  ['architecture', 'concept'],
  ['implementation_behavior', 'concept'],
  ['security_policy', 'concept'],
  ['policy', 'concept'],
  ['principle', 'concept'],
  ['document_collection', 'document'],
  ['specification', 'document'],
  ['spec', 'document'],
  ['adr', 'document'],
  ['issue', 'document'],
  ['github_issue', 'document'],
  ['pull_request', 'document'],
  ['github_pull_request', 'document'],
  ['backend', 'tool'],
  ['cli', 'tool'],
]);

export const CONTEXT_MAP_PREDICATE_ALIASES = new Map<string, string>([
  ['uses_decision', 'uses'],
  ['uses decision', 'uses'],
  ['supports_backend', 'supports'],
  ['supports backend', 'supports'],
  ['supported_backend', 'supports'],
  ['is_specified_by', 'specified_by'],
  ['is specified by', 'specified_by'],
  ['specified by', 'specified_by'],
  ['depends on', 'depends_on'],
  ['depends_on', 'depends_on'],
  ['relies_on', 'depends_on'],
  ['relies on', 'depends_on'],
  ['is_part_of', 'part_of'],
  ['is part of', 'part_of'],
  ['part of', 'part_of'],
  ['spawns local processes through', 'runs_via'],
  ['runs through', 'runs_via'],
  ['runs_via', 'runs_via'],
  ['driven_by', 'driven_by'],
  ['driven by', 'driven_by'],
]);

export const CONTEXT_MAP_ALLOWED_RELATIONSHIP_PREDICATES = new Set([
  'blocks',
  'captures',
  'configures',
  'contains',
  'depends_on',
  'documents',
  'documented_by',
  'driven_by',
  'enables',
  'governs',
  'implements',
  'implemented_by',
  'managed_by',
  'owns',
  'part_of',
  'produces',
  'references',
  'relates_to',
  'replaces',
  'requires',
  'runs_via',
  'specified_by',
  'stores',
  'stored_in',
  'supports',
  'supersedes',
  'uses',
]);

export const CONTEXT_MAP_ENTITY_TYPE_PROMPT = Array.from(CONTEXT_MAP_BUILT_IN_ENTITY_TYPES).join(', ');
export const CONTEXT_MAP_RELATIONSHIP_PREDICATE_PROMPT = Array.from(CONTEXT_MAP_ALLOWED_RELATIONSHIP_PREDICATES).join(', ');

export const CONTEXT_MAP_FACT_PAYLOAD_KEYS = [
  'facts',
  'factsMarkdown',
  'factMarkdown',
  'keyFacts',
  'durableFacts',
  'factStatements',
];

export function normalizeAliasArray(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

export function normalizeCandidateFacts(payload: Record<string, unknown>): string[] {
  return dedupeFacts(CONTEXT_MAP_FACT_PAYLOAD_KEYS.flatMap((key) => normalizeFactFieldValue(payload[key])));
}

function normalizeFactFieldValue(value: unknown): string[] {
  if (typeof value === 'string') {
    const lines = value.split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
      .filter(Boolean);
    return lines.length > 1 ? dedupeFacts(lines) : normalizeFactArray(value);
  }
  return normalizeFactArray(value);
}

export function normalizeFactArray(value: unknown): string[] {
  if (typeof value === 'string') return dedupeFacts([normalizeFactText(value)]);
  if (!Array.isArray(value)) return [];
  return dedupeFacts(value.flatMap((item) => {
    const fact = normalizeFactText(item);
    return fact ? [fact] : [];
  }));
}

function normalizeFactText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (!isRecord(value)) return '';
  for (const key of ['markdown', 'statementMarkdown', 'text', 'value', 'content', 'summaryMarkdown', 'description']) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.replace(/\s+/g, ' ').trim();
  }
  return '';
}

export function dedupeFacts(facts: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const fact of facts) {
    const normalized = fact.replace(/\s+/g, ' ').trim();
    const key = normalizedCandidateText(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized.length <= 1_000 ? normalized : `${normalized.slice(0, 997)}...`);
  }
  return output;
}

export function normalizedCandidateText(value: string): string {
  return value.trim().toLowerCase().replace(/[`"']/g, '').replace(/\s+/g, ' ');
}

export function normalizeRelationshipPredicate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const textKey = trimmed.toLowerCase().replace(/[`"']/g, '').replace(/\s+/g, ' ');
  const slugKey = normalizeSlug(trimmed);
  return CONTEXT_MAP_PREDICATE_ALIASES.get(textKey)
    || CONTEXT_MAP_PREDICATE_ALIASES.get(slugKey)
    || slugKey;
}

export function isAllowedRelationshipPredicate(value: string): boolean {
  const predicate = normalizeRelationshipPredicate(value);
  if (!predicate) return false;
  if (predicate.includes('_unlike') || predicate.endsWith('_unlike')) return false;
  if (predicate.startsWith('not_') || predicate.startsWith('does_not_')) return false;
  if (predicate.includes('_versus_') || predicate === 'versus' || predicate === 'compared_to') return false;
  return CONTEXT_MAP_ALLOWED_RELATIONSHIP_PREDICATES.has(predicate);
}

export function normalizeCandidateSensitivity(value: string): string {
  const slug = normalizeSlug(value);
  if (!slug) return '';
  if (slug === 'work_sensitive' || slug === 'confidential' || slug === 'private_work_data') return 'work-sensitive';
  if (slug === 'personal_sensitive' || slug === 'private_personal_data' || slug === 'personal_data') return 'personal-sensitive';
  if (slug === 'secret_pointer' || slug === 'secret_pointer_only' || slug === 'secret' || slug === 'credential') return 'secret-pointer';
  if (slug === 'normal') return 'normal';
  return '';
}

export function readPayloadString(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function hasRelationshipEvidence(payload: Record<string, unknown>): boolean {
  return Boolean(readPayloadString(payload, ['evidenceMarkdown', 'rationale', 'reason', 'summaryMarkdown']));
}

export function isSelfRelationshipPayload(payload: Record<string, unknown>, projectNames: Set<string> = new Set()): boolean {
  const subjectName = readPayloadString(payload, ['subjectName', 'subjectEntityName']);
  const objectName = readPayloadString(payload, ['objectName', 'objectEntityName']);
  if (!subjectName || !objectName) return false;
  return normalizedCandidateText(subjectName) === normalizedCandidateText(objectName)
    || canonicalRelationshipName(subjectName, projectNames) === canonicalRelationshipName(objectName, projectNames);
}

export function canonicalEntityName(name: string, projectNames: Set<string>): string {
  let normalized = normalizedCandidateText(name).replace(/[_-]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  for (const projectName of Array.from(projectNames).sort((a, b) => b.length - a.length)) {
    const normalizedProject = normalizedCandidateText(projectName).replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    if (normalizedProject && normalized !== normalizedProject && normalized.startsWith(`${normalizedProject} `)) {
      normalized = normalized.slice(normalizedProject.length).trim();
      break;
    }
  }
  normalized = normalized.replace(/^(project|workspace)\s+/, '').trim();
  if ([
    'spec',
    'spec docs',
    'spec document',
    'spec documents',
    'specification',
    'specification docs',
    'specification document',
    'specification documents',
    'project spec',
    'project specification',
    'project specification documents',
  ].includes(normalized)) return 'specification';
  if (['adr', 'adrs', 'architecture decision record', 'architecture decision records', 'adr collection'].includes(normalized)) {
    return 'architecture decision records';
  }
  return normalized;
}

export function canonicalRelationshipName(name: string, projectNames: Set<string>): string {
  return canonicalEntityName(name, projectNames);
}

export function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
