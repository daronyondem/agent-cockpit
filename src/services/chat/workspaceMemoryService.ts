import fsp from 'fs/promises';
import path from 'path';
import type {
  MemoryConsolidationAudit,
  MemoryEntryMetadata,
  MemoryFile,
  MemoryRedaction,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySnapshot,
  MemorySource,
  MemoryStatus,
} from '../../types';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { WorkspaceMemoryStore } from './workspaceMemoryStore';
import {
  emptyMemoryMetadataIndex,
  memorySourceFromFilename,
  normalizeMemoryMetadata,
  normalizeMemorySource,
  slugify,
} from './memoryMetadata';
import { searchMemoryFiles } from './memorySearch';

interface ParsedMemoryFrontmatter {
  name: string | null;
  description: string | null;
  type: MemoryFile['type'];
}

interface WorkspaceMemoryServiceDeps {
  store: WorkspaceMemoryStore;
  parseMemoryFrontmatter(content: string): ParsedMemoryFrontmatter;
  getWorkspaceMemoryEnabled?(hash: string): Promise<boolean>;
  log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Stateful workspace Memory lifecycle over `WorkspaceMemoryStore`.
 * The store owns raw paths and atomic file I/O; this service owns sidecar
 * metadata, legacy layout migration, notes, snapshots, and lexical search.
 */
export class WorkspaceMemoryService {
  constructor(private readonly deps: WorkspaceMemoryServiceDeps) {}

  private _memoryDir(hash: string): string {
    return this.deps.store.memoryDir(hash);
  }

  private _memoryFilesDir(hash: string): string {
    return this.deps.store.filesDir(hash);
  }

  private _memoryClaudeDir(hash: string): string {
    return this.deps.store.claudeDir(hash);
  }

  private _memoryNotesDir(hash: string): string {
    return this.deps.store.notesDir(hash);
  }

  async readMemoryMetadataIndex(hash: string) {
    const raw = await this.deps.store.readMetadataIndexFile(hash);
    if (!raw) return emptyMemoryMetadataIndex();

    const now = new Date().toISOString();
    const entries: Record<string, MemoryEntryMetadata> = {};
    const rawEntries = raw && typeof raw === 'object'
      ? (raw as { entries?: unknown }).entries
      : null;
    if (rawEntries && typeof rawEntries === 'object') {
      for (const [filename, entry] of Object.entries(rawEntries as Record<string, unknown>)) {
        const normalized = normalizeMemoryMetadata(entry, filename, memorySourceFromFilename(filename), now);
        entries[normalized.filename] = normalized;
      }
    }

    return {
      version: 1 as const,
      updatedAt: raw && typeof raw === 'object' && typeof (raw as { updatedAt?: unknown }).updatedAt === 'string'
        ? (raw as { updatedAt: string }).updatedAt
        : now,
      entries,
    };
  }

  private async _writeMemoryMetadataIndex(hash: string, index: Awaited<ReturnType<WorkspaceMemoryService['readMemoryMetadataIndex']>>): Promise<void> {
    await this.deps.store.writeMetadataIndex(hash, index);
  }

  private async _attachMemoryMetadata(
    hash: string,
    files: MemoryFile[],
    persist: boolean,
  ): Promise<MemoryFile[]> {
    if (files.length === 0) {
      if (persist) {
        const existing = await this.readMemoryMetadataIndex(hash);
        const deletedEntries = Object.fromEntries(
          Object.entries(existing.entries).filter(([, entry]) => entry.status === 'deleted'),
        );
        await this._writeMemoryMetadataIndex(hash, {
          version: 1,
          updatedAt: new Date().toISOString(),
          entries: deletedEntries,
        });
      }
      return files;
    }

    const existing = await this.readMemoryMetadataIndex(hash);
    const now = new Date().toISOString();
    const entries: Record<string, MemoryEntryMetadata> = {};
    for (const entry of Object.values(existing.entries)) {
      if (entry.status === 'deleted') entries[entry.filename] = entry;
    }

    const enriched: MemoryFile[] = [];
    for (const file of files) {
      const source = normalizeMemorySource(file.source, 'cli-capture');
      const previous = existing.entries[file.filename] || file.metadata;
      const metadata = normalizeMemoryMetadata(previous, file.filename, source, now);
      const nextMetadata: MemoryEntryMetadata = {
        ...metadata,
        filename: file.filename,
        source,
      };
      if (nextMetadata.status === 'deleted') {
        entries[file.filename] = nextMetadata;
        continue;
      }
      entries[file.filename] = nextMetadata;
      enriched.push({
        ...file,
        source,
        metadata: nextMetadata,
      });
    }

    if (persist) {
      await this._writeMemoryMetadataIndex(hash, {
        version: 1,
        updatedAt: now,
        entries,
      });
    }

    return enriched;
  }

