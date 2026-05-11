import type { Conversation, ConversationListItem, Message, SessionHistoryItem } from './responses';
import { parseServiceTierInput, type ContractServiceTier, type ServiceTierInput } from './serviceTier';
import { asRecord, optionalBoolean, optionalString, optionalStringEnum, requiredNonEmptyString } from './validation';

export type ContractEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const CONTRACT_EFFORT_LEVELS: readonly ContractEffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface CreateConversationRequest {
  title?: string;
  workingDir?: string;
  backend?: string;
  cliProfileId?: string;
  model?: string;
  effort?: ContractEffortLevel;
  serviceTier?: ServiceTierInput;
}

export interface ValidatedCreateConversationRequest extends Omit<CreateConversationRequest, 'serviceTier'> {
  serviceTier?: ContractServiceTier | null;
}

export interface RenameConversationRequest {
  title: string;
}

export interface SetUnreadRequest {
  unread: boolean;
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
    serviceTier: parseServiceTierInput(record.serviceTier),
  };
}

export function validateRenameConversationRequest(body: unknown): RenameConversationRequest {
  const record = asRecord(body);
  return { title: requiredNonEmptyString(record, 'title', 'title is required') };
}

export function validateSetUnreadRequest(body: unknown): SetUnreadRequest {
  const record = asRecord(body);
  const unread = optionalBoolean(record, 'unread', 'unread must be a boolean');
  return { unread: unread === true };
}
