import type { Settings } from '../types';
import type { ContractEffortLevel } from './conversations';
import {
  asRecord,
  contractError,
  optionalBoolean,
  optionalClampedInteger,
  optionalRecord,
  optionalString,
  optionalStringEnum,
  requiredBoolean,
  requiredString,
} from './validation';

export type RoutineState = 'proposed' | 'enabled' | 'disabled';
export type RoutineTriggerType = 'manual' | 'schedule';
export type RoutineNotificationMode = 'off' | 'workspaceDefault';
export type RoutineRunStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type RoutineRunSource = 'manual' | 'scheduled';

export interface RoutineScheduleTrigger {
  type: 'schedule';
  timezone?: string;
  weekdaysOnly?: boolean;
  windowStart?: string;
  windowEnd?: string;
  intervalMinutes: number;
}

export interface RoutineManualTrigger {
  type: 'manual';
}

export type RoutineTrigger = RoutineManualTrigger | RoutineScheduleTrigger;

export interface RoutineHarnessConfig {
  cliProfileId?: string;
  model?: string;
  effort?: ContractEffortLevel;
}

export interface RoutineNotificationConfig {
  mode: RoutineNotificationMode;
}

export interface RoutineManifest {
  schemaVersion: 1;
  kind: 'agent-cockpit.routine';
  id: string;
  title: string;
  description?: string;
  routineFile: string;
  state: RoutineState;
  trigger: RoutineTrigger;
  harness?: RoutineHarnessConfig;
  notification?: RoutineNotificationConfig;
  outputRetentionDays?: number;
  timeoutMinutes?: number;
}

export interface RoutineRunRecord {
  runId: string;
  routineId: string;
  source: RoutineRunSource;
  status: RoutineRunStatus;
  startedAt: string;
  completedAt?: string;
  inputPath: string;
  outputDir: string;
  tmpDir: string;
  finalPath?: string;
  notifyPath?: string;
  errorMessage?: string;
  notificationSentAt?: string;
  notificationError?: string;
}

export interface RoutineRuntimeState {
  version: 1;
  lastRun?: RoutineRunRecord;
  runs: RoutineRunRecord[];
}

export interface RoutineListItem {
  manifest: RoutineManifest;
  state: RoutineState;
  routinePath: string;
  routineDir: string;
  lastRun?: RoutineRunRecord;
  running?: boolean;
}

export interface WorkspaceRoutineSettings {
  telegram?: {
    enabled?: boolean;
    botToken?: string;
    chatId?: string;
    chatTitle?: string;
    chatType?: string;
  };
}

export interface WorkspaceRoutineSettingsResponse {
  telegram: {
    enabled: boolean;
    configured: boolean;
    botConfigured: boolean;
    destinationConfigured: boolean;
    chatId?: string;
    chatTitle?: string;
    chatType?: string;
  };
}

export interface RoutineSettingsEnvelope {
  enabled: boolean;
  routinesDir: string;
  authoringPath: string;
  notification: WorkspaceRoutineSettingsResponse;
}

export interface RoutineListResponse {
  enabled: boolean;
  routines: RoutineListItem[];
  settings: RoutineSettingsEnvelope;
}

export interface TelegramDestinationSummary {
  chatId: string;
  chatTitle?: string;
  chatType?: string;
}

export interface RoutineTelegramDestinationConnectStartResponse {
  status: 'pending' | 'missing_bot';
  code?: string;
  expiresAt?: string;
  instruction?: string;
}

export interface RoutineTelegramDestinationConnectPollResponse {
  status: 'pending' | 'connected' | 'expired' | 'missing_bot';
  code?: string;
  expiresAt?: string;
  destination?: TelegramDestinationSummary;
  settings?: RoutineSettingsEnvelope;
}

export interface RoutineInstallRequest {
  state: 'enabled' | 'disabled';
}

export interface RoutineEnabledRequest {
  enabled: boolean;
}

export interface RoutineUpdateRequest {
  manifest?: Partial<RoutineManifest>;
  routineContent?: string;
}

export interface RoutineWorkspaceSettingsRequest {
  settings: WorkspaceRoutineSettings;
}

export interface RoutineProposalValidationRequest {
  marker?: string;
  content?: string;
}

export const ROUTINE_PROPOSAL_MARKER_RE = /<!--\s*AGENT_COCKPIT_ROUTINE_PROPOSAL:v1:(.*?)\s*-->/g;

const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function extractRoutineProposalMarkers(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return [];
  const markers: string[] = [];
  ROUTINE_PROPOSAL_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROUTINE_PROPOSAL_MARKER_RE.exec(text))) {
    const value = String(match[1] || '').trim();
    if (value) markers.push(value);
  }
  return markers;
}

