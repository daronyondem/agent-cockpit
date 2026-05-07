import type {
  MemoryReviewRunSource,
  MemoryReviewScheduleConfig,
  MemoryReviewScheduleDays,
} from '../types';

export const DEFAULT_MEMORY_REVIEW_SCHEDULE: MemoryReviewScheduleConfig = { mode: 'off' };
const DEFAULT_MEMORY_REVIEW_CHECK_INTERVAL_MS = 60_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isMemoryReviewTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

function parseTimeMinutes(value: string | undefined): number | null {
  if (!isMemoryReviewTime(value)) return null;
  const [h, m] = value.split(':').map((part) => Number(part));
  return h * 60 + m;
}

function dateAtLocalMinutes(base: Date, minutes: number): Date {
  const next = new Date(base);
  next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return next;
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface ZonedDateParts {
  weekday: number;
  year: number;
  month: number;
  dayOfMonth: number;
  hour: number;
  minute: number;
}

function normalizeTimezone(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const timezone = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return undefined;
  }
}

function zonedParts(date: Date, timezone?: string): ZonedDateParts {
  if (!timezone) {
    return {
      weekday: date.getDay(),
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      dayOfMonth: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const rawHour = Number(value('hour'));
  return {
    weekday: WEEKDAY_INDEX[value('weekday')] ?? date.getDay(),
    year: Number(value('year')) || date.getFullYear(),
    month: Number(value('month')) || date.getMonth() + 1,
    dayOfMonth: Number(value('day')) || date.getDate(),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(value('minute')) || 0,
  };
}

function zonedDateKey(parts: ZonedDateParts): string {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.dayOfMonth).padStart(2, '0'),
  ].join('-');
}

function normalizeDays(value: unknown): MemoryReviewScheduleDays {
  if (value === 'weekdays' || value === 'custom') return value;
  return 'daily';
}

function normalizeCustomDays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days = [...new Set(value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6))]
    .sort((a, b) => a - b);
  return days.length ? days : undefined;
}

export function normalizeMemoryReviewScheduleConfig(input: unknown): MemoryReviewScheduleConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_MEMORY_REVIEW_SCHEDULE };
  const raw = input as Partial<MemoryReviewScheduleConfig & { mode?: unknown }>;
  if (raw.mode !== 'window') return { ...DEFAULT_MEMORY_REVIEW_SCHEDULE };
  if (!isMemoryReviewTime(raw.windowStart) || !isMemoryReviewTime(raw.windowEnd) || raw.windowStart === raw.windowEnd) {
    return { ...DEFAULT_MEMORY_REVIEW_SCHEDULE };
  }
  const days = normalizeDays(raw.days);
  const customDays = days === 'custom' ? normalizeCustomDays(raw.customDays) : undefined;
  if (days === 'custom' && !customDays?.length) return { ...DEFAULT_MEMORY_REVIEW_SCHEDULE };
  return {
    mode: 'window',
    days,
    ...(customDays ? { customDays } : {}),
    windowStart: raw.windowStart,
    windowEnd: raw.windowEnd,
    ...(normalizeTimezone(raw.timezone) ? { timezone: normalizeTimezone(raw.timezone) } : {}),
  };
}

export function validateMemoryReviewScheduleConfig(input: unknown): { config?: MemoryReviewScheduleConfig; error?: string } {
  if (!input || typeof input !== 'object') return { error: 'memoryReviewSchedule must be an object' };
  const raw = input as Partial<MemoryReviewScheduleConfig & { mode?: unknown }>;
  if (raw.mode === 'off') return { config: { mode: 'off' } };
  if (raw.mode !== 'window') return { error: 'mode must be off or window' };
  if (!isMemoryReviewTime(raw.windowStart)) return { error: 'windowStart must be HH:mm' };
  if (!isMemoryReviewTime(raw.windowEnd)) return { error: 'windowEnd must be HH:mm' };
  if (raw.windowStart === raw.windowEnd) return { error: 'windowStart and windowEnd must be different' };
  const days = normalizeDays(raw.days);
  const customDays = days === 'custom' ? normalizeCustomDays(raw.customDays) : undefined;
  if (days === 'custom' && !customDays?.length) return { error: 'customDays must include at least one day from 0 to 6' };
  const timezone = normalizeTimezone(raw.timezone);
  if (raw.timezone !== undefined && raw.timezone && !timezone) {
    return { error: 'timezone must be a valid IANA timezone' };
  }
  return {
    config: {
      mode: 'window',
      days,
      ...(customDays ? { customDays } : {}),
      windowStart: raw.windowStart,
      windowEnd: raw.windowEnd,
      ...(timezone ? { timezone } : {}),
    },
  };
}

