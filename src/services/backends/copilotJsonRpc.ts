import { AsyncLocalStorage } from 'node:async_hooks';
import { ConnectionError, ConnectionErrors, ErrorCodes, StreamMessageReader } from 'vscode-jsonrpc/node';
import type { CopilotClient } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };

const connecting = new AsyncLocalStorage<boolean>();
const listen = StreamMessageReader.prototype.listen;

// vscode-jsonrpc 8.2.1 does not clear its recurring partial-message timer on
// dispose. The SDK does not consume those diagnostic notifications; Cockpit
// owns startup/request deadlines and transport closure. Only our SDK readers
// disable the diagnostic through the reader's public configuration API.
StreamMessageReader.prototype.listen = function (callback) {
  if (connecting.getStore()) this.partialMessageTimeout = 0;
  return listen.call(this, callback);
};

export function connectCopilotClient(client: Pick<CopilotClient, 'start'>): Promise<void> {
  return connecting.run(true, () => client.start());
}

/** Pending RPC rejection can precede the owned process's exit notification. */
export function isCopilotConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === ErrorCodes.MessageWriteError || error.code === ErrorCodes.MessageReadError
    || error.code === ErrorCodes.PendingResponseRejected || error.code === ErrorCodes.ConnectionInactive
    || error instanceof ConnectionError && (error.code === ConnectionErrors.Closed || error.code === ConnectionErrors.Disposed);
}
