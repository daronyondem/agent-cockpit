import crypto from 'crypto';
import path from 'path';
import type { RunOneShotOptions } from '../backends/base';
import type { BackendRegistry } from '../backends/registry';
import type { CliProfileRuntime } from '../cliProfiles';
import type {
  EffortLevel,
  ContextMapWorkspaceSettings,
  Conversation,
  ConversationListItem,
  Message,
  Settings,
} from '../../types';
import type {
  ContextCandidateType,
  ContextEntityRow,
  ContextMapDatabase,
  ContextRunSource,
  ContextSourceCursorType,
  InsertCandidateParams,
  UpsertConversationCursorParams,
} from './db';
import {
  DEFAULT_CONTEXT_MAP_CLI_CONCURRENCY,
  DEFAULT_CONTEXT_MAP_EXTRACTION_CONCURRENCY,
  DEFAULT_CONTEXT_MAP_SCAN_INTERVAL_MINUTES,
  DEFAULT_CONTEXT_MAP_SYNTHESIS_CONCURRENCY,
  MAX_CONTEXT_MAP_PROCESSOR_CONCURRENCY,
} from './defaults';
import { parseContextMapJsonOutput, repairContextMapJsonOutput } from './jsonRepair';
import { logger } from '../../utils/logger';
import {
  buildContextMapRunTimings,
  buildExtractionFailureMessage,
  buildExtractionTimingSummary,
  countDraftsByType,
  draftTypeCount,
  emptySynthesisMetadata,
  summarizeExtractionRepairs,
  truncateErrorMessage,
  type ContextMapExtractionFailure,
  type ContextMapExtractionRepairEvent,
  type ContextMapExtractionTimingSummary,
  type ContextMapExtractionUnitTiming,
  type ContextMapRunTimings,
  type ContextMapSynthesisMetadata,
  type ContextMapSynthesisStageMetadata,
} from './pipelineMetadata';
import { autoApplyContextMapCandidates } from './autoApply';
import {
  buildWorkspaceSourcePackets,
  emptyWorkspaceSourceBuildResult,
  emptyWorkspaceSourcePlanning,
  formatStaleSourceCursor,
  planWorkspaceSourcePackets,
  shouldDiscoverWorkspaceSources,
  type ContextMapSourcePacket,
} from './sourcePlanning';
import {
  CONTEXT_MAP_ALLOWED_RELATIONSHIP_PREDICATES,
  CONTEXT_MAP_BUILT_IN_ENTITY_TYPES,
  CONTEXT_MAP_ENTITY_TYPE_PROMPT,
  CONTEXT_MAP_FACT_PAYLOAD_KEYS,
  CONTEXT_MAP_RELATIONSHIP_PREDICATE_PROMPT,
  CONTEXT_MAP_TYPE_ALIASES,
  canonicalEntityName,
  canonicalRelationshipName,
  dedupeFacts,
  hasRelationshipEvidence,
  isAllowedRelationshipPredicate,
  isSelfRelationshipPayload,
  normalizeAliasArray,
  normalizeCandidateFacts,
  normalizeCandidateSensitivity,
  normalizeFactArray,
  normalizedCandidateText,
  normalizeRelationshipPredicate,
  normalizeSlug,
  readPayloadString,
} from './candidatePrimitives';

const log = logger.child({ module: 'context-map-service' });

export interface ContextMapChatService {
  getSettings(): Promise<Settings>;
  resolveCliProfileRuntime?(
    cliProfileId: string | undefined | null,
    fallbackBackend?: string | null,
  ): Promise<CliProfileRuntime>;
  getWorkspaceContextMapSettings(hash: string): Promise<ContextMapWorkspaceSettings | null>;
  getContextMapDb(hash: string): ContextMapDatabase | null;
  listConversations(opts?: { archived?: boolean }): Promise<ConversationListItem[]>;
  getConversation(id: string): Promise<Conversation | null>;
  getSessionMessages?(id: string, sessionNumber: number): Promise<Message[] | null>;
  getWorkspacePath?(hash: string): Promise<string | null>;
  getWorkspaceInstructions?(hash: string): Promise<string | null>;
}

export interface ContextMapWorkspaceProcessResult {
  workspaceHash: string;
  source: ContextRunSource | null;
  runId: string | null;
  conversationsScanned: number;
  spansInserted: number;
  cursorsUpdated: number;
  messagesProcessed: number;
  candidatesCreated: number;
  stopped?: boolean;
  skippedReason?: 'workspace-not-found' | 'already-running' | 'no-changes';
}

interface ContextMapSpanWork {
  spanId: string;
  conversationId: string;
  sessionEpoch: number;
  startMessageId: string;
  endMessageId: string;
  sourceHash: string;
  cursor: UpsertConversationCursorParams;
  messageCount: number;
  conversationTitle: string;
  workingDir: string;
  messages: Message[];
}

interface PendingContextMapCandidate {
  candidateType: ContextCandidateType;
  confidence: number;
  payload: Record<string, unknown>;
}

interface ContextMapCandidateDraft extends PendingContextMapCandidate {
  idSource:
    | { kind: 'span'; runId: string; spanId: string; index: number }
    | { kind: 'source'; sourceType: ContextMapSourcePacket['sourceType']; sourceId: string; sourceHash: string };
}

interface ContextMapSuccessfulSourceCursor {
  sourceType: ContextSourceCursorType;
  sourceId: string;
  sourceHash: string;
}

interface ContextMapExtractionResult {
  candidates: InsertCandidateParams[];
  successfulSpanIds: Set<string>;
  successfulSourcePackets: number;
  successfulSourceCursors: ContextMapSuccessfulSourceCursor[];
  failures: ContextMapExtractionFailure[];
  repairs: ContextMapExtractionRepairEvent[];
  synthesis: ContextMapSynthesisMetadata;
  timings: Pick<ContextMapRunTimings, 'extractionMs' | 'synthesisMs' | 'extractionUnits' | 'synthesisStages'>;
}

type ContextMapExtractionJob =
  | { kind: 'span'; span: ContextMapSpanWork }
  | { kind: 'source'; packet: ContextMapSourcePacket };

interface ContextMapExtractionJobResult {
  job: ContextMapExtractionJob;
  sourceType: ContextMapExtractionFailure['sourceType'];
  sourceId: string;
  durationMs: number;
  candidates: PendingContextMapCandidate[];
  repairs: ContextMapExtractionRepairEvent[];
  errorMessage?: string;
}

interface KnownEntityTargets {
  ids: Set<string>;
  names: Set<string>;
}

interface KnownRelationshipEndpoint {
  name: string;
  typeSlug: string;
  draft?: ContextMapCandidateDraft;
  entity?: ContextEntityRow;
}

interface KnownRelationshipEndpoints {
  exact: Map<string, KnownRelationshipEndpoint>;
  canonical: Map<string, KnownRelationshipEndpoint>;
}

interface ActiveContextMapRun {
  abortController: AbortController;
  runId?: string;
  db?: ContextMapDatabase;
}

interface ResolvedContextMapProcessor {
  runtime: CliProfileRuntime;
  model?: string;
  effort?: EffortLevel;
}

interface ContextMapProcessorAdapter {
  runOneShot(prompt: string, opts?: RunOneShotOptions): Promise<string>;
}

export interface ContextMapServiceOptions {
  chatService: ContextMapChatService;
  backendRegistry?: BackendRegistry | null;
  now?: () => Date;
  emitUpdate?: (hash: string) => void | Promise<void>;
}

export class ContextMapService {
  private readonly chatService: ContextMapChatService;
  private readonly backendRegistry: BackendRegistry | null;
  private readonly now: () => Date;
  private readonly emitUpdate?: (hash: string) => void | Promise<void>;
  private readonly running = new Map<string, ActiveContextMapRun>();

  constructor(opts: ContextMapServiceOptions) {
    this.chatService = opts.chatService;
    this.backendRegistry = opts.backendRegistry ?? null;
    this.now = opts.now ?? (() => new Date());
    this.emitUpdate = opts.emitUpdate;
  }

  isRunning(hash: string): boolean {
    return this.running.has(hash);
  }

  async stopWorkspace(hash: string): Promise<boolean> {
    const active = this.running.get(hash);
    if (!active) return false;
    active.abortController.abort();
    if (active.db && active.runId) {
      const run = active.db.getRun(active.runId);
      if (run?.status === 'running') {
        active.db.finishRun(active.runId, 'stopped', this.now().toISOString(), 'Stopped by user');
      }
    }
    if (this.emitUpdate) {
      try {
        await this.emitUpdate(hash);
      } catch (err: unknown) {
        log.warn('Failed to emit stop update', { workspaceHash: hash, error: err });
      }
    }
    return true;
  }

  async processWorkspace(
    hash: string,
    opts: { source?: ContextRunSource } = {},
  ): Promise<ContextMapWorkspaceProcessResult> {
    if (this.running.has(hash)) {
      return emptyResult(hash, null, 'already-running');
    }
    const active: ActiveContextMapRun = { abortController: new AbortController() };
    this.running.set(hash, active);
    let shouldEmitUpdate = false;
    try {
      const result = await this.processWorkspaceInternal(hash, opts, active);
      shouldEmitUpdate = result.runId !== null;
      return result;
    } catch (err: unknown) {
      shouldEmitUpdate = true;
      throw err;
    } finally {
      this.running.delete(hash);
      if (shouldEmitUpdate && this.emitUpdate) {
        try {
          await this.emitUpdate(hash);
        } catch (err: unknown) {
          log.warn('Failed to emit update', { workspaceHash: hash, error: err });
        }
      }
    }
  }

  async processConversationSession(
    hash: string,
    conversationId: string,
    sessionNumber: number,
    opts: { source: Extract<ContextRunSource, 'session_reset' | 'archive'> },
  ): Promise<ContextMapWorkspaceProcessResult> {
    if (this.running.has(hash)) {
      return emptyResult(hash, null, 'already-running');
    }
    const active: ActiveContextMapRun = { abortController: new AbortController() };
    this.running.set(hash, active);
    let shouldEmitUpdate = false;
    try {
      const result = await this.processWorkspaceInternal(hash, {
        source: opts.source,
        conversationScope: { conversationId, sessionNumber },
      }, active);
      shouldEmitUpdate = result.runId !== null;
      return result;
    } catch (err: unknown) {
      shouldEmitUpdate = true;
      throw err;
    } finally {
      this.running.delete(hash);
      if (shouldEmitUpdate && this.emitUpdate) {
        try {
          await this.emitUpdate(hash);
        } catch (err: unknown) {
          log.warn('Failed to emit update', { workspaceHash: hash, error: err });
        }
      }
    }
  }

  private async processWorkspaceInternal(
    hash: string,
    opts: {
      source?: ContextRunSource;
      conversationScope?: { conversationId: string; sessionNumber: number };
    },
    active: ActiveContextMapRun,
  ): Promise<ContextMapWorkspaceProcessResult> {
    const totalStartedMs = monotonicNowMs();
    const workspaceSettings = await this.chatService.getWorkspaceContextMapSettings(hash);
    if (!workspaceSettings) {
      return emptyResult(hash, null, 'workspace-not-found');
    }

    const settings = await this.chatService.getSettings();
    configureContextMapProcessorConcurrency(settings.contextMap);
    const db = this.chatService.getContextMapDb(hash);
    if (!db) {
      return emptyResult(hash, null, 'workspace-not-found');
    }

    const planningStartedMs = monotonicNowMs();
    const spans: ContextMapSpanWork[] = [];
    const cursorOnly: UpsertConversationCursorParams[] = [];
    let conversationsScanned = 0;
    let messagesProcessed = 0;

    if (opts.conversationScope) {
      const conversation = await this.chatService.getConversation(opts.conversationScope.conversationId);
      const messages = this.chatService.getSessionMessages
        ? await this.chatService.getSessionMessages(opts.conversationScope.conversationId, opts.conversationScope.sessionNumber)
        : null;
      if (conversation && conversation.workspaceHash === hash && messages) {
        const work = buildConversationSessionWork(db, {
          conversationId: conversation.id,
          sessionNumber: opts.conversationScope.sessionNumber,
          title: conversation.title,
          workingDir: conversation.workingDir,
          messages,
        }, this.now);
        if (work) {
          conversationsScanned += 1;
          messagesProcessed += work.messageCount;
          if (work.span) {
            spans.push(work.span);
          } else {
            cursorOnly.push(work.cursor);
          }
        }
      }
    } else {
      const refs = (await this.chatService.listConversations({ archived: false }))
        .filter((conv) => conv.workspaceHash === hash && !conv.archived)
        .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

      for (const ref of refs) {
        const conversation = await this.chatService.getConversation(ref.id);
        if (!conversation || conversation.workspaceHash !== hash) continue;
        const work = buildConversationWork(db, conversation, this.now);
        if (!work) continue;
        conversationsScanned += 1;
        messagesProcessed += work.messageCount;
        if (work.span) {
          spans.push(work.span);
        } else {
          cursorOnly.push(work.cursor);
        }
      }
    }
    const planningMs = elapsedMs(planningStartedMs);

    const sourceDiscoveryStartedMs = monotonicNowMs();
    const source = opts.source ?? (db.listRuns().length === 0 ? 'initial_scan' : 'scheduled');
    const workspaceSourceBuild = shouldDiscoverWorkspaceSources(source)
      ? await buildWorkspaceSourcePackets(this.chatService, hash)
      : emptyWorkspaceSourceBuildResult();
    const sourcePlanning = !opts.conversationScope && shouldDiscoverWorkspaceSources(source)
      ? planWorkspaceSourcePackets(
        db,
        source,
        workspaceSourceBuild.packets,
        workspaceSourceBuild.discoveredCursorKeys,
      )
      : emptyWorkspaceSourcePlanning();
    const sourcePackets = sourcePlanning.packetsForExtraction;
    const sourceDiscoveryMs = elapsedMs(sourceDiscoveryStartedMs);

    if (spans.length === 0 && sourcePackets.length === 0 && sourcePlanning.missingCursors.length === 0) {
      if (cursorOnly.length > 0) {
        db.transaction(() => {
          for (const cursor of cursorOnly) db.upsertConversationCursor(cursor);
        });
        return {
          workspaceHash: hash,
          source: null,
          runId: null,
          conversationsScanned,
          spansInserted: 0,
          cursorsUpdated: cursorOnly.length,
          messagesProcessed,
          candidatesCreated: 0,
        };
      }
      return emptyResult(hash, null, 'no-changes');
    }

    const startedAt = this.now().toISOString();
    const runId = `cm-run-${crypto.randomUUID()}`;
    db.insertRun({
      runId,
      source,
      startedAt,
      metadata: {
        conversationsScanned,
        spansInserted: spans.length,
        messagesProcessed,
        sourcePacketsDiscovered: sourcePlanning.discoveredPackets.length,
        sourcePacketsProcessed: sourcePackets.length,
        sourcePacketsSkippedUnchanged: sourcePlanning.skippedUnchanged,
        sourceCursorsMarkedMissing: sourcePlanning.missingCursors.length,
      },
    });
    active.runId = runId;
    active.db = db;
    if (this.emitUpdate) {
      try {
        await this.emitUpdate(hash);
      } catch (err: unknown) {
        log.warn('Failed to emit running update', { workspaceHash: hash, error: err });
      }
    }

    try {
      throwIfContextMapStopped(active.abortController.signal);
      const extraction = await this.extractPendingCandidates(
        spans,
        sourcePackets,
        runId,
        source,
        settings,
        workspaceSettings,
        db,
        active.abortController.signal,
      );
      throwIfContextMapStopped(active.abortController.signal);
      const successfulSpans = spans.filter((span) => extraction.successfulSpanIds.has(span.spanId));
      const successfulExtractionUnits = successfulSpans.length + extraction.successfulSourcePackets;
      const baseRunMetadata = {
        conversationsScanned,
        spansInserted: successfulSpans.length,
        spansPlanned: spans.length,
        messagesProcessed,
        sourcePacketsProcessed: sourcePackets.length,
        sourcePacketsSucceeded: extraction.successfulSourcePackets,
        sourcePacketsDiscovered: sourcePlanning.discoveredPackets.length,
        sourcePacketsSkippedUnchanged: sourcePlanning.skippedUnchanged,
        sourceCursorsMarkedMissing: sourcePlanning.missingCursors.length,
        staleSources: sourcePlanning.missingCursors.slice(0, 50).map(formatStaleSourceCursor),
        extractionUnitsFailed: extraction.failures.length,
        extractionFailures: extraction.failures.slice(0, 20),
        extractionRepairs: summarizeExtractionRepairs(extraction.repairs),
        candidateSynthesis: extraction.synthesis,
        timings: buildContextMapRunTimings({
          totalMs: elapsedMs(totalStartedMs),
          planningMs,
          sourceDiscoveryMs,
          extractionMs: extraction.timings.extractionMs,
          synthesisMs: extraction.timings.synthesisMs,
          persistenceMs: 0,
          autoApplyMs: 0,
          extractionUnits: extraction.timings.extractionUnits,
          synthesisStages: extraction.timings.synthesisStages,
        }),
      };
      if (successfulExtractionUnits === 0 && extraction.failures.length > 0) {
        db.updateRunMetadata(runId, baseRunMetadata);
        throw new Error(buildExtractionFailureMessage(extraction.failures));
      }
      const completedAt = this.now().toISOString();
      const persistenceStartedMs = monotonicNowMs();
      const insertedCandidateIds = db.transaction(() => {
        const ids: string[] = [];
        for (const span of successfulSpans) {
          db.insertSourceSpan({
            spanId: span.spanId,
            runId,
            conversationId: span.conversationId,
            sessionEpoch: span.sessionEpoch,
            startMessageId: span.startMessageId,
            endMessageId: span.endMessageId,
            sourceHash: span.sourceHash,
            processedAt: completedAt,
          });
          db.upsertConversationCursor(span.cursor);
        }
        for (const cursor of cursorOnly) db.upsertConversationCursor(cursor);
        for (const cursor of extraction.successfulSourceCursors) {
          db.upsertSourceCursor({
            sourceType: cursor.sourceType,
            sourceId: cursor.sourceId,
            lastProcessedSourceHash: cursor.sourceHash,
            lastProcessedAt: completedAt,
            lastSeenAt: completedAt,
            lastRunId: runId,
            status: 'active',
            errorMessage: null,
          });
        }
        for (const cursor of sourcePlanning.missingCursors) {
          db.markSourceCursorMissing(cursor.sourceType, cursor.sourceId, completedAt, runId);
        }
        for (const candidate of extraction.candidates) {
          if (db.getCandidate(candidate.candidateId)) continue;
          db.insertCandidate(candidate);
          ids.push(candidate.candidateId);
        }
        return ids;
      });
      const persistenceMs = elapsedMs(persistenceStartedMs);
      const autoApplyStartedMs = monotonicNowMs();
      const autoApplyCandidateIds = Array.from(new Set([
        ...insertedCandidateIds,
        ...db.listCandidates('pending').map((candidate) => candidate.candidateId),
      ]));
      const autoApply = autoApplyContextMapCandidates(db, autoApplyCandidateIds, completedAt);
      const insertedCandidatesAfterAutoApply = insertedCandidateIds
        .map((candidateId) => db.getCandidate(candidateId))
        .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
      const insertedCandidatesAutoApplied = insertedCandidatesAfterAutoApply
        .filter((candidate) => candidate.status === 'active').length;
      const insertedCandidatesNeedingAttention = insertedCandidatesAfterAutoApply
        .filter((candidate) => candidate.status === 'pending').length;
      const autoApplyMs = elapsedMs(autoApplyStartedMs);
      const finalRunMetadata = {
        ...baseRunMetadata,
        candidatesInserted: insertedCandidateIds.length,
        candidatesAutoApplied: autoApply.applied,
        existingCandidatesAutoApplied: Math.max(0, autoApply.applied - insertedCandidatesAutoApplied),
        candidatesNeedingAttention: insertedCandidatesNeedingAttention,
        autoApplyFailures: autoApply.failures.slice(0, 20),
        timings: buildContextMapRunTimings({
          totalMs: elapsedMs(totalStartedMs),
          planningMs,
          sourceDiscoveryMs,
          extractionMs: extraction.timings.extractionMs,
          synthesisMs: extraction.timings.synthesisMs,
          persistenceMs,
          autoApplyMs,
          extractionUnits: extraction.timings.extractionUnits,
          synthesisStages: extraction.timings.synthesisStages,
        }),
      };
      db.updateRunMetadata(runId, finalRunMetadata);
      db.finishRun(
        runId,
        'completed',
        completedAt,
        extraction.failures.length > 0 ? buildExtractionFailureMessage(extraction.failures) : null,
      );
      return {
        workspaceHash: hash,
        source,
        runId,
        conversationsScanned,
        spansInserted: successfulSpans.length,
        cursorsUpdated: successfulSpans.length + cursorOnly.length,
        messagesProcessed,
        candidatesCreated: insertedCandidateIds.length,
      };
    } catch (err: unknown) {
      const stopped = isContextMapStop(err, active.abortController.signal);
      db.finishRun(
        runId,
        stopped ? 'stopped' : 'failed',
        this.now().toISOString(),
        stopped ? 'Stopped by user' : (err as Error).message,
      );
      if (stopped) {
        return {
          workspaceHash: hash,
          source,
          runId,
          conversationsScanned,
          spansInserted: 0,
          cursorsUpdated: 0,
          messagesProcessed,
          candidatesCreated: 0,
          stopped: true,
        };
      }
      throw err;
    }
  }

