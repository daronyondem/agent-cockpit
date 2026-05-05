import type { KbAutoDreamConfig, KbAutoDreamState } from '../../types';
import type { KbDatabase } from './db';
import type { KbDreamService } from './dream';

export const DEFAULT_KB_AUTO_DREAM_CONFIG: KbAutoDreamConfig = { mode: 'off' };
export const MAX_AUTO_DREAM_INTERVAL_HOURS = 24 * 365;
const DEFAULT_AUTO_DREAM_CHECK_INTERVAL_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isKbAutoDreamTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

function parseTimeMinutes(value: string | undefined): number | null {
  if (!isKbAutoDreamTime(value)) return null;
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

function isValidIntervalHours(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_AUTO_DREAM_INTERVAL_HOURS;
}

export function normalizeKbAutoDreamConfig(input: unknown): KbAutoDreamConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_KB_AUTO_DREAM_CONFIG };
  const raw = input as Partial<KbAutoDreamConfig>;
  if (raw.mode === 'interval' && isValidIntervalHours(raw.intervalHours)) {
    return { mode: 'interval', intervalHours: raw.intervalHours };
  }
  if (
    raw.mode === 'window'
    && isKbAutoDreamTime(raw.windowStart)
    && isKbAutoDreamTime(raw.windowEnd)
    && raw.windowStart !== raw.windowEnd
  ) {
    return { mode: 'window', windowStart: raw.windowStart, windowEnd: raw.windowEnd };
  }
  return { ...DEFAULT_KB_AUTO_DREAM_CONFIG };
}

export function validateKbAutoDreamConfig(input: unknown): { config?: KbAutoDreamConfig; error?: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'autoDream must be an object' };
  }
  const raw = input as Partial<KbAutoDreamConfig>;
  if (raw.mode === 'off') return { config: { mode: 'off' } };
  if (raw.mode === 'interval') {
    if (!isValidIntervalHours(raw.intervalHours)) {
      return { error: `intervalHours must be an integer from 1 to ${MAX_AUTO_DREAM_INTERVAL_HOURS}` };
    }
    return { config: { mode: 'interval', intervalHours: raw.intervalHours } };
  }
  if (raw.mode === 'window') {
    if (!isKbAutoDreamTime(raw.windowStart)) {
      return { error: 'windowStart must be HH:mm' };
    }
    if (!isKbAutoDreamTime(raw.windowEnd)) {
      return { error: 'windowEnd must be HH:mm' };
    }
    if (raw.windowStart === raw.windowEnd) {
      return { error: 'windowStart and windowEnd must be different' };
    }
    return { config: { mode: 'window', windowStart: raw.windowStart, windowEnd: raw.windowEnd } };
  }
  return { error: 'mode must be off, interval, or window' };
}

export interface KbAutoDreamWindowState {
  inside: boolean;
  nextStartAt: Date | null;
  windowEndAt: Date | null;
}

export function getKbAutoDreamWindowState(
  config: KbAutoDreamConfig,
  now: Date = new Date(),
): KbAutoDreamWindowState {
  const start = parseTimeMinutes(config.windowStart);
  const end = parseTimeMinutes(config.windowEnd);
  if (start === null || end === null || start === end) {
    return { inside: false, nextStartAt: null, windowEndAt: null };
  }

  const current = now.getHours() * 60 + now.getMinutes();
  const startToday = dateAtLocalMinutes(now, start);
  const endToday = dateAtLocalMinutes(now, end);

  if (start < end) {
    if (current >= start && current < end) {
      return { inside: true, nextStartAt: startToday, windowEndAt: endToday };
    }
    if (current < start) {
      return { inside: false, nextStartAt: startToday, windowEndAt: endToday };
    }
    return {
      inside: false,
      nextStartAt: addDays(startToday, 1),
      windowEndAt: addDays(endToday, 1),
    };
  }

  if (current >= start) {
    return { inside: true, nextStartAt: startToday, windowEndAt: addDays(endToday, 1) };
  }
  if (current < end) {
    return { inside: true, nextStartAt: addDays(startToday, -1), windowEndAt: endToday };
  }
  return { inside: false, nextStartAt: startToday, windowEndAt: addDays(endToday, 1) };
}

