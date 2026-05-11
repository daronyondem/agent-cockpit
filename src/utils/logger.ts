export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const SECRET_KEY_RE = /(token|secret|password|credential|authorization|cookie|session)/i;

export interface LogSerializationOptions {
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

const DEFAULT_SERIALIZATION_OPTIONS: Required<LogSerializationOptions> = {
  maxDepth: 6,
  maxArrayLength: 50,
  maxObjectKeys: 50,
  maxStringLength: 2000,
};

export interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    error: (message, meta) => writeLog('error', message, bindings, meta),
    warn: (message, meta) => writeLog('warn', message, bindings, meta),
    info: (message, meta) => writeLog('info', message, bindings, meta),
    debug: (message, meta) => writeLog('debug', message, bindings, meta),
    child: (childBindings) => createLogger({ ...bindings, ...childBindings }),
  };
}

export const logger = createLogger();

export function getConfiguredLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug' ? raw : 'info';
}

export function shouldLog(level: LogLevel, configured: LogLevel = getConfiguredLogLevel()): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[configured];
}

export function sanitizeLogMeta(value: unknown, options: LogSerializationOptions = {}): unknown {
  return safeLogValue(value, options);
}

export function safeLogValue(value: unknown, options: LogSerializationOptions = {}): unknown {
  return serializeLogValue(value, {
    ...DEFAULT_SERIALIZATION_OPTIONS,
    ...options,
  }, new WeakSet(), 0);
}

function serializeLogValue(
  value: unknown,
  options: Required<LogSerializationOptions>,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return truncateString(value, options.maxStringLength);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= options.maxDepth) return '[MaxDepth]';

  seen.add(value);
  try {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : value.toString();
    }
    if (value instanceof Error) {
      return serializeLogObject({
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
      }, options, seen, depth);
    }
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, options.maxArrayLength);
      const output = value.slice(0, limit).map((item) => serializeLogValue(item, options, seen, depth + 1));
      if (value.length > limit) output.push(`[Truncated ${value.length - limit} items]`);
      return output;
    }
    if (value instanceof Map) {
      const entries = Array.from(value.entries());
      if (entries.every(([key]) => typeof key === 'string')) {
        return serializeLogObject(Object.fromEntries(entries), options, seen, depth);
      }
      const output = entries.slice(0, options.maxArrayLength).map(([key, item]) => [
        serializeLogValue(key, options, seen, depth + 1),
        typeof key === 'string' && SECRET_KEY_RE.test(key) ? '[REDACTED]' : serializeLogValue(item, options, seen, depth + 1),
      ]);
      if (entries.length > output.length) output.push([`[Truncated ${entries.length - output.length} entries]`]);
      return output;
    }
    if (value instanceof Set) {
      return serializeLogValue(Array.from(value.values()), options, seen, depth + 1);
    }
    return serializeLogObject(value as Record<string, unknown>, options, seen, depth);
  } finally {
    seen.delete(value);
  }
}

function serializeLogObject(
  value: Record<string, unknown>,
  options: Required<LogSerializationOptions>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const entries = Object.entries(value);
  const limit = Math.min(entries.length, options.maxObjectKeys);
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, limit)) {
    output[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : serializeLogValue(item, options, seen, depth + 1);
  }
  if (entries.length > limit) output.__truncatedKeys = entries.length - limit;
  return output;
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function writeLog(
  level: LogLevel,
  message: string,
  bindings: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): void {
  if (!shouldLog(level)) return;
  const payload = safeLogValue({ ...bindings, ...(meta || {}) }) as Record<string, unknown>;
  const line = `[${level}] ${message}${Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : ''}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
