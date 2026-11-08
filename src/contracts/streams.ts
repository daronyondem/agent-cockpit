import { parseServiceTierInput, type ContractServiceTier, type ServiceTierInput } from './serviceTier';
import { parseClaudeCodeModeInput, type ClaudeCodeModeInput, type ContractClaudeCodeMode } from './claudeCodeMode';
import { asRecord, contractError, optionalArray, optionalBoolean, optionalString, optionalStringEnum, requiredNonEmptyString } from './validation';
import type { Message, StreamJobRuntimeInfo } from './responses';
import { CONTRACT_EFFORT_LEVELS, type ContractEffortLevel } from './conversations';

export interface ChatAttachmentReference {
  /** Server-assigned filename from this conversation's upload response. */
  name: string;
}

export interface SendMessageRequest {
  content: string;
  attachments?: ChatAttachmentReference[];
  backend?: string;
  model?: string;
  effort?: ContractEffortLevel;
  claudeCodeMode?: ClaudeCodeModeInput;
  cliProfileId?: string;
  serviceTier?: ServiceTierInput;
}

export interface ValidatedSendMessageRequest extends Omit<SendMessageRequest, 'claudeCodeMode' | 'serviceTier'> {
  claudeCodeMode?: ContractClaudeCodeMode | null;
  serviceTier?: ContractServiceTier | null;
}

export interface ConversationInputRequest {
  text: string;
  streamActive?: boolean;
  /** Opaque interaction generation, required by Cortex question/plan replies. */
  decisionId?: string;
}

export interface SendMessageResponse {
  userMessage: Message;
  streamReady: boolean;
}

export interface ConversationInputResponse {
  mode: 'stdin' | 'message';
}

export interface ActiveStreamResponse {
  id: string;
  jobId?: string | null;
  state?: string;
  backend: string;
  startedAt: string | null;
  lastEventAt: string | null;
  connected: boolean;
  runtimeAttached: boolean;
  pending: boolean;
  runtime: StreamJobRuntimeInfo | null;
}

export interface ActiveStreamsResponse {
  ids: string[];
  streams: ActiveStreamResponse[];
}

export function validateSendMessageRequest(body: unknown): ValidatedSendMessageRequest {
  const record = asRecord(body);
  return {
    content: requiredNonEmptyString(record, 'content', 'Message content required'),
    attachments: optionalArray(record, 'attachments', item => {
      const name = requiredNonEmptyString(asRecord(item), 'name', 'Attachment filename required');
      if (name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name)) contractError('Invalid attachment filename');
      return { name };
    }),
    backend: optionalString(record, 'backend'),
    model: optionalString(record, 'model'),
    effort: optionalStringEnum(record, 'effort', CONTRACT_EFFORT_LEVELS),
    claudeCodeMode: parseClaudeCodeModeInput(record.claudeCodeMode),
    cliProfileId: optionalString(record, 'cliProfileId'),
    serviceTier: parseServiceTierInput(record.serviceTier),
  };
}

export function validateConversationInputRequest(body: unknown): ConversationInputRequest {
  const record = asRecord(body);
  return {
    text: requiredNonEmptyString(record, 'text', 'Input text required'),
    streamActive: optionalBoolean(record, 'streamActive'),
    decisionId: optionalString(record, 'decisionId'),
  };
}
