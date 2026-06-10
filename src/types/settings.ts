// ── Settings Types ───────────────────────────────────────────────────

import type { EffortLevel, ServiceTier, CliProfile } from './cliProfiles';
import type { MemoryProcessorStatusSnapshot } from './memory';
import type { WorkspaceContextGlobalSettings } from './workspaceContext';

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  sendBehavior: 'enter' | 'ctrlEnter';
  systemPrompt: string;
  defaultBackend?: string;
  /** Runtime CLI profiles available for conversations and background CLI tasks. */
  cliProfiles?: CliProfile[];
  /** Default profile for new conversations once the UI switches from raw backend selection to profile selection. */
  defaultCliProfileId?: string;
  defaultModel?: string;
  /** Default adaptive reasoning effort. Only applies when defaultBackend/model supports it. */
  defaultEffort?: EffortLevel;
  /** Default backend service tier override. Currently only Codex uses `fast`. */
  defaultServiceTier?: ServiceTier;
  workingDirectory?: string;
  /**
   * Globally-configured Memory CLI used for:
   *   (a) backing the `memory_note` MCP tool — processes incoming notes,
   *       classifies/dedupes, and formats them with frontmatter.
   *   (b) post-session extraction — reads non-Claude session transcripts and
   *       writes new memory entries.
   * The CLI selected here should be a CLI profile. `cliBackend` is retained
   * as a legacy fallback for settings written before CLI profiles existed.
   */
  memory?: {
    cliProfileId?: string;
    /** @deprecated Use cliProfileId. */
    cliBackend?: string;
    cliModel?: string;
    cliEffort?: EffortLevel;
    lastProcessorStatus?: MemoryProcessorStatusSnapshot;
  };
  /**
   * Globally-configured Knowledge Base CLIs. Three separate roles:
   *   - Ingestion: optional vision-capable CLI that converts visual
   *     content (PDF pages with figures/tables, DOCX images, PPTX slides
   *     with charts, standalone uploaded images) into clean Markdown at
   *     ingest time. When unset, those code paths fall back to image-only
   *     references (current behavior).
   *   - Digestion: runs once per raw file to produce structured entries.
   *   - Dreaming: manually invoked to synthesize entries into a coherent
   *     knowledge graph. Incremental by default, full rebuild on demand.
   * All three should point at CLI profiles. Legacy `*CliBackend` fields are
   * retained as fallbacks for older settings files. `convertSlidesToImages` opts into
   * the LibreOffice-backed PPTX slide rasterization path (global, not
   * per-workspace).
   */
  knowledgeBase?: {
    ingestionCliProfileId?: string;
    /** @deprecated Use ingestionCliProfileId. */
    ingestionCliBackend?: string;
    ingestionCliModel?: string;
    ingestionCliEffort?: EffortLevel;
    digestionCliProfileId?: string;
    /** @deprecated Use digestionCliProfileId. */
    digestionCliBackend?: string;
    digestionCliModel?: string;
    digestionCliEffort?: EffortLevel;
    dreamingCliProfileId?: string;
    /** @deprecated Use dreamingCliProfileId. */
    dreamingCliBackend?: string;
    dreamingCliModel?: string;
    dreamingCliEffort?: EffortLevel;
    /**
     * Max documents processed in parallel by ingestion, digestion, and
     * dreaming pipelines per workspace. Within a single document, work
     * stays sequential. Default 2.
     */
    cliConcurrency?: number;
    /**
     * @deprecated Renamed to `cliConcurrency`. Read-time migration in
     * `settingsService.getSettings()` copies this value forward when the
     * new key is missing. Kept on the type for one release cycle so old
     * `settings.json` files continue to load without warnings.
     */
    dreamingConcurrency?: number;
    /** Cosine similarity score above which an entry→topic match skips LLM verification. Default 0.75. */
    dreamingStrongMatchThreshold?: number;
    /** Cosine similarity score below which an entry is routed to new-topic creation. Default 0.45. */
    dreamingBorderlineThreshold?: number;
    /** Optional second extraction pass after each digestion chunk. Default false. */
    kbGleaningEnabled?: boolean;
    /**
     * When true, PPTX ingestion shells out to LibreOffice to render each
     * slide as a PNG (better fidelity for decks that rely on visual
     * layout). When false, only extracted text, speaker notes, and
     * embedded media are captured. Requires a detectable LibreOffice install
     * (`soffice` on PATH or a standard platform install location); if missing,
     * a warning is logged and the pipeline falls back to text-only.
     */
    convertSlidesToImages?: boolean;
    /**
     * Per-workspace auto-digest toggle. When true, ingested files are
     * automatically digested once conversion completes. When false, the
     * user must click "Digest All Pending" or per-row Digest. Default
     * false. Stored in workspace settings (this field is per-workspace
     * despite living on the global Settings shape — see WorkspaceIndex).
     * NOTE: toggling from false → true does NOT retroactively digest
     * existing ingested files.
     */
    autoDigest?: boolean;
  };
  /**
   * Globally-configured Workspace Context processor defaults. Workspaces opt in
   * independently through WorkspaceIndex.workspaceContextEnabled and may either
   * use these defaults or provide a workspace-level override.
   */
  workspaceContext?: WorkspaceContextGlobalSettings;
  /**
   * Globally-configured external integrations. Routine/workspace settings
   * choose destinations, while shared credentials live here.
   */
  integrations?: {
    telegram?: {
      /** Secret bot token. Persisted server-side and redacted from browser responses. */
      botToken?: string;
      /** Browser response hint derived from the persisted token. */
      configured?: boolean;
      /** Client-only save flag used to clear the persisted token. */
      clearBotToken?: boolean;
      botUsername?: string;
      botId?: string;
      botFirstName?: string;
      updatedAt?: string;
    };
  };
}