export interface MemoryReviewWindowState {
  inside: boolean;
  nextStartAt: Date | null;
  windowEndAt: Date | null;
}

function dayMatches(config: Extract<MemoryReviewScheduleConfig, { mode: 'window' }>, date: Date): boolean {
  const day = zonedParts(date, config.timezone).weekday;
  if (config.days === 'weekdays') return day >= 1 && day <= 5;
  if (config.days === 'custom') return (config.customDays || []).includes(day);
  return true;
}

export function getMemoryReviewWindowState(
  config: MemoryReviewScheduleConfig,
  now: Date = new Date(),
): MemoryReviewWindowState {
  if (config.mode !== 'window') return { inside: false, nextStartAt: null, windowEndAt: null };
  const start = parseTimeMinutes(config.windowStart);
  const end = parseTimeMinutes(config.windowEnd);
  if (start === null || end === null || start === end) return { inside: false, nextStartAt: null, windowEndAt: null };

  const nowParts = zonedParts(now, config.timezone);
  const current = nowParts.hour * 60 + nowParts.minute;
  const startToday = dateAtLocalMinutes(now, start);
  const endToday = dateAtLocalMinutes(now, end);
  const activeDate = start < end || current >= start ? now : addDays(now, -1);

  let inside = false;
  let windowEndAt: Date | null = null;
  if (start < end) {
    inside = current >= start && current < end && dayMatches(config, now);
    windowEndAt = endToday;
  } else if (current >= start) {
    inside = dayMatches(config, now);
    windowEndAt = addDays(endToday, 1);
  } else if (current < end) {
    inside = dayMatches(config, activeDate);
    windowEndAt = endToday;
  }

  if (inside) return { inside: true, nextStartAt: startToday, windowEndAt };

  for (let offset = 0; offset <= 7; offset++) {
    const candidate = addDays(startToday, offset);
    if (candidate.getTime() <= now.getTime()) continue;
    if (!dayMatches(config, candidate)) continue;
    return {
      inside: false,
      nextStartAt: candidate,
      windowEndAt: start < end ? dateAtLocalMinutes(candidate, end) : addDays(dateAtLocalMinutes(candidate, end), 1),
    };
  }
  return { inside: false, nextStartAt: null, windowEndAt: null };
}

function activeMemoryReviewWindowKey(
  config: MemoryReviewScheduleConfig,
  date: Date,
): string | null {
  if (config.mode !== 'window') return null;
  const start = parseTimeMinutes(config.windowStart);
  const end = parseTimeMinutes(config.windowEnd);
  if (start === null || end === null || start === end) return null;

  const parts = zonedParts(date, config.timezone);
  const current = parts.hour * 60 + parts.minute;
  let startDateKey: string | null = null;

  if (start < end) {
    if (current >= start && current < end && dayMatches(config, date)) {
      startDateKey = zonedDateKey(parts);
    }
  } else if (current >= start) {
    if (dayMatches(config, date)) startDateKey = zonedDateKey(parts);
  } else if (current < end) {
    const activeDate = addDays(date, -1);
    if (dayMatches(config, activeDate)) {
      startDateKey = zonedDateKey(zonedParts(activeDate, config.timezone));
    }
  }

  if (!startDateKey) return null;
  return [
    config.timezone || 'server-local',
    config.days,
    (config.customDays || []).join(','),
    config.windowStart,
    config.windowEnd,
    startDateKey,
  ].join('|');
}