  /**
   * Migrate legacy `memory/files/*.md` (flat layout from before this feature)
   * into `memory/files/claude/*.md`. Idempotent and silent if there's
   * nothing to migrate.
   */
  private async _migrateLegacyMemoryLayout(hash: string): Promise<void> {
    const filesDir = this._memoryFilesDir(hash);
    let entries: string[];
    try {
      entries = await fsp.readdir(filesDir);
    } catch {
      return;
    }
    const loose = entries.filter((e) => e.endsWith('.md'));
    if (loose.length === 0) return;

    const claudeDir = this._memoryClaudeDir(hash);
    await fsp.mkdir(claudeDir, { recursive: true });
    for (const name of loose) {
      const from = path.join(filesDir, name);
      const to = path.join(claudeDir, name);
      try {
        await fsp.rename(from, to);
      } catch (err: unknown) {
        this.deps.log?.warn('Legacy memory migration could not move file', { from, to, error: err });
      }
    }
    this.deps.log?.info('Migrated legacy memory files', { count: loose.length, destination: claudeDir });
  }

  /**
   * Enumerate notes stored under `files/notes/` and return them as
   * MemoryFile entries. Returns an empty array if the notes dir doesn't
   * exist yet.
   */
  private async _readNotesFromDisk(hash: string): Promise<MemoryFile[]> {
    const notesDir = this._memoryNotesDir(hash);
    let names: string[];
    try {
      names = await fsp.readdir(notesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const files: MemoryFile[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      const full = path.join(notesDir, name);
      let content: string;
      try {
        content = await fsp.readFile(full, 'utf8');
      } catch (err: unknown) {
        this.deps.log?.warn('Could not read memory note', { path: full, error: err });
        continue;
      }
      const parsed = this.deps.parseMemoryFrontmatter(content);
      // Infer source from filename prefix if frontmatter didn't say.
      let source: 'memory-note' | 'session-extraction' = 'memory-note';
      if (name.startsWith('session_')) source = 'session-extraction';
      files.push({
        filename: `notes/${name}`,
        name: parsed.name,
        description: parsed.description,
        type: parsed.type,
        content,
        source,
      });
    }
    return files;
  }

  /**
   * Persist a CLI-capture snapshot (e.g. from Claude Code) to the
   * workspace's memory directory. Only the `files/claude/` subtree is
   * wiped — any notes written via `memory_note` or post-session
   * extraction in `files/notes/` are preserved and merged back into the
   * canonical `snapshot.json`.
   */
  async saveWorkspaceMemory(hash: string, snapshot: MemorySnapshot): Promise<void> {
    const memDir = this._memoryDir(hash);
    const filesDir = this._memoryFilesDir(hash);
    const claudeDir = this._memoryClaudeDir(hash);

    await fsp.mkdir(memDir, { recursive: true });
    await fsp.mkdir(filesDir, { recursive: true });

    // Migrate any legacy loose files before we touch things.
    await this._migrateLegacyMemoryLayout(hash);

    // Wipe ONLY the claude subdirectory — notes are preserved.
    try {
      await fsp.rm(claudeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    await fsp.mkdir(claudeDir, { recursive: true });

    if (snapshot.index) {
      await fsp.writeFile(path.join(claudeDir, 'MEMORY.md'), snapshot.index, 'utf8');
    }
    const claudeFiles: MemoryFile[] = [];
    for (const file of snapshot.files) {
      // The adapter returns bare filenames; guard against path traversal
      // and normalize them into `claude/<name>`.
      const bareName = path.basename(file.filename);
      if (!bareName || bareName === '.' || bareName === '..') continue;
      await fsp.writeFile(path.join(claudeDir, bareName), file.content, 'utf8');
      claudeFiles.push({
        ...file,
        filename: `claude/${bareName}`,
        source: 'cli-capture',
      });
    }

    // Merge preserved notes back into the snapshot.
    const notes = await this._readNotesFromDisk(hash);

    const mergedFiles = await this._attachMemoryMetadata(hash, [...claudeFiles, ...notes], true);
    const merged: MemorySnapshot = {
      ...snapshot,
      files: mergedFiles,
    };

    await this.deps.store.writeSnapshot(hash, merged);
  }

  /**
   * Load the stored memory snapshot for a workspace, or `null` if none.
   * Reconciles the on-disk snapshot with any notes that may have been
   * written since the last CLI capture, so the caller always sees a
   * fresh merged view.
   */
  async getWorkspaceMemory(hash: string): Promise<MemorySnapshot | null> {
    const snapshot = await this.deps.store.readSnapshot(hash);

    // Even if there's no CLI-capture snapshot yet, notes alone can
    // constitute a memory store (non-Claude workspace that only uses
    // memory_note). Build a minimal snapshot in that case.
    const notes = await this._readNotesFromDisk(hash);
    if (!snapshot) {
      if (notes.length === 0) return null;
      const files = await this._attachMemoryMetadata(hash, notes, false);
      return {
        capturedAt: new Date().toISOString(),
        sourceBackend: 'memory-note',
        sourcePath: null,
        index: '',
        files,
      };
    }

    // Rebuild: keep CLI-capture files as stored, but always re-read notes
    // fresh from disk so post-snapshot writes are reflected.
    const claudeFiles = (snapshot.files || []).filter(
      (f) => (f.source || 'cli-capture') === 'cli-capture',
    );
    const files = await this._attachMemoryMetadata(hash, [...claudeFiles, ...notes], false);
    return { ...snapshot, files };
  }

  async searchWorkspaceMemory(
    hash: string,
    options: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    const snapshot = await this.getWorkspaceMemory(hash);
    return searchMemoryFiles(snapshot?.files || [], options);
  }

  /**
   * Append a memory entry under `files/notes/`. Used by both the
   * `memory_note` MCP tool and post-session extraction. Updates
   * `snapshot.json` atomically so `getWorkspaceMemory()` reflects the
   * write immediately. Returns the relative path (`notes/<name>`).
   */
  async addMemoryNoteEntry(
    hash: string,
    args: {
      content: string;
      source: 'memory-note' | 'session-extraction';
      filenameHint?: string;
    },
  ): Promise<string> {
    const notesDir = this._memoryNotesDir(hash);
    await fsp.mkdir(notesDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slugSource = args.filenameHint || 'note';
    const slug = slugify(slugSource);
    const prefix = args.source === 'session-extraction' ? 'session' : 'note';

    // Pick a non-colliding filename.
    let attempt = 0;
    let name = `${prefix}_${timestamp}_${slug}.md`;
    while (true) {
      try {
        await fsp.access(path.join(notesDir, name));
        attempt++;
        name = `${prefix}_${timestamp}_${slug}_${attempt}.md`;
      } catch {
        break;
      }
    }

    await fsp.writeFile(path.join(notesDir, name), args.content, 'utf8');

    // Rebuild snapshot.json so callers immediately see the new entry.
    await this._refreshSnapshotIndex(hash);

    return `notes/${name}`;
  }

  /**
   * Replace an existing Agent Cockpit-owned note entry in place. Claude
   * capture files are immutable from this path because the next native
   * capture can rewrite that subtree.
   */
  async replaceMemoryNoteEntry(hash: string, relPath: string, content: string): Promise<boolean> {
    if (!relPath.startsWith('notes/')) {
      throw new Error('Only notes entries can be replaced');
    }
    if (!relPath.endsWith('.md')) {
      throw new Error('Only .md entries can be replaced');
    }

    const notesDir = this._memoryNotesDir(hash);
    const resolved = path.resolve(this._memoryFilesDir(hash), relPath);
    if (!resolved.startsWith(path.resolve(notesDir) + path.sep)) {
      throw new Error('Path traversal rejected');
    }

    try {
      await fsp.access(resolved);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    await atomicWriteFile(resolved, content);
    await this._refreshSnapshotIndex(hash);
    return true;
  }

  /**
   * Restore a superseded entry to active state and remove its entry ID
   * from replacement entries' `supersedes[]` lists.
   */
  async restoreMemoryEntry(hash: string, relPath: string): Promise<MemoryEntryMetadata | null> {
    const snapshot = await this.getWorkspaceMemory(hash);
    if (!snapshot || !snapshot.files.length) return null;

    const existing = await this.readMemoryMetadataIndex(hash);
    const now = new Date().toISOString();
    const entries: Record<string, MemoryEntryMetadata> = {};
    for (const file of snapshot.files) {
      const source = normalizeMemorySource(file.source, memorySourceFromFilename(file.filename));
      const metadata = normalizeMemoryMetadata(
        existing.entries[file.filename] || file.metadata,
        file.filename,
        source,
        now,
      );
      entries[file.filename] = {
        ...metadata,
        filename: file.filename,
        source,
      };
    }

    const current = entries[relPath];
    if (!current) return null;
    if (current.status !== 'superseded') {
      throw new Error('Only superseded memory entries can be restored');
    }

    const { supersededBy: _supersededBy, ...restoredBase } = current;
    const restored = normalizeMemoryMetadata(
      {
        ...restoredBase,
        status: 'active',
        updatedAt: now,
      },
      current.filename,
      current.source,
      now,
    );
    entries[relPath] = restored;

    for (const [filename, entry] of Object.entries(entries)) {
      if (filename === relPath || !entry.supersedes?.includes(current.entryId)) continue;
      const nextSupersedes = entry.supersedes.filter((entryId) => entryId !== current.entryId);
      const { supersedes: _supersedes, ...entryBase } = entry;
      entries[filename] = normalizeMemoryMetadata(
        {
          ...entryBase,
          ...(nextSupersedes.length ? { supersedes: nextSupersedes } : {}),
          updatedAt: now,
        },
        entry.filename,
        entry.source,
        now,
      );
    }

    await this._writeMemoryMetadataIndex(hash, {
      version: 1,
      updatedAt: now,
      entries,
    });
    await this._refreshSnapshotIndex(hash);

    return restored;
  }

  /**
   * Patch Agent Cockpit-owned lifecycle metadata for existing memory files.
   * The markdown files remain untouched; the sidecar and snapshot are
   * reconciled so future reads expose the same metadata.
   */
  async patchMemoryEntryMetadata(
    hash: string,
    updates: Array<{
      filename: string;
      patch: {
        status?: MemoryStatus;
        scope?: MemoryEntryMetadata['scope'];
        sourceConversationId?: string;
        supersedes?: string[];
        supersededBy?: string;
        confidence?: number;
        redaction?: MemoryRedaction[];
      };
    }>,
  ): Promise<MemoryEntryMetadata[]> {
    if (updates.length === 0) return [];

    const snapshot = await this.getWorkspaceMemory(hash);
    if (!snapshot || !snapshot.files.length) return [];

    const existing = await this.readMemoryMetadataIndex(hash);
    const now = new Date().toISOString();
    const entries: Record<string, MemoryEntryMetadata> = {};
    for (const file of snapshot.files) {
      const source = normalizeMemorySource(file.source, memorySourceFromFilename(file.filename));
      const metadata = normalizeMemoryMetadata(
        existing.entries[file.filename] || file.metadata,
        file.filename,
        source,
        now,
      );
      entries[file.filename] = {
        ...metadata,
        filename: file.filename,
        source,
      };
    }

    const patched: MemoryEntryMetadata[] = [];
    for (const update of updates) {
      const current = entries[update.filename];
      if (!current) continue;
      const next = normalizeMemoryMetadata(
        {
          ...current,
          ...update.patch,
          entryId: current.entryId,
          filename: current.filename,
          source: current.source,
          createdAt: current.createdAt,
          updatedAt: now,
        },
        current.filename,
        current.source,
        now,
      );
      entries[update.filename] = next;
      patched.push(next);
    }

    if (patched.length === 0) return [];

    await this._writeMemoryMetadataIndex(hash, {
      version: 1,
      updatedAt: now,
      entries,
    });
    await this._refreshSnapshotIndex(hash);

    return patched;
  }

  /**
   * Delete a single memory entry by its relative path (`claude/<name>`
   * or `notes/<name>`). Path is validated to stay inside
   * `files/`. Updates `snapshot.json` after deletion. Returns true if
   * the file was deleted, false if it didn't exist.
   */
  async deleteMemoryEntry(hash: string, relPath: string): Promise<boolean> {
    const filesDir = this._memoryFilesDir(hash);
    const resolved = path.resolve(filesDir, relPath);
    if (!resolved.startsWith(path.resolve(filesDir) + path.sep)) {
      throw new Error('Path traversal rejected');
    }
    if (!resolved.endsWith('.md')) {
      throw new Error('Only .md entries can be deleted');
    }
    const existing = await this.readMemoryMetadataIndex(hash);
    try {
      await fsp.unlink(resolved);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    const now = new Date().toISOString();
    const source = normalizeMemorySource(existing.entries[relPath]?.source, memorySourceFromFilename(relPath));
    const entries = { ...existing.entries };
    if (source === 'cli-capture') {
      const deleted = normalizeMemoryMetadata(
        {
          ...existing.entries[relPath],
          filename: relPath,
          source,
          status: 'deleted',
          updatedAt: now,
        },
        relPath,
        source,
        now,
      );
      entries[relPath] = deleted;
    } else {
      delete entries[relPath];
    }
    await this._writeMemoryMetadataIndex(hash, {
      version: 1,
      updatedAt: now,
      entries,
    });

    // Rebuild snapshot.json so the deletion is reflected.
    await this._refreshSnapshotIndex(hash);
    return true;
  }

  /**
   * Wipe all memory entries for a workspace. Removes every `.md` under
   * `memory/files/claude/` and `memory/files/notes/`, then rewrites
   * `snapshot.json` to reflect the empty state. Leaves the workspace's
   * Memory-enabled flag untouched. Returns the number of files deleted.
   */
  async clearWorkspaceMemory(hash: string): Promise<number> {
    let deleted = 0;
    for (const dir of [this._memoryClaudeDir(hash), this._memoryNotesDir(hash)]) {
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const name of entries) {
        if (!name.endsWith('.md')) continue;
        try {
          await fsp.unlink(path.join(dir, name));
          deleted++;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }

    // Bulk clear is a complete reset, so it drops deleted tombstones too.
    await this._writeMemoryMetadataIndex(hash, emptyMemoryMetadataIndex());

    // Rebuild snapshot.json so getWorkspaceMemory() reflects the wipe
    // immediately. Safe even if no prior snapshot existed.
    await this._refreshSnapshotIndex(hash);
    return deleted;
  }

  /**
   * Persist a reviewable audit record for manual memory consolidation.
   * Consolidation never deletes files; this file captures metadata-only
   * supersession changes plus any advisory actions the user left unapplied.
   */
  async saveMemoryConsolidationAudit(
    hash: string,
    audit: Omit<MemoryConsolidationAudit, 'version' | 'createdAt'> & { createdAt?: string },
  ): Promise<string> {
    return this.deps.store.saveConsolidationAudit(hash, audit);
  }

  /**
   * Rewrite `snapshot.json` from the current on-disk state without
   * re-running capture. Used after note writes and deletions so
   * `getWorkspaceMemory()` stays consistent.
   */
  private async _refreshSnapshotIndex(hash: string): Promise<void> {
    let snapshot = await this.deps.store.readSnapshot(hash);
    if (!snapshot) {
      // No prior snapshot — synthesize a minimal one keyed on the notes.
      snapshot = {
        capturedAt: new Date().toISOString(),
        sourceBackend: 'memory-note',
        sourcePath: null,
        index: '',
        files: [],
      };
      await fsp.mkdir(this._memoryDir(hash), { recursive: true });
    }

    // Re-read the Claude subtree so deletions of claude/* also take effect.
    const claudeDir = this._memoryClaudeDir(hash);
    const claudeFiles: MemoryFile[] = [];
    try {
      const names = await fsp.readdir(claudeDir);
      for (const name of names.sort()) {
        if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
        const full = path.join(claudeDir, name);
        const content = await fsp.readFile(full, 'utf8');
        const parsed = this.deps.parseMemoryFrontmatter(content);
        claudeFiles.push({
          filename: `claude/${name}`,
          name: parsed.name,
          description: parsed.description,
          type: parsed.type,
          content,
          source: 'cli-capture',
        });
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const notes = await this._readNotesFromDisk(hash);
    const files = await this._attachMemoryMetadata(hash, [...claudeFiles, ...notes], true);
    const next: MemorySnapshot = {
      ...snapshot,
      capturedAt: new Date().toISOString(),
      files,
    };
    await this.deps.store.writeSnapshot(hash, next);
  }

  async getWorkspaceMemoryPointer(hash: string): Promise<string | null> {
    if (!hash) return null;
    const enabled = await this.deps.getWorkspaceMemoryEnabled?.(hash);
    if (!enabled) return null;
    let filesDir = this._memoryFilesDir(hash);
    try {
      filesDir = await this.deps.store.ensureFilesDir(hash);
    } catch (err: unknown) {
      this.deps.log?.warn('Could not create workspace memory pointer directory', { path: filesDir, error: err });
    }
    const absPath = path.resolve(filesDir);
    return [
      `[Workspace memory is available at ${absPath}/`,
      `Contains .md files with YAML frontmatter (type, name, description) followed by body text.`,
      `Read these when the user references preferences, feedback, decisions, project context, or prior work style.]`,
    ].join('\n');
  }
}
