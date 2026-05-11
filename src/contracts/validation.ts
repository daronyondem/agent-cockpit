export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractValidationError';
  }
}

export function isContractValidationError(err: unknown): err is ContractValidationError {
  return err instanceof ContractValidationError;
}

export function contractError(message: string): never {
  throw new ContractValidationError(message);
}

export function asRecord(value: unknown, message = 'body must be an object'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) contractError(message);
  return value as Record<string, unknown>;
}

export function optionalString(record: Record<string, unknown>, key: string, message = `${key} must be a string`): string | undefined {
  const value = record[key];
  if (value == null) return undefined;
  if (typeof value !== 'string') contractError(message);
  return value;
}

export function requiredString(record: Record<string, unknown>, key: string, message = `${key} is required`): string {
  const value = record[key];
  if (typeof value !== 'string') contractError(message);
  return value;
}

export function requiredNonEmptyString(record: Record<string, unknown>, key: string, message = `${key} is required`): string {
  const value = requiredString(record, key, message);
  if (!value.trim()) contractError(message);
  return value;
}

export function optionalBoolean(record: Record<string, unknown>, key: string, message = `${key} must be a boolean`): boolean | undefined {
  const value = record[key];
  if (value == null) return undefined;
  if (typeof value !== 'boolean') contractError(message);
  return value;
}

export function requiredBoolean(record: Record<string, unknown>, key: string, message = `${key} must be a boolean`): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') contractError(message);
  return value;
}

export function optionalFiniteNumber(record: Record<string, unknown>, key: string, message = `${key} must be a finite number`): number | undefined {
  const value = record[key];
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) contractError(message);
  return value;
}

export function optionalClampedInteger(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  message = `${key} must be a finite number`,
): number | undefined {
  const value = optionalFiniteNumber(record, key, message);
  if (value === undefined) return undefined;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function optionalRecord(record: Record<string, unknown>, key: string, message = `${key} must be an object`): Record<string, unknown> | undefined {
  const value = record[key];
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) contractError(message);
  return value as Record<string, unknown>;
}

export function optionalArray<T>(
  record: Record<string, unknown>,
  key: string,
  parseItem: (item: unknown, index: number) => T,
  message = `${key} must be an array`,
): T[] | undefined {
  const value = record[key];
  if (value == null) return undefined;
  if (!Array.isArray(value)) contractError(message);
  return value.map(parseItem);
}

export function optionalStringEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  message = `${key} must be one of: ${allowed.join(', ')}`,
): T | undefined {
  const value = optionalString(record, key, message);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) contractError(message);
  return value as T;
}
