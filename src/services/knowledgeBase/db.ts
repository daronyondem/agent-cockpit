// Knowledge Base SQLite facade. KbDatabase owns one per-workspace
// better-sqlite3 handle and delegates domain logic to ./db/* modules.

import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as digestSessionDb from './db/digestSession';
import * as entriesDb from './db/entries';
import * as documentsDb from './db/documents';
import * as foldersDb from './db/folders';
import * as glossaryDb from './db/glossary';
import * as rawDb from './db/raw';
import * as reflectionsDb from './db/reflections';
import * as synthesisDb from './db/synthesis';
import * as synthesisGraphDb from './db/synthesisGraph';
import {
  ensureRootFolder,
  getSchemaVersion as readSchemaVersion,
  initSchema,
  recoverFromCrash,
} from './db/schema';
import * as statsDb from './db/stats';
import type {
  DigestSessionRow,
  InsertConnectionParams,
  InsertEntryParams,
  InsertEntrySourceParams,
  InsertLocationParams,
  InsertReflectionParams,
  InsertRawParams,
  InsertTopicHistoryParams,
  KbDocumentNodeRow,
  KbDocumentRow,
  KbEntrySourceRow,
  KbGlossaryRow,
  ListEntriesFilter,
  LocationRow,
  RawDbRow,
  RawError,
  ReplaceEntryParams,
  SynthesisConnectionRow,
  SynthesisReflectionRow,
  SynthesisRunMode,
  SynthesisRunRow,
  SynthesisRunStatus,
  SynthesisSnapshot,
  SynthesisTopicHistoryRow,
  SynthesisTopicRow,
  UpsertDocumentStructureParams,
  UpsertTopicParams,
} from './db/types';
import type {
  KbCounters,
  KbEntry,
  KbFolder,
  KbRawEntry,
  KbRawStatus,
} from '../../types';

export { KB_DB_SCHEMA_VERSION } from './db/schema';
export { normalizeFolderPath } from './db/folders';
export * from './db/types';

/**
 * Wrapper over a per-workspace SQLite database. Owns one `Database`
 * handle and delegates synchronous operations to focused DB modules.
 */
export class KbDatabase {
  private readonly db: BetterSqlite3Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // WAL gives us concurrent reads during a write and better crash
    // recovery than the default rollback journal. Foreign keys are off
    // by default in SQLite; we need them on for ON DELETE CASCADE to
    // work on the raw → entries → entry_tags chain.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    initSchema(this.db);
    ensureRootFolder(this.db);
    recoverFromCrash(this.db);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Meta ─────────────────────────────────────────────────────────────────

  getSchemaVersion(): number {
    return readSchemaVersion(this.db);
  }

  // ── Folders ──────────────────────────────────────────────────────────────

  listFolders(): KbFolder[] {
    return foldersDb.listFolders(this.db);
  }

  folderExists(folderPath: string): boolean {
    return foldersDb.folderExists(this.db, folderPath);
  }

  createFolder(folderPath: string): void {
    foldersDb.createFolder(this.db, folderPath);
  }

  renameFolder(fromPath: string, toPath: string): void {
    foldersDb.renameFolder(this.db, fromPath, toPath);
  }

  deleteFolder(folderPath: string): void {
    foldersDb.deleteFolder(this.db, folderPath);
  }

  listFolderSubtree(folderPath: string): KbFolder[] {
    return foldersDb.listFolderSubtree(this.db, folderPath);
  }

  // ── Raw files ────────────────────────────────────────────────────────────

  getRawById(rawId: string): RawDbRow | null {
    return rawDb.getRawById(this.db, rawId);
  }

  getRawBySha(sha256: string): RawDbRow | null {
    return rawDb.getRawBySha(this.db, sha256);
  }

  insertRaw(params: InsertRawParams): void {
    rawDb.insertRaw(this.db, params);
  }

  updateRawStatus(
    rawId: string,
    status: KbRawStatus,
    error: RawError | null = null,
  ): void {
    rawDb.updateRawStatus(this.db, rawId, status, error);
  }

