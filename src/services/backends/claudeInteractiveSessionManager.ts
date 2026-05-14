import { ClaudeInteractivePtyController } from './claudeInteractivePty';

export class ClaudeInteractiveSessionManager {
  private readonly _controllers = new Map<string, ClaudeInteractivePtyController>();

  attach(conversationId: string | undefined, controller: ClaudeInteractivePtyController): void {
    if (!conversationId) return;
    const previous = this._controllers.get(conversationId);
    if (previous && previous !== controller) previous.kill();
    this._controllers.set(conversationId, controller);
  }

  detach(conversationId: string | undefined, controller?: ClaudeInteractivePtyController): void {
    if (!conversationId) return;
    const current = this._controllers.get(conversationId);
    if (!current || (controller && current !== controller)) return;
    this._controllers.delete(conversationId);
  }

  kill(conversationId: string): void {
    const controller = this._controllers.get(conversationId);
    if (!controller) return;
    controller.kill();
    this._controllers.delete(conversationId);
  }

  shutdown(): void {
    for (const controller of this._controllers.values()) {
      controller.kill();
    }
    this._controllers.clear();
  }
}