  private async extractPendingCandidates(
    spans: ContextMapSpanWork[],
    sourcePackets: ContextMapSourcePacket[],
    runId: string,
    runSource: ContextRunSource,
    settings: Settings,
    workspaceSettings: ContextMapWorkspaceSettings,
    db: ContextMapDatabase,
    abortSignal: AbortSignal,
  ): Promise<ContextMapExtractionResult> {
    if (!this.backendRegistry || (spans.length === 0 && sourcePackets.length === 0)) {
      return emptyExtractionResult(spans);
    }

    const processor = await this.resolveProcessor(settings, workspaceSettings);
    const adapter = this.backendRegistry.get(processor.runtime.backendId);
    if (!adapter) {
      throw new Error(
        `Configured Context Map processor "${processor.runtime.cliProfileId || processor.runtime.backendId}" uses unregistered backend "${processor.runtime.backendId}".`,
      );
    }

    const extractionStartedMs = monotonicNowMs();
    const jobs: ContextMapExtractionJob[] = [
      ...spans.map((span) => ({ kind: 'span' as const, span })),
      ...sourcePackets.map((packet) => ({ kind: 'source' as const, packet })),
    ];
    const jobResults = await Promise.all(jobs.map((job) => runContextMapExtractionJob({
      job,
      adapter,
      processor,
      abortSignal,
    })));
    const drafts: ContextMapCandidateDraft[] = [];
    const failures: ContextMapExtractionFailure[] = [];
    const repairs: ContextMapExtractionRepairEvent[] = [];
    const extractionUnitTimings: ContextMapExtractionUnitTiming[] = [];
    const successfulSpanIds = new Set<string>();
    const successfulSourceCursors: ContextMapSuccessfulSourceCursor[] = [];
    let successfulSourcePackets = 0;
    const knownEntityTargets = buildKnownEntityTargets(db);

    for (const result of jobResults) {
      repairs.push(...result.repairs);
      if (result.errorMessage) {
        failures.push({
          sourceType: result.sourceType,
          sourceId: result.sourceId,
          errorMessage: result.errorMessage,
        });
        extractionUnitTimings.push({
          sourceType: result.sourceType,
          sourceId: result.sourceId,
          durationMs: result.durationMs,
          status: 'failed',
          candidates: 0,
          ...(result.repairs.length > 0 ? { repaired: true } : {}),
        });
        continue;
      }

      if (result.job.kind === 'span') {
        const { span } = result.job;
        const parsed = prepareCandidatesForReview(result.candidates, knownEntityTargets).filter((candidate) => (
          shouldKeepCandidate(candidate, { workspacePath: span.workingDir })
        ));
        successfulSpanIds.add(span.spanId);
        parsed.forEach((candidate, index) => {
          const payload = {
            ...candidate.payload,
            sourceSpan: {
              spanId: span.spanId,
              runId,
              sourceType: 'conversation_message',
              conversationId: span.conversationId,
              sessionEpoch: span.sessionEpoch,
              startMessageId: span.startMessageId,
              endMessageId: span.endMessageId,
              sourceHash: span.sourceHash,
            },
          };
          drafts.push({
            idSource: { kind: 'span', runId, spanId: span.spanId, index },
            candidateType: candidate.candidateType,
            payload,
            confidence: candidate.confidence,
          });
          rememberCandidateEntity(candidate, knownEntityTargets);
        });
        extractionUnitTimings.push({
          sourceType: result.sourceType,
          sourceId: result.sourceId,
          durationMs: result.durationMs,
          status: 'succeeded',
          candidates: parsed.length,
          ...(result.repairs.length > 0 ? { repaired: true } : {}),
        });
        continue;
      }

      const { packet } = result.job;
      const parsed = limitCandidatesForSource(
        prepareCandidatesForReview(result.candidates, knownEntityTargets).filter((candidate) => (
          shouldKeepCandidate(candidate, {
            sourcePacket: packet,
            workspacePath: packet.locator.workspacePath as string | undefined,
          })
        )),
        packet,
      );
      successfulSourcePackets += 1;
      successfulSourceCursors.push({
        sourceType: packet.sourceType,
        sourceId: packet.sourceId,
        sourceHash: packet.sourceHash,
      });
      parsed.forEach((candidate) => {
        const payload = {
          ...candidate.payload,
          sourceSpan: {
            sourceType: packet.sourceType,
            sourceId: packet.sourceId,
            runId,
            sourceHash: packet.sourceHash,
            locator: packet.locator,
          },
        };
        drafts.push({
          idSource: {
            kind: 'source',
            sourceType: packet.sourceType,
            sourceId: packet.sourceId,
            sourceHash: packet.sourceHash,
          },
          candidateType: candidate.candidateType,
          payload,
          confidence: candidate.confidence,
        });
        rememberCandidateEntity(candidate, knownEntityTargets);
      });
      extractionUnitTimings.push({
        sourceType: result.sourceType,
        sourceId: result.sourceId,
        durationMs: result.durationMs,
        status: 'succeeded',
        candidates: parsed.length,
        ...(result.repairs.length > 0 ? { repaired: true } : {}),
      });
    }
    const extractionMs = elapsedMs(extractionStartedMs);
    const packetWorkspacePath = sourcePackets.find((packet) => typeof packet.locator.workspacePath === 'string')?.locator.workspacePath;
    const workspacePath = spans[0]?.workingDir || (typeof packetWorkspacePath === 'string' ? packetWorkspacePath : undefined);
    const initialRefined = prepareCandidateDraftsForPersistence(drafts, db, workspacePath, false);
    const synthesisStartedMs = monotonicNowMs();
    const synthesisResult = await synthesizeCandidateDrafts({
      drafts: initialRefined,
      db,
      adapter,
      processor,
      abortSignal,
      workspacePath,
      minCandidates: runSource === 'scheduled'
        ? CONTEXT_MAP_SCHEDULED_SYNTHESIS_MIN_CANDIDATES
        : CONTEXT_MAP_SYNTHESIS_MIN_CANDIDATES,
    });
    const relationshipRecovered = recoverStrictRelationshipDrafts(
      synthesisResult.drafts,
      initialRefined,
      db,
      workspacePath,
    );
    const recoveredRelationshipCandidates = Math.max(
      0,
      draftTypeCount(relationshipRecovered, 'new_relationship') - draftTypeCount(synthesisResult.drafts, 'new_relationship'),
    );
    const refined = prepareCandidateDraftsForPersistence(
      relationshipRecovered,
      db,
      workspacePath,
      synthesisResult.metadata.attempted,
    );
    const synthesisMs = elapsedMs(synthesisStartedMs);
    const now = this.now().toISOString();
    const candidates: InsertCandidateParams[] = [];
    const seenCandidateKeys = new Set<string>();
    for (const draft of refined) {
      const semanticKey = candidateSemanticKey(draft.candidateType, draft.payload);
      if (semanticKey && seenCandidateKeys.has(semanticKey)) continue;
      if (semanticKey) seenCandidateKeys.add(semanticKey);
      candidates.push({
        candidateId: draftCandidateId(draft),
        runId,
        candidateType: draft.candidateType,
        payload: draft.payload,
        confidence: draft.confidence,
        now,
      });
    }
    return {
      candidates,
      successfulSpanIds,
      successfulSourcePackets,
      successfulSourceCursors,
      failures,
      repairs,
      synthesis: {
        ...synthesisResult.metadata,
        outputCandidates: refined.length,
        inputCandidateTypes: countDraftsByType(initialRefined),
        outputCandidateTypes: countDraftsByType(refined),
        droppedCandidates: Math.max(0, synthesisResult.metadata.inputCandidates - refined.length),
        ...(recoveredRelationshipCandidates > 0 ? { recoveredRelationshipCandidates } : {}),
      },
      timings: {
        extractionMs,
        synthesisMs,
        extractionUnits: buildExtractionTimingSummary(extractionUnitTimings),
        synthesisStages: synthesisResult.metadata.stages || [],
      },
    };
  }

  private async resolveProcessor(
    settings: Settings,
    workspaceSettings: ContextMapWorkspaceSettings,
  ): Promise<ResolvedContextMapProcessor> {
    const mode = workspaceSettings.processorMode === 'override' ? 'override' : 'global';
    const global = settings.contextMap || {};
    const cliProfileId = mode === 'override'
      ? workspaceSettings.cliProfileId ?? global.cliProfileId
      : global.cliProfileId;
    const fallbackBackend = mode === 'override'
      ? workspaceSettings.cliBackend || global.cliBackend || settings.defaultBackend || 'claude-code'
      : global.cliBackend || settings.defaultBackend || 'claude-code';
    const runtime = this.chatService.resolveCliProfileRuntime
      ? await this.chatService.resolveCliProfileRuntime(cliProfileId, fallbackBackend)
      : { backendId: fallbackBackend };

    return {
      runtime,
      model: mode === 'override' ? workspaceSettings.cliModel || global.cliModel : global.cliModel,
      effort: mode === 'override' ? workspaceSettings.cliEffort || global.cliEffort : global.cliEffort,
    };
  }
}

async function runContextMapExtractionJob(opts: {
  job: ContextMapExtractionJob;
  adapter: ContextMapProcessorAdapter;
  processor: ResolvedContextMapProcessor;
  abortSignal: AbortSignal;
}): Promise<ContextMapExtractionJobResult> {
  const sourceType = opts.job.kind === 'span' ? 'conversation_message' : opts.job.packet.sourceType;
  const sourceId = opts.job.kind === 'span'
    ? `${opts.job.span.conversationId}:${opts.job.span.startMessageId}-${opts.job.span.endMessageId}`
    : opts.job.packet.sourceId;
  const workspacePath = opts.job.kind === 'span'
    ? opts.job.span.workingDir || undefined
    : opts.job.packet.locator.workspacePath as string | undefined;
  const startedMs = monotonicNowMs();
  const repairs: ContextMapExtractionRepairEvent[] = [];

  try {
    throwIfContextMapStopped(opts.abortSignal);
    const rawOutput = opts.job.kind === 'span'
      ? await runContextMapExtractionOneShot(
        opts.adapter,
        buildContextMapExtractionPrompt(opts.job.span),
        {
          model: opts.processor.model,
          effort: opts.processor.effort,
          timeoutMs: 120_000,
          abortSignal: opts.abortSignal,
          workingDir: workspacePath,
          allowTools: false,
          cliProfile: opts.processor.runtime.profile,
        } satisfies RunOneShotOptions,
        opts.abortSignal,
      )
      : await runContextMapExtractionOneShot(
        opts.adapter,
        buildContextMapSourcePrompt(opts.job.packet),
        {
          model: opts.processor.model,
          effort: opts.processor.effort,
          timeoutMs: 120_000,
          abortSignal: opts.abortSignal,
          workingDir: workspacePath,
          allowTools: false,
          cliProfile: opts.processor.runtime.profile,
        } satisfies RunOneShotOptions,
        opts.abortSignal,
      );
    throwIfContextMapStopped(opts.abortSignal);
    const candidates = await parseContextMapCandidatesWithRepair(rawOutput, {
      sourceType,
      sourceId,
      adapter: opts.adapter,
      processor: opts.processor,
      abortSignal: opts.abortSignal,
      workspacePath,
      repairs,
    });
    return {
      job: opts.job,
      sourceType,
      sourceId,
      durationMs: elapsedMs(startedMs),
      candidates,
      repairs,
    };
  } catch (err: unknown) {
    if (isContextMapStop(err, opts.abortSignal)) throw err;
    return {
      job: opts.job,
      sourceType,
      sourceId,
      durationMs: elapsedMs(startedMs),
      candidates: [],
      repairs,
      errorMessage: (err as Error).message,
    };
  }
}

function emptyExtractionResult(spans: ContextMapSpanWork[]): ContextMapExtractionResult {
  return {
    candidates: [],
    successfulSpanIds: new Set(spans.map((span) => span.spanId)),
    successfulSourcePackets: 0,
    successfulSourceCursors: [],
    failures: [],
    repairs: [],
    synthesis: emptySynthesisMetadata(0),
    timings: {
      extractionMs: 0,
      synthesisMs: 0,
      extractionUnits: buildExtractionTimingSummary([]),
      synthesisStages: [],
    },
  };
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function elapsedMs(startedMs: number): number {
  return Math.max(0, monotonicNowMs() - startedMs);
}

export interface ContextMapSchedulerOptions {
  chatService: ContextMapChatService & {
    listContextMapEnabledWorkspaceHashes(): Promise<string[]>;
  };
  processor: ContextMapService;
  now?: () => Date;
  logger?: Pick<typeof log, 'warn'>;
}

export class ContextMapScheduler {
  private readonly chatService: ContextMapSchedulerOptions['chatService'];
  private readonly processor: ContextMapService;
  private readonly now: () => Date;
  private readonly logger: Pick<typeof log, 'warn'>;
  private readonly lastCheckedAt = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(opts: ContextMapSchedulerOptions) {
    this.chatService = opts.chatService;
    this.processor = opts.processor;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? log;
  }

  start(checkIntervalMs = 60_000): void {
    if (this.interval) return;
    void this.checkNow({ force: true });
    this.interval = setInterval(() => void this.checkNow(), checkIntervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async checkNow(opts: { force?: boolean } = {}): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const settings = await this.chatService.getSettings();
      const globalScanIntervalMinutes = normalizedScanIntervalMinutes(settings.contextMap?.scanIntervalMinutes);
      const concurrency = normalizedConcurrency(settings.contextMap?.cliConcurrency);
      const nowMs = this.now().getTime();
      const hashes = await this.chatService.listContextMapEnabledWorkspaceHashes();
      const enabled = new Set(hashes);
      for (const known of Array.from(this.lastCheckedAt.keys())) {
        if (!enabled.has(known)) this.lastCheckedAt.delete(known);
      }

      const due: string[] = [];
      for (const hash of hashes) {
        if (this.processor.isRunning(hash)) continue;
        if (opts.force) {
          due.push(hash);
          continue;
        }
        const last = this.lastCheckedAt.get(hash);
        const workspaceSettings = await this.chatService.getWorkspaceContextMapSettings(hash);
        const scanIntervalMinutes = normalizedScanIntervalMinutes(
          workspaceSettings?.scanIntervalMinutes ?? globalScanIntervalMinutes,
        );
        if (!last || last + (scanIntervalMinutes * 60_000) <= nowMs) due.push(hash);
      }

      await runWithConcurrency(due, concurrency, async (hash) => {
        try {
          await this.processor.processWorkspace(hash);
        } catch (err: unknown) {
          this.logger.warn('context-map scheduler workspace check failed', {
            workspaceHash: hash,
            errorMessage: (err as Error).message,
          });
        } finally {
          this.lastCheckedAt.set(hash, this.now().getTime());
        }
      });
    } catch (err: unknown) {
      this.logger.warn('context-map scheduler scan failed', { errorMessage: (err as Error).message });
    } finally {
      this.checking = false;
    }
  }
}

function buildConversationWork(
  db: ContextMapDatabase,
  conversation: Conversation,
  now: () => Date,
): { span?: ContextMapSpanWork; cursor: UpsertConversationCursorParams; messageCount: number } | null {
  return buildConversationSessionWork(db, {
    conversationId: conversation.id,
    sessionNumber: conversation.sessionNumber,
    title: conversation.title,
    workingDir: conversation.workingDir,
    messages: conversation.messages,
  }, now);
}

function buildConversationSessionWork(
  db: ContextMapDatabase,
  conversation: {
    conversationId: string;
    sessionNumber: number;
    title: string;
    workingDir: string;
    messages: Message[];
  },
  now: () => Date,
): { span?: ContextMapSpanWork; cursor: UpsertConversationCursorParams; messageCount: number } | null {
  const messages = conversation.messages.filter(isProcessableMessage);
  if (messages.length === 0) return null;

  const cursor = db.getConversationCursor(conversation.conversationId);
  let startIndex = 0;
  if (cursor && cursor.sessionEpoch === conversation.sessionNumber) {
    const cursorIndex = messages.findIndex((message) => message.id === cursor.lastProcessedMessageId);
    if (cursorIndex >= 0) {
      if (cursorIndex === messages.length - 1) {
        if (hashMessage(messages[cursorIndex]) === cursor.lastProcessedSourceHash) return null;
        startIndex = cursorIndex;
      } else {
        startIndex = cursorIndex + 1;
      }
    }
  }

  if (startIndex >= messages.length) return null;
  const range = messages.slice(startIndex);
  const first = range[0];
  const last = range[range.length - 1];
  const processedAt = now().toISOString();
  const sourceHash = hashMessages(range);
  const cursorParams: UpsertConversationCursorParams = {
    conversationId: conversation.conversationId,
    sessionEpoch: conversation.sessionNumber,
    lastProcessedMessageId: last.id,
    lastProcessedAt: processedAt,
    lastProcessedSourceHash: hashMessage(last),
  };

  if (db.hasSourceSpan(conversation.conversationId, conversation.sessionNumber, first.id, last.id, sourceHash)) {
    return {
      cursor: cursorParams,
      messageCount: range.length,
    };
  }

  return {
    span: {
      spanId: stableId('cm-span', [
        conversation.conversationId,
        String(conversation.sessionNumber),
        first.id,
        last.id,
        sourceHash,
      ]),
      conversationId: conversation.conversationId,
      sessionEpoch: conversation.sessionNumber,
      startMessageId: first.id,
      endMessageId: last.id,
      sourceHash,
      cursor: cursorParams,
      messageCount: range.length,
      conversationTitle: conversation.title,
      workingDir: conversation.workingDir,
      messages: range,
    },
    cursor: cursorParams,
    messageCount: range.length,
  };
}

function isProcessableMessage(message: Message): boolean {
  if (!message.id) return false;
  if (message.role !== 'user' && message.role !== 'assistant') return false;
  if (message.turn === 'progress' || message.streamError) return false;
  const hasText = Boolean((message.content || '').trim());
  const hasBlocks = Array.isArray(message.contentBlocks) && message.contentBlocks.length > 0;
  return hasText || hasBlocks;
}

function throwIfContextMapStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Context Map scan stopped');
}

