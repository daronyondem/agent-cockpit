export interface FileDeliveryExtraction {
  cleaned: string;
  files: string[];
}

export interface UploadedFilesExtraction {
  cleaned: string;
  paths: string[];
}

interface StreamErrorMessageLike {
  id?: string;
  role?: string;
  content?: string;
  streamError?: {
    message?: string;
    source?: string;
  };
}

const FILE_DELIVERY_RE = /<!--\s*FILE_DELIVERY:(.*?)\s*-->/g;
const UPLOADED_FILES_RE = /\n*\[Uploaded files?: ([^\]]+)\]\s*$/;

export function extractFileDeliveries(text: unknown): FileDeliveryExtraction {
  if (typeof text !== 'string' || !text) return { cleaned: typeof text === 'string' ? text : '', files: [] };
  const files: string[] = [];
  const cleaned = text.replace(FILE_DELIVERY_RE, (_match, p) => {
    const trimmed = (p || '').trim();
    if (trimmed) files.push(trimmed);
    return '';
  });
  return { cleaned, files };
}

export function extractUploadedFiles(text: unknown): UploadedFilesExtraction {
  if (typeof text !== 'string' || !text) return { cleaned: typeof text === 'string' ? text : '', paths: [] };
  const match = text.match(UPLOADED_FILES_RE);
  if (!match) return { cleaned: text, paths: [] };
  const paths = match[1].split(',').map(s => s.trim()).filter(Boolean);
  const cleaned = text.slice(0, match.index).replace(/\s+$/, '');
  return { cleaned, paths };
}

export function streamErrorMessageText(message: StreamErrorMessageLike | null | undefined): string | null {
  if (!message || !message.streamError) return null;
  const err = message.streamError;
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return typeof message.content === 'string' && message.content ? message.content : 'Stream error';
}

export function streamErrorMessageSource(message: StreamErrorMessageLike | null | undefined): string | null {
  if (!message || !message.streamError) return null;
  const err = message.streamError;
  return err && typeof err.source === 'string' ? err.source : null;
}

export function hiddenStreamErrorMessageIds(
  messages: StreamErrorMessageLike[],
  activeError: string | null | undefined,
  activeSource: string | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(messages)) return ids;
  for (const msg of messages) {
    if (msg && msg.id && msg.role === 'assistant' && msg.streamError && streamErrorMessageSource(msg) === 'abort') {
      ids.add(msg.id);
    }
  }
  if (!activeError) return ids;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'assistant' && msg.streamError) {
      const source = streamErrorMessageSource(msg);
      const sourceMatches = !activeSource || !source || source === activeSource;
      if (streamErrorMessageText(msg) === activeError && sourceMatches && msg.id) ids.add(msg.id);
      return ids;
    }
    if (msg.role === 'assistant' || msg.role === 'user') return ids;
  }
  return ids;
}