export function getKbAutoDreamState(
  configInput: unknown,
  lastRunAt: string | null | undefined,
  now: Date = new Date(),
): KbAutoDreamState {
  const config = normalizeKbAutoDreamConfig(configInput);
  if (config.mode === 'off') {
    return { ...config, nextRunAt: null };
  }
  if (config.mode === 'interval') {
    const lastMs = lastRunAt ? Date.parse(lastRunAt) : NaN;
    const nextMs = Number.isFinite(lastMs)
      ? Math.max(now.getTime(), lastMs + (config.intervalHours ?? 1) * HOUR_MS)
      : now.getTime();
    return { ...config, nextRunAt: new Date(nextMs).toISOString() };
  }

  const windowState = getKbAutoDreamWindowState(config, now);
  return {
    ...config,
    nextRunAt: (windowState.inside ? now : windowState.nextStartAt)?.toISOString() ?? null,
    windowActive: windowState.inside,
    windowEndAt: windowState.windowEndAt?.toISOString() ?? null,
  };
}

interface KbDreamSchedulerChatService {
  listKbEnabledWorkspaceHashes(): Promise<string[]>;
  getWorkspaceKbAutoDream(hash: string): Promise<KbAutoDreamConfig>;
  getKbDb(hash: string): KbDatabase | null;
}

interface KbDreamSchedulerDreaming {
  dream(hash: string): Promise<unknown>;
  isRunning(hash: string): boolean;
  requestStop(hash: string): boolean;
}

interface KbDreamSchedulerOptions {
  chatService: KbDreamSchedulerChatService;
  kbDreaming: KbDreamSchedulerDreaming | KbDreamService;
  now?: () => Date;
  logger?: Pick<Console, 'warn'>;
}

export class KbDreamScheduler {
  private readonly chatService: KbDreamSchedulerChatService;
  private readonly kbDreaming: KbDreamSchedulerDreaming;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, 'warn'>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private readonly windowOwnedRuns = new Set<string>();

  constructor(opts: KbDreamSchedulerOptions) {
    this.chatService = opts.chatService;
    this.kbDreaming = opts.kbDreaming as KbDreamSchedulerDreaming;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? console;
  }

  start(checkIntervalMs: number = DEFAULT_AUTO_DREAM_CHECK_INTERVAL_MS): void {
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
      const hashes = await this.chatService.listKbEnabledWorkspaceHashes();
      const seen = new Set(hashes);
      for (const hash of Array.from(this.windowOwnedRuns)) {
        if (!seen.has(hash)) this.stopWindowOwnedRun(hash);
      }
      for (const hash of hashes) {
        try {
          await this.checkWorkspace(hash);
        } catch (err: unknown) {
          this.logger.warn(`[kb:auto-dream] scheduler check failed for ${hash}:`, (err as Error).message);
        }
      }
    } catch (err: unknown) {
      this.logger.warn('[kb:auto-dream] scheduler scan failed:', (err as Error).message);
    } finally {
      this.checking = false;
    }
  }

  private async checkWorkspace(hash: string): Promise<void> {
    const config = normalizeKbAutoDreamConfig(await this.chatService.getWorkspaceKbAutoDream(hash));
    if (config.mode === 'off') {
      this.stopWindowOwnedRun(hash);
      return;
    }

    const db = this.chatService.getKbDb(hash);
    if (!db) {
      this.stopWindowOwnedRun(hash);
      return;
    }

    if (config.mode === 'window') {
      const windowState = getKbAutoDreamWindowState(config, this.now());
      if (!windowState.inside) {
        this.stopWindowOwnedRun(hash);
        return;
      }
      if (this.kbDreaming.isRunning(hash) || db.countNeedsSynthesis() === 0) return;
      this.startDream(hash, true);
      return;
    }

    this.windowOwnedRuns.delete(hash);
    if (this.kbDreaming.isRunning(hash) || db.countNeedsSynthesis() === 0) return;
    const snapshot = db.getSynthesisSnapshot();
    if (!this.isIntervalDue(config, snapshot.lastRunAt)) return;
    this.startDream(hash, false);
  }

  private isIntervalDue(config: KbAutoDreamConfig, lastRunAt: string | null): boolean {
    if (config.mode !== 'interval' || !config.intervalHours) return false;
    const lastMs = lastRunAt ? Date.parse(lastRunAt) : NaN;
    if (!Number.isFinite(lastMs)) return true;
    return lastMs + config.intervalHours * HOUR_MS <= this.now().getTime();
  }

  private startDream(hash: string, windowOwned: boolean): void {
    if (windowOwned) this.windowOwnedRuns.add(hash);
    this.kbDreaming.dream(hash)
      .catch((err: unknown) => {
        this.logger.warn(`[kb:auto-dream] run failed for ${hash}:`, (err as Error).message);
      })
      .finally(() => {
        if (windowOwned) this.windowOwnedRuns.delete(hash);
      });
  }

  private stopWindowOwnedRun(hash: string): void {
    if (!this.windowOwnedRuns.has(hash)) return;
    if (this.kbDreaming.isRunning(hash)) this.kbDreaming.requestStop(hash);
    this.windowOwnedRuns.delete(hash);
  }
}
