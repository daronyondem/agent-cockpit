// ─── Synthesis markdown generator ────────────────────────────────────────────
//
// Regenerates the `synthesis/` directory from SQLite after each dream run.
// These files are materialized views — the DB is the source of truth.
//
// Output:
//   synthesis/index.md              — master topic list
//   synthesis/topics/<slug>.md      — per-topic prose + related + entries
//   synthesis/connections.md        — full connection graph

import fs from 'fs';
import path from 'path';
import type { KbDatabase } from './db';

/**
 * Regenerate all synthesis markdown files from the DB. Wipes and recreates
 * the `synthesis/` directory to ensure stale files from deleted topics
 * are cleaned up.
 */
export function regenerateSynthesisMarkdown(
  db: KbDatabase,
  synthesisDir: string,
): void {
  const topicsDir = path.join(synthesisDir, 'topics');
  const reflectionsDir = path.join(synthesisDir, 'reflections');

  // Wipe topics and top-level files, but preserve the reflections/ directory
  // (reflection markdown is regenerated separately after Phase 5).
  if (fs.existsSync(topicsDir)) {
    fs.rmSync(topicsDir, { recursive: true, force: true });
  }
  for (const file of ['index.md', 'connections.md']) {
    const fp = path.join(synthesisDir, file);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  fs.mkdirSync(topicsDir, { recursive: true });
  // Ensure reflections dir exists (may have been wiped by a full rebuild).
  fs.mkdirSync(reflectionsDir, { recursive: true });

  const topics = db.listTopics();
  const connections = db.listAllConnections();

  // Build a title lookup for connection labels.
  const titleMap = new Map(topics.map((t) => [t.topicId, t.title]));

  // ── index.md ────────────────────────────────────────────────────────────
  const indexLines: string[] = [
    '# Knowledge Base — Topic Index',
    '',
    `> ${topics.length} topics, ${connections.length} connections`,
    '',
    '| Topic | Entries | Connections |',
    '|-------|---------|-------------|',
  ];
  for (const t of topics) {
    indexLines.push(
      `| [${t.title}](topics/${t.topicId}.md) | ${t.entryCount} | ${t.connectionCount} |`,
    );
  }
  fs.writeFileSync(path.join(synthesisDir, 'index.md'), indexLines.join('\n') + '\n');

  // ── topics/<slug>.md ────────────────────────────────────────────────────
  for (const topic of topics) {
    const topicConnections = db.listConnectionsForTopic(topic.topicId);
    const entryIds = db.listTopicEntryIds(topic.topicId);
    // Fetch entry metadata for the list.
    const entries = entryIds
      .map((eid) => db.getEntry(eid))
      .filter((e) => e !== null);

    const lines: string[] = [];
    lines.push(`# ${topic.title}`);
    lines.push('');
    if (topic.content) {
      lines.push(topic.content);
      lines.push('');
    }

    // Related topics section.
    if (topicConnections.length > 0) {
      lines.push('## Related Topics');
      lines.push('');
      for (const conn of topicConnections) {
        const otherTopicId =
          conn.sourceTopic === topic.topicId ? conn.targetTopic : conn.sourceTopic;
        const otherTitle = titleMap.get(otherTopicId) ?? otherTopicId;
        const direction =
          conn.sourceTopic === topic.topicId ? `→ ${conn.relationship}` : `← ${conn.relationship}`;
        lines.push(
          `- [${otherTitle}](${otherTopicId}.md) — ${direction} (${conn.confidence})`,
        );
      }
      lines.push('');
    }

    // Entries section.
    if (entries.length > 0) {
      lines.push('## Entries');
      lines.push('');
      for (const entry of entries) {
        lines.push(
          `- [${entry.title}](../../entries/${entry.entryId}/entry.md)`,
        );
      }
      lines.push('');
    }

    fs.writeFileSync(path.join(topicsDir, `${topic.topicId}.md`), lines.join('\n'));
  }

  // ── connections.md ──────────────────────────────────────────────────────
  const connLines: string[] = [
    '# Knowledge Base — Connections',
    '',
    `> ${connections.length} connections across ${topics.length} topics`,
    '',
    '| Source | → | Target | Relationship | Confidence |',
    '|--------|---|--------|-------------|------------|',
  ];
  for (const c of connections) {
    const srcTitle = titleMap.get(c.sourceTopic) ?? c.sourceTopic;
    const tgtTitle = titleMap.get(c.targetTopic) ?? c.targetTopic;
    connLines.push(
      `| ${srcTitle} | → | ${tgtTitle} | ${c.relationship} | ${c.confidence} |`,
    );
  }
  fs.writeFileSync(path.join(synthesisDir, 'connections.md'), connLines.join('\n') + '\n');
}