  setRawDigestedAt(rawId: string, digestedAt: string): void {
    rawDb.setRawDigestedAt(this.db, rawId, digestedAt);
  }

  setRawHandler(rawId: string, handler: string): void {
    rawDb.setRawHandler(this.db, rawId, handler);
  }

  setRawMetadata(rawId: string, metadata: Record<string, unknown> | null): void {
    rawDb.setRawMetadata(this.db, rawId, metadata);
  }

  deleteRaw(rawId: string): string[] {
    return rawDb.deleteRaw(this.db, rawId);
  }

  // ── Raw locations ────────────────────────────────────────────────────────

  addLocation(params: InsertLocationParams): void {
    rawDb.addLocation(this.db, params);
  }

  removeLocation(rawId: string, folderPath: string, filename: string): void {
    rawDb.removeLocation(this.db, rawId, folderPath, filename);
  }

  countLocations(rawId: string): number {
    return rawDb.countLocations(this.db, rawId);
  }

  findLocation(folderPath: string, filename: string): LocationRow | null {
    return rawDb.findLocation(this.db, folderPath, filename);
  }

  listLocations(rawId: string): LocationRow[] {
    return rawDb.listLocations(this.db, rawId);
  }

  listRawInFolder(
    folderPath: string,
    opts: { limit?: number; offset?: number } = {},
  ): KbRawEntry[] {
    return rawDb.listRawInFolder(this.db, folderPath, opts);
  }

  listPendingDeleteRaw(): RawDbRow[] {
    return rawDb.listPendingDeleteRaw(this.db);
  }

  listAllRaw(): RawDbRow[] {
    return rawDb.listAllRaw(this.db);
  }

  listIngestedRawIds(): string[] {
    return rawDb.listIngestedRawIds(this.db);
  }

  // ── Document structure ──────────────────────────────────────────────────

  upsertDocumentStructure(params: UpsertDocumentStructureParams): void {
    documentsDb.upsertDocumentStructure(this.db, params);
  }

  getDocument(rawId: string): KbDocumentRow | null {
    return documentsDb.getDocument(this.db, rawId);
  }

  listDocumentNodes(rawId: string): KbDocumentNodeRow[] {
    return documentsDb.listDocumentNodes(this.db, rawId);
  }

  listDocuments(opts: { query?: string; limit?: number } = {}): KbDocumentRow[] {
    return documentsDb.listDocuments(this.db, opts);
  }

  deleteDocumentStructure(rawId: string): void {
    documentsDb.deleteDocumentStructure(this.db, rawId);
  }

  // ── Glossary ────────────────────────────────────────────────────────────

  listGlossary(): KbGlossaryRow[] {
    return glossaryDb.listGlossary(this.db);
  }

  getGlossaryTerm(id: number): KbGlossaryRow | null {
    return glossaryDb.getGlossaryTerm(this.db, id);
  }

  addGlossaryTerm(term: string, expansion: string, now = new Date().toISOString()): KbGlossaryRow {
    return glossaryDb.addGlossaryTerm(this.db, term, expansion, now);
  }

  updateGlossaryTerm(id: number, term: string, expansion: string, now = new Date().toISOString()): KbGlossaryRow | null {
    return glossaryDb.updateGlossaryTerm(this.db, id, term, expansion, now);
  }

  deleteGlossaryTerm(id: number): boolean {
    return glossaryDb.deleteGlossaryTerm(this.db, id);
  }

  // ── Counters ─────────────────────────────────────────────────────────────

  getCounters(): KbCounters {
    return statsDb.getCounters(this.db);
  }

  // ── Entries ──────────────────────────────────────────────────────────────

  insertEntry(params: InsertEntryParams): void {
    entriesDb.insertEntry(this.db, params);
  }

  insertEntrySources(sources: InsertEntrySourceParams[]): void {
    entriesDb.insertEntrySources(this.db, sources);
  }

  replaceEntriesForRawId(rawId: string, entries: ReplaceEntryParams[]): string[] {
    return entriesDb.replaceEntriesForRawId(this.db, rawId, entries);
  }

  listEntrySources(entryId: string): KbEntrySourceRow[] {
    return entriesDb.listEntrySources(this.db, entryId);
  }

