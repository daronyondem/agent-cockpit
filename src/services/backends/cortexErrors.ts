import type { ErrorEvent } from '../../types';
import { cortexRecord, CortexRpcError } from './cortexProtocol';
import { cortexHasCompleteUsage } from './cortexUsage';

/** Only locally authored, value-free validation messages may cross this boundary. */
export class CortexInputError extends Error {}
export class CortexMissingSessionError extends Error {}
/** Locally authored, value-free inactivity watchdog stop. */
export class CortexInactivityError extends Error {}

/** Exact native load failure observed on 1.2.35; never classify connection/auth errors. */
export function cortexMissingSession(error: unknown, sessionId: string, version: string): boolean {
  return (version === '1.2.35' || version.startsWith('1.2.35+'))
    && error instanceof CortexRpcError && error.code === -32603 && error.message === 'Internal error'
    && cortexRecord(error.data).details === `Failed to load session ${sessionId}: Session '${sessionId}' not found`;
}

export function cortexTerminalError(value: unknown, text: string, version: string): ErrorEvent | null {
  const result = cortexRecord(value);
  if (result.stopReason === 'cancelled') return { type: 'error', error: 'Cortex turn cancelled', source: 'abort' };
  if (result.stopReason !== 'end_turn') {
    return { type: 'error', error: 'Cortex stopped before completing the turn', source: 'backend' };
  }
  // These native failures were observed only as text, without final usage.
  // Successful answers quoting errors still carry usage or surrounding prose.
  if (!cortexHasCompleteUsage(result.usage) && /^Error:/i.test(text.trim())) {
    const native = version === '1.2.35' || version.startsWith('1.2.35+');
    if (native && /^Error: Connection error: Error: No Snowflake connection available\./.test(text.trim())) {
      return { type: 'error', error: 'Cortex could not connect. Check the selected Snowflake connection and authentication.', source: 'backend' };
    }
    const api = native && text.trim().match(/^Error: Error: API error ([45]\d\d):/);
    if (api) return { type: 'error', error: api[1] === '408' ? 'The Snowflake request timed out.' : `The Snowflake request failed (HTTP ${api[1]}).`, source: 'backend' };
    return { type: 'error', error: 'Cortex returned an unrecognized error. Check the CLI connection and service status.', source: 'backend' };
  }
  return null;
}

export function cortexRuntimeError(error: unknown): ErrorEvent {
  if (error instanceof CortexInputError) return { type: 'error', error: error.message, source: 'backend' };
  if (error instanceof CortexInactivityError) return { type: 'error', error: error.message, source: 'transport' };
  if (error instanceof Error && error.message === 'Cortex ACP request timed out') {
    return { type: 'error', error: 'Cortex request timed out; its runtime was stopped.', source: 'transport' };
  }
  // Native RPC text/data can contain accounts, URLs and credentials. Never echo it.
  return { type: 'error', error: error instanceof CortexRpcError ? 'Cortex rejected the request.' : 'Cortex runtime stopped unexpectedly.', source: 'transport' };
}
