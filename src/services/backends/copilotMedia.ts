import path from 'path';
import type { MessageOptions } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { ModelOption } from '../../types';
import { parseUploadedFilesTag } from '../chat/messageQueueStore';

/** Keep the existing upload wire format, but give the SDK actual attachments. */
export function copilotMessageInput(message: string, models: ModelOption[], selected: string | null | undefined, env: NodeJS.ProcessEnv, transport: 'sdk' | 'jsonl' = 'sdk'): {
  prompt: string; attachments?: Extract<NonNullable<MessageOptions['attachments']>[number], { type: 'file' }>[];
} {
  const parsed = parseUploadedFilesTag(message);
  if (!parsed) return { prompt: message };
  const requested = selected?.trim();
  const id = requested && requested !== 'auto' ? requested : env.COPILOT_MODEL?.trim() || 'auto';
  const model = models.find(candidate => candidate.id === id);
  // SDK PDF evidence is independent of the older CLI attachment transport.
  const verifiedPdfTransport = transport === 'jsonl' || (env.COPILOT_PROVIDER_BASE_URL && env.COPILOT_PROVIDER_TYPE === 'anthropic' && id === 'claude-sonnet-4.6');
  for (const attachment of parsed.attachments) {
    const kind = attachment.kind;
    if ((kind === 'image' || kind === 'pdf') && (model?.capabilities?.input?.[kind] !== true || (kind === 'pdf' && !verifiedPdfTransport))) {
      throw new Error(`Copilot model "${id}" does not have verified ${kind} input for this provider. Choose a supported model or remove the attachment.`);
    }
  }
  return { prompt: parsed.content, attachments: [...new Set(parsed.attachments.map(file => file.path))]
    .map(file => ({ type: 'file', path: file, displayName: path.basename(file) })) };
}