  deleteEntriesByRawId(rawId: string): string[] {
    return entriesDb.deleteEntriesByRawId(this.db, rawId);
  }

  listEntryIdsByRawId(rawId: string): string[] {
    return entriesDb.listEntryIdsByRawId(this.db, rawId);
  }

  listEntryIds(): string[] {
    return entriesDb.listEntryIds(this.db);
  }

  entryExists(entryId: string): boolean {
    return entriesDb.entryExists(this.db, entryId);
  }

  countEntriesByRawId(rawId: string): number {
    return entriesDb.countEntriesByRawId(this.db, rawId);
  }

  getEntry(entryId: string): KbEntry | null {
    return entriesDb.getEntry(this.db, entryId);
  }

  listEntries(opts: ListEntriesFilter & { limit?: number; offset?: number } = {}): KbEntry[] {
    return entriesDb.listEntries(this.db, opts);
  }

  countEntries(opts: ListEntriesFilter = {}): number {
    return entriesDb.countEntries(this.db, opts);
  }

  listAllTags(): Array<{ tag: string; count: number }> {
    return entriesDb.listAllTags(this.db);
  }

  entryIdTaken(entryId: string): boolean {
    return entriesDb.entryIdTaken(this.db, entryId);
  }

  // ── Synthesis (Dreaming) ──────────────────────────────────────────────────

  getSynthesisMeta(key: string): string | null {
    return synthesisDb.getSynthesisMeta(this.db, key);
  }

  setSynthesisMeta(key: string, value: string): void {
    synthesisDb.setSynthesisMeta(this.db, key, value);
  }

  getSynthesisSnapshot(): SynthesisSnapshot {
    return synthesisDb.getSynthesisSnapshot(this.db);
  }

  startSynthesisRun(runId: string, mode: SynthesisRunMode, startedAt: string): void {
    synthesisDb.startSynthesisRun(this.db, runId, mode, startedAt);
  }

  finishSynthesisRun(
    runId: string,
    status: Exclude<SynthesisRunStatus, 'running'>,
    completedAt: string,
    errorMessage: string | null = null,
  ): void {
    synthesisDb.finishSynthesisRun(this.db, runId, status, completedAt, errorMessage);
  }

  getSynthesisRun(runId: string): SynthesisRunRow | null {
    return synthesisDb.getSynthesisRun(this.db, runId);
  }

  listSynthesisRuns(limit = 50): SynthesisRunRow[] {
    return synthesisDb.listSynthesisRuns(this.db, limit);
  }

  insertTopicHistory(params: InsertTopicHistoryParams): SynthesisTopicHistoryRow {
    return synthesisDb.insertTopicHistory(this.db, params);
  }

  listTopicHistory(topicId?: string): SynthesisTopicHistoryRow[] {
    return synthesisDb.listTopicHistory(this.db, topicId);
  }

  countNeedsSynthesis(): number {
    return synthesisDb.countNeedsSynthesis(this.db);
  }

  listNeedsSynthesisEntryIds(): string[] {
    return synthesisDb.listNeedsSynthesisEntryIds(this.db);
  }

  clearNeedsSynthesis(entryIds: string[]): void {
    synthesisDb.clearNeedsSynthesis(this.db, entryIds);
  }

  markAllNeedsSynthesis(): void {
    synthesisDb.markAllNeedsSynthesis(this.db);
  }

  markCoTopicEntriesStale(deletedEntryIds: string[]): void {
    synthesisDb.markCoTopicEntriesStale(this.db, deletedEntryIds);
  }

  // ── Synthesis Topics ────────────────────────────────────────────────────

  upsertTopic(params: UpsertTopicParams): void {
    synthesisGraphDb.upsertTopic(this.db, params);
  }

  deleteTopic(topicId: string): void {
    synthesisGraphDb.deleteTopic(this.db, topicId);
  }

  _deleteOrphanTopics(): void {
    synthesisGraphDb.deleteOrphanTopics(this.db);
  }

  getTopic(topicId: string): SynthesisTopicRow | null {
    return synthesisGraphDb.getTopic(this.db, topicId);
  }

