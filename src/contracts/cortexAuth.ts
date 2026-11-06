import { asRecord, contractError } from './validation';

export interface CortexConnectionSummary {
  name: string;
  manualOAuth: boolean;
  browserTimeoutMs: number;
}

/** Transient, authenticated API state. Never save this in settings or history. */
export interface CortexAuthHandoff {
  phase: 'starting' | 'waiting-for-browser' | 'verifying';
  generation: string;
  connection: string;
  version?: string;
  authorizationUrl?: string;
  expiresAt?: string;
}

export interface CortexConnectionCreate { name: string; account: string; user: string }

function exactBody(value: unknown, keys: string[]): Record<string, unknown> {
  const body = asRecord(value);
  if (Object.keys(body).some(key => !keys.includes(key))) contractError('Unexpected authentication field');
  return body;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\p{Cc}\p{Cs}]/u.test(value)) {
    contractError(`${field} must be nonempty text without control characters`);
  }
  return value;
}

export function validateCortexConnectionCreate(value: unknown): CortexConnectionCreate {
  const body = exactBody(value, ['name', 'account', 'user']);
  const name = text(body.name, 'Connection name', 128);
  const account = text(body.account, 'Account', 256).trim();
  if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(account)) contractError('Account must be a Snowflake account identifier');
  return { name, account, user: text(body.user, 'User', 256) };
}

export function validateCortexSetup(value: unknown): { connection: string } {
  const body = exactBody(value, ['connection']);
  return { connection: text(body.connection, 'Connection name', 1024) };
}

export function validateCortexRedirect(value: unknown): { generation: string; redirectUrl: string } {
  const body = exactBody(value, ['generation', 'redirectUrl']);
  return { generation: text(body.generation, 'Generation', 128), redirectUrl: text(body.redirectUrl, 'Redirect URL', 16_384) };
}