function isContextMapStop(_err: unknown, signal: AbortSignal): boolean {
  return signal.aborted;
}

class ContextMapAsyncLimiter {
  private active = 0;
  private readonly queue: Array<{
    signal: AbortSignal;
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    onAbort: () => void;
  }> = [];

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.round(limit));
    this.drain();
  }

  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    throwIfContextMapStopped(signal);
    return new Promise<T>((resolve, reject) => {
      let item!: {
        signal: AbortSignal;
        task: () => Promise<unknown>;
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
        onAbort: () => void;
      };
      const onAbort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) {
          this.queue.splice(index, 1);
          signal.removeEventListener('abort', item.onAbort);
          reject(new Error('Context Map scan stopped'));
        }
      };
      item = {
        signal,
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        onAbort,
      };
      signal.addEventListener('abort', item.onAbort, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) return;
      item.signal.removeEventListener('abort', item.onAbort);
      if (item.signal.aborted) {
        item.reject(new Error('Context Map scan stopped'));
        continue;
      }
      this.active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

const contextMapExtractionLimiter = new ContextMapAsyncLimiter(DEFAULT_CONTEXT_MAP_EXTRACTION_CONCURRENCY);
const contextMapSynthesisLimiter = new ContextMapAsyncLimiter(DEFAULT_CONTEXT_MAP_SYNTHESIS_CONCURRENCY);

function configureContextMapProcessorConcurrency(contextMap: Settings['contextMap']): void {
  contextMapExtractionLimiter.setLimit(normalizedProcessorConcurrency(
    contextMap?.extractionConcurrency,
    DEFAULT_CONTEXT_MAP_EXTRACTION_CONCURRENCY,
  ));
  contextMapSynthesisLimiter.setLimit(normalizedProcessorConcurrency(
    contextMap?.synthesisConcurrency,
    DEFAULT_CONTEXT_MAP_SYNTHESIS_CONCURRENCY,
  ));
}

function runContextMapExtractionOneShot(
  adapter: ContextMapProcessorAdapter,
  prompt: string,
  options: RunOneShotOptions,
  abortSignal: AbortSignal,
): Promise<string> {
  return contextMapExtractionLimiter.run(abortSignal, () => adapter.runOneShot(prompt, options));
}

function runContextMapSynthesisOneShot(
  adapter: ContextMapProcessorAdapter,
  prompt: string,
  options: RunOneShotOptions,
  abortSignal: AbortSignal,
): Promise<string> {
  return contextMapSynthesisLimiter.run(abortSignal, () => adapter.runOneShot(prompt, options));
}

const CONTEXT_MAP_SYNTHESIS_MIN_CANDIDATES = 8;
const CONTEXT_MAP_SCHEDULED_SYNTHESIS_MIN_CANDIDATES = 3;
const CONTEXT_MAP_SYNTHESIS_TIMEOUT_MS = 180_000;
const CONTEXT_MAP_SYNTHESIS_CHUNK_SIZE = 36;
const CONTEXT_MAP_SYNTHESIS_CHUNK_TARGET = 10;
const CONTEXT_MAP_SYNTHESIS_ARBITER_INPUT_LIMIT = 50;
const CONTEXT_MAP_SYNTHESIS_FINAL_TARGET_CANDIDATES = 34;
const CONTEXT_MAP_SYNTHESIS_FINAL_MAX_CANDIDATES = 45;
const CONTEXT_MAP_SYNTHESIS_FALLBACK_MAX_CANDIDATES = 40;
const CONTEXT_MAP_SYNTHESIS_MAX_RELATIONSHIP_CANDIDATES = 12;
const CONTEXT_MAP_SYNTHESIS_RECOVERED_RELATIONSHIP_CANDIDATES = 12;

const CONTEXT_MAP_CANDIDATE_TYPES = new Set<ContextCandidateType>([
  'new_entity',
  'entity_update',
  'entity_merge',
  'new_relationship',
  'relationship_update',
  'relationship_removal',
  'new_entity_type',
  'alias_addition',
  'evidence_link',
  'sensitivity_classification',
  'conflict_flag',
]);

function buildContextMapExtractionPrompt(span: ContextMapSpanWork): string {
  const transcript = span.messages.map((message) => [
    `<message id="${escapeAttr(message.id)}" role="${escapeAttr(message.role)}" timestamp="${escapeAttr(message.timestamp || '')}">`,
    message.content?.trim() || renderContentBlocks(message.contentBlocks),
    '</message>',
  ].join('\n')).join('\n\n');

  return [
    'You are the Context Map processor for a workspace.',
    '',
    'Review the conversation span and propose only durable workspace context that should be considered for the Context Map.',
    '',
    'Rules:',
    '- Output a single JSON object only. Do not include markdown or prose.',
    '- Use an empty candidates array when there is nothing durable to propose.',
    '- Do not include secrets, credentials, tokens, or private personal data. If a secret-like pointer matters, propose sensitivity_classification instead of copying the secret.',
    '- Prefer high-value entities, relationships, decisions, workflows, tools, documents, features, assets, and aliases that would help future conversations in this workspace.',
    '- Treat the conversation as evidence. Do not create entities for ordinary filenames, paths, the workspace root folder, or incidental local assets mentioned in the conversation.',
    '- Create a document entity only when the document is a durable conceptual artifact such as a maintained spec, ADR, proposal, roadmap, manuscript chapter, research source, or plan that future work will discuss by name.',
    '- Create an asset entity only when the asset is a durable product/domain object, not just a local file, image, logo, or attachment path.',
    '- For every new_entity, include 1-4 concise facts when the source contains durable details that future conversations should retrieve. Do not copy sensitive identifiers or trivia.',
    `- For new_entity payload.typeSlug, use one of the built-in entity types unless you also propose a new_entity_type candidate: ${CONTEXT_MAP_ENTITY_TYPE_PROMPT}.`,
    '- Use feature for user-facing product capabilities, behavior areas, and feature proposals.',
    '- Do not invent typeSlug values such as product, subsystem, backend, issue, github_issue, pull_request, architecture, policy, or principle; map them to the closest built-in type.',
    '- Do not create pull request or issue entities for routine GitHub bookkeeping. Mention issue/PR IDs only inside summaries or evidence when they describe a durable project, decision, or document.',
    '- For new_relationship payloads, use subjectName, predicate, and objectName. Do not use sourceName, targetName, fromName, toName, or relationshipType.',
    `- Use durable relationship predicates only. Preferred predicates: ${CONTEXT_MAP_RELATIONSHIP_PREDICATE_PROMPT}. Comparative, vague, or one-off labels belong in entity summaries or facts, not relationships.`,
    '- Use implements/implemented_by only when the evidence identifies implementation ownership or a concrete implementation component, tool, workflow, or project. UI placement, navigation, and access details belong in entity facts, not relationships.',
    '- Use part_of for project/root containment only with explicit high-confidence evidence. Weak issue, bug, UI-state, or loose project associations belong in entity facts.',
    '- For every new_relationship, include evidenceMarkdown with one short reason from the source. If the evidence is only a loose association, omit the relationship.',
    '- Include relationship candidates for durable reporting lines, ownership, authorship, dependency, storage, or workflow/tool usage when both endpoints are represented by kept entities or are already known.',
    '- Do not emit evidence_link unless you know the existing targetKind and targetId. New candidates automatically carry sourceSpan evidence.',
    '- If a new entity itself is sensitive, put sensitivity directly on that new_entity payload. Emit sensitivity_classification only for an existing or clearly named entity target; include entityName or entityId plus sensitivity: normal, work-sensitive, personal-sensitive, or secret-pointer.',
    '- Do not create both a project-prefixed name and an unprefixed name for the same thing. Choose one canonical entity name.',
    '- Treat maintained specs, ADR collections, roadmaps, and plans as document entities. Use workflow only for repeatable processes or operating procedures.',
    '- When uncertain whether a filename-like mention matters as an entity, omit it. Evidence links can still point back to the file through sourceSpan.',
    '- Each candidate must include type, confidence, and payload.',
    '',
    'Allowed candidate types:',
    Array.from(CONTEXT_MAP_CANDIDATE_TYPES).join(', '),
    '',
    'Expected JSON shape:',
    '{"candidates":[{"type":"new_entity","confidence":0.85,"payload":{"typeSlug":"project","name":"Example","summaryMarkdown":"Short durable summary."}}]}',
    '',
    'Source span:',
    JSON.stringify({
      conversationId: span.conversationId,
      conversationTitle: span.conversationTitle,
      sessionEpoch: span.sessionEpoch,
      startMessageId: span.startMessageId,
      endMessageId: span.endMessageId,
    }),
    '',
    'Conversation span:',
    transcript,
  ].join('\n');
}

function buildContextMapSourcePrompt(packet: ContextMapSourcePacket): string {
  const codeOutline = packet.sourceType === 'code_outline';
  return [
    'You are the Context Map processor for a workspace.',
    '',
    codeOutline
      ? 'Review this workspace code outline packet and propose only durable implementation context that should be considered for the Context Map.'
      : 'Review this workspace Markdown/source packet and propose only durable workspace context that should be considered for the Context Map.',
    '',
    'Rules:',
    '- Output a single JSON object only. Do not include markdown or prose.',
    '- Use an empty candidates array when there is nothing durable to propose.',
    '- First judge whether this source deserves Context Map candidates at all. Empty output is preferred over weak extraction.',
    '- Do not include secrets, credentials, tokens, or private personal data. If a secret-like pointer matters, propose sensitivity_classification instead of copying the secret.',
    '- Prefer high-value entities, relationships, decisions, workflows, tools, documents, features, assets, and aliases that would help future conversations in this workspace.',
    '- Treat this source as evidence. Do not create an entity for the source file itself, the workspace root folder, or ordinary filenames/paths/assets mentioned in the source.',
    ...(codeOutline ? [
      '- For code outlines, extract only stable implementation areas that future work will discuss: services, route/API surfaces, data stores, schedulers, backend adapters, frontend screens, mobile clients, MCP servers, build/runtime tooling, and durable test harnesses.',
      '- Do not create entities for individual ordinary functions, classes, imports, route strings, local files, directories, package names, or dependencies. Mention file paths and important code symbols as facts or evidence only.',
      '- Prefer feature, workflow, concept, tool, project, or decision entities for implementation areas. Use document only for durable manifests/spec-like artifacts, not ordinary source files.',
      '- For code-outline relationships, keep only durable implementation links such as implements, uses, stores, runs_via, depends_on, supports, specified_by, documents, or governs when both endpoints are durable implementation/context entities.',
    ] : []),
    '- Blog posts, article drafts, and essay-like sources should usually produce at most one durable document/concept candidate, unless the source defines a repeatedly reused named framework or workflow.',
    '- Contact/profile files should usually produce the person plus only the most durable projects, organizations, workflows, or decisions that future work will reference.',
    '- Contact/profile files may include up to two high-confidence relationship candidates for durable manager/reporting, organization ownership, collaboration, or project/workflow ownership links.',
    '- Workflow/runbook files should usually produce one workflow plus only critical durable tools/rules needed to run that workflow.',
    '- Workflow/runbook files may include up to two high-confidence relationship candidates for the tools, documents, or projects the workflow uses, produces, stores, or depends on.',
    '- Create a document entity only when the document is a durable conceptual artifact such as a maintained spec, ADR, proposal, roadmap, manuscript chapter, research source, or plan that future work will discuss by name.',
    '- Create an asset entity only when the asset is a durable product/domain object, not just a local file, image, logo, or attachment path.',
    '- For every new_entity, include 1-4 concise facts when the source contains durable details that future conversations should retrieve. Do not copy sensitive identifiers or trivia.',
    `- For new_entity payload.typeSlug, use one of the built-in entity types unless you also propose a new_entity_type candidate: ${CONTEXT_MAP_ENTITY_TYPE_PROMPT}.`,
    '- Use feature for user-facing product capabilities, behavior areas, and feature proposals.',
    '- Do not invent typeSlug values such as product, subsystem, backend, issue, github_issue, pull_request, architecture, policy, or principle; map them to the closest built-in type.',
    '- Do not expand README/spec feature lists into a candidate for every listed feature. Prefer the smallest set of central concepts that future work will repeatedly reference.',
    '- For new_relationship payloads, use subjectName, predicate, and objectName. Do not use sourceName, targetName, fromName, toName, or relationshipType.',
    `- Use durable relationship predicates only. Preferred predicates: ${CONTEXT_MAP_RELATIONSHIP_PREDICATE_PROMPT}. Comparative, vague, or one-off labels belong in entity summaries or facts, not relationships.`,
    '- Use implements/implemented_by only when the evidence identifies implementation ownership or a concrete implementation component, tool, workflow, or project. UI placement, navigation, and access details belong in entity facts, not relationships.',
    '- Use part_of for project/root containment only with explicit high-confidence evidence. Weak issue, bug, UI-state, or loose project associations belong in entity facts.',
    '- For every new_relationship, include evidenceMarkdown with one short reason from the source. If the evidence is only a loose association, omit the relationship.',
    '- Include relationship candidates for durable reporting lines, ownership, authorship, dependency, storage, or workflow/tool usage when both endpoints are represented by kept entities or are already known.',
    '- Do not emit evidence_link unless you know the existing targetKind and targetId. New candidates automatically carry sourceSpan evidence.',
    '- If a new entity itself is sensitive, put sensitivity directly on that new_entity payload. Emit sensitivity_classification only for an existing or clearly named entity target; include entityName or entityId plus sensitivity: normal, work-sensitive, personal-sensitive, or secret-pointer.',
    '- Do not create both a project-prefixed name and an unprefixed name for the same thing. Choose one canonical entity name.',
    '- Treat maintained specs, ADR collections, roadmaps, and plans as document entities. Use workflow only for repeatable processes or operating procedures.',
    '- When uncertain whether a filename-like mention matters as an entity, omit it. Evidence links can still point back to the file through sourceSpan.',
    '- Each candidate must include type, confidence, and payload.',
    '- Dropping marginal candidates is expected. The output should help keep the Context Map small enough to be useful without normal manual review.',
    codeOutline ? '- Return at most eight candidates for this code outline packet.' : '- Return at most six candidates for this source.',
    '',
    'Allowed candidate types:',
    Array.from(CONTEXT_MAP_CANDIDATE_TYPES).join(', '),
    '',
    'Expected JSON shape:',
    '{"candidates":[{"type":"new_entity","confidence":0.85,"payload":{"typeSlug":"workflow","name":"Example workflow","summaryMarkdown":"Short durable summary."}}]}',
    '',
    'Source:',
    JSON.stringify({
      sourceType: packet.sourceType,
      sourceId: packet.sourceId,
      title: packet.title,
      locator: packet.locator,
    }),
    '',
    'Source content:',
    packet.body,
  ].join('\n');
}

async function synthesizeCandidateDrafts(opts: {
  drafts: ContextMapCandidateDraft[];
  db: ContextMapDatabase;
  adapter: ContextMapProcessorAdapter;
  processor: ResolvedContextMapProcessor;
  abortSignal: AbortSignal;
  workspacePath: string | undefined;
  minCandidates: number;
}): Promise<{ drafts: ContextMapCandidateDraft[]; metadata: ContextMapSynthesisMetadata }> {
  if (opts.drafts.length < opts.minCandidates) {
    return {
      drafts: opts.drafts,
      metadata: emptySynthesisMetadata(opts.drafts.length),
    };
  }

  const stages: ContextMapSynthesisStageMetadata[] = [];
  const openQuestions: string[] = [];
  const errorMessages: string[] = [];
  let fallback = false;
  let workingDrafts = opts.drafts;
  let finalTargetCandidates = Math.min(opts.drafts.length, CONTEXT_MAP_SYNTHESIS_FINAL_TARGET_CANDIDATES);

  if (workingDrafts.length > CONTEXT_MAP_SYNTHESIS_CHUNK_SIZE) {
    const chunked: ContextMapCandidateDraft[] = [];
    const chunkResults = await Promise.all(buildSynthesisChunks(workingDrafts).map((chunk) => (
      runContextMapSynthesisPass({
        ...opts,
        drafts: chunk.drafts,
        stage: 'chunk',
        chunkId: chunk.chunkId,
        targetCandidates: CONTEXT_MAP_SYNTHESIS_CHUNK_TARGET,
        fallbackLimit: Math.min(CONTEXT_MAP_SYNTHESIS_CHUNK_TARGET, chunk.drafts.length),
      })
    )));
    for (const result of chunkResults) {
      stages.push(result.metadata);
      openQuestions.push(...result.metadata.openQuestions);
      if (result.metadata.fallback) {
        fallback = true;
        if (result.metadata.errorMessage) errorMessages.push(result.metadata.errorMessage);
      }
      chunked.push(...result.drafts);
    }
    workingDrafts = prepareCandidateDraftsForPersistence(chunked, opts.db, opts.workspacePath, true);
  }

  if (workingDrafts.length >= opts.minCandidates) {
    finalTargetCandidates = finalSynthesisTarget(opts.drafts.length, workingDrafts.length);
    const result = opts.drafts.length > CONTEXT_MAP_SYNTHESIS_CHUNK_SIZE
      ? await runContextMapArbiterPass({
        ...opts,
        drafts: boundedFallbackCandidateDrafts(workingDrafts, CONTEXT_MAP_SYNTHESIS_ARBITER_INPUT_LIMIT),
        fallbackDrafts: workingDrafts,
        targetCandidates: finalTargetCandidates,
        hardMaxCandidates: CONTEXT_MAP_SYNTHESIS_FINAL_MAX_CANDIDATES,
        fallbackLimit: Math.min(CONTEXT_MAP_SYNTHESIS_FALLBACK_MAX_CANDIDATES, workingDrafts.length),
      })
      : await runContextMapSynthesisPass({
        ...opts,
        drafts: workingDrafts,
        stage: 'single',
        targetCandidates: finalSynthesisTarget(opts.drafts.length, workingDrafts.length),
        fallbackLimit: Math.min(CONTEXT_MAP_SYNTHESIS_FALLBACK_MAX_CANDIDATES, workingDrafts.length),
      });
    stages.push(result.metadata);
    openQuestions.push(...result.metadata.openQuestions);
    if (result.metadata.fallback) {
      fallback = true;
      if (result.metadata.errorMessage) errorMessages.push(result.metadata.errorMessage);
    }
    workingDrafts = result.drafts;
  }

  const bounded = workingDrafts.length > CONTEXT_MAP_SYNTHESIS_FINAL_MAX_CANDIDATES
    ? boundedFallbackCandidateDrafts(workingDrafts, CONTEXT_MAP_SYNTHESIS_FINAL_MAX_CANDIDATES)
    : workingDrafts;
  const outputCandidates = bounded.length;
  const boundedAfterSynthesis = workingDrafts.length > CONTEXT_MAP_SYNTHESIS_FINAL_MAX_CANDIDATES;
  const usedFallback = fallback || boundedAfterSynthesis;
  const metadata: ContextMapSynthesisMetadata = {
    attempted: true,
    inputCandidates: opts.drafts.length,
    outputCandidates,
    inputCandidateTypes: countDraftsByType(opts.drafts),
    outputCandidateTypes: countDraftsByType(bounded),
    droppedCandidates: Math.max(0, opts.drafts.length - outputCandidates),
    targetCandidates: finalTargetCandidates,
    hardMaxCandidates: CONTEXT_MAP_SYNTHESIS_FINAL_MAX_CANDIDATES,
    openQuestions: dedupeOpenQuestions(openQuestions),
    stages,
  };
  if (usedFallback) metadata.fallback = true;
  if (errorMessages.length > 0) metadata.errorMessage = errorMessages.slice(0, 3).join('; ');
  if (fallback) metadata.fallbackBound = CONTEXT_MAP_SYNTHESIS_FALLBACK_MAX_CANDIDATES;
  else if (boundedAfterSynthesis) metadata.fallbackBound = CONTEXT_MAP_SYNTHESIS_FINAL_MAX_CANDIDATES;
  return {
    drafts: bounded,
    metadata,
  };
}