  listTopics(): SynthesisTopicRow[] {
    return synthesisGraphDb.listTopics(this.db);
  }

  listTopicSummaries(): Array<{ topicId: string; title: string; summary: string | null }> {
    return synthesisGraphDb.listTopicSummaries(this.db);
  }

  listTopicIds(): string[] {
    return synthesisGraphDb.listTopicIds(this.db);
  }

  // ── Synthesis Topic-Entry Membership ────────────────────────────────────

  assignEntries(topicId: string, entryIds: string[]): void {
    synthesisGraphDb.assignEntries(this.db, topicId, entryIds);
  }

  unassignEntries(topicId: string, entryIds: string[]): void {
    synthesisGraphDb.unassignEntries(this.db, topicId, entryIds);
  }

  listTopicEntryIds(topicId: string): string[] {
    return synthesisGraphDb.listTopicEntryIds(this.db, topicId);
  }

  listEntryTopicIds(entryId: string): string[] {
    return synthesisGraphDb.listEntryTopicIds(this.db, entryId);
  }

  // ── Synthesis Connections ───────────────────────────────────────────────

  upsertConnection(params: InsertConnectionParams): void {
    synthesisGraphDb.upsertConnection(this.db, params);
  }

  removeConnection(sourceTopic: string, targetTopic: string): void {
    synthesisGraphDb.removeConnection(this.db, sourceTopic, targetTopic);
  }

  listConnectionsForTopic(topicId: string): SynthesisConnectionRow[] {
    return synthesisGraphDb.listConnectionsForTopic(this.db, topicId);
  }

  listAllConnections(): SynthesisConnectionRow[] {
    return synthesisGraphDb.listAllConnections(this.db);
  }

  listTopicPairsBySharedEntries(): Array<{
    topicA: string;
    topicB: string;
    sharedEntryCount: number;
  }> {
    return synthesisGraphDb.listTopicPairsBySharedEntries(this.db);
  }

  listTransitiveCandidates(): Array<{
    topicA: string;
    topicC: string;
    viaTopicB: string;
    relAB: string;
    relBC: string;
  }> {
    return synthesisGraphDb.listTransitiveCandidates(this.db);
  }

  // ── Synthesis Reflections ──────────────────────────────────────────────

  insertReflection(params: InsertReflectionParams): void {
    reflectionsDb.insertReflection(this.db, params);
  }

  listReflections(): SynthesisReflectionRow[] {
    return reflectionsDb.listReflections(this.db);
  }

  getReflection(reflectionId: string): (SynthesisReflectionRow & { citedEntryIds: string[] }) | null {
    return reflectionsDb.getReflection(this.db, reflectionId);
  }

  wipeReflections(): void {
    reflectionsDb.wipeReflections(this.db);
  }

  listStaleReflectionIds(): string[] {
    return reflectionsDb.listStaleReflectionIds(this.db);
  }

  deleteReflections(reflectionIds: string[]): void {
    reflectionsDb.deleteReflections(this.db, reflectionIds);
  }

  private _countStaleReflections(): number {
    return reflectionsDb.countStaleReflections(this.db);
  }

  // ── Synthesis Bulk Operations ──────────────────────────────────────────

  wipeSynthesis(): void {
    synthesisGraphDb.wipeSynthesis(this.db);
  }

  detectGodNodes(): string[] {
    return synthesisGraphDb.detectGodNodes(this.db);
  }

  // ── Digestion session (issue #148) ───────────────────────────────────────

  getDigestSession(): DigestSessionRow | null {
    return digestSessionDb.getDigestSession(this.db);
  }

  upsertDigestSession(row: DigestSessionRow): void {
    digestSessionDb.upsertDigestSession(this.db, row);
  }

  clearDigestSession(): void {
    digestSessionDb.clearDigestSession(this.db);
  }

}

// ─── Opener + migration ─────────────────────────────────────────────────────

/** Options for `openKbDatabase`. */
export interface OpenKbDatabaseOptions {
  /** Absolute path to the workspace's `knowledge/state.db`. */
  dbPath: string;
  /** Absolute path to the legacy `knowledge/state.json`, if any. */
  legacyJsonPath: string;
  /** Absolute path to `knowledge/raw/` for re-hashing migrated files. */
  rawDir: string;
}

