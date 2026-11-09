import type { Usage } from '../../types';
import { copilotTurnUsage, copilotUnavailableUsage } from './copilotUsage';

/** Reconcile every live snapshot against the last charged native checkpoint. */
export class CopilotLiveUsage {
  private pending: Promise<void> | null = null;
  private dirty = false;
  private unavailable = false;

  constructor(private checkpoint: Usage | null, private read: () => Promise<Usage | null>, private emit: (usage: Usage) => void) {}

  request(): void {
    this.dirty = true;
    if (this.pending) return;
    this.pending = (async () => {
      while (this.dirty) { this.dirty = false; await this.reconcile(); }
    })().finally(() => { this.pending = null; });
    void this.pending.catch(() => {}); // The owning turn handles cancellation.
  }

  async finish(): Promise<void> {
    await this.pending;
    await this.reconcile();
  }

  private async reconcile(): Promise<void> {
    const current = await this.read();
    if (!this.checkpoint || !current) {
      if (!this.unavailable) this.emit(copilotUnavailableUsage());
      this.unavailable = true;
      return;
    }
    const delta = copilotTurnUsage(current, this.checkpoint);
    const changed = JSON.stringify(current) !== JSON.stringify(this.checkpoint);
    this.checkpoint = current;
    if (changed) this.emit(delta);
  }
}
