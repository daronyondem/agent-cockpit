import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { KbFolder } from '../../../types';

const FOLDER_SEGMENT_RE = /^[^/\x00-\x1f]+$/;

export function listFolders(db: BetterSqlite3Database): KbFolder[] {
  const rows = db
    .prepare<unknown[], { folder_path: string; created_at: string }>(
      'SELECT folder_path, created_at FROM folders ORDER BY folder_path',
    )
    .all();
  return rows.map((r) => ({ folderPath: r.folder_path, createdAt: r.created_at }));
}

export function folderExists(db: BetterSqlite3Database, folderPath: string): boolean {
  const row = db
    .prepare<unknown[], { folder_path: string }>(
      'SELECT folder_path FROM folders WHERE folder_path = ?',
    )
    .get(folderPath);
  return Boolean(row);
}

/**
 * Create `folderPath` and any missing ancestors. Idempotent — calling
 * on an existing folder is a no-op. Root ('') is always present.
 */
export function createFolder(db: BetterSqlite3Database, folderPath: string): void {
  const normalized = normalizeFolderPath(folderPath);
  if (normalized === '') return; // root always exists

  // Build the ancestor chain: 'a/b/c' → ['a', 'a/b', 'a/b/c']
  const segments = normalized.split('/');
  const chain: string[] = [];
  let acc = '';
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    chain.push(acc);
  }
  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO folders (folder_path, created_at) VALUES (?, ?)',
  );
  db.transaction(() => {
    for (const fp of chain) insert.run(fp, now);
  })();
}

/**
 * Rename `fromPath` to `toPath`, cascading to all descendant folders
 * and every `raw_locations` row in the subtree. Throws if `fromPath`
 * doesn't exist or `toPath` (or any descendant target) already does.
 */
export function renameFolder(
  db: BetterSqlite3Database,
  fromPath: string,
  toPath: string,
): void {
  const from = normalizeFolderPath(fromPath);
  const to = normalizeFolderPath(toPath);
  if (from === '') throw new Error('Cannot rename root folder.');
  if (to === '') throw new Error('Cannot rename folder to root.');
  if (from === to) return;

  db.transaction(() => {
    if (!folderExists(db, from)) {
      throw new Error(`Folder ${from} does not exist.`);
    }
    // Collision check: the new name itself + any descendant collisions.
    // We check both the direct target and the prefix rewrite of every
    // existing descendant under `from` against what would become their
    // new path under `to`.
    if (folderExists(db, to)) {
      throw new Error(`Folder ${to} already exists.`);
    }
    const descendants = db
      .prepare<unknown[], { folder_path: string }>(
        "SELECT folder_path FROM folders WHERE folder_path LIKE ? || '/%' ORDER BY folder_path",
      )
      .all(from);
    for (const d of descendants) {
      const rewritten = to + d.folder_path.slice(from.length);
      if (folderExists(db, rewritten)) {
        throw new Error(`Folder ${rewritten} already exists (would collide on rename).`);
      }
    }

    // Ensure every ancestor of `to` exists (same as createFolder on a
    // missing parent chain). We need this because we're about to insert
    // the rename target before deleting the old one, and it has a PK
    // constraint on folder_path — we can't rename to a non-existent
    // parent without creating the parent first.
    const toSegments = to.split('/');
    let acc = '';
    const now = new Date().toISOString();
    const insertFolder = db.prepare(
      'INSERT OR IGNORE INTO folders (folder_path, created_at) VALUES (?, ?)',
    );
    // All ancestors of `to` except the target itself.
    for (let i = 0; i < toSegments.length - 1; i += 1) {
      acc = acc ? `${acc}/${toSegments[i]}` : toSegments[i];
      insertFolder.run(acc, now);
    }

    // SQLite doesn't support UPDATE on a PK directly while a FK still
    // references the old value — we'd hit an FK violation on
    // raw_locations. Workaround: insert the new folder, re-parent the
    // locations to the new folder, then delete the old folder.
    //
    // Do this in reverse depth order so children move before parents
    // (parents are the PK the children reference).
    const allFolders = [
      { from, to },
      ...descendants.map((d) => ({
        from: d.folder_path,
        to: to + d.folder_path.slice(from.length),
      })),
    ];
    // Deepest first for INSERTs so children exist before their moves.
    // Actually, INSERT order doesn't matter — no FK from folders to
    // folders. But deleting in deepest-first order matters to avoid
    // RESTRICT violations between raw_locations and folders.
    for (const pair of allFolders) {
      insertFolder.run(pair.to, now);
    }
    // Move raw_locations from each old folder to its new counterpart.
    const moveLocations = db.prepare(
      'UPDATE raw_locations SET folder_path = ? WHERE folder_path = ?',
    );
    for (const pair of allFolders) {
      moveLocations.run(pair.to, pair.from);
    }
    // Delete deepest old folders first (they can't be referenced by
    // raw_locations any more because we just moved them).
    const deleteFolderStmt = db.prepare(
      'DELETE FROM folders WHERE folder_path = ?',
    );
    const sortedDeep = [...allFolders].sort(
      (a, b) => b.from.length - a.from.length,
    );
    for (const pair of sortedDeep) {
      deleteFolderStmt.run(pair.from);
    }
  })();
}

/**
 * Delete `folderPath`. Does NOT cascade to children. Callers that want
 * to drop a non-empty folder must first transition every
 * `raw_locations` row in the subtree out (either to another folder or
 * via `removeLocation`). This keeps cascade semantics explicit in the
 * orchestrator rather than hidden in the FK layer.
 */
export function deleteFolder(db: BetterSqlite3Database, folderPath: string): void {
  const normalized = normalizeFolderPath(folderPath);
  if (normalized === '') throw new Error('Cannot delete root folder.');
  db
    .prepare('DELETE FROM folders WHERE folder_path = ?')
    .run(normalized);
}

/**
 * Find every folder whose path is `folderPath` itself or starts with
 * `folderPath + '/'`. Used by the cascade-delete logic to enumerate
 * the subtree.
 */
export function listFolderSubtree(
  db: BetterSqlite3Database,
  folderPath: string,
): KbFolder[] {
  const normalized = normalizeFolderPath(folderPath);
  const rows = db
    .prepare<unknown[], { folder_path: string; created_at: string }>(
      "SELECT folder_path, created_at FROM folders WHERE folder_path = ? OR folder_path LIKE ? || '/%' ORDER BY LENGTH(folder_path) DESC",
    )
    .all(normalized, normalized);
  return rows.map((r) => ({ folderPath: r.folder_path, createdAt: r.created_at }));
}

/**
 * Validate and normalize a folder path. Strips leading/trailing slashes,
 * collapses repeated slashes, rejects `..`, control characters, empty
 * segments, and over-long paths. Returns '' for root.
 */
export function normalizeFolderPath(input: string): string {
  if (input === undefined || input === null) return '';
  const raw = String(input).trim();
  if (raw === '' || raw === '/') return '';
  if (raw.length > 4096) {
    throw new Error('Folder path is too long (max 4096 chars).');
  }
  const segments = raw.split('/').filter((s) => s !== '');
  if (segments.length === 0) return '';
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error(`Invalid folder segment: "${seg}"`);
    }
    if (seg.length > 128) {
      throw new Error(`Folder segment too long (max 128 chars): "${seg}"`);
    }
    if (!FOLDER_SEGMENT_RE.test(seg)) {
      throw new Error(`Invalid folder segment: "${seg}"`);
    }
  }
  return segments.join('/');
}