/** Shape of the Phase 1/2 `state.json` we migrate from. */
interface LegacyKbState {
  version?: number;
  entrySchemaVersion?: number;
  raw?: Record<
    string,
    {
      rawId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      uploadedAt: string;
      status: string;
      error?: string;
    }
  >;
}

/**
 * Open (or create) a KB database, handling one-shot migration from the
 * legacy `state.json` format if needed. Returns a ready-to-use instance.
 *
 * Migration rules:
 *   - If `state.db` already exists → open it, skip migration entirely.
 *   - Else if `state.json` exists → open a fresh DB, replay the JSON
 *     into the schema in one tx, then rename the JSON to
 *     `state.json.migrated` as a one-release safety copy.
 *   - Else → open a fresh DB with just the empty schema + root folder.
 *
 * Migration hashes each raw file from disk to populate the full sha256
 * column (the legacy format only kept the 16-char rawId). Files that
 * are missing on disk are inserted anyway with sha256 = rawId, with a
 * warning logged — this can only happen if someone tampered with the
 * raw/ directory, but we'd rather preserve the state row so the user
 * can see the broken entry in the UI than silently drop it.
 */
export function openKbDatabase(opts: OpenKbDatabaseOptions): KbDatabase {
  const { dbPath, legacyJsonPath, rawDir } = opts;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const dbAlreadyExists = fs.existsSync(dbPath);
  const db = new KbDatabase(dbPath);

  if (dbAlreadyExists) return db;

  // Fresh DB — check for legacy state.json to migrate.
  if (!fs.existsSync(legacyJsonPath)) return db;

  let legacy: LegacyKbState;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf8')) as LegacyKbState;
  } catch (err) {
    console.warn(
      `[kb:db] failed to parse legacy state.json at ${legacyJsonPath}: ${(err as Error).message}. Starting fresh.`,
    );
    return db;
  }

  const rawEntries = legacy.raw ?? {};
  const rawIds = Object.keys(rawEntries);
  if (rawIds.length === 0) {
    // Nothing to migrate — still rename the empty JSON so we don't
    // keep retrying.
    safeRename(legacyJsonPath, legacyJsonPath + '.migrated');
    return db;
  }

  db.transaction(() => {
    for (const rawId of rawIds) {
      const row = rawEntries[rawId];
      const ext = path.extname(row.filename) || '';
      const rawFilePath = path.join(rawDir, `${rawId}${ext}`);
      let sha256 = rawId;
      try {
        const buf = fs.readFileSync(rawFilePath);
        sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      } catch (err) {
        console.warn(
          `[kb:db] migration: could not re-hash ${rawFilePath}: ${(err as Error).message}. Falling back to rawId as sha256.`,
        );
      }
      // Migrated rows are always in the legacy terminal states; if a
      // row was stuck as 'ingesting' or 'digesting' at shutdown, snap
      // it to 'failed' so the user can retry it.
      let status: KbRawStatus = 'ingested';
      const legacyStatus = row.status;
      if (legacyStatus === 'ingested' || legacyStatus === 'digested' || legacyStatus === 'failed') {
        status = legacyStatus;
      } else {
        status = 'failed';
      }
      db.insertRaw({
        rawId,
        sha256,
        status,
        byteLength: row.sizeBytes,
        mimeType: row.mimeType,
        handler: null,
        uploadedAt: row.uploadedAt,
        metadata: null,
      });
      if (row.error) {
        db.updateRawStatus(rawId, status, {
          errorClass: 'unknown',
          errorMessage: row.error,
        });
      }
      db.addLocation({
        rawId,
        folderPath: '',
        filename: row.filename,
        uploadedAt: row.uploadedAt,
      });
    }
  });

  safeRename(legacyJsonPath, legacyJsonPath + '.migrated');
  return db;
}

function safeRename(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    console.warn(
      `[kb:db] could not rename ${from} → ${to}: ${(err as Error).message}`,
    );
  }
}
