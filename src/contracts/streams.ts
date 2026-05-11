import { parseServiceTierInput, type ContractServiceTier, type ServiceTierInput } from './serviceTier';
import { asRecord, optionalBoolean, optionalString, requiredNonEmptyString } from './validation';
import type { ContractEffortLevel } from './conversations';

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

export function validateSendMessageRequest(body: unknown): ValidatedSendMessageRequest {
  const record = asRecord(body);
  return {
    content: requiredNonEmptyString(record, 'content', 'Message content required'),
    backend: optionalString(record, 'backend'),
    model: optionalString(record, 'model'),
    effort: optionalString(record, 'effort') as ContractEffortLevel | undefined,
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
