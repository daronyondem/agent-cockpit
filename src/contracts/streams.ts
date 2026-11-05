import { parseServiceTierInput, type ContractServiceTier, type ServiceTierInput } from './serviceTier';
import { parseClaudeCodeModeInput, type ClaudeCodeModeInput, type ContractClaudeCodeMode } from './claudeCodeMode';
import { asRecord, contractError, optionalBoolean, optionalString, optionalStringEnum, requiredNonEmptyString } from './validation';
import type { Message, StreamJobRuntimeInfo } from './responses';
import { CONTRACT_EFFORT_LEVELS, type ContractEffortLevel } from './conversations';

export interface SendMessageRequest {
  content: string;
  backend?: string;
  model?: string;
  effort?: ContractEffortLevel | null;
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
  requestId?: string;
  turnId?: string;
  inputId?: string;
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
    effort: record.effort === null ? null : optionalStringEnum(record, 'effort', CONTRACT_EFFORT_LEVELS),
    claudeCodeMode: parseClaudeCodeModeInput(record.claudeCodeMode),
    cliProfileId: optionalString(record, 'cliProfileId'),
    serviceTier: parseServiceTierInput(record.serviceTier),
  };
}

export function validateConversationInputRequest(body: unknown): ConversationInputRequest {
  const record = asRecord(body);
  const requestId = optionalString(record, 'requestId');
  const turnId = optionalString(record, 'turnId');
  const inputId = optionalString(record, 'inputId');
  if ([requestId, turnId, inputId].some(id => id !== undefined && !id.trim())) contractError('Input identities must be nonempty.');
  if ((turnId !== undefined) !== (inputId !== undefined)) contractError('Steering requires turnId and inputId.');
  if (requestId !== undefined && turnId !== undefined) contractError('An input must answer a question or steer a turn.');
  return {
    text: requiredNonEmptyString(record, 'text', 'Input text required'),
    streamActive: optionalBoolean(record, 'streamActive'),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(turnId !== undefined ? { turnId, inputId } : {}),
  };
}
