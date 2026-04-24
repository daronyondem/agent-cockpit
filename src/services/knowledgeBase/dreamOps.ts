// ─── Dreaming operation parser + applicator ─────────────────────────────────
//
// Parses the JSON output from dreaming CLI calls into a typed operations list,
// validates each operation, and applies them transactionally to the DB.
//
// The CLI returns:
//   { "operations": [ { "op": "create_topic", ... }, ... ] }
//
// Supported operations:
//   create_topic, update_topic, merge_topics, split_topic, delete_topic,
//   assign_entries, unassign_entries,
//   add_connection, update_connection, remove_connection

import type { KbDatabase, UpsertTopicParams, InsertConnectionParams } from './db';

// ── Operation types ─────────────────────────────────────────────────────────

interface CreateTopicOp {
  op: 'create_topic';
  topic_id: string;
  title: string;
  summary: string;
  content: string;
}

interface UpdateTopicOp {
  op: 'update_topic';
  topic_id: string;
  title?: string;
  summary?: string;
  content?: string;
}

interface MergeTopicsOp {
  op: 'merge_topics';
  source_topic_ids: string[];
  into_topic_id: string;
  title: string;
  summary: string;
  content: string;
}

interface SplitTopicOp {
  op: 'split_topic';
  source_topic_id: string;
  into: Array<{
    topic_id: string;
    title: string;
    summary: string;
    content: string;
  }>;
}

interface DeleteTopicOp {
  op: 'delete_topic';
  topic_id: string;
}

interface AssignEntriesOp {
  op: 'assign_entries';
  topic_id: string;
  entry_ids: string[];
}

interface UnassignEntriesOp {
  op: 'unassign_entries';
  topic_id: string;
  entry_ids: string[];
}

interface AddConnectionOp {
  op: 'add_connection';
  source_topic: string;
  target_topic: string;
  relationship: string;
  confidence: string;
  evidence?: string;
}

interface UpdateConnectionOp {
  op: 'update_connection';
  source_topic: string;
  target_topic: string;
  relationship?: string;
  confidence?: string;
}

interface RemoveConnectionOp {
  op: 'remove_connection';
  source_topic: string;
  target_topic: string;
}

export type DreamOperation =
  | CreateTopicOp
  | UpdateTopicOp
  | MergeTopicsOp
  | SplitTopicOp
  | DeleteTopicOp
  | AssignEntriesOp
  | UnassignEntriesOp
  | AddConnectionOp
  | UpdateConnectionOp
  | RemoveConnectionOp;

/** Result of parsing CLI output. */
export interface ParseResult {
  operations: DreamOperation[];
  warnings: string[];
}

const VALID_OPS = new Set([
  'create_topic', 'update_topic', 'merge_topics', 'split_topic', 'delete_topic',
  'assign_entries', 'unassign_entries',
  'add_connection', 'update_connection', 'remove_connection',
]);

const VALID_CONFIDENCE = new Set(['extracted', 'inferred', 'speculative']);

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse raw CLI stdout into a validated operations list. Extracts the JSON
 * block from potentially noisy output (the CLI might emit preamble text).
 */
