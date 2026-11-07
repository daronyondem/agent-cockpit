import type { CortexCodeProfileConfig } from '../types';
import { asRecord, contractError } from './validation';

/** Configuration only; installation and authentication require separate checks. */
export function hasRequiredCliProfileConfig(profile: { harness?: string; cortexCode?: unknown }): boolean {
  if (profile.harness !== 'cortex-code') return true;
  try { parseCortexCodeProfileConfig(profile.cortexCode); return true; }
  catch { return false; }
}

/** Shared request/persistence validation; error messages never include field values. */
export function parseCortexCodeProfileConfig(value: unknown): CortexCodeProfileConfig {
  const config = asRecord(value, 'cortexCode must be an object with a connection name');
  if (Object.keys(config).some(key => key !== 'connection')) {
    contractError('cortexCode accepts only a connection name');
  }
  if (typeof config.connection !== 'string' || !config.connection.trim()
    || /\p{Cc}/u.test(config.connection)) {
    contractError('cortexCode.connection must be a nonempty name without control characters');
  }
  return { connection: config.connection };
}
