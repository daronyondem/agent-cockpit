import { parseServiceTierInput, type ContractServiceTier, type ServiceTierInput } from './serviceTier';
import { asRecord, optionalBoolean, optionalString, optionalStringEnum, requiredNonEmptyString } from './validation';
import type { Message, StreamJobRuntimeInfo } from './responses';
import { CONTRACT_EFFORT_LEVELS, type ContractEffortLevel } from './conversations';

export interface SendMessageRequest {
  content: string;
  backend?: string;
  model?: string;
  effort?: ContractEffortLevel;
  cliProfileId?: string;
  serviceTier?: ServiceTierInput;
}

export interface ValidatedSendMessageRequest extends Omit<SendMessageRequest, 'serviceTier'> {
  serviceTier?: ContractServiceTier | null;
}

export interface ConversationInputRequest {
  text: string;
  streamActive?: boolean;
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
    backend: optionalString(record, 'backend'),
    model: optionalString(record, 'model'),
    effort: optionalStringEnum(record, 'effort', CONTRACT_EFFORT_LEVELS),
    cliProfileId: optionalString(record, 'cliProfileId'),
    serviceTier: parseServiceTierInput(record.serviceTier),
  };
}

export function validateConversationInputRequest(body: unknown): ConversationInputRequest {
  const record = asRecord(body);
  return {
    text: requiredNonEmptyString(record, 'text', 'Input text required'),
    streamActive: optionalBoolean(record, 'streamActive'),
  };
}
