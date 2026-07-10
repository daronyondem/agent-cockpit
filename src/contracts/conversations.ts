import type {
  Conversation,
  ConversationListItem,
  ConversationMessageWindow,
  ConversationPinnedMessage,
  Message,
  SessionHistoryItem,
} from './responses';
import { parseClaudeCodeModeInput, type ClaudeCodeModeInput, type ContractClaudeCodeMode } from './claudeCodeMode';
import { parseServiceTierInput, type ContractServiceTier, type ServiceTierInput } from './serviceTier';
import { asRecord, optionalBoolean, optionalString, optionalStringEnum, requiredBoolean, requiredNonEmptyString } from './validation';

export type ContractEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const CONTRACT_EFFORT_LEVELS: readonly ContractEffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface CreateConversationRequest {
  title?: string;
  workingDir?: string;
  backend?: string;
  cliProfileId?: string;
  model?: string;
  effort?: ContractEffortLevel;
  claudeCodeMode?: ClaudeCodeModeInput;
  serviceTier?: ServiceTierInput;
}

export interface ValidatedCreateConversationRequest extends Omit<CreateConversationRequest, 'claudeCodeMode' | 'serviceTier'> {
  claudeCodeMode?: ContractClaudeCodeMode | null;
  serviceTier?: ContractServiceTier | null;
}

export interface RenameConversationRequest {
  title: string;
}

export interface ResetConversationRequest {
  cliProfileId?: string;
  backend?: string;
}

export interface SetUnreadRequest {
  unread: boolean;
}

export interface SetMessagePinnedRequest {
  pinned: boolean;
}

export interface ConversationListResponse {
  conversations: ConversationListItem[];
}

export interface ConversationResponse extends Conversation {}

export interface ConversationSessionsResponse {
  sessions: SessionHistoryItem[];
}

export interface ConversationSessionMessagesResponse {
  messages: Message[];
}

export interface ConversationMessagesResponse {
  messages: Message[];
  messageWindow: ConversationMessageWindow;
  pinnedMessages: ConversationPinnedMessage[];
}

export interface ConversationDeleteResponse {
  ok: true;
}

export function validateCreateConversationRequest(body: unknown): ValidatedCreateConversationRequest {
  const record = asRecord(body);
  return {
    title: optionalString(record, 'title'),
    workingDir: optionalString(record, 'workingDir'),
    backend: optionalString(record, 'backend'),
    cliProfileId: optionalString(record, 'cliProfileId'),
    model: optionalString(record, 'model'),
    effort: optionalStringEnum(record, 'effort', CONTRACT_EFFORT_LEVELS),
    claudeCodeMode: parseClaudeCodeModeInput(record.claudeCodeMode),
    serviceTier: parseServiceTierInput(record.serviceTier),
  };
}

export function validateRenameConversationRequest(body: unknown): RenameConversationRequest {
  const record = asRecord(body);
  return { title: requiredNonEmptyString(record, 'title', 'title is required') };
}

export function validateResetConversationRequest(body: unknown): ResetConversationRequest {
  const record = body == null ? {} : asRecord(body);
  return {
    cliProfileId: optionalString(record, 'cliProfileId'),
    backend: optionalString(record, 'backend'),
  };
}

export function validateSetUnreadRequest(body: unknown): SetUnreadRequest {
  const record = asRecord(body);
  const unread = optionalBoolean(record, 'unread', 'unread must be a boolean');
  return { unread: unread === true };
}

export function validateSetMessagePinnedRequest(body: unknown): SetMessagePinnedRequest {
  const record = asRecord(body);
  return { pinned: requiredBoolean(record, 'pinned', 'pinned must be a boolean') };
}