async function runContextMapSynthesisPass(opts: {
  drafts: ContextMapCandidateDraft[];
  db: ContextMapDatabase;
  adapter: ContextMapProcessorAdapter;
  processor: ResolvedContextMapProcessor;
  abortSignal: AbortSignal;
  workspacePath: string | undefined;
  stage: 'single' | 'chunk' | 'final';
  chunkId?: string;
  targetCandidates: number;
  fallbackLimit: number;
}): Promise<{ drafts: ContextMapCandidateDraft[]; metadata: ContextMapSynthesisStageMetadata }> {
  const stageStartedMs = monotonicNowMs();
  let repairAttempted = false;
  let repairSucceeded = false;
  let repairErrorMessage: string | undefined;
  try {
    const rawOutput = await runContextMapSynthesisOneShot(opts.adapter, buildContextMapSynthesisPrompt(opts.drafts, opts.db, {
      stage: opts.stage,
      chunkId: opts.chunkId,
      targetCandidates: opts.targetCandidates,
    }), {
      model: opts.processor.model,
      effort: opts.processor.effort,
      timeoutMs: CONTEXT_MAP_SYNTHESIS_TIMEOUT_MS,
      abortSignal: opts.abortSignal,
      workingDir: opts.workspacePath,
      allowTools: false,
      cliProfile: opts.processor.runtime.profile,
    } satisfies RunOneShotOptions, opts.abortSignal);
    throwIfContextMapStopped(opts.abortSignal);
    let result: { drafts: ContextMapCandidateDraft[]; openQuestions: string[] };
    try {
      result = parseContextMapSynthesisOutput(rawOutput, opts.drafts, opts.workspacePath);
    } catch (parseErr: unknown) {
      repairAttempted = true;
      try {
        const repairedOutput = await repairContextMapJsonOutput({
          rawOutput,
          errorMessage: (parseErr as Error).message,
          schema: 'synthesis',
          runOneShot: (prompt, options, signal) => runContextMapSynthesisOneShot(opts.adapter, prompt, options, signal),
          processor: {
            model: opts.processor.model,
            effort: opts.processor.effort,
            cliProfile: opts.processor.runtime.profile,
          },
          abortSignal: opts.abortSignal,
          workspacePath: opts.workspacePath,
        });
        throwIfContextMapStopped(opts.abortSignal);
        result = parseContextMapSynthesisOutput(repairedOutput, opts.drafts, opts.workspacePath);
        repairSucceeded = true;
      } catch (repairErr: unknown) {
        repairErrorMessage = truncateErrorMessage((repairErr as Error).message);
        throw parseErr;
      }
    }
    const drafts = result.drafts.length > opts.targetCandidates
      ? boundedFallbackCandidateDrafts(result.drafts, opts.targetCandidates)
      : result.drafts;
    return {
      drafts,
      metadata: {
        stage: opts.stage,
        chunkId: opts.chunkId,
        durationMs: elapsedMs(stageStartedMs),
        inputCandidates: opts.drafts.length,
        outputCandidates: drafts.length,
        inputCandidateTypes: countDraftsByType(opts.drafts),
        outputCandidateTypes: countDraftsByType(drafts),
        droppedCandidates: Math.max(0, opts.drafts.length - drafts.length),
        targetCandidates: opts.targetCandidates,
        openQuestions: result.openQuestions,
        ...(repairAttempted ? {
          repairAttempted,
          repairSucceeded,
          ...(repairErrorMessage ? { repairErrorMessage } : {}),
        } : {}),
      },
    };
  } catch (err: unknown) {
    if (isContextMapStop(err, opts.abortSignal)) throw err;
    const drafts = boundedFallbackCandidateDrafts(opts.drafts, opts.fallbackLimit);
    return {
      drafts,
      metadata: {
        stage: opts.stage,
        chunkId: opts.chunkId,
        durationMs: elapsedMs(stageStartedMs),
        inputCandidates: opts.drafts.length,
        outputCandidates: drafts.length,
        inputCandidateTypes: countDraftsByType(opts.drafts),
        outputCandidateTypes: countDraftsByType(drafts),
        droppedCandidates: Math.max(0, opts.drafts.length - drafts.length),
        targetCandidates: opts.fallbackLimit,
        openQuestions: [],
        fallback: true,
        errorMessage: truncateErrorMessage((err as Error).message),
        ...(repairAttempted ? {
          repairAttempted,
          repairSucceeded,
          ...(repairErrorMessage ? { repairErrorMessage } : {}),
        } : {}),
      },
    };
  }
}

async function runContextMapArbiterPass(opts: {
  drafts: ContextMapCandidateDraft[];
  fallbackDrafts: ContextMapCandidateDraft[];
  db: ContextMapDatabase;
  adapter: ContextMapProcessorAdapter;
  processor: ResolvedContextMapProcessor;
  abortSignal: AbortSignal;
  workspacePath: string | undefined;
  targetCandidates: number;
  hardMaxCandidates: number;
  fallbackLimit: number;
}): Promise<{ drafts: ContextMapCandidateDraft[]; metadata: ContextMapSynthesisStageMetadata }> {
  const stageStartedMs = monotonicNowMs();
  let repairAttempted = false;
  let repairSucceeded = false;
  let repairErrorMessage: string | undefined;
  try {
    const rawOutput = await runContextMapSynthesisOneShot(opts.adapter, buildContextMapArbiterPrompt(opts.drafts, opts.db, {
      targetCandidates: opts.targetCandidates,
      hardMaxCandidates: opts.hardMaxCandidates,
    }), {
      model: opts.processor.model,
      effort: opts.processor.effort,
      timeoutMs: CONTEXT_MAP_SYNTHESIS_TIMEOUT_MS,
      abortSignal: opts.abortSignal,
      workingDir: opts.workspacePath,
      allowTools: false,
      cliProfile: opts.processor.runtime.profile,
    } satisfies RunOneShotOptions, opts.abortSignal);
    throwIfContextMapStopped(opts.abortSignal);
    let result: { drafts: ContextMapCandidateDraft[]; openQuestions: string[] };
    try {
      result = parseContextMapArbiterOutput(rawOutput, opts.drafts, opts.workspacePath);
    } catch (parseErr: unknown) {
      repairAttempted = true;
      try {
        const repairedOutput = await repairContextMapJsonOutput({
          rawOutput,
          errorMessage: (parseErr as Error).message,
          schema: 'arbiter',
          runOneShot: (prompt, options, signal) => runContextMapSynthesisOneShot(opts.adapter, prompt, options, signal),
          processor: {
            model: opts.processor.model,
            effort: opts.processor.effort,
            cliProfile: opts.processor.runtime.profile,
          },
          abortSignal: opts.abortSignal,
          workspacePath: opts.workspacePath,
        });
        throwIfContextMapStopped(opts.abortSignal);
        result = parseContextMapArbiterOutput(repairedOutput, opts.drafts, opts.workspacePath);
        repairSucceeded = true;
      } catch (repairErr: unknown) {
        repairErrorMessage = truncateErrorMessage((repairErr as Error).message);
        throw parseErr;
      }
    }
    const drafts = result.drafts.length > opts.targetCandidates
      ? boundedFallbackCandidateDrafts(result.drafts, opts.targetCandidates)
      : result.drafts;
    return {
      drafts,
      metadata: {
        stage: 'final',
        durationMs: elapsedMs(stageStartedMs),
        inputCandidates: opts.drafts.length,
        outputCandidates: drafts.length,
        inputCandidateTypes: countDraftsByType(opts.drafts),
        outputCandidateTypes: countDraftsByType(drafts),
        droppedCandidates: Math.max(0, opts.drafts.length - drafts.length),
        targetCandidates: opts.targetCandidates,
        hardMaxCandidates: opts.hardMaxCandidates,
        openQuestions: result.openQuestions,
        ...(repairAttempted ? {
          repairAttempted,
          repairSucceeded,
          ...(repairErrorMessage ? { repairErrorMessage } : {}),
        } : {}),
      },
    };
  } catch (err: unknown) {
    if (isContextMapStop(err, opts.abortSignal)) throw err;
    const drafts = boundedFallbackCandidateDrafts(opts.fallbackDrafts, opts.fallbackLimit);
    return {
      drafts,
      metadata: {
        stage: 'final',
        durationMs: elapsedMs(stageStartedMs),
        inputCandidates: opts.drafts.length,
        outputCandidates: drafts.length,
        inputCandidateTypes: countDraftsByType(opts.drafts),
        outputCandidateTypes: countDraftsByType(drafts),
        droppedCandidates: Math.max(0, opts.drafts.length - drafts.length),
        targetCandidates: opts.fallbackLimit,
        hardMaxCandidates: opts.hardMaxCandidates,
        openQuestions: [],
        fallback: true,
        errorMessage: truncateErrorMessage((err as Error).message),
        ...(repairAttempted ? {
          repairAttempted,
          repairSucceeded,
          ...(repairErrorMessage ? { repairErrorMessage } : {}),
        } : {}),
      },
    };
  }
}

function buildSynthesisChunks(drafts: ContextMapCandidateDraft[]): Array<{ chunkId: string; drafts: ContextMapCandidateDraft[] }> {
  const bucketOrder: string[] = [];
  const buckets = new Map<string, ContextMapCandidateDraft[]>();
  for (const draft of drafts) {
    const bucket = synthesisBucketForDraft(draft);
    if (!buckets.has(bucket)) {
      buckets.set(bucket, []);
      bucketOrder.push(bucket);
    }
    buckets.get(bucket)?.push(draft);
  }

  const chunks: Array<{ chunkId: string; drafts: ContextMapCandidateDraft[] }> = [];
  for (const bucket of bucketOrder) {
    const bucketDrafts = buckets.get(bucket) || [];
    for (let index = 0; index < bucketDrafts.length; index += CONTEXT_MAP_SYNTHESIS_CHUNK_SIZE) {
      chunks.push({
        chunkId: `${bucket}:${Math.floor(index / CONTEXT_MAP_SYNTHESIS_CHUNK_SIZE) + 1}`,
        drafts: bucketDrafts.slice(index, index + CONTEXT_MAP_SYNTHESIS_CHUNK_SIZE),
      });
    }
  }
  return chunks;
}

function synthesisBucketForDraft(draft: ContextMapCandidateDraft): string {
  const sourceSpan = isRecord(draft.payload.sourceSpan) ? draft.payload.sourceSpan : {};
  const sourceType = readPayloadString(sourceSpan, ['sourceType']);
  if (sourceType === 'conversation_message') return `conversation:${readPayloadString(sourceSpan, ['conversationId']) || 'unknown'}`;
  if (sourceType === 'code_outline') return 'code-outline';
  const sourceId = readPayloadString(sourceSpan, ['sourceId']).toLowerCase();
  if (sourceId.startsWith('context/contact-')) return 'context-contacts';
  if (sourceId.startsWith('context/')) return 'context';
  if (sourceId.startsWith('workflows/')) return 'workflows';
  if (sourceId.startsWith('repos/')) return 'repo-content';
  if (sourceId.startsWith('drafts/')) return 'drafts';
  if (sourceId.includes('/')) return sourceId.split('/')[0] || 'sources';
  return sourceId || sourceType || 'sources';
}

function finalSynthesisTarget(originalInputCount: number, currentInputCount: number): number {
  if (currentInputCount <= CONTEXT_MAP_SYNTHESIS_MIN_CANDIDATES) return currentInputCount;
  if (originalInputCount <= CONTEXT_MAP_SYNTHESIS_CHUNK_SIZE) {
    return Math.min(currentInputCount, CONTEXT_MAP_SYNTHESIS_FINAL_TARGET_CANDIDATES);
  }
  return Math.min(
    currentInputCount,
    CONTEXT_MAP_SYNTHESIS_FINAL_TARGET_CANDIDATES,
    Math.max(20, Math.ceil(originalInputCount * 0.18), Math.ceil(currentInputCount * 0.45)),
  );
}

function dedupeOpenQuestions(value: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const question of value) {
    const normalized = normalizedCandidateText(question);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(question);
    if (output.length >= 10) break;
  }
  return output;
}

function boundedFallbackCandidateDrafts(drafts: ContextMapCandidateDraft[], limit: number): ContextMapCandidateDraft[] {
  if (drafts.length <= limit) return drafts;
  const selected = drafts
    .map((draft, index) => ({ draft, index, score: fallbackCandidateScore(draft) }))
    .sort((a, b) => b.score - a.score || b.draft.confidence - a.draft.confidence || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.draft);
  return selected;
}

function fallbackCandidateScore(draft: ContextMapCandidateDraft): number {
  const typeWeights: Record<ContextCandidateType, number> = {
    new_entity: 100,
    entity_update: 90,
    new_entity_type: 45,
    alias_addition: 35,
    sensitivity_classification: 30,
    new_relationship: 22,
    evidence_link: 18,
    relationship_update: 12,
    relationship_removal: 8,
    entity_merge: 8,
    conflict_flag: 6,
  };
  let score = typeWeights[draft.candidateType] || 0;
  if (draft.candidateType === 'new_entity') {
    const entityType = normalizeSlug(readPayloadString(draft.payload, ['typeSlug', 'entityType', 'type']));
    score += entityFallbackWeight(entityType);
  }
  if (draft.candidateType === 'new_relationship') {
    const predicate = normalizeRelationshipPredicate(readPayloadString(draft.payload, ['predicate', 'relationship', 'label']));
    if (isCoreRelationshipPredicate(predicate)) score += 8;
    if (predicate === 'relates_to' || !hasRelationshipEvidence(draft.payload)) score -= 12;
  }
  score += sourceFallbackWeight(draft);
  score += draft.confidence * 20;
  return score;
}

function entityFallbackWeight(typeSlug: string): number {
  const weights: Record<string, number> = {
    person: 20,
    project: 20,
    workflow: 18,
    document: 17,
    decision: 16,
    organization: 14,
    tool: 10,
    feature: 8,
    asset: 2,
    concept: 0,
  };
  return weights[typeSlug] ?? 0;
}

function sourceFallbackWeight(draft: ContextMapCandidateDraft): number {
  const bucket = synthesisBucketForDraft(draft);
  if (bucket.startsWith('conversation:')) return 12;
  if (bucket === 'code-outline') return 8;
  if (bucket === 'context' || bucket === 'context-contacts' || bucket === 'workflows') return 10;
  if (bucket === 'drafts') return -4;
  if (bucket === 'repo-content') return -8;
  return 0;
}

function buildContextMapSynthesisPrompt(
  drafts: ContextMapCandidateDraft[],
  db: ContextMapDatabase,
  opts: { stage: 'single' | 'chunk' | 'final'; chunkId?: string; targetCandidates: number },
): string {
  const activeEntities = db.listEntities({ status: 'active' }).slice(0, 80).map((entity) => ({
    entityId: entity.entityId,
    typeSlug: entity.typeSlug,
    name: entity.name,
    aliases: db.listAliases(entity.entityId).map((alias) => alias.alias).slice(0, 8),
  }));

  return [
    'You are the Context Map synthesis processor for a workspace.',
    '',
    'You will receive candidate Context Map updates extracted independently from conversations and workspace sources.',
    'Your job is to prevent Context Map noise. Consolidate them into a smaller, higher-value set before storage.',
    '',
    'Synthesis task:',
    stableStringify({
      stage: opts.stage,
      chunkId: opts.chunkId || null,
      inputCandidates: drafts.length,
      targetCandidates: opts.targetCandidates,
    }),
    '',
    'Rules:',
    '- Output a single JSON object only. Do not include markdown or prose.',
    '- Keep only durable workspace context that future conversations are likely to retrieve.',
    '- Dropping candidates is expected. Needs Attention is for exceptions, not normal operation.',
    '- Merge duplicate entity candidates. Keep the best canonical name and move losing names into aliases.',
    '- If the same name appears with multiple entity types, choose one canonical type and fold the weaker variant into aliases, facts, or evidence.',
    '- Prefer fewer, stronger candidates over exhaustive noun extraction.',
    '- The output should be useful even if the user never reviews it manually.',
    '- Drop ordinary filenames, paths, screenshots, SVGs, local assets, temporary implementation details, one-off observations, and weak loose associations.',
    '- Most source-local concepts should become facts or evidence on a stronger entity, not first-class entities.',
    '- Do not create entities for physical files unless the file is a durable conceptual artifact people will discuss by name, such as a maintained spec, ADR, proposal, roadmap, plan, manuscript chapter, or research source.',
    '- Convert weak relationships into concise entity facts when that preserves useful evidence without adding graph noise.',
    '- Keep relationship candidates only when both endpoints are active or are present in the synthesized output.',
    '- Do not invent unsupported candidate types, entity type slugs, relationship predicates, entities, facts, secrets, or evidence.',
    '- Every output candidate must include sourceRefs with one or more sourceRef values from the input candidates that support it.',
    `- Return at most ${opts.targetCandidates} candidates. Fewer is better when the lower-value items would clutter the map.`,
    `- Built-in entity types: ${CONTEXT_MAP_ENTITY_TYPE_PROMPT}.`,
    `- Allowed relationship predicates: ${CONTEXT_MAP_RELATIONSHIP_PREDICATE_PROMPT}.`,
    `- Allowed candidate types: ${Array.from(CONTEXT_MAP_CANDIDATE_TYPES).join(', ')}.`,
    '',
    'Expected JSON shape:',
    '{"candidates":[{"sourceRefs":["candidate-1"],"type":"new_entity","confidence":0.88,"payload":{"typeSlug":"project","name":"Example","summaryMarkdown":"Short durable summary.","aliases":["Example alias"]}}],"dropped":[{"sourceRef":"candidate-2","reason":"duplicate"}],"openQuestions":["Optional concrete uncertainty."]}',
    '',
    'Active entities already in the map:',
    stableStringify(activeEntities),
    '',
    'Input candidates:',
    stableStringify(drafts.map((draft, index) => candidateForSynthesis(draft, `candidate-${index + 1}`))),
  ].join('\n');
}