export function validateRoutineManifest(input: unknown): RoutineManifest {
  const record = asRecord(input, 'routine manifest must be an object');
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== 1) contractError('routine schemaVersion must be 1');
  const kind = requiredString(record, 'kind', 'routine kind is required');
  if (kind !== 'agent-cockpit.routine') contractError('routine kind must be agent-cockpit.routine');
  const id = normalizeRoutineId(requiredString(record, 'id', 'routine id is required'));
  const title = requiredString(record, 'title', 'routine title is required').trim();
  if (!title) contractError('routine title is required');
  const routineFile = normalizeRoutineMarkdownPath(requiredString(record, 'routineFile', 'routineFile is required'));
  const state = optionalStringEnum(record, 'state', ['proposed', 'enabled', 'disabled'] as const, 'routine state is invalid') || 'proposed';
  const manifest: RoutineManifest = {
    schemaVersion: 1,
    kind: 'agent-cockpit.routine',
    id,
    title,
    routineFile,
    state,
    trigger: validateRoutineTrigger(record.trigger),
  };

  const description = optionalString(record, 'description', 'routine description must be a string');
  if (description) manifest.description = description;

  const harness = validateRoutineHarness(record.harness);
  if (harness && Object.keys(harness).length > 0) manifest.harness = harness;

  const notification = validateRoutineNotification(record.notification);
  if (notification) manifest.notification = notification;

  const outputRetentionDays = optionalClampedInteger(record, 'outputRetentionDays', 1, 3650, 'outputRetentionDays must be a number');
  if (outputRetentionDays !== undefined) manifest.outputRetentionDays = outputRetentionDays;
  const timeoutMinutes = optionalClampedInteger(record, 'timeoutMinutes', 1, 24 * 60, 'timeoutMinutes must be a number');
  if (timeoutMinutes !== undefined) manifest.timeoutMinutes = timeoutMinutes;

  return manifest;
}

export function validateRoutineInstallRequest(body: unknown): RoutineInstallRequest {
  const record = asRecord(body);
  return {
    state: optionalStringEnum(record, 'state', ['enabled', 'disabled'] as const, 'state must be enabled or disabled') || 'disabled',
  };
}

export function validateRoutineEnabledRequest(body: unknown): RoutineEnabledRequest {
  const record = asRecord(body);
  return {
    enabled: requiredBoolean(record, 'enabled', 'enabled must be a boolean'),
  };
}

export function validateRoutineUpdateRequest(body: unknown): RoutineUpdateRequest {
  const record = asRecord(body);
  const out: RoutineUpdateRequest = {};
  const routineContent = optionalString(record, 'routineContent', 'routineContent must be a string');
  if (routineContent !== undefined) out.routineContent = routineContent;
  if (record.manifest !== undefined) {
    const manifestRecord = asRecord(record.manifest, 'manifest must be an object');
    out.manifest = manifestRecord;
  }
  return out;
}

export function validateRoutineWorkspaceSettingsRequest(body: unknown): RoutineWorkspaceSettingsRequest {
  const record = asRecord(body);
  const input = record.settings === undefined ? record : asRecord(record.settings, 'settings must be an object');
  const telegram = optionalRecord(input, 'telegram', 'telegram must be an object');
  const settings: WorkspaceRoutineSettings = {};
  if (telegram) {
    settings.telegram = {
      enabled: optionalBoolean(telegram, 'enabled', 'telegram.enabled must be a boolean'),
      botToken: optionalString(telegram, 'botToken', 'telegram.botToken must be a string'),
      chatId: optionalString(telegram, 'chatId', 'telegram.chatId must be a string'),
      chatTitle: optionalString(telegram, 'chatTitle', 'telegram.chatTitle must be a string'),
      chatType: optionalString(telegram, 'chatType', 'telegram.chatType must be a string'),
    };
  }
  return { settings };
}

export function validateRoutineProposalValidationRequest(body: unknown): RoutineProposalValidationRequest {
  const record = asRecord(body);
  const marker = optionalString(record, 'marker', 'marker must be a string');
  const content = optionalString(record, 'content', 'content must be a string');
  if (!marker && !content) contractError('marker or content is required');
  return {
    ...(marker ? { marker } : {}),
    ...(content ? { content } : {}),
  };
}

