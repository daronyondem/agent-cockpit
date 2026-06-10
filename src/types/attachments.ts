// ── Attachment Types ─────────────────────────────────────────────────

/**
 * Broad type grouping for an attachment, used by the composer to pick an icon
 * tile + color. Derived server-side from file extension at upload time so the
 * client can render type-aware chips without any client-side guessing.
 */
export type AttachmentKind = 'image' | 'pdf' | 'text' | 'code' | 'md' | 'folder' | 'file';

/**
 * Structured metadata for a single attachment on a user message. Produced by
 * `POST /conversations/:id/upload` (enriched response) and carried verbatim on
 * queued messages so the client can render typed chips without re-inferring.
 * `path` is the absolute server path that is appended to the message content
 * as `[Uploaded files: <path>]` when the message ships to the backend — the
 * CLI reads the files from disk using those paths.
 */
export interface AttachmentMeta {
  /** Basename of the file (e.g. "network-timeline.png"). */
  name: string;
  /** Absolute server path inside the conversation's artifacts dir. */
  path: string;
  /** Raw byte size, when known. */
  size?: number;
  /** Broad kind grouping for the composer chip. */
  kind: AttachmentKind;
  /** Human-readable secondary line for the chip (e.g. "1.8 MB", "service/kb"). */
  meta?: string;
}

/**
 * Structured metadata for a generated assistant artifact persisted inside a
 * conversation's artifact directory. Backends emit artifact source events
 * when they produce files/images outside the normal text stream; processStream
 * copies those bytes here and persists this descriptor on the assistant
 * message so every client can render the file without harness-specific logic.
 */
export interface ConversationArtifact {
  /** Stored basename inside data/chat/artifacts/{conversationId}/. */
  filename: string;
  /** Absolute server path inside the conversation's artifacts dir. */
  path: string;
  /** Broad kind grouping for renderers. */
  kind: AttachmentKind;
  /** Raw byte size after persistence, when known. */
  size?: number;
  /** MIME type, either backend-provided or inferred from the filename. */
  mimeType?: string;
  /** Optional human-readable label from the backend/tool. */
  title?: string;
  /** Backend tool/item id that produced the artifact, when known. */
  sourceToolId?: string | null;
}

/**
 * One entry in a conversation's message queue. `content` is the plain user
 * text (without the `[Uploaded files: …]` tag); `attachments` carry the typed
 * metadata the composer needs to render chips. On drain, the client rebuilds
 * the wire format by appending `[Uploaded files: <paths>]` back onto content.
 *
 * Legacy queues stored as `string[]` are auto-migrated to this shape on read
 * (see `_normalizeQueue` / `_parseUploadedFilesTag` in chatService).
 */
export interface QueuedMessage {
  content: string;
  attachments?: AttachmentMeta[];
}