function buildContextMapArbiterPrompt(
  drafts: ContextMapCandidateDraft[],
  db: ContextMapDatabase,
  opts: { targetCandidates: number; hardMaxCandidates: number },
): string {
  const activeEntities = db.listEntities({ status: 'active' }).slice(0, 80).map((entity) => ({
    entityId: entity.entityId,
    typeSlug: entity.typeSlug,
    name: entity.name,
    aliases: db.listAliases(entity.entityId).map((alias) => alias.alias).slice(0, 8),
  }));

  return [
    'You are the Context Map synthesis processor for a workspace, acting as the final arbiter.',
    '',
    'You will receive compact summaries of candidates that were already cleaned by earlier extraction and chunk synthesis passes.',
    'Your job is to decide what survives. Do not rewrite full candidates; return decision references that the backend will apply to the normalized candidates.',
    '',
    'Synthesis task:',
    stableStringify({
      stage: 'final',
      mode: 'arbiter_decisions',
      inputCandidates: drafts.length,
      targetCandidates: opts.targetCandidates,
      hardMaxCandidates: opts.hardMaxCandidates,
    }),
    '',
    'Rules:',
    '- Output a single JSON object only. Do not include markdown or prose.',
    '- Keep only durable workspace context that future conversations are likely to retrieve.',
    `- Default to ${opts.targetCandidates} or fewer candidates. Do not fill the budget just because it exists.`,
    `- Never exceed ${opts.hardMaxCandidates} candidates. Exceed the default target only when every extra candidate is distinct, high-signal, and likely to be retrieved later.`,
    '- For broad initial scans, a smaller excellent map is better than a complete noun inventory.',
    '- Drop ordinary filenames, paths, screenshots, SVGs, local assets, temporary implementation details, source-local trivia, and weak loose associations.',
    '- Keep relationship candidates only when both endpoints are active or are present in the kept candidates.',
    '- Convert weak relationships into facts when the evidence is useful but the relationship would add graph noise.',
    '- Merge duplicate entity candidates. Choose one canonical ref; the backend will preserve source evidence and aliases.',
    '- Use typeCorrections only to map an entity to a built-in entity type when the extracted type is clearly wrong.',
    '- Do not invent entities, facts, secrets, evidence, or source refs. Every ref must be from the input candidates.',
    `- Built-in entity types: ${CONTEXT_MAP_ENTITY_TYPE_PROMPT}.`,
    `- Allowed relationship predicates: ${CONTEXT_MAP_RELATIONSHIP_PREDICATE_PROMPT}.`,
    '',
    'Decision fields:',
    '- keepRefs: candidate refs to persist as-is after backend normalization.',
    '- dropRefs: candidate refs to discard.',
    '- mergeGroups: entity merge decisions, each with sourceRefs, canonicalRef, and optional name/typeSlug/summaryMarkdown/aliases/facts overrides.',
    '- typeCorrections: objects with sourceRef and typeSlug for candidate refs whose entity type should change.',
    '- relationshipToFactRefs: weak relationship refs to fold into facts on a kept subject entity.',
    '',
    'Expected JSON shape:',
    '{"keepRefs":["candidate-1"],"dropRefs":["candidate-3"],"mergeGroups":[{"sourceRefs":["candidate-1","candidate-2"],"canonicalRef":"candidate-1","name":"Example Program","typeSlug":"project","summaryMarkdown":"Short durable summary.","aliases":["Example alias"],"facts":["Useful durable fact."]}],"typeCorrections":[{"sourceRef":"candidate-4","typeSlug":"workflow"}],"relationshipToFactRefs":["candidate-5"],"openQuestions":["Optional concrete uncertainty."]}',
    '',
    'Active entities already in the map:',
    stableStringify(activeEntities),
    '',
    'Input candidate summaries:',
    stableStringify(drafts.map((draft, index) => candidateForArbiter(draft, `candidate-${index + 1}`))),
  ].join('\n');
}

function parseContextMapSynthesisOutput(
  rawOutput: string,
  inputDrafts: ContextMapCandidateDraft[],
  workspacePath: string | undefined,
): { drafts: ContextMapCandidateDraft[]; openQuestions: string[] } {
  const parsed = parseContextMapJsonOutput(
    rawOutput,
    'Context Map synthesis returned no JSON object.',
    'Context Map synthesis returned invalid JSON',
  );
  if (!isRecord(parsed)) throw new Error('Context Map synthesis output must be a JSON object.');
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error('Context Map synthesis output must include a candidates array.');
  }

  const inputByRef = new Map(inputDrafts.map((draft, index) => [`candidate-${index + 1}`, draft]));
  const proposedEntityTypes = collectProposedEntityTypeSlugs(candidates);
  const output: ContextMapCandidateDraft[] = [];
  for (const item of candidates) {
    const refs = normalizeSynthesisSourceRefs(item).filter((ref) => inputByRef.has(ref));
    if (refs.length === 0) continue;
    const normalized = normalizeCandidate(item, proposedEntityTypes);
    if (!normalized) throw new Error('Context Map synthesis returned an invalid candidate.');
    if (!shouldKeepCandidate(normalized, { workspacePath })) continue;
    const primaryDraft = inputByRef.get(refs[0]);
    if (!primaryDraft) continue;
    const payload = { ...normalized.payload };
    if (!isRecord(payload.sourceSpan)) {
      const sourceSpan = sourceSpanFromDraft(primaryDraft);
      if (sourceSpan) payload.sourceSpan = sourceSpan;
    }
    const relatedSourceSpans = relatedSourceSpansForRefs(refs, inputByRef);
    if (relatedSourceSpans.length > 1) payload.relatedSourceSpans = relatedSourceSpans;
    output.push({
      idSource: primaryDraft.idSource,
      candidateType: normalized.candidateType,
      confidence: normalized.confidence,
      payload,
    });
  }

  if (candidates.length > 0 && output.length === 0) {
    throw new Error('Context Map synthesis returned candidates without valid sourceRefs.');
  }

  return {
    drafts: output,
    openQuestions: normalizeOpenQuestions(parsed.openQuestions),
  };
}

function parseContextMapArbiterOutput(
  rawOutput: string,
  inputDrafts: ContextMapCandidateDraft[],
  workspacePath: string | undefined,
): { drafts: ContextMapCandidateDraft[]; openQuestions: string[] } {
  const parsed = parseContextMapJsonOutput(
    rawOutput,
    'Context Map final arbiter returned no JSON object.',
    'Context Map final arbiter returned invalid JSON',
  );
  if (!isRecord(parsed)) throw new Error('Context Map final arbiter output must be a JSON object.');
  const hasDecisionFields = ['keepRefs', 'dropRefs', 'mergeGroups', 'typeCorrections', 'relationshipToFactRefs']
    .some((key) => Object.prototype.hasOwnProperty.call(parsed, key));
  if (!hasDecisionFields) {
    throw new Error('Context Map final arbiter output must include decision refs.');
  }

  const inputByRef = new Map(inputDrafts.map((draft, index) => [`candidate-${index + 1}`, draft]));
  const validRefs = new Set(inputByRef.keys());
  const typeCorrections = normalizeArbiterTypeCorrections(parsed.typeCorrections, validRefs);
  const dropRefs = new Set(normalizeArbiterRefs(parsed.dropRefs).filter((ref) => validRefs.has(ref)));
  const relationshipToFactRefs = new Set(normalizeArbiterRefs(parsed.relationshipToFactRefs).filter((ref) => validRefs.has(ref)));
  const handledRefs = new Set<string>();
  const output: ContextMapCandidateDraft[] = [];
  const outputRefs = new Set<string>();

  const includeDraft = (ref: string, draft: ContextMapCandidateDraft): void => {
    if (outputRefs.has(ref)) return;
    if (!shouldKeepCandidate(draft, { workspacePath })) return;
    outputRefs.add(ref);
    output.push(draft);
  };

  const mergeGroups = Array.isArray(parsed.mergeGroups) ? parsed.mergeGroups.filter(isRecord) : [];
  for (const group of mergeGroups) {
    const groupRefs = normalizeArbiterRefs(group)
      .filter((ref) => validRefs.has(ref) && !dropRefs.has(ref) && !relationshipToFactRefs.has(ref));
    const entityRefs = groupRefs.filter((ref) => inputByRef.get(ref)?.candidateType === 'new_entity');
    if (entityRefs.length === 0) continue;
    const preferredRef = readPayloadString(group, ['canonicalRef', 'sourceRef', 'candidateRef', 'ref']);
    const canonicalRef = entityRefs.includes(preferredRef)
      ? preferredRef
      : chooseArbiterCanonicalEntityRef(entityRefs, inputByRef);
    const merged = cloneDraftWithTypeCorrection(canonicalRef, inputByRef, typeCorrections);
    if (!merged || merged.candidateType !== 'new_entity') continue;
    applyArbiterMergeOverrides(merged, group);

    for (const ref of entityRefs) {
      handledRefs.add(ref);
      if (ref === canonicalRef) continue;
      const loser = cloneDraftWithTypeCorrection(ref, inputByRef, typeCorrections);
      if (!loser || loser.candidateType !== 'new_entity') continue;
      mergeEntityAliases(merged.payload, loser.payload);
      mergeEntityFacts(merged.payload, loser.payload);
      mergeRelatedSourceSpan(merged.payload, loser);
      merged.confidence = Math.max(merged.confidence, loser.confidence);
    }
    includeDraft(canonicalRef, merged);
  }

  const hasExplicitKeepRefs = Array.isArray(parsed.keepRefs);
  const hasExplicitDropRefs = dropRefs.size > 0;
  const keepRefs = hasExplicitKeepRefs
    ? normalizeArbiterRefs(parsed.keepRefs)
    : hasExplicitDropRefs
      ? Array.from(validRefs)
      : [];
  for (const ref of keepRefs) {
    if (!validRefs.has(ref) || dropRefs.has(ref) || handledRefs.has(ref) || relationshipToFactRefs.has(ref)) continue;
    const draft = cloneDraftWithTypeCorrection(ref, inputByRef, typeCorrections);
    if (!draft) continue;
    includeDraft(ref, draft);
  }

  foldArbiterRelationshipsIntoFacts(relationshipToFactRefs, inputByRef, output);
  return {
    drafts: output,
    openQuestions: normalizeOpenQuestions(parsed.openQuestions),
  };
}

function candidateForSynthesis(draft: ContextMapCandidateDraft, sourceRef: string): Record<string, unknown> {
  const payload = { ...draft.payload };
  delete payload.sourceSpan;
  delete payload.relatedSourceSpans;
  return {
    sourceRef,
    type: draft.candidateType,
    confidence: draft.confidence,
    payload: compactJsonForPrompt(payload),
    source: compactJsonForPrompt(draft.payload.sourceSpan),
  };
}

function candidateForArbiter(draft: ContextMapCandidateDraft, sourceRef: string): Record<string, unknown> {
  const sourceSpan = isRecord(draft.payload.sourceSpan) ? draft.payload.sourceSpan : {};
  const source = {
    sourceType: readPayloadString(sourceSpan, ['sourceType']),
    sourceId: readPayloadString(sourceSpan, ['sourceId']),
    conversationTitle: readPayloadString(sourceSpan, ['conversationTitle']),
    title: readPayloadString(sourceSpan, ['title']),
    locator: readPayloadString(sourceSpan, ['locator']),
  };
  const base: Record<string, unknown> = {
    sourceRef,
    type: draft.candidateType,
    confidence: Math.round(draft.confidence * 100) / 100,
    bucket: synthesisBucketForDraft(draft),
    source: compactJsonForPrompt(source),
  };
  if (draft.candidateType === 'new_entity' || draft.candidateType === 'entity_update') {
    base.typeSlug = readPayloadString(draft.payload, ['typeSlug', 'entityType', 'type']);
    base.name = readPayloadString(draft.payload, ['name', 'entityName', 'title']);
    base.summaryMarkdown = compactPromptString(readPayloadString(draft.payload, ['summaryMarkdown', 'notesMarkdown', 'description']), 260);
    base.aliases = normalizeAliasArray(draft.payload.aliases).slice(0, 4);
    base.facts = normalizeCandidateFacts(draft.payload).slice(0, 3).map((fact) => compactPromptString(fact, 180));
    base.sensitivity = readPayloadString(draft.payload, ['sensitivity', 'classification']);
    return removeEmptyPromptFields(base);
  }
  if (draft.candidateType === 'new_relationship' || draft.candidateType === 'relationship_update') {
    base.subjectName = readPayloadString(draft.payload, ['subjectName', 'subjectEntityName']);
    base.predicate = readPayloadString(draft.payload, ['predicate', 'relationship', 'label']);
    base.objectName = readPayloadString(draft.payload, ['objectName', 'objectEntityName']);
    base.evidenceMarkdown = compactPromptString(readPayloadString(draft.payload, ['evidenceMarkdown', 'rationale', 'reason', 'summaryMarkdown']), 260);
    return removeEmptyPromptFields(base);
  }
  base.payload = compactJsonForPrompt(draft.payload, 1);
  return removeEmptyPromptFields(base);
}

