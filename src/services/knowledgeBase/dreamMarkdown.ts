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

  // Wipe and recreate the directory.
  if (fs.existsSync(synthesisDir)) {
    fs.rmSync(synthesisDir, { recursive: true, force: true });
  }
  fs.mkdirSync(topicsDir, { recursive: true });

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

/**
 * Generate the `_dream_tmp/` files that dreaming prompts reference.
 * Returns the absolute path to the temp directory.
 */
export function generateDreamTmpFiles(
  db: KbDatabase,
  knowledgeDir: string,
): string {
  const tmpDir = path.join(knowledgeDir, '_dream_tmp');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  // ── all-topics.txt ──────────────────────────────────────────────────────
  const summaries = db.listTopicSummaries();
  const topicLines = summaries.map(
    (t) => `${t.topicId} | ${t.title} | ${t.summary ?? '(no summary)'}`,
  );
  fs.writeFileSync(
    path.join(tmpDir, 'all-topics.txt'),
    topicLines.length > 0
      ? topicLines.join('\n') + '\n'
      : '(no topics yet)\n',
  );

  // ── god-nodes.txt ───────────────────────────────────────────────────────
  const godNodesRaw = db.getSynthesisMeta('god_nodes');
  const godNodes: string[] = godNodesRaw ? JSON.parse(godNodesRaw) : [];
  if (godNodes.length > 0) {
    const topics = db.listTopics();
    const godTopics = topics.filter((t) => godNodes.includes(t.topicId));
    const godLines = godTopics.map(
      (t) =>
        `- "${t.title}" (${t.topicId}): ${t.entryCount} entries, ${t.connectionCount} connections — consider splitting`,
    );
    fs.writeFileSync(path.join(tmpDir, 'god-nodes.txt'), godLines.join('\n') + '\n');
  }

  // ── per-topic content files ─────────────────────────────────────────────
  const topics = db.listTopics();
  for (const topic of topics) {
    const connections = db.listConnectionsForTopic(topic.topicId);
    const entryIds = db.listTopicEntryIds(topic.topicId);

    const lines: string[] = [];
    lines.push(`# ${topic.title}`);
    lines.push('');
    if (topic.summary) {
      lines.push(`**Summary:** ${topic.summary}`);
      lines.push('');
    }

    if (connections.length > 0) {
      lines.push('## Current Connections');
      for (const conn of connections) {
        const other =
          conn.sourceTopic === topic.topicId ? conn.targetTopic : conn.sourceTopic;
        const dir =
          conn.sourceTopic === topic.topicId ? '→' : '←';
        lines.push(`- ${dir} ${other} (${conn.relationship}, ${conn.confidence})`);
      }
      lines.push('');
    }

    lines.push(`## Member Entries (${entryIds.length} total)`);
    if (entryIds.length <= 50) {
      const entries = entryIds
        .map((eid) => db.getEntry(eid))
        .filter((e) => e !== null);
      for (const e of entries) {
        lines.push(`- ${e.entryId}: "${e.title}"`);
      }
    } else {
      // Write a separate members file for large topics.
      const entries = entryIds
        .map((eid) => db.getEntry(eid))
        .filter((e) => e !== null);
      const memberLines = entries.map((e) => `${e.entryId}: "${e.title}"`);
      fs.writeFileSync(
        path.join(tmpDir, `topic-${topic.topicId}-members.txt`),
        memberLines.join('\n') + '\n',
      );
      lines.push(`Full list at: _dream_tmp/topic-${topic.topicId}-members.txt`);
    }
    lines.push('');

    if (topic.content) {
      lines.push('## Content');
      lines.push(topic.content);
      lines.push('');
    }

    fs.writeFileSync(
      path.join(tmpDir, `topic-${topic.topicId}-content.md`),
      lines.join('\n'),
    );
  }

  return tmpDir;
}

/** Clean up `_dream_tmp/` after a dream run. */
export function cleanupDreamTmp(knowledgeDir: string): void {
  const tmpDir = path.join(knowledgeDir, '_dream_tmp');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
