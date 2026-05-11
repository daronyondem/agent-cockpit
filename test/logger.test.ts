import { createLogger, safeLogValue, sanitizeLogMeta, shouldLog } from '../src/utils/logger';

describe('logger', () => {
  const originalLogLevel = process.env.LOG_LEVEL;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.LOG_LEVEL = 'info';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.LOG_LEVEL = originalLogLevel;
    jest.restoreAllMocks();
  });

  test('filters debug logs unless LOG_LEVEL enables them', () => {
    expect(shouldLog('debug', 'info')).toBe(false);
    expect(shouldLog('debug', 'debug')).toBe(true);
  });

  test('redacts secret-like metadata keys recursively', () => {
    expect(sanitizeLogMeta({
      token: 'abc',
      nested: { password: 'pw', safe: 'ok' },
    })).toEqual({
      token: '[REDACTED]',
      nested: { password: '[REDACTED]', safe: 'ok' },
    });
  });

  test('merges child bindings with per-call metadata', () => {
    process.env.LOG_LEVEL = 'debug';
    createLogger({ subsystem: 'test' }).child({ convId: 'abc123' }).debug('hello', { count: 1 });
    expect(logSpy.mock.calls[0][0]).toContain('[debug] hello');
    expect(logSpy.mock.calls[0][0]).toContain('"subsystem":"test"');
    expect(logSpy.mock.calls[0][0]).toContain('"convId":"abc123"');
    expect(logSpy.mock.calls[0][0]).toContain('"count":1');
  });

  test('serializes cyclic metadata without throwing', () => {
    const cycle: Record<string, unknown> = { safe: 'ok' };
    cycle.self = cycle;

    process.env.LOG_LEVEL = 'debug';
    expect(() => createLogger().debug('cycle', { cycle })).not.toThrow();
    expect(logSpy.mock.calls[0][0]).toContain('"self":"[Circular]"');
  });

  test('serializes Error objects and non-json primitives', () => {
    const serialized = safeLogValue({
      error: new TypeError('bad input'),
      amount: 10n,
      handler: function runHandler() {},
      symbol: Symbol('s'),
    }) as Record<string, unknown>;

    expect(serialized.error).toMatchObject({ name: 'TypeError', message: 'bad input' });
    expect(serialized.amount).toBe('10');
    expect(serialized.handler).toBe('[Function runHandler]');
    expect(serialized.symbol).toBe('Symbol(s)');
  });

  test('redacts secret-like Map keys', () => {
    expect(safeLogValue(new Map([
      ['token', 'secret'],
      ['safe', 'ok'],
    ]))).toEqual({
      token: '[REDACTED]',
      safe: 'ok',
    });

    const objectKey = { key: 'safe' };
    expect(safeLogValue(new Map<unknown, unknown>([
      ['password', 'pw'],
      [objectKey, { value: 1 }],
    ]))).toEqual([
      ['password', '[REDACTED]'],
      [{ key: 'safe' }, { value: 1 }],
    ]);
  });

  test('bounds large strings, arrays, and objects', () => {
    expect(safeLogValue('abcdef', { maxStringLength: 3 })).toBe('abc...[truncated 3 chars]');
    expect(safeLogValue([1, 2, 3], { maxArrayLength: 2 })).toEqual([1, 2, '[Truncated 1 items]']);
    expect(safeLogValue({ a: 1, b: 2, c: 3 }, { maxObjectKeys: 2 })).toEqual({
      a: 1,
      b: 2,
      __truncatedKeys: 1,
    });
  });
});