function compactPromptString(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function compactPromptBlock(value: string, limit: number): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, Math.max(0, limit - 3))}...`;
}

function removeEmptyPromptFields(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === '' || item === undefined || item === null) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    if (isRecord(item) && Object.keys(item).length === 0) continue;
    output[key] = item;
  }
  return output;
}

function normalizeSynthesisSourceRefs(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const refs = value.sourceRefs;
  if (Array.isArray(refs)) {
    return refs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  }
  const ref = value.sourceRef;
  return typeof ref === 'string' && ref.trim() ? [ref.trim()] : [];
}

function normalizeArbiterRefs(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) {
    return dedupeAliases(value.flatMap((item) => normalizeArbiterRefs(item)));
  }
  if (!isRecord(value)) return [];
  const refs = [
    ...normalizeArbiterRefs(value.sourceRefs),
    ...normalizeArbiterRefs(value.candidateRefs),
    ...normalizeArbiterRefs(value.refs),
  ];
  const direct = readPayloadString(value, ['sourceRef', 'candidateRef', 'ref']);
  if (direct) refs.push(direct);
  return dedupeAliases(refs);
}

function normalizeArbiterTypeCorrections(value: unknown, validRefs: Set<string>): Map<string, string> {
  const corrections = new Map<string, string>();
  if (!Array.isArray(value)) return corrections;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const ref = normalizeArbiterRefs(item).find((candidateRef) => validRefs.has(candidateRef));
    if (!ref) continue;
    const typeSlug = normalizeBuiltInEntityTypeSlug(readPayloadString(item, ['typeSlug', 'entityType', 'type']));
    if (typeSlug) corrections.set(ref, typeSlug);
  }
  return corrections;
}

function normalizeBuiltInEntityTypeSlug(value: string): string {
  const typeSlug = normalizeSlug(value);
  const aliased = CONTEXT_MAP_TYPE_ALIASES.get(typeSlug) || typeSlug;
  return CONTEXT_MAP_BUILT_IN_ENTITY_TYPES.has(aliased) ? aliased : '';
}

function chooseArbiterCanonicalEntityRef(
  refs: string[],
  inputByRef: Map<string, ContextMapCandidateDraft>,
): string {
  return refs
    .slice()
    .sort((a, b) => {
      const draftA = inputByRef.get(a);
      const draftB = inputByRef.get(b);
      if (!draftA || !draftB) return 0;
      return fallbackCandidateScore(draftB) - fallbackCandidateScore(draftA)
        || draftB.confidence - draftA.confidence
        || refs.indexOf(a) - refs.indexOf(b);
    })[0];
}

function cloneDraftWithTypeCorrection(
  ref: string,
  inputByRef: Map<string, ContextMapCandidateDraft>,
  typeCorrections: Map<string, string>,
): ContextMapCandidateDraft | null {
  const source = inputByRef.get(ref);
  if (!source) return null;
  const draft = cloneContextMapCandidateDraft(source);
  const typeSlug = typeCorrections.get(ref);
  if (typeSlug && draft.candidateType === 'new_entity') {
    draft.payload.typeSlug = typeSlug;
  }
  return draft;
}

function cloneContextMapCandidateDraft(draft: ContextMapCandidateDraft): ContextMapCandidateDraft {
  return {
    idSource: draft.idSource,
    candidateType: draft.candidateType,
    confidence: draft.confidence,
    payload: cloneRecord(draft.payload),
  };
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function applyArbiterMergeOverrides(draft: ContextMapCandidateDraft, group: Record<string, unknown>): void {
  const name = readPayloadString(group, ['name', 'canonicalName', 'title']);
  if (name) draft.payload.name = name;
  const typeSlug = normalizeBuiltInEntityTypeSlug(readPayloadString(group, ['typeSlug', 'entityType', 'type']));
  if (typeSlug) draft.payload.typeSlug = typeSlug;
  const summaryMarkdown = readPayloadString(group, ['summaryMarkdown', 'summary', 'description']);
  if (summaryMarkdown) draft.payload.summaryMarkdown = summaryMarkdown;
  const aliases = normalizeAliasArray(group.aliases);
  if (aliases.length > 0) {
    draft.payload.aliases = dedupeAliases([...normalizeAliasArray(draft.payload.aliases), ...aliases]);
  }
  const facts = normalizeFactArray(group.facts);
  if (facts.length > 0) {
    draft.payload.facts = dedupeFacts([...normalizeCandidateFacts(draft.payload), ...facts]);
  }
}

function mergeEntityFacts(target: Record<string, unknown>, source: Record<string, unknown>): void {
  const facts = [
    ...normalizeCandidateFacts(target),
    ...normalizeCandidateFacts(source),
  ];
  const sourceSummary = readPayloadString(source, ['summaryMarkdown', 'notesMarkdown', 'description']);
  const targetSummary = readPayloadString(target, ['summaryMarkdown', 'notesMarkdown', 'description']);
  if (sourceSummary && normalizedCandidateText(sourceSummary) !== normalizedCandidateText(targetSummary)) facts.push(sourceSummary);
  const deduped = dedupeFacts(facts);
  if (deduped.length > 0) target.facts = deduped;
}

function foldArbiterRelationshipsIntoFacts(
  relationshipRefs: Set<string>,
  inputByRef: Map<string, ContextMapCandidateDraft>,
  outputDrafts: ContextMapCandidateDraft[],
): void {
  if (relationshipRefs.size === 0 || outputDrafts.length === 0) return;
  const entitiesByName = new Map<string, ContextMapCandidateDraft>();
  for (const draft of outputDrafts) {
    if (draft.candidateType !== 'new_entity') continue;
    const name = readPayloadString(draft.payload, ['name', 'entityName', 'title']);
    if (name) entitiesByName.set(normalizedCandidateText(name), draft);
  }
  for (const ref of relationshipRefs) {
    const relationshipDraft = inputByRef.get(ref);
    if (!relationshipDraft || relationshipDraft.candidateType !== 'new_relationship') continue;
    const subjectName = readPayloadString(relationshipDraft.payload, ['subjectName', 'subjectEntityName']);
    const objectName = readPayloadString(relationshipDraft.payload, ['objectName', 'objectEntityName']);
    const subjectDraft = entitiesByName.get(normalizedCandidateText(subjectName));
    if (!subjectDraft || !subjectName || !objectName) continue;
    const fact = relationshipFactFromDraft(relationshipDraft, subjectName, objectName, 'final arbiter kept this as a fact instead of a relationship');
    if (!fact) continue;
    subjectDraft.payload.facts = dedupeFacts([...normalizeCandidateFacts(subjectDraft.payload), fact]);
    mergeRelatedSourceSpan(subjectDraft.payload, relationshipDraft);
  }
}

function sourceSpanFromDraft(draft: ContextMapCandidateDraft): Record<string, unknown> | null {
  return isRecord(draft.payload.sourceSpan) ? { ...draft.payload.sourceSpan } : null;
}

function relatedSourceSpansForRefs(
  refs: string[],
  inputByRef: Map<string, ContextMapCandidateDraft>,
): Record<string, unknown>[] {
  const spans: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const draft = inputByRef.get(ref);
    if (!draft) continue;
    const span = sourceSpanFromDraft(draft);
    if (!span) continue;
    const key = stableStringify(span);
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push(span);
  }
  return spans;
}

function normalizeOpenQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const questions: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const question = item.replace(/\s+/g, ' ').trim();
    const key = normalizedCandidateText(question);
    if (!question || seen.has(key)) continue;
    seen.add(key);
    questions.push(question.length <= 220 ? question : `${question.slice(0, 217)}...`);
    if (questions.length >= 10) break;
  }
  return questions;
}

function compactJsonForPrompt(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= 700 ? normalized : `${normalized.slice(0, 697)}...`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactJsonForPrompt(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort().slice(0, 18)) {
    output[key] = compactJsonForPrompt(record[key], depth + 1);
  }
  return output;
}

function renderContentBlocks(blocks: Message['contentBlocks']): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';
  return blocks.map((block) => stableStringify(block)).join('\n');
}

async function parseContextMapCandidatesWithRepair(
  rawOutput: string,
  opts: {
    sourceType: ContextMapExtractionFailure['sourceType'];
    sourceId: string;
    adapter: ContextMapProcessorAdapter;
    processor: ResolvedContextMapProcessor;
    abortSignal: AbortSignal;
    workspacePath: string | undefined;
    repairs: ContextMapExtractionRepairEvent[];
  },
): Promise<PendingContextMapCandidate[]> {
  try {
    return parseContextMapCandidates(rawOutput);
  } catch (parseErr: unknown) {
    try {
      const repairedOutput = await repairContextMapJsonOutput({
        rawOutput,
        errorMessage: (parseErr as Error).message,
        schema: 'extraction',
        runOneShot: (prompt, options, signal) => runContextMapExtractionOneShot(opts.adapter, prompt, options, signal),
        processor: {
          model: opts.processor.model,
          effort: opts.processor.effort,
          cliProfile: opts.processor.runtime.profile,
        },
        abortSignal: opts.abortSignal,
        workspacePath: opts.workspacePath,
      });
      throwIfContextMapStopped(opts.abortSignal);
      const parsed = parseContextMapCandidates(repairedOutput);
      opts.repairs.push({
        sourceType: opts.sourceType,
        sourceId: opts.sourceId,
        succeeded: true,
      });
      return parsed;
    } catch (repairErr: unknown) {
      opts.repairs.push({
        sourceType: opts.sourceType,
        sourceId: opts.sourceId,
        succeeded: false,
        errorMessage: truncateErrorMessage((repairErr as Error).message),
      });
      throw parseErr;
    }
  }
}

function parseContextMapCandidates(rawOutput: string): PendingContextMapCandidate[] {
  const parsed = parseContextMapJsonOutput(
    rawOutput,
    'Context Map processor returned no JSON object.',
    'Context Map processor returned invalid JSON',
  );
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Context Map processor output must be a JSON object.');
  }
  const candidates = (parsed as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) {
    throw new Error('Context Map processor output must include a candidates array.');
  }
  const proposedEntityTypes = collectProposedEntityTypeSlugs(candidates);
  return candidates.flatMap((item, index) => {
    const normalized = normalizeCandidate(item, proposedEntityTypes);
    if (!normalized) {
      throw new Error(`Context Map processor candidate ${index + 1} is invalid.`);
    }
    return [normalized];
  });
}

function buildKnownEntityTargets(db: ContextMapDatabase): KnownEntityTargets {
  const activeEntities = db.listEntities({ status: 'active' });
  return {
    ids: new Set(activeEntities.map((entity) => entity.entityId)),
    names: new Set(activeEntities.map((entity) => normalizedCandidateText(entity.name))),
  };
}

function prepareCandidatesForReview(
  candidates: PendingContextMapCandidate[],
  knownEntityTargets: KnownEntityTargets,
): PendingContextMapCandidate[] {
  const proposedEntityByName = new Map<string, PendingContextMapCandidate>();
  for (const candidate of candidates) {
    if (candidate.candidateType !== 'new_entity') continue;
    const name = readPayloadString(candidate.payload, ['name', 'entityName', 'title']);
    if (name) proposedEntityByName.set(normalizedCandidateText(name), candidate);
  }

  return candidates.filter((candidate) => {
    if (candidate.candidateType !== 'sensitivity_classification') return true;
    const sensitivity = normalizeCandidateSensitivity(readPayloadString(candidate.payload, ['sensitivity', 'classification']));
    if (!sensitivity) return false;
    const entityId = readPayloadString(candidate.payload, ['entityId', 'targetEntityId']);
    if (entityId && knownEntityTargets.ids.has(entityId)) return true;
    const entityName = readPayloadString(candidate.payload, ['entityName', 'name', 'targetName']);
    const normalizedName = normalizedCandidateText(entityName);
    if (normalizedName && knownEntityTargets.names.has(normalizedName)) return true;

    const proposedEntity = normalizedName ? proposedEntityByName.get(normalizedName) : null;
    if (proposedEntity) {
      proposedEntity.payload.sensitivity = sensitivity;
    }
    return false;
  });
}

function rememberCandidateEntity(candidate: PendingContextMapCandidate, knownEntityTargets: KnownEntityTargets): void {
  if (candidate.candidateType !== 'new_entity') return;
  const name = readPayloadString(candidate.payload, ['name', 'entityName', 'title']);
  if (name) knownEntityTargets.names.add(normalizedCandidateText(name));
}

function limitCandidatesForSource(
  candidates: PendingContextMapCandidate[],
  packet: ContextMapSourcePacket,
): PendingContextMapCandidate[] {
  const limit = candidateLimitForSource(packet);
  if (candidates.length <= limit) return candidates;
  const relationshipReserve = relationshipReserveForSource(packet, limit);
  const reservedRelationships = relationshipReserve > 0
    ? candidates
      .map((candidate, index) => ({ candidate, index, score: sourceCandidateScore(candidate) }))
      .filter((item) => isStrictSourceRelationshipCandidate(item.candidate))
      .sort((a, b) => b.score - a.score || b.candidate.confidence - a.candidate.confidence || a.index - b.index)
      .slice(0, relationshipReserve)
    : [];
  const reserved = new Set(reservedRelationships.map((item) => item.candidate));
  const selected = candidates
    .map((candidate, index) => ({ candidate, index, score: sourceCandidateScore(candidate) }))
    .filter((item) => !reserved.has(item.candidate))
    .sort((a, b) => b.score - a.score || b.candidate.confidence - a.candidate.confidence || a.index - b.index)
    .slice(0, Math.max(0, limit - reservedRelationships.length))
    .concat(reservedRelationships)
    .sort((a, b) => a.index - b.index);
  return selected.map((item) => item.candidate);
}

function relationshipReserveForSource(packet: ContextMapSourcePacket, limit: number): number {
  if (limit < 2 || packet.sourceType === 'workspace_instruction') return 0;
  if (packet.sourceType === 'code_outline') return Math.min(2, limit - 1);
  const sourceId = packet.sourceId.toLowerCase();
  if (sourceId.startsWith('context/contact-')) return 1;
  if (sourceId.startsWith('workflows/')) return 1;
  if (sourceId.startsWith('context/')) return 1;
  if (sourceId === 'readme.md' || sourceId === 'spec.md' || sourceId === 'docs/spec.md') return 1;
  return 0;
}

function isStrictSourceRelationshipCandidate(candidate: PendingContextMapCandidate): boolean {
  if (candidate.candidateType !== 'new_relationship') return false;
  if (candidate.confidence < 0.8) return false;
  const subjectName = readPayloadString(candidate.payload, ['subjectName', 'subjectEntityName', 'sourceName', 'fromName']);
  const objectName = readPayloadString(candidate.payload, ['objectName', 'objectEntityName', 'targetName', 'toName']);
  const predicate = normalizeRelationshipPredicate(readPayloadString(candidate.payload, ['predicate', 'relationship', 'label', 'relationshipType']));
  return Boolean(subjectName && objectName && predicate && predicate !== 'relates_to' && hasRelationshipEvidence(candidate.payload));
}

function candidateLimitForSource(packet: ContextMapSourcePacket): number {
  if (packet.sourceType === 'workspace_instruction') return 4;
  if (packet.sourceType === 'code_outline') return 8;
  const sourceId = packet.sourceId.toLowerCase();
  if (sourceId === 'agents.md' || sourceId === 'claude.md') return 3;
  if (sourceId === 'readme.md' || sourceId === 'spec.md' || sourceId === 'docs/spec.md') return 5;
  if (sourceId.startsWith('workflows/')) return 4;
  if (sourceId.startsWith('context/contact-')) return 4;
  if (sourceId.startsWith('drafts/')) return 3;
  if (sourceId.includes('/content/posts/') || sourceId.includes('/content/races.') || sourceId.includes('/themes/')) return 2;
  return 5;
}

function sourceCandidateScore(candidate: PendingContextMapCandidate): number {
  const typeWeight: Record<ContextCandidateType, number> = {
    new_entity: 50,
    entity_update: 45,
    new_relationship: 35,
    alias_addition: 25,
    new_entity_type: 20,
    relationship_update: 18,
    evidence_link: 12,
    sensitivity_classification: 10,
    entity_merge: 8,
    relationship_removal: 8,
    conflict_flag: 6,
  };
  const payload = candidate.payload;
  const entityType = candidate.candidateType === 'new_entity'
    ? readPayloadString(payload, ['typeSlug', 'entityType', 'type'])
    : '';
  const entityWeight = entityType === 'project'
    ? 8
    : entityType === 'document' || entityType === 'workflow' || entityType === 'feature'
      ? 5
      : 0;
  return (typeWeight[candidate.candidateType] || 0) + entityWeight + candidate.confidence;
}

function prepareCandidateDraftsForPersistence(
  drafts: ContextMapCandidateDraft[],
  db: ContextMapDatabase,
  workspacePath: string | undefined,
  synthesisAttempted: boolean,
): ContextMapCandidateDraft[] {
  const normalizedDrafts = drafts.map(normalizeCandidateDraftForPersistence);
  const refined = refineCandidateDrafts(normalizedDrafts, db, workspacePath);
  const typeResolved = resolveEntityNameTypeConflicts(refined);
  const sourceFolded = synthesisAttempted ? foldSourceLocalEntityDrafts(typeResolved) : typeResolved;
  return synthesisAttempted ? pruneRelationshipDrafts(sourceFolded) : sourceFolded;
}

function normalizeCandidateDraftForPersistence(draft: ContextMapCandidateDraft): ContextMapCandidateDraft {
  const payload = { ...draft.payload };
  normalizePayloadFacts(payload);
  correctPayloadSensitivityFromSource(draft.candidateType, payload);
  return { ...draft, payload };
}

function recoverStrictRelationshipDrafts(
  keptDrafts: ContextMapCandidateDraft[],
  sourceDrafts: ContextMapCandidateDraft[],
  db: ContextMapDatabase,
  workspacePath: string | undefined,
): ContextMapCandidateDraft[] {
  if (keptDrafts.length === 0 || sourceDrafts.length === 0) return keptDrafts;
  const activeEntities = db.listEntities({ status: 'active' });
  const projectNames = collectProjectNames([...keptDrafts, ...sourceDrafts], activeEntities, workspacePath);
  const keptEntityDrafts = keptDrafts.filter((draft) => draft.candidateType === 'new_entity');
  const knownNames = buildKnownEndpointNames(db, activeEntities, keptEntityDrafts, projectNames, {
    includePendingCandidates: false,
  });
  const existingKeys = new Set(
    keptDrafts
      .filter((draft) => draft.candidateType === 'new_relationship')
      .map((draft) => relationshipCandidateKey(draft.payload)),
  );
  const recovered: ContextMapCandidateDraft[] = [];

  for (const sourceDraft of sourceDrafts) {
    if (sourceDraft.candidateType !== 'new_relationship') continue;
    const draft = cloneContextMapCandidateDraft(sourceDraft);
    const subjectName = readPayloadString(draft.payload, ['subjectName', 'subjectEntityName']);
    const objectName = readPayloadString(draft.payload, ['objectName', 'objectEntityName']);
    const subject = resolveKnownEndpointTarget(subjectName, knownNames, projectNames);
    const object = resolveKnownEndpointTarget(objectName, knownNames, projectNames);
    if (!subject || !object) continue;
    draft.payload.subjectName = subject.name;
    draft.payload.objectName = object.name;
    if (isSameRelationshipEndpoint(subject, object, projectNames)) continue;
    const assessment = assessRelationshipDraft(draft, subject, object);
    if (!assessment.keep) continue;
    if (relationshipAlreadyRepresentedAsFact(subject, draft)) continue;
    const predicate = normalizeRelationshipPredicate(readPayloadString(draft.payload, ['predicate', 'relationship', 'label']));
    if (predicate === 'relates_to' || draft.confidence < 0.84 || !hasRelationshipEvidence(draft.payload)) continue;
    const key = relationshipCandidateKey(draft.payload);
    if (!key || existingKeys.has(key)) continue;
    existingKeys.add(key);
    recovered.push(draft);
  }

  if (recovered.length === 0) return keptDrafts;
  const selected = recovered
    .map((draft, index) => ({ draft, index, score: relationshipPersistenceScore(draft) }))
    .sort((a, b) => b.score - a.score || b.draft.confidence - a.draft.confidence || a.index - b.index)
    .slice(0, CONTEXT_MAP_SYNTHESIS_RECOVERED_RELATIONSHIP_CANDIDATES)
    .map((item) => item.draft);
  return [...keptDrafts, ...selected];
}

function relationshipCandidateKey(payload: Record<string, unknown>): string {
  const subjectName = normalizedCandidateText(readPayloadString(payload, ['subjectName', 'subjectEntityName']));
  const predicate = normalizeRelationshipPredicate(readPayloadString(payload, ['predicate', 'relationship', 'label']));
  const objectName = normalizedCandidateText(readPayloadString(payload, ['objectName', 'objectEntityName']));
  return subjectName && predicate && objectName ? `${subjectName}:${predicate}:${objectName}` : '';
}

function relationshipAlreadyRepresentedAsFact(
  subject: KnownRelationshipEndpoint,
  relationshipDraft: ContextMapCandidateDraft,
): boolean {
  if (!subject.draft) return false;
  const objectName = normalizedCandidateText(readPayloadString(relationshipDraft.payload, ['objectName', 'objectEntityName']));
  if (!objectName) return false;
  const evidence = normalizedCandidateText(readPayloadString(relationshipDraft.payload, ['evidenceMarkdown', 'rationale', 'reason', 'summaryMarkdown']));
  return normalizeCandidateFacts(subject.draft.payload).some((fact) => {
    const normalizedFact = normalizedCandidateText(fact);
    if (!normalizedFact.includes(objectName)) return false;
    return !evidence || normalizedFact.includes(evidence.slice(0, 80));
  });
}

function refineCandidateDrafts(
  drafts: ContextMapCandidateDraft[],
  db: ContextMapDatabase,
  workspacePath: string | undefined,
): ContextMapCandidateDraft[] {
  if (drafts.length === 0) return drafts;

  const activeEntities = db.listEntities({ status: 'active' });
  const projectNames = collectProjectNames(drafts, activeEntities, workspacePath);
  const activeIndex = buildActiveEntityIndex(activeEntities, db, projectNames);
  const aliasNameMap = new Map<string, string>();
  const entityGroups = new Map<string, { draft: ContextMapCandidateDraft; order: number }>();
  const ordered: Array<{ draft: ContextMapCandidateDraft; order: number }> = [];

  drafts.forEach((draft, order) => {
    if (draft.candidateType === 'entity_update') {
      const activeEntity = findActiveEntityForUpdate(draft, activeEntities, db, projectNames);
      if (!activeEntity) return;
      if (!readPayloadString(draft.payload, ['entityId', 'targetEntityId'])) {
        draft.payload.entityId = activeEntity.entityId;
      }
      if (isNoopEntityUpdateDraft(draft, activeEntity, db)) return;
      ordered.push({ draft, order });
      return;
    }

    if (draft.candidateType !== 'new_entity') {
      ordered.push({ draft, order });
      return;
    }

    const name = readPayloadString(draft.payload, ['name', 'entityName', 'title']);
    const typeSlug = normalizeSlug(readPayloadString(draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
    if (!name) return;

    const activeMatch = findActiveEntityMatch(activeIndex, typeSlug, name, projectNames);
    if (activeMatch) {
      aliasNameMap.set(normalizedCandidateText(name), activeMatch.name);
      const updateDraft = convertNewEntityToUpdateDraft(draft, activeMatch.entity, name);
      ordered.push({ draft: updateDraft, order });
      return;
    }

    const key = entityCanonicalKey(typeSlug, name, projectNames);
    const existing = entityGroups.get(key);
    if (!existing) {
      entityGroups.set(key, { draft, order });
      return;
    }

    const winner = choosePreferredEntityDraft(existing.draft, draft, projectNames);
    const loser = winner === existing.draft ? draft : existing.draft;
    const winnerOrder = winner === existing.draft ? existing.order : order;
    mergeEntityAliases(winner.payload, loser.payload);
    const loserName = readPayloadString(loser.payload, ['name', 'entityName', 'title']);
    const winnerName = readPayloadString(winner.payload, ['name', 'entityName', 'title']);
    if (loserName && winnerName) aliasNameMap.set(normalizedCandidateText(loserName), winnerName);
    entityGroups.set(key, { draft: winner, order: Math.min(existing.order, winnerOrder) });
  });

  for (const grouped of entityGroups.values()) ordered.push(grouped);
  const knownNames = buildKnownEndpointNames(db, activeEntities, Array.from(entityGroups.values()).map((item) => item.draft), projectNames);
  for (const [from, to] of aliasNameMap.entries()) {
    const target = resolveKnownEndpointTarget(to, knownNames, projectNames);
    if (!target) continue;
    knownNames.exact.set(from, target);
    knownNames.canonical.set(canonicalRelationshipName(from, projectNames), target);
  }

  return ordered
    .sort((a, b) => a.order - b.order)
    .flatMap(({ draft }) => {
      if (draft.candidateType !== 'new_relationship') return [draft];
      const subjectName = readPayloadString(draft.payload, ['subjectName', 'subjectEntityName']);
      const objectName = readPayloadString(draft.payload, ['objectName', 'objectEntityName']);
      const subject = resolveKnownEndpointTarget(subjectName, knownNames, projectNames);
      const object = resolveKnownEndpointTarget(objectName, knownNames, projectNames);
      if (!subject || !object) return [];
      draft.payload.subjectName = subject.name;
      draft.payload.objectName = object.name;
      if (isSameRelationshipEndpoint(subject, object, projectNames)) return [];
      const assessment = assessRelationshipDraft(draft, subject, object);
      if (!assessment.keep) {
        convertRejectedRelationshipToFact(draft, subject, object, assessment.reason);
        return [];
      }
      return [draft];
    });
}

function resolveEntityNameTypeConflicts(drafts: ContextMapCandidateDraft[]): ContextMapCandidateDraft[] {
  const groups = new Map<string, Array<{ draft: ContextMapCandidateDraft; index: number }>>();
  drafts.forEach((draft, index) => {
    if (draft.candidateType !== 'new_entity') return;
    const name = readPayloadString(draft.payload, ['name', 'entityName', 'title']);
    if (!name) return;
    const key = normalizedCandidateText(name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push({ draft, index });
  });

  const remove = new Set<ContextMapCandidateDraft>();
  for (const group of groups.values()) {
    const typeSlugs = new Set(group.map((item) => normalizeSlug(readPayloadString(item.draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept'));
    if (group.length < 2 || typeSlugs.size < 2) continue;
    const winner = group
      .slice()
      .sort((a, b) => entityTypeConflictScore(b.draft) - entityTypeConflictScore(a.draft) || a.index - b.index)[0];
    for (const item of group) {
      if (item === winner) continue;
      mergeEntityAliases(winner.draft.payload, item.draft.payload);
      mergeRelatedSourceSpan(winner.draft.payload, item.draft);
      const loserSummary = readPayloadString(item.draft.payload, ['summaryMarkdown', 'notesMarkdown', 'description']);
      const loserType = normalizeSlug(readPayloadString(item.draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
      const winnerType = normalizeSlug(readPayloadString(winner.draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
      if (loserSummary && loserType !== winnerType) {
        const facts = normalizeCandidateFacts(winner.draft.payload);
        facts.push(`Also appeared as ${loserType}: ${loserSummary}`);
        winner.draft.payload.facts = dedupeFacts(facts);
      }
      remove.add(item.draft);
    }
  }

  return drafts.filter((draft) => !remove.has(draft));
}

function foldSourceLocalEntityDrafts(drafts: ContextMapCandidateDraft[]): ContextMapCandidateDraft[] {
  const groups = new Map<string, Array<{ draft: ContextMapCandidateDraft; index: number }>>();
  drafts.forEach((draft, index) => {
    if (draft.candidateType !== 'new_entity') return;
    const sourceKey = sourceIdentityKey(draft);
    if (!sourceKey) return;
    if (!groups.has(sourceKey)) groups.set(sourceKey, []);
    groups.get(sourceKey)?.push({ draft, index });
  });

  const remove = new Set<ContextMapCandidateDraft>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const parent = chooseSourceLocalParent(group.map((item) => item.draft));
    if (!parent) continue;
    for (const item of group) {
      const draft = item.draft;
      if (draft === parent || !shouldFoldSourceLocalEntity(draft, parent)) continue;
      const fact = sourceLocalEntityFact(draft);
      if (fact) {
        parent.payload.facts = dedupeFacts([...normalizeCandidateFacts(parent.payload), fact]);
        mergeRelatedSourceSpan(parent.payload, draft);
      }
      remove.add(draft);
    }
  }

  return drafts.filter((draft) => !remove.has(draft));
}

function sourceIdentityKey(draft: ContextMapCandidateDraft): string {
  const sourceSpan = isRecord(draft.payload.sourceSpan) ? draft.payload.sourceSpan : {};
  const sourceType = readPayloadString(sourceSpan, ['sourceType']);
  if (!sourceType) return '';
  if (sourceType === 'conversation_message') {
    return [
      sourceType,
      readPayloadString(sourceSpan, ['conversationId']),
      readPayloadString(sourceSpan, ['sessionEpoch']),
      readPayloadString(sourceSpan, ['startMessageId']),
      readPayloadString(sourceSpan, ['endMessageId']),
    ].join(':');
  }
  return [sourceType, readPayloadString(sourceSpan, ['sourceId'])].join(':');
}

function chooseSourceLocalParent(drafts: ContextMapCandidateDraft[]): ContextMapCandidateDraft | null {
  const ranked = drafts
    .slice()
    .sort((a, b) => sourceLocalParentScore(b) - sourceLocalParentScore(a) || b.confidence - a.confidence);
  return ranked[0] || null;
}

function sourceLocalParentScore(draft: ContextMapCandidateDraft): number {
  const typeSlug = normalizeSlug(readPayloadString(draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
  const weights: Record<string, number> = {
    person: 100,
    project: 92,
    workflow: 88,
    organization: 84,
    document: 58,
    decision: 56,
    tool: 50,
    feature: 44,
    concept: 30,
    asset: 0,
  };
  return (weights[typeSlug] ?? 20) + (draft.confidence * 10);
}

function shouldFoldSourceLocalEntity(draft: ContextMapCandidateDraft, parent: ContextMapCandidateDraft): boolean {
  const typeSlug = normalizeSlug(readPayloadString(draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
  const parentTypeSlug = normalizeSlug(readPayloadString(parent.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
  if (['person', 'organization'].includes(typeSlug)) return false;
  if (typeSlug === 'asset') return true;
  if (typeSlug === 'document') {
    const name = readPayloadString(draft.payload, ['name', 'entityName', 'title']);
    if (isMaintainedDocumentEntityName(name)) return false;
    return draft.confidence < 0.9 && ['person', 'project', 'workflow', 'organization'].includes(parentTypeSlug);
  }
  if (['concept', 'feature', 'tool'].includes(typeSlug)) {
    return draft.confidence < 0.86 && ['person', 'project', 'workflow', 'organization', 'document'].includes(parentTypeSlug);
  }
  return false;
}

function isMaintainedDocumentEntityName(name: string): boolean {
  const normalized = normalizedCandidateText(name);
  return /\b(spec|specification|adr|architecture decision|roadmap|plan|proposal|runbook|manual|chapter|manuscript|research source)\b/.test(normalized);
}

function sourceLocalEntityFact(draft: ContextMapCandidateDraft): string {
  const typeSlug = normalizeSlug(readPayloadString(draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
  const name = readPayloadString(draft.payload, ['name', 'entityName', 'title']);
  if (!name) return '';
  const summary = readPayloadString(draft.payload, ['summaryMarkdown', 'notesMarkdown', 'description']);
  return summary
    ? `Related ${typeSlug}: ${name} - ${summary}`
    : `Related ${typeSlug}: ${name}`;
}

function entityTypeConflictScore(draft: ContextMapCandidateDraft): number {
  const typeSlug = normalizeSlug(readPayloadString(draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
  return (entityFallbackWeight(typeSlug) / 100) + draft.confidence;
}

function mergeRelatedSourceSpan(payload: Record<string, unknown>, draft: ContextMapCandidateDraft): void {
  const spans = Array.isArray(payload.relatedSourceSpans)
    ? payload.relatedSourceSpans.filter(isRecord)
    : [];
  if (isRecord(payload.sourceSpan)) spans.push(payload.sourceSpan);
  const loserSpan = sourceSpanFromDraft(draft);
  if (loserSpan) spans.push(loserSpan);
  const deduped: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    const key = stableStringify(span);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...span });
  }
  if (deduped.length > 1) payload.relatedSourceSpans = deduped;
}

function pruneRelationshipDrafts(drafts: ContextMapCandidateDraft[]): ContextMapCandidateDraft[] {
  const relationships = drafts
    .map((draft, index) => ({ draft, index, score: relationshipPersistenceScore(draft) }))
    .filter((item) => item.draft.candidateType === 'new_relationship');
  if (relationships.length <= CONTEXT_MAP_SYNTHESIS_MAX_RELATIONSHIP_CANDIDATES) return drafts;
  const kept = new Set(relationships
    .sort((a, b) => b.score - a.score || b.draft.confidence - a.draft.confidence || a.index - b.index)
    .slice(0, CONTEXT_MAP_SYNTHESIS_MAX_RELATIONSHIP_CANDIDATES)
    .map((item) => item.draft));
  return drafts.filter((draft) => draft.candidateType !== 'new_relationship' || kept.has(draft));
}

function relationshipPersistenceScore(draft: ContextMapCandidateDraft): number {
  if (draft.candidateType !== 'new_relationship') return 0;
  const predicate = normalizeRelationshipPredicate(readPayloadString(draft.payload, ['predicate', 'relationship', 'label']));
  let score = draft.confidence * 20;
  if (isCoreRelationshipPredicate(predicate)) score += 10;
  if (isInterpretiveRelationshipPredicate(predicate)) score -= 4;
  if (predicate === 'relates_to') score -= 12;
  if (hasRelationshipEvidence(draft.payload)) score += 6;
  return score;
}

function collectProjectNames(
  drafts: ContextMapCandidateDraft[],
  activeEntities: ContextEntityRow[],
  workspacePath: string | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const entity of activeEntities) {
    if (entity.typeSlug === 'project') names.add(entity.name);
  }
  for (const draft of drafts) {
    if (draft.candidateType !== 'new_entity') continue;
    const typeSlug = normalizeSlug(readPayloadString(draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
    const name = readPayloadString(draft.payload, ['name', 'entityName', 'title']);
    if (typeSlug === 'project' && name) names.add(name);
  }
  if (workspacePath) {
    const workspaceName = humanizeWorkspaceName(path.basename(workspacePath));
    if (workspaceName) names.add(workspaceName);
  }
  return names;
}

function humanizeWorkspaceName(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildActiveEntityIndex(
  activeEntities: ContextEntityRow[],
  db: ContextMapDatabase,
  projectNames: Set<string>,
): Map<string, { entity: ContextEntityRow; name: string }> {
  const index = new Map<string, { entity: ContextEntityRow; name: string }>();
  for (const entity of activeEntities) {
    const names = [entity.name, ...db.listAliases(entity.entityId).map((alias) => alias.alias)];
    for (const name of names) {
      index.set(activeEntityIndexKey(entity.typeSlug, normalizedCandidateText(name)), { entity, name: entity.name });
      index.set(activeEntityIndexKey(entity.typeSlug, canonicalEntityName(name, projectNames)), { entity, name: entity.name });
    }
  }
  return index;
}

function findActiveEntityMatch(
  index: Map<string, { entity: ContextEntityRow; name: string }>,
  typeSlug: string,
  name: string,
  projectNames: Set<string>,
): { entity: ContextEntityRow; name: string } | null {
  return index.get(activeEntityIndexKey(typeSlug, normalizedCandidateText(name)))
    || index.get(activeEntityIndexKey(typeSlug, canonicalEntityName(name, projectNames)))
    || null;
}

function findActiveEntityForUpdate(
  draft: ContextMapCandidateDraft,
  activeEntities: ContextEntityRow[],
  db: ContextMapDatabase,
  projectNames: Set<string>,
): ContextEntityRow | null {
  const payload = draft.payload;
  const entityId = readPayloadString(payload, ['entityId', 'targetEntityId']);
  if (entityId) return activeEntities.find((entity) => entity.entityId === entityId) || null;

  const name = readPayloadString(payload, ['entityName', 'name', 'targetName']);
  if (!name) return null;
  const typeSlug = normalizeSlug(readPayloadString(payload, ['typeSlug', 'entityType', 'targetTypeSlug', 'targetType']));
  const normalizedName = normalizedCandidateText(name);
  const canonicalName = canonicalEntityName(name, projectNames);
  for (const entity of activeEntities) {
    if (typeSlug && entity.typeSlug !== typeSlug) continue;
    const entityNames = [entity.name, ...db.listAliases(entity.entityId).map((alias) => alias.alias)];
    if (entityNames.some((candidateName) => (
      normalizedCandidateText(candidateName) === normalizedName
      || canonicalEntityName(candidateName, projectNames) === canonicalName
    ))) {
      return entity;
    }
  }
  return null;
}

function activeEntityIndexKey(typeSlug: string, name: string): string {
  return `${typeSlug}:${name}`;
}

function convertNewEntityToUpdateDraft(
  draft: ContextMapCandidateDraft,
  activeEntity: ContextEntityRow,
  proposedName: string,
): ContextMapCandidateDraft {
  const payload = { ...draft.payload };
  delete payload.typeSlug;
  delete payload.entityType;
  delete payload.type;
  delete payload.name;
  delete payload.entityName;
  delete payload.title;
  const aliases = normalizeAliasArray(payload.aliases);
  if (normalizedCandidateText(proposedName) !== normalizedCandidateText(activeEntity.name)) aliases.push(proposedName);
  return {
    ...draft,
    candidateType: 'entity_update',
    payload: {
      ...payload,
      entityId: activeEntity.entityId,
      aliases: dedupeAliases(aliases),
    },
  };
}

function isNoopEntityUpdateDraft(
  draft: ContextMapCandidateDraft,
  activeEntity: ContextEntityRow,
  db: ContextMapDatabase,
): boolean {
  const payload = draft.payload;
  const newName = readPayloadString(payload, ['newName', 'updatedName']);
  if (newName && normalizedCandidateText(newName) !== normalizedCandidateText(activeEntity.name)) return false;
  const typeSlug = normalizeSlug(readPayloadString(payload, ['newTypeSlug', 'updatedTypeSlug']));
  if (typeSlug && typeSlug !== activeEntity.typeSlug) return false;
  const sensitivity = normalizeCandidateSensitivity(readPayloadString(payload, ['sensitivity']));
  if (sensitivity && sensitivity !== activeEntity.sensitivity) return false;
  const aliases = normalizeAliasArray(payload.aliases);
  const facts = normalizeCandidateFacts(payload);
  const summary = readPayloadString(payload, ['summaryMarkdown', 'summary']);
  const notes = readPayloadString(payload, ['notesMarkdown', 'notes']);
  const onlySummaryUpdate = Boolean(
    summary
    && !newName
    && !typeSlug
    && !sensitivity
    && !notes
    && aliases.length === 0
    && facts.length === 0,
  );
  if (summary && normalizedCandidateText(summary) !== normalizedCandidateText(activeEntity.summaryMarkdown || '')) {
    if (activeEntity.summaryMarkdown && onlySummaryUpdate && isFileBackedCandidatePayload(payload)) return true;
    return false;
  }
  if (notes && normalizedCandidateText(notes) !== normalizedCandidateText(activeEntity.notesMarkdown || '')) return false;

  const knownAliases = new Set([
    normalizedCandidateText(activeEntity.name),
    ...db.listAliases(activeEntity.entityId).map((alias) => normalizedCandidateText(alias.alias)),
  ]);
  if (aliases.some((alias) => !knownAliases.has(normalizedCandidateText(alias)))) return false;

  const knownFacts = new Set(db.listFacts(activeEntity.entityId).map((fact) => normalizedCandidateText(fact.statementMarkdown)));
  if (facts.some((fact) => !knownFacts.has(normalizedCandidateText(fact)))) return false;

  return true;
}

function isFileBackedCandidatePayload(payload: Record<string, unknown>): boolean {
  const sourceSpan = isRecord(payload.sourceSpan) ? payload.sourceSpan : {};
  return readPayloadString(sourceSpan, ['sourceType']) === 'file';
}

function choosePreferredEntityDraft(
  current: ContextMapCandidateDraft,
  next: ContextMapCandidateDraft,
  projectNames: Set<string>,
): ContextMapCandidateDraft {
  const currentName = readPayloadString(current.payload, ['name', 'entityName', 'title']);
  const nextName = readPayloadString(next.payload, ['name', 'entityName', 'title']);
  const currentScore = entityNameQualityScore(currentName, projectNames) + current.confidence;
  const nextScore = entityNameQualityScore(nextName, projectNames) + next.confidence;
  return nextScore > currentScore ? next : current;
}

function entityNameQualityScore(name: string, projectNames: Set<string>): number {
  const normalized = normalizedCandidateText(name);
  let score = 0;
  if (normalized.startsWith('project ') || normalized.startsWith('workspace ')) score -= 5;
  if (normalized.endsWith(' documents') || normalized.endsWith(' docs') || normalized.endsWith(' files')) score -= 1;
  for (const projectName of projectNames) {
    const normalizedProject = normalizedCandidateText(projectName);
    if (normalizedProject && normalized !== normalizedProject && normalized.startsWith(`${normalizedProject} `)) {
      score -= 0.25;
    }
  }
  if (normalized.length > 0 && normalized.length <= 80) score += 1;
  return score;
}

function mergeEntityAliases(target: Record<string, unknown>, source: Record<string, unknown>): void {
  const aliases = [
    ...normalizeAliasArray(target.aliases),
    ...normalizeAliasArray(source.aliases),
  ];
  const sourceName = readPayloadString(source, ['name', 'entityName', 'title']);
  const targetName = readPayloadString(target, ['name', 'entityName', 'title']);
  if (sourceName && normalizedCandidateText(sourceName) !== normalizedCandidateText(targetName)) aliases.push(sourceName);
  const deduped = dedupeAliases(aliases);
  if (deduped.length > 0) target.aliases = deduped;
}

function dedupeAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const alias of aliases) {
    const key = normalizedCandidateText(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(alias);
  }
  return output;
}

function buildKnownEndpointNames(
  db: ContextMapDatabase,
  activeEntities: ContextEntityRow[],
  newEntityDrafts: ContextMapCandidateDraft[],
  projectNames: Set<string>,
  opts: { includePendingCandidates?: boolean } = {},
): KnownRelationshipEndpoints {
  const exact = new Map<string, KnownRelationshipEndpoint>();
  const canonical = new Map<string, KnownRelationshipEndpoint>();
  const remember = (name: string, target: KnownRelationshipEndpoint) => {
    if (!name || !target.name) return;
    exact.set(normalizedCandidateText(name), target);
    canonical.set(canonicalRelationshipName(name, projectNames), target);
  };

  for (const entity of activeEntities) {
    const target = { name: entity.name, typeSlug: entity.typeSlug, entity };
    remember(entity.name, target);
    for (const alias of db.listAliases(entity.entityId)) remember(alias.alias, target);
  }

  if (opts.includePendingCandidates !== false) {
    for (const candidate of db.listCandidates('pending')) {
      if (candidate.candidateType !== 'new_entity') continue;
      const payload = candidate.payload || {};
      const name = readPayloadString(payload, ['name', 'entityName', 'title']);
      const typeSlug = normalizeSlug(readPayloadString(payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
      const target = { name, typeSlug };
      remember(name, target);
      for (const alias of normalizeAliasArray(payload.aliases)) remember(alias, target);
    }
  }

  for (const draft of newEntityDrafts) {
    const name = readPayloadString(draft.payload, ['name', 'entityName', 'title']);
    const typeSlug = normalizeSlug(readPayloadString(draft.payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
    const target = { name, typeSlug, draft };
    remember(name, target);
    for (const alias of normalizeAliasArray(draft.payload.aliases)) remember(alias, target);
  }

  return { exact, canonical };
}

function resolveKnownEndpointTarget(
  name: string,
  knownNames: KnownRelationshipEndpoints,
  projectNames: Set<string>,
): KnownRelationshipEndpoint | null {
  if (!name) return null;
  return knownNames.exact.get(normalizedCandidateText(name))
    || knownNames.canonical.get(canonicalRelationshipName(name, projectNames))
    || null;
}

function isSameRelationshipEndpoint(
  subject: KnownRelationshipEndpoint,
  object: KnownRelationshipEndpoint,
  projectNames: Set<string>,
): boolean {
  if (subject.entity && object.entity && subject.entity.entityId === object.entity.entityId) return true;
  return normalizedCandidateText(subject.name) === normalizedCandidateText(object.name)
    || canonicalRelationshipName(subject.name, projectNames) === canonicalRelationshipName(object.name, projectNames);
}

function entityCanonicalKey(typeSlug: string, name: string, projectNames: Set<string>): string {
  return `${typeSlug}:${canonicalEntityName(name, projectNames)}`;
}

function assessRelationshipDraft(
  draft: ContextMapCandidateDraft,
  subject: KnownRelationshipEndpoint,
  object: KnownRelationshipEndpoint,
): { keep: boolean; reason?: string } {
  const predicate = normalizeRelationshipPredicate(readPayloadString(draft.payload, ['predicate', 'relationship', 'label']));
  if (!predicate || !isAllowedRelationshipPredicate(predicate)) return { keep: false, reason: 'unsupported predicate' };
  draft.payload.predicate = predicate;

  const compatibility = relationshipCompatibilityScore(predicate, subject.typeSlug, object.typeSlug);
  if (compatibility < 0) return { keep: false, reason: 'incompatible endpoint types' };
  if (predicate === 'relates_to' && !hasRelationshipEvidence(draft.payload)) {
    return { keep: false, reason: 'generic relationship without evidence' };
  }
  if (predicate === 'part_of' && object.typeSlug === 'project' && draft.confidence < 0.8) {
    return { keep: false, reason: 'low-confidence project containment relationship' };
  }

  const confidence = draft.confidence;
  let score = confidence >= 0.86 ? 2 : confidence >= 0.8 ? 1 : -1;
  score += compatibility;
  if (isCoreRelationshipPredicate(predicate)) score += 2;
  if (isInterpretiveRelationshipPredicate(predicate)) score -= 1;
  if (hasRelationshipEvidence(draft.payload)) score += 1;
  if (predicate === 'relates_to') score -= 2;

  return score >= 3
    ? { keep: true }
    : { keep: false, reason: `relationship score ${score}` };
}

function relationshipCompatibilityScore(predicate: string, subjectType: string, objectType: string): number {
  if (predicate === 'documents') return subjectType === 'document' ? 2 : -1;
  if (predicate === 'documented_by') return objectType === 'document' ? 2 : -1;
  if (predicate === 'specified_by') return objectType === 'document' ? 2 : -1;
  if (predicate === 'stores') return ['decision', 'feature', 'workflow', 'tool', 'project'].includes(subjectType) ? 1 : -1;
  if (predicate === 'stored_in') return ['document', 'project', 'tool', 'asset'].includes(objectType) ? 2 : -1;
  if (predicate === 'implements') return ['concept', 'workflow', 'tool', 'project'].includes(subjectType) ? 1 : -1;
  if (predicate === 'implemented_by') return ['concept', 'workflow', 'tool', 'project'].includes(objectType) ? 2 : -1;
  if (predicate === 'requires' || predicate === 'depends_on') return subjectType !== 'document' ? 1 : -1;
  if (predicate === 'part_of') return subjectType !== objectType || objectType === 'project' ? 1 : -1;
  if (predicate === 'uses') return subjectType !== 'document' && objectType !== 'person' ? 1 : -1;
  if (predicate === 'supports') {
    return ['feature', 'workflow', 'tool', 'project'].includes(subjectType)
      && ['feature', 'workflow', 'project', 'concept', 'decision', 'tool'].includes(objectType)
      ? 1
      : -1;
  }
  if (predicate === 'governs') return ['decision', 'workflow', 'document'].includes(subjectType) ? 2 : -1;
  if (predicate === 'driven_by') {
    return ['feature', 'workflow', 'project'].includes(subjectType)
      && ['decision', 'workflow', 'tool', 'document'].includes(objectType)
      ? 2
      : -1;
  }
  if (predicate === 'references') return 0;
  if (predicate === 'relates_to') return 0;
  if (predicate === 'managed_by' || predicate === 'owns') return ['person', 'organization'].includes(objectType) ? 2 : -1;
  if (predicate === 'runs_via') return objectType === 'tool' ? 2 : -1;
  if (predicate === 'configures') return subjectType !== 'document' ? 1 : -1;
  if (predicate === 'captures') return subjectType === 'document' || subjectType === 'decision' ? 1 : -1;
  if (predicate === 'contains') return subjectType === 'project' || subjectType === 'document' ? 1 : -1;
  if (predicate === 'blocks' || predicate === 'replaces' || predicate === 'supersedes') return subjectType === objectType ? 1 : -1;
  if (predicate === 'produces') return subjectType !== 'document' ? 1 : -1;
  if (predicate === 'enables') return subjectType !== 'document' ? 1 : -1;
  return -1;
}

function isCoreRelationshipPredicate(predicate: string): boolean {
  return new Set([
    'depends_on',
    'documents',
    'documented_by',
    'governs',
    'implements',
    'implemented_by',
    'part_of',
    'requires',
    'specified_by',
    'stores',
    'stored_in',
    'supports',
    'uses',
  ]).has(predicate);
}

function isInterpretiveRelationshipPredicate(predicate: string): boolean {
  return new Set(['driven_by', 'enables', 'references', 'relates_to']).has(predicate);
}

function convertRejectedRelationshipToFact(
  draft: ContextMapCandidateDraft,
  subject: KnownRelationshipEndpoint,
  object: KnownRelationshipEndpoint,
  reason: string | undefined,
): void {
  if (!subject.draft || subject.draft.candidateType !== 'new_entity') return;
  const fact = relationshipFactFromDraft(draft, subject.name, object.name, reason);
  if (!fact) return;
  const facts = normalizeCandidateFacts(subject.draft.payload);
  facts.push(fact);
  subject.draft.payload.facts = dedupeFacts(facts);
}

function relationshipFactFromDraft(
  draft: ContextMapCandidateDraft,
  subjectName: string,
  objectName: string,
  reason: string | undefined,
): string {
  const evidence = readPayloadString(draft.payload, ['evidenceMarkdown', 'rationale', 'reason', 'summaryMarkdown']);
  if (!evidence) return '';
  const predicate = normalizeRelationshipPredicate(readPayloadString(draft.payload, ['predicate', 'relationship', 'label']));
  const prefix = predicate ? `${subjectName} ${predicate.replace(/_/g, ' ')} ${objectName}` : `${subjectName} relates to ${objectName}`;
  const suffix = reason ? ` (${reason})` : '';
  return `${prefix}: ${evidence}${suffix}`;
}

function draftCandidateId(draft: ContextMapCandidateDraft): string {
  if (draft.idSource.kind === 'span') {
    return stableId('cm-cand', [
      draft.idSource.runId,
      draft.idSource.spanId,
      String(draft.idSource.index),
      draft.candidateType,
      stableStringify(draft.payload),
    ]);
  }
  return stableId('cm-cand', [
    draft.idSource.sourceType,
    draft.idSource.sourceId,
    draft.idSource.sourceHash,
    draft.candidateType,
    stableStringify(candidatePayloadIdentity(draft.payload)),
  ]);
}

function collectProposedEntityTypeSlugs(candidates: unknown[]): Set<string> {
  const slugs = new Set<string>();
  for (const value of candidates) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.type !== 'new_entity_type') continue;
    const payload = record.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const typeSlug = normalizeSlug(readPayloadString(payload as Record<string, unknown>, ['typeSlug', 'slug', 'type']));
    const aliased = CONTEXT_MAP_TYPE_ALIASES.get(typeSlug) || typeSlug;
    if (typeSlug && !CONTEXT_MAP_BUILT_IN_ENTITY_TYPES.has(aliased)) slugs.add(typeSlug);
  }
  return slugs;
}

function normalizeCandidate(value: unknown, proposedEntityTypes: Set<string>): PendingContextMapCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidateType = record.type;
  if (typeof candidateType !== 'string' || !CONTEXT_MAP_CANDIDATE_TYPES.has(candidateType as ContextCandidateType)) {
    return null;
  }
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : 1;
  return {
    candidateType: candidateType as ContextCandidateType,
    confidence,
    payload: normalizeCandidatePayload(candidateType as ContextCandidateType, payload as Record<string, unknown>, proposedEntityTypes),
  };
}

function shouldKeepCandidate(
  candidate: PendingContextMapCandidate,
  context: { sourcePacket?: ContextMapSourcePacket; workspacePath?: string },
): boolean {
  const payload = candidate.payload;
  if (candidate.candidateType === 'new_entity') {
    const name = readPayloadString(payload, ['name', 'entityName', 'title']);
    const typeSlug = readPayloadString(payload, ['typeSlug', 'entityType', 'type']);
    if (!name) return false;
    if (isWorkspaceRootName(name, context.workspacePath)) return false;
    if ((typeSlug === 'document' || typeSlug === 'asset') && looksLikeLocalFileReference(name)) return false;
    if ((typeSlug === 'document' || typeSlug === 'asset') && context.sourcePacket && isSourceFileName(name, context.sourcePacket)) return false;
  }
  if (candidate.candidateType === 'new_relationship') {
    const subjectName = readPayloadString(payload, ['subjectName', 'subjectEntityName']);
    const objectName = readPayloadString(payload, ['objectName', 'objectEntityName']);
    const predicate = readPayloadString(payload, ['predicate', 'relationship', 'label']);
    if (!subjectName || !objectName || !predicate) return false;
    if (!isAllowedRelationshipPredicate(predicate)) return false;
    if (isSelfRelationshipPayload(payload)) return false;
    if (looksLikeLocalFileReference(subjectName) || looksLikeLocalFileReference(objectName)) return false;
  }
  if (candidate.candidateType === 'new_entity_type') {
    const typeSlug = normalizeSlug(readPayloadString(payload, ['typeSlug', 'slug', 'type']));
    const aliased = CONTEXT_MAP_TYPE_ALIASES.get(typeSlug) || typeSlug;
    if (!typeSlug || CONTEXT_MAP_BUILT_IN_ENTITY_TYPES.has(aliased)) return false;
  }
  if (candidate.candidateType === 'evidence_link') {
    const targetKind = readPayloadString(payload, ['targetKind', 'kind']);
    const targetId = readPayloadString(payload, ['targetId', 'entityId', 'factId', 'relationshipId', 'candidateId']);
    if (!targetKind || !targetId) return false;
  }
  if (candidate.candidateType === 'sensitivity_classification') {
    const entityName = readPayloadString(payload, ['entityName', 'name', 'targetName']);
    const entityId = readPayloadString(payload, ['entityId', 'targetEntityId']);
    const sensitivity = normalizeCandidateSensitivity(readPayloadString(payload, ['sensitivity', 'classification']));
    if ((!entityName && !entityId) || !sensitivity) return false;
  }
  if (candidate.candidateType === 'alias_addition') {
    const alias = readPayloadString(payload, ['alias', 'name']);
    if (looksLikeLocalFileReference(alias)) return false;
  }
  return true;
}

function normalizeCandidatePayload(
  candidateType: ContextCandidateType,
  payload: Record<string, unknown>,
  proposedEntityTypes: Set<string>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...payload };
  normalizePayloadStringArray(normalized, 'aliases', normalizeAliasArray);
  normalizePayloadFacts(normalized);
  if (candidateType === 'new_entity') {
    const typeSlug = normalizeEntityTypeSlug(readPayloadString(payload, ['typeSlug', 'entityType', 'type']), proposedEntityTypes);
    normalized.typeSlug = typeSlug || 'concept';
  }
  if (candidateType === 'entity_update') {
    normalizeTypeKey(normalized, payload, 'newTypeSlug', proposedEntityTypes);
    normalizeTypeKey(normalized, payload, 'updatedTypeSlug', proposedEntityTypes);
  }
  if (candidateType === 'new_relationship' || candidateType === 'relationship_update' || candidateType === 'relationship_removal') {
    normalizeRelationshipPayload(normalized, payload);
  }
  if (candidateType === 'sensitivity_classification') {
    const sensitivity = normalizeCandidateSensitivity(readPayloadString(payload, ['sensitivity', 'classification']));
    if (sensitivity) normalized.sensitivity = sensitivity;
  }
  if (candidateType === 'new_entity_type') {
    const typeSlug = normalizeSlug(readPayloadString(payload, ['typeSlug', 'slug', 'type']));
    if (typeSlug) normalized.typeSlug = typeSlug;
  }
  return normalized;
}

function normalizePayloadFacts(payload: Record<string, unknown>): void {
  const facts = normalizeCandidateFacts(payload);
  for (const key of CONTEXT_MAP_FACT_PAYLOAD_KEYS) delete payload[key];
  if (facts.length > 0) payload.facts = facts;
}

function normalizePayloadStringArray(
  payload: Record<string, unknown>,
  key: string,
  normalize: (value: unknown) => string[],
): void {
  if (!Object.prototype.hasOwnProperty.call(payload, key)) return;
  const values = normalize(payload[key]);
  if (values.length > 0) payload[key] = values;
  else delete payload[key];
}

function candidateSemanticKey(candidateType: ContextCandidateType, payload: Record<string, unknown>): string {
  if (candidateType === 'new_entity') {
    const name = normalizedCandidateText(readPayloadString(payload, ['name', 'entityName', 'title']));
    const typeSlug = normalizeSlug(readPayloadString(payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
    return name ? `${candidateType}:${typeSlug}:${name}` : '';
  }
  if (candidateType === 'new_relationship') {
    const subjectName = normalizedCandidateText(readPayloadString(payload, ['subjectName', 'subjectEntityName']));
    const predicate = normalizedCandidateText(readPayloadString(payload, ['predicate', 'relationship', 'label']));
    const objectName = normalizedCandidateText(readPayloadString(payload, ['objectName', 'objectEntityName']));
    return subjectName && predicate && objectName
      ? `${candidateType}:${subjectName}:${predicate}:${objectName}`
      : '';
  }
  if (candidateType === 'new_entity_type') {
    const typeSlug = normalizeSlug(readPayloadString(payload, ['typeSlug', 'slug', 'type']));
    return typeSlug ? `${candidateType}:${typeSlug}` : '';
  }
  if (candidateType === 'alias_addition') {
    const entity = normalizedCandidateText(readPayloadString(payload, ['entityId', 'entityName', 'name', 'targetName']));
    const alias = normalizedCandidateText(readPayloadString(payload, ['alias']));
    return entity && alias ? `${candidateType}:${entity}:${alias}` : '';
  }
  if (candidateType === 'sensitivity_classification') {
    const entity = normalizedCandidateText(readPayloadString(payload, ['entityId', 'entityName', 'name', 'targetName']));
    const sensitivity = normalizeCandidateSensitivity(readPayloadString(payload, ['sensitivity', 'classification']));
    return entity && sensitivity ? `${candidateType}:${entity}:${sensitivity}` : '';
  }
  const withoutSourceSpan = { ...payload };
  delete withoutSourceSpan.sourceSpan;
  return `${candidateType}:${stableStringify(withoutSourceSpan)}`;
}

function candidatePayloadIdentity(payload: Record<string, unknown>): Record<string, unknown> {
  return canonicalizeCandidateIdentityValue(payload) as Record<string, unknown>;
}

function canonicalizeCandidateIdentityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeCandidateIdentityValue(item));
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'runId') continue;
    output[key] = canonicalizeCandidateIdentityValue(item);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeTypeKey(
  normalized: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: string,
  proposedEntityTypes: Set<string>,
): void {
  const typeSlug = normalizeEntityTypeSlug(readPayloadString(payload, [key]), proposedEntityTypes);
  if (typeSlug) normalized[key] = typeSlug;
}

function normalizeRelationshipPayload(
  normalized: Record<string, unknown>,
  payload: Record<string, unknown>,
): void {
  if (!readPayloadString(payload, ['subjectName', 'subjectEntityName'])) {
    const subjectName = readPayloadString(payload, ['sourceName', 'fromName']);
    if (subjectName) normalized.subjectName = subjectName;
  }
  if (!readPayloadString(payload, ['objectName', 'objectEntityName'])) {
    const objectName = readPayloadString(payload, ['targetName', 'toName']);
    if (objectName) normalized.objectName = objectName;
  }
  if (!readPayloadString(payload, ['predicate', 'relationship', 'label'])) {
    const predicate = readPayloadString(payload, ['relationshipType']);
    if (predicate) normalized.predicate = predicate;
  }
  const predicate = readPayloadString(normalized, ['predicate', 'relationship', 'label']);
  if (predicate) normalized.predicate = normalizeRelationshipPredicate(predicate);
}

function normalizeEntityTypeSlug(value: string, proposedEntityTypes: Set<string>): string {
  const slug = normalizeSlug(value);
  if (!slug) return '';
  const aliased = CONTEXT_MAP_TYPE_ALIASES.get(slug) || slug;
  if (proposedEntityTypes.has(aliased)) return aliased;
  return CONTEXT_MAP_BUILT_IN_ENTITY_TYPES.has(aliased) ? aliased : 'concept';
}

function correctPayloadSensitivityFromSource(
  candidateType: ContextCandidateType,
  payload: Record<string, unknown>,
): void {
  if (candidateType !== 'new_entity' && candidateType !== 'entity_update' && candidateType !== 'sensitivity_classification') return;
  const current = normalizeCandidateSensitivity(readPayloadString(payload, ['sensitivity', 'classification']));
  if (current === 'secret-pointer') {
    payload.sensitivity = current;
    return;
  }
  const sourceSensitivity = sensitivityFromSourceSpan(payload);
  if (!sourceSensitivity) {
    if (current) payload.sensitivity = current;
    return;
  }
  payload.sensitivity = sourceSensitivity;
}

function sensitivityFromSourceSpan(payload: Record<string, unknown>): 'work-sensitive' | 'personal-sensitive' | '' {
  const sourceSpan = isRecord(payload.sourceSpan) ? payload.sourceSpan : {};
  const locator = isRecord(sourceSpan.locator) ? sourceSpan.locator : {};
  const text = [
    readPayloadString(sourceSpan, ['sourceId', 'path', 'title', 'filename']),
    readPayloadString(locator, ['path', 'workspacePath']),
  ].join(' ').toLowerCase();
  if (!text.trim()) return '';
  if (/\b(aws|work|career|customer|partner|battlecard|enablement|speaking|coaching|consulting)\b/.test(text)) {
    return 'work-sensitive';
  }
  if (/(^|[/_-])(family|health|wellness|investing|investment|immigration|finance|financial|medical)([/_.-]|$)/.test(text)) {
    return 'personal-sensitive';
  }
  return '';
}

function isSourceFileName(name: string, packet: ContextMapSourcePacket): boolean {
  if (!name || packet.sourceType !== 'file') return false;
  const normalizedName = normalizeFileishName(name);
  const sourceId = normalizeFileishName(packet.sourceId);
  const title = normalizeFileishName(packet.title);
  return normalizedName === sourceId || normalizedName === title;
}

function isWorkspaceRootName(name: string, workspacePath: string | undefined): boolean {
  if (!name || !workspacePath) return false;
  return normalizeEntityName(name) === normalizeEntityName(path.basename(workspacePath));
}

function looksLikeLocalFileReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return true;
  return /\.[A-Za-z0-9]{1,12}(?:[#?].*)?$/.test(trimmed);
}

function normalizeFileishName(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}

function normalizeEntityName(value: string): string {
  return value.trim().toLowerCase();
}

function escapeAttr(value: string): string {
  return value.replace(/[&"]/g, (ch) => (ch === '&' ? '&amp;' : '&quot;'));
}

function hashMessage(message: Message): string {
  return sha256(stableStringify({
    id: message.id,
    role: message.role,
    content: message.content || '',
    contentBlocks: message.contentBlocks || null,
    timestamp: message.timestamp || '',
    turn: message.turn || null,
  }));
}

function hashMessages(messages: Message[]): string {
  return sha256(stableStringify(messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content || '',
    contentBlocks: message.contentBlocks || null,
    timestamp: message.timestamp || '',
    turn: message.turn || null,
  }))));
}

function normalizedScanIntervalMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(1440, Math.round(value)))
    : DEFAULT_CONTEXT_MAP_SCAN_INTERVAL_MINUTES;
}

function normalizedConcurrency(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(10, Math.round(value)))
    : DEFAULT_CONTEXT_MAP_CLI_CONCURRENCY;
}

function normalizedProcessorConcurrency(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_CONTEXT_MAP_PROCESSOR_CONCURRENCY, Math.round(value)))
    : fallback;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  }));
}

function emptyResult(
  workspaceHash: string,
  source: ContextRunSource | null,
  skippedReason: ContextMapWorkspaceProcessResult['skippedReason'],
): ContextMapWorkspaceProcessResult {
  return {
    workspaceHash,
    source,
    runId: null,
    conversationsScanned: 0,
    spansInserted: 0,
    cursorsUpdated: 0,
    messagesProcessed: 0,
    candidatesCreated: 0,
    skippedReason,
  };
}

function stableId(prefix: string, parts: string[]): string {
  return `${prefix}-${sha256(parts.join('\0')).slice(0, 32)}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}
