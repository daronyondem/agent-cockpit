import { AsyncLocalStorage } from 'node:async_hooks';
import { StreamMessageReader } from 'vscode-jsonrpc/node';
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