interface MemoryReviewSchedulerChatService {
  listMemoryEnabledWorkspaceHashes(): Promise<string[]>;
  getWorkspaceMemoryReviewSchedule(hash: string): Promise<MemoryReviewScheduleConfig>;
  getWorkspaceMemoryReviewScheduleUpdatedAt(hash: string): Promise<string | undefined>;
  listMemoryReviewRuns(hash: string): Promise<Array<{ createdAt: string; source?: MemoryReviewRunSource }>>;
}

interface MemoryReviewSchedulerRunner {
  isMemoryReviewRunning(hash: string): boolean;
  hasPendingMemoryReview(hash: string): Promise<boolean>;
  hasMemoryChangedSinceLastScheduledReview(hash: string, since?: string): Promise<boolean>;
  createMemoryReviewRun(hash: string, args: { source: 'manual' | 'scheduled'; replaceExisting?: boolean }): Promise<unknown>;
}

interface MemoryReviewSchedulerOptions {
  chatService: MemoryReviewSchedulerChatService;
  runner: MemoryReviewSchedulerRunner;
  now?: () => Date;
  logger?: Pick<Console, 'warn'>;
}

export class MemoryReviewScheduler {
  private readonly chatService: MemoryReviewSchedulerChatService;
  private readonly runner: MemoryReviewSchedulerRunner;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, 'warn'>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(opts: MemoryReviewSchedulerOptions) {
    this.chatService = opts.chatService;
    this.runner = opts.runner;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? console;
  }

  start(checkIntervalMs: number = DEFAULT_MEMORY_REVIEW_CHECK_INTERVAL_MS): void {
    if (this.interval) return;
    void this.checkNow();
    this.interval = setInterval(() => void this.checkNow(), checkIntervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async checkNow(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const hashes = await this.chatService.listMemoryEnabledWorkspaceHashes();
      for (const hash of hashes) {
        try {
          await this.checkWorkspace(hash);
        } catch (err: unknown) {
          this.logger.warn(`[memory-review] scheduler check failed for ${hash}:`, (err as Error).message);
        }
      }
    } catch (err: unknown) {
      this.logger.warn('[memory-review] scheduler scan failed:', (err as Error).message);
    } finally {
      this.checking = false;
    }
  }

  private async checkWorkspace(hash: string): Promise<void> {
    const config = normalizeMemoryReviewScheduleConfig(await this.chatService.getWorkspaceMemoryReviewSchedule(hash));
    if (config.mode === 'off') return;
    const now = this.now();
    const windowState = getMemoryReviewWindowState(config, now);
    if (!windowState.inside || this.runner.isMemoryReviewRunning(hash)) return;
    const currentWindowKey = activeMemoryReviewWindowKey(config, now);
    if (!currentWindowKey) return;
    const scheduleUpdatedAt = await this.chatService.getWorkspaceMemoryReviewScheduleUpdatedAt(hash);
    const runs = await this.chatService.listMemoryReviewRuns(hash);
    const hasScheduledRunInWindow = runs.some((run) => (
      run.source === 'scheduled'
      && (!scheduleUpdatedAt || run.createdAt >= scheduleUpdatedAt)
      && activeMemoryReviewWindowKey(config, new Date(run.createdAt)) === currentWindowKey
    ));
    if (hasScheduledRunInWindow) return;
    if (await this.runner.hasPendingMemoryReview(hash)) return;
    if (!(await this.runner.hasMemoryChangedSinceLastScheduledReview(hash, scheduleUpdatedAt))) return;
    this.runner.createMemoryReviewRun(hash, { source: 'scheduled' })
      .catch((err: unknown) => {
        this.logger.warn(`[memory-review] scheduled run failed for ${hash}:`, (err as Error).message);
      });
  }
}