export function parseDreamOutput(raw: string): ParseResult {
  const warnings: string[] = [];

  // Find the JSON object in the output — the CLI might wrap it in markdown
  // fences or have preamble text.
  const jsonStr = extractJson(raw);
  if (!jsonStr) {
    return { operations: [], warnings: ['No JSON object found in CLI output'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { operations: [], warnings: [`JSON parse error: ${(err as Error).message}`] };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { operations: [], warnings: ['Parsed output is not an object'] };
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.operations)) {
    return { operations: [], warnings: ['Missing or non-array "operations" field'] };
  }

  const operations: DreamOperation[] = [];
  for (let i = 0; i < obj.operations.length; i++) {
    const item = obj.operations[i] as Record<string, unknown>;
    if (!item || typeof item !== 'object' || typeof item.op !== 'string') {
      warnings.push(`Operation ${i}: missing or invalid "op" field`);
      continue;
    }
    if (!VALID_OPS.has(item.op)) {
      warnings.push(`Operation ${i}: unknown op "${item.op}"`);
      continue;
    }
    const validation = validateOp(item, i);
    if (validation.error) {
      warnings.push(validation.error);
      continue;
    }
    operations.push(item as unknown as DreamOperation);
  }

  return { operations, warnings };
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateOp(
  item: Record<string, unknown>,
  idx: number,
): { error?: string } {
  const prefix = `Operation ${idx} (${item.op})`;

  switch (item.op) {
    case 'create_topic':
      if (!isNonEmptyString(item.topic_id)) return { error: `${prefix}: missing topic_id` };
      if (!isNonEmptyString(item.title)) return { error: `${prefix}: missing title` };
      if (!isNonEmptyString(item.summary)) return { error: `${prefix}: missing summary` };
      if (!isNonEmptyString(item.content)) return { error: `${prefix}: missing content` };
      break;

    case 'update_topic':
      if (!isNonEmptyString(item.topic_id)) return { error: `${prefix}: missing topic_id` };
      // At least one field to update
      if (!item.title && !item.summary && !item.content) {
        return { error: `${prefix}: no fields to update` };
      }
      break;

    case 'merge_topics':
      if (!Array.isArray(item.source_topic_ids) || item.source_topic_ids.length < 2) {
        return { error: `${prefix}: source_topic_ids must be an array of ≥2` };
      }
      if (!isNonEmptyString(item.into_topic_id)) return { error: `${prefix}: missing into_topic_id` };
      if (!isNonEmptyString(item.title)) return { error: `${prefix}: missing title` };
      if (!isNonEmptyString(item.content)) return { error: `${prefix}: missing content` };
      break;

    case 'split_topic':
      if (!isNonEmptyString(item.source_topic_id)) return { error: `${prefix}: missing source_topic_id` };
      if (!Array.isArray(item.into) || item.into.length < 2) {
        return { error: `${prefix}: "into" must be an array of ≥2 topics` };
      }
      for (let j = 0; j < item.into.length; j++) {
        const sub = item.into[j] as Record<string, unknown>;
        if (!isNonEmptyString(sub?.topic_id)) return { error: `${prefix}: into[${j}] missing topic_id` };
        if (!isNonEmptyString(sub?.title)) return { error: `${prefix}: into[${j}] missing title` };
        if (!isNonEmptyString(sub?.content)) return { error: `${prefix}: into[${j}] missing content` };
      }
      break;

    case 'delete_topic':
      if (!isNonEmptyString(item.topic_id)) return { error: `${prefix}: missing topic_id` };
      break;

    case 'assign_entries':
    case 'unassign_entries':
      if (!isNonEmptyString(item.topic_id)) return { error: `${prefix}: missing topic_id` };
      if (!Array.isArray(item.entry_ids) || item.entry_ids.length === 0) {
        return { error: `${prefix}: entry_ids must be a non-empty array` };
      }
      break;

    case 'add_connection':
      if (!isNonEmptyString(item.source_topic)) return { error: `${prefix}: missing source_topic` };
      if (!isNonEmptyString(item.target_topic)) return { error: `${prefix}: missing target_topic` };
      if (!isNonEmptyString(item.relationship)) return { error: `${prefix}: missing relationship` };
      if (item.confidence && !VALID_CONFIDENCE.has(item.confidence as string)) {
        return { error: `${prefix}: invalid confidence "${item.confidence}"` };
      }
      break;

    case 'update_connection':
      if (!isNonEmptyString(item.source_topic)) return { error: `${prefix}: missing source_topic` };
      if (!isNonEmptyString(item.target_topic)) return { error: `${prefix}: missing target_topic` };
      if (item.confidence && !VALID_CONFIDENCE.has(item.confidence as string)) {
        return { error: `${prefix}: invalid confidence "${item.confidence}"` };
      }
      break;

    case 'remove_connection':
      if (!isNonEmptyString(item.source_topic)) return { error: `${prefix}: missing source_topic` };
      if (!isNonEmptyString(item.target_topic)) return { error: `${prefix}: missing target_topic` };
      break;
  }

  return {};
}

// ── Application ─────────────────────────────────────────────────────────────

/**
 * Apply a list of parsed operations to the DB in a single transaction.
 * Returns warnings for operations that couldn't be applied (e.g. updating
 * a non-existent topic).
 */
export function applyOperations(
  db: KbDatabase,
  operations: DreamOperation[],
): string[] {
  const warnings: string[] = [];
  const now = new Date().toISOString();

  db.transaction(() => {
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      try {
        applyOne(db, op, now);
      } catch (err) {
        warnings.push(`Operation ${i} (${op.op}): ${(err as Error).message}`);
      }
    }
  });

  return warnings;
}

function applyOne(db: KbDatabase, op: DreamOperation, now: string): void {
  switch (op.op) {
    case 'create_topic': {
      const params: UpsertTopicParams = {
        topicId: op.topic_id,
        title: op.title,
        summary: op.summary,
        content: op.content,
        updatedAt: now,
      };
      db.upsertTopic(params);
      break;
    }

    case 'update_topic': {
      const existing = db.getTopic(op.topic_id);
      if (!existing) throw new Error(`Topic "${op.topic_id}" not found`);
      const params: UpsertTopicParams = {
        topicId: op.topic_id,
        title: op.title ?? existing.title,
        summary: op.summary ?? existing.summary,
        content: op.content ?? existing.content,
        updatedAt: now,
      };
      db.upsertTopic(params);
      break;
    }

    case 'merge_topics': {
      // Collect all entry assignments from source topics.
      const allEntryIds = new Set<string>();
      for (const srcId of op.source_topic_ids) {
        for (const eid of db.listTopicEntryIds(srcId)) {
          allEntryIds.add(eid);
        }
      }
      // Delete source topics (cascades connections + memberships).
      for (const srcId of op.source_topic_ids) {
        if (srcId !== op.into_topic_id) {
          db.deleteTopic(srcId);
        }
      }
      // Create/update the merged topic.
      db.upsertTopic({
        topicId: op.into_topic_id,
        title: op.title,
        summary: op.summary ?? '',
        content: op.content,
        updatedAt: now,
      });
      // Reassign all collected entries.
      db.assignEntries(op.into_topic_id, [...allEntryIds]);
      break;
    }

    case 'split_topic': {
      // Collect entries from source topic before deleting.
      const sourceEntryIds = db.listTopicEntryIds(op.source_topic_id);
      // Collect connections from source topic before deleting.
      const sourceConnections = db.listConnectionsForTopic(op.source_topic_id);
      // Delete source topic.
      db.deleteTopic(op.source_topic_id);
      // Create each new topic.
      for (const sub of op.into) {
        db.upsertTopic({
          topicId: sub.topic_id,
          title: sub.title,
          summary: sub.summary ?? '',
          content: sub.content,
          updatedAt: now,
        });
      }
      // Re-distribute entries: for now, assign all source entries to all
      // new topics. The CLI should follow up with unassign_entries ops to
      // refine, but we ensure nothing is orphaned.
      const newTopicIds = op.into.map((s) => s.topic_id);
      for (const tid of newTopicIds) {
        db.assignEntries(tid, sourceEntryIds);
      }
      // Rewire connections: connections that referenced the source topic
      // now point to the first new topic. The CLI can refine with
      // add/remove_connection ops.
      for (const conn of sourceConnections) {
        const src = conn.sourceTopic === op.source_topic_id ? newTopicIds[0] : conn.sourceTopic;
        const tgt = conn.targetTopic === op.source_topic_id ? newTopicIds[0] : conn.targetTopic;
        if (src === tgt) continue; // skip self-connections
        db.upsertConnection({
          sourceTopic: src,
          targetTopic: tgt,
          relationship: conn.relationship,
          confidence: conn.confidence,
          evidence: conn.evidence,
        });
      }
      break;
    }

    case 'delete_topic':
      db.deleteTopic(op.topic_id);
      break;

    case 'assign_entries':
      db.assignEntries(op.topic_id, op.entry_ids);
      break;

    case 'unassign_entries':
      db.unassignEntries(op.topic_id, op.entry_ids);
      break;

    case 'add_connection': {
      const params: InsertConnectionParams = {
        sourceTopic: op.source_topic,
        targetTopic: op.target_topic,
        relationship: op.relationship,
        confidence: op.confidence || 'inferred',
        evidence: op.evidence ?? null,
      };
      db.upsertConnection(params);
      break;
    }

    case 'update_connection': {
      // Read existing, merge fields, upsert.
      const params: InsertConnectionParams = {
        sourceTopic: op.source_topic,
        targetTopic: op.target_topic,
        relationship: op.relationship || 'related',
        confidence: op.confidence || 'inferred',
        evidence: null,
      };
      db.upsertConnection(params);
      break;
    }

    case 'remove_connection':
      db.removeConnection(op.source_topic, op.target_topic);
      break;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.length > 0;
}

/**
 * Extract the first JSON object `{ ... }` from raw text. Handles markdown
 * fences (```json ... ```) and preamble/postamble text. The brace scanner
 * tracks string state so braces inside string values do not close the object
 * prematurely.
 */
function extractJson(raw: string): string | null {
  // Try markdown fenced block first.
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) return inner;
  }
  return scanBalancedObject(raw);
}

/**
 * Walk `raw` and return the slice covering the first balanced top-level
 * `{ ... }`. Ignores braces inside JSON string literals, honouring backslash
 * escapes. Returns `null` if no balanced object is found.
 */
function scanBalancedObject(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}