export function sanitizeWorkspaceRoutineSettings(value: unknown): WorkspaceRoutineSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const telegram = raw.telegram && typeof raw.telegram === 'object' && !Array.isArray(raw.telegram)
    ? raw.telegram as Record<string, unknown>
    : {};
  const settings: WorkspaceRoutineSettings = {};
  if (Object.keys(telegram).length > 0) {
    const botToken = typeof telegram.botToken === 'string' ? telegram.botToken.trim() : '';
    const chatId = typeof telegram.chatId === 'string' ? telegram.chatId.trim() : '';
    const chatTitle = typeof telegram.chatTitle === 'string' ? telegram.chatTitle.trim() : '';
    const chatType = typeof telegram.chatType === 'string' ? telegram.chatType.trim() : '';
    settings.telegram = {
      enabled: telegram.enabled === true,
      ...(botToken ? { botToken } : {}),
      ...(chatId ? { chatId } : {}),
      ...(chatTitle ? { chatTitle } : {}),
      ...(chatType ? { chatType } : {}),
    };
  }
  return settings;
}

export function workspaceRoutineSettingsResponse(settings: WorkspaceRoutineSettings, globalSettings?: Settings | null): WorkspaceRoutineSettingsResponse {
  const telegram = settings.telegram || {};
  const botToken = telegram.botToken || globalSettings?.integrations?.telegram?.botToken || '';
  const chatId = telegram.chatId || '';
  return {
    telegram: {
      enabled: telegram.enabled === true,
      configured: Boolean(botToken && chatId),
      botConfigured: Boolean(botToken),
      destinationConfigured: Boolean(chatId),
      ...(chatId ? { chatId } : {}),
      ...(telegram.chatTitle ? { chatTitle: telegram.chatTitle } : {}),
      ...(telegram.chatType ? { chatType: telegram.chatType } : {}),
    },
  };
}

function validateRoutineTrigger(value: unknown): RoutineTrigger {
  const record = value === undefined ? { type: 'manual' } : asRecord(value, 'routine trigger must be an object');
  const type = optionalStringEnum(record, 'type', ['manual', 'schedule'] as const, 'routine trigger type is invalid') || 'manual';
  if (type === 'manual') return { type: 'manual' };
  const intervalMinutes = optionalClampedInteger(record, 'intervalMinutes', 1, 1440, 'intervalMinutes must be a number');
  if (intervalMinutes === undefined) contractError('schedule trigger intervalMinutes is required');
  const trigger: RoutineScheduleTrigger = { type: 'schedule', intervalMinutes };
  const timezone = optionalString(record, 'timezone', 'timezone must be a string');
  if (timezone) trigger.timezone = normalizeTimezone(timezone);
  const windowStart = optionalString(record, 'windowStart', 'windowStart must be a string');
  const windowEnd = optionalString(record, 'windowEnd', 'windowEnd must be a string');
  if ((windowStart === undefined) !== (windowEnd === undefined)) {
    contractError('schedule windows must include both windowStart and windowEnd');
  }
  if (windowStart !== undefined) trigger.windowStart = normalizeTimeOfDay(windowStart, 'windowStart');
  if (windowEnd !== undefined) trigger.windowEnd = normalizeTimeOfDay(windowEnd, 'windowEnd');
  const weekdaysOnly = optionalBoolean(record, 'weekdaysOnly', 'weekdaysOnly must be a boolean');
  if (weekdaysOnly !== undefined) trigger.weekdaysOnly = weekdaysOnly;
  return trigger;
}

function validateRoutineHarness(value: unknown): RoutineHarnessConfig | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, 'routine harness must be an object');
  const harness: RoutineHarnessConfig = {};
  const cliProfileId = optionalString(record, 'cliProfileId', 'cliProfileId must be a string');
  if (cliProfileId) harness.cliProfileId = cliProfileId;
  const model = optionalString(record, 'model', 'model must be a string');
  if (model) harness.model = model;
  const effort = optionalStringEnum(record, 'effort', EFFORT_LEVELS, 'effort is invalid');
  if (effort) harness.effort = effort;
  return harness;
}

function validateRoutineNotification(value: unknown): RoutineNotificationConfig | undefined {
  if (value === undefined) return { mode: 'workspaceDefault' };
  const record = asRecord(value, 'routine notification must be an object');
  return {
    mode: optionalStringEnum(record, 'mode', ['off', 'workspaceDefault'] as const, 'notification mode is invalid') || 'workspaceDefault',
  };
}

function normalizeRoutineId(value: string): string {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!normalized) contractError('routine id is required');
  return normalized;
}

function normalizeRoutineMarkdownPath(value: string): string {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized || normalized.includes('..') || normalized.includes('//') || !normalized.toLowerCase().endsWith('.md')) {
    contractError('routineFile must be a relative markdown path');
  }
  return normalized;
}

function normalizeTimeOfDay(value: string, field: string): string {
  const match = String(value || '').trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) contractError(`${field} must use HH:mm 24-hour time`);
  return `${match[1]}:${match[2]}`;
}

function normalizeTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone) contractError('timezone must be a valid IANA timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    contractError('timezone must be a valid IANA timezone');
  }
}
