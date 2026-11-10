import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArtifactEvent, CortexRpcMessage } from '../../types';
import { cortexRecord } from './cortexProtocol';
import { cortexPathWithin } from './cortexAttachments';

/** Explicit delivery only: completed file-resource links or assistant delivery markers. */
export class CortexArtifacts {
  private calls = new Map<string, Record<string, unknown>>();
  private emitted = new Set<string>();
  private authored = new Map<string, string>();
  private completedOutput = false;

  constructor(private sessionId: string, private cwd: string) {}

  async collect(message: CortexRpcMessage): Promise<ArtifactEvent[]> {
    if (message.method !== 'session/update' || message.params?.sessionId !== this.sessionId) return [];
    const update = cortexRecord(message.params.update);
    if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string') return [];
    const call = { ...this.calls.get(update.toolCallId), ...update };
    this.calls.set(update.toolCallId, call);
    if (call.status !== 'completed') return [];
    const title = typeof call.title === 'string' ? call.title.split(':')[0] : '';
    const authored = ['write', 'edit'].includes(title) || call.kind === 'edit';
    const resources = Array.isArray(call.content) ? call.content.map(cortexRecord) : [];
    const candidates: string[] = [];
    if (authored) {
      const input = cortexRecord(call.rawInput);
      const written = typeof input.file_path === 'string' ? [input.file_path] : [];
      for (const block of resources) if (block.type === 'diff' && typeof block.path === 'string') written.push(block.path);
      for (const file of written) {
        try { this.authored.set(await fs.realpath(path.resolve(this.cwd, file)), update.toolCallId); } catch { /* unavailable output */ }
      }
    }
    if (authored || call.kind === 'execute') this.completedOutput = true;
    if (authored || call.kind === 'execute') for (const block of resources) {
      const resource = block.type === 'content' ? cortexRecord(block.content) : block;
      if (resource.type === 'resource_link' && typeof resource.uri === 'string') {
        try { candidates.push(fileURLToPath(resource.uri)); } catch { /* non-file resources are not artifacts */ }
      }
    }
    return this.files(candidates, update.toolCallId);
  }

  async deliver(paths: string[]): Promise<ArtifactEvent[]> {
    if (!this.completedOutput) return [];
    return this.files(paths.slice(0, 10));
  }

  private async files(candidates: string[], toolId?: string): Promise<ArtifactEvent[]> {
    const events: ArtifactEvent[] = [];
    for (const candidate of candidates) {
      try {
        const [root, file] = await Promise.all([fs.realpath(this.cwd), fs.realpath(path.resolve(this.cwd, candidate))]);
        if (!cortexPathWithin(root, file) || file.split(path.sep).includes('.cortex')) continue;
        const stat = await fs.stat(file);
        const identity = `${file}:${stat.size}:${stat.mtimeMs}`;
        if (!stat.isFile() || stat.size > 50 * 1024 * 1024 || this.emitted.has(identity)) continue;
        this.emitted.add(identity);
        events.push({ type: 'artifact', sourcePath: file, filename: path.basename(file), sourceToolId: toolId || this.authored.get(file) || null });
      } catch { /* deleted/unavailable files do not fabricate artifacts */ }
    }
    return events;
  }
}
