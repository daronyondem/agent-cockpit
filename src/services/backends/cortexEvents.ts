import type { StreamEvent, CortexRpcMessage } from '../../types';
import { cortexRecord } from './cortexProtocol';
import { extractToolDetails } from './toolUtils';
import { CortexTurnUsage } from './cortexUsage';

const TOOLS: Record<string, string> = {
  read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', grep: 'Grep', glob: 'Glob',
  ask_user_question: 'AskUserQuestion', enter_plan_mode: 'EnterPlanMode', exit_plan_mode: 'ExitPlanMode',
  web_search: 'WebSearch', web_fetch: 'WebFetch', task: 'Task',
};

export function cortexToolText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.flatMap(item => {
    const block = cortexRecord(item);
    const nested = cortexRecord(block.content);
    if (block.type === 'content' && nested.type === 'text' && typeof nested.text === 'string') return [nested.text];
    if (block.type === 'diff' && typeof block.path === 'string') return [`Updated ${block.path}`
      + (typeof block.oldText === 'string' ? `\n---\n${block.oldText}` : '')
      + (typeof block.newText === 'string' ? `\n+++\n${block.newText}` : '')];
    if (block.type === 'content' && nested.type === 'resource' && typeof cortexRecord(nested.resource).text === 'string') return [String(cortexRecord(nested.resource).text)];
    if (block.type === 'content' && nested.type === 'resource_link' && typeof nested.name === 'string') return [nested.name];
    if (block.type === 'resource_link' && typeof block.name === 'string') return [block.name];
    return [];
  }).join('\n');
}

export class CortexEventDecoder {
  finalText = '';
  readonly deliveries: string[] = [];
  readonly usage = new CortexTurnUsage();
  private tools = new Map<string, { tool: string; finished: boolean }>();
  private textCommitted = false;
  private textBuffer = '';

  constructor(readonly sessionId: string) {}

  decode(message: CortexRpcMessage): StreamEvent[] {
    if (message.method !== 'session/update' || message.params?.sessionId !== this.sessionId) return [];
    const update = cortexRecord(message.params.update);
    if (update.sessionUpdate === 'usage_update') { this.usage.snapshot(update); return []; }
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      const content = cortexRecord(update.content);
      if (content.type !== 'text' || typeof content.text !== 'string') return [];
      if (update.sessionUpdate === 'agent_thought_chunk') return [{ type: 'thinking', content: content.text, streaming: true }];
      this.finalText += content.text;
      if (this.textCommitted) return this.visible(content.text);
      const prefix = this.finalText.trimStart().toLowerCase();
      // Hold a possible native terminal error until the result classifies it.
      if (!prefix || 'error:'.startsWith(prefix) || prefix.startsWith('error:')) return [];
      return this.flushText();
    }
    if (!['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)) || typeof update.toolCallId !== 'string') return [];
    const id = update.toolCallId;
    const events: StreamEvent[] = [];
    let tool = this.tools.get(id);
    if (!tool) {
      const title = typeof update.title === 'string' ? update.title : 'Tool';
      const native = title.split(':')[0];
      tool = { tool: TOOLS[native] || title, finished: false };
      this.tools.set(id, tool);
      events.push(...this.finishText());
      if (this.finalText.trim()) events.push({ type: 'turn_boundary' });
      this.finalText = '';
      this.textCommitted = false;
      const detail = extractToolDetails({ type: 'tool_use', id, name: tool.tool, input: cortexRecord(update.rawInput) });
      // Interactive cards come from the reverse RPC, never an empty tool call.
      events.push({ type: 'tool_activity', id, tool: tool.tool, description: detail.description || title });
    }
    if (!tool.finished && (update.status === 'completed' || update.status === 'failed')) {
      tool.finished = true;
      const text = cortexToolText(update.content) || (typeof update.rawOutput === 'string' ? update.rawOutput : '');
      events.push({ type: 'tool_outcomes', outcomes: [{ toolUseId: id, isError: update.status === 'failed',
        status: update.status === 'failed' ? 'error' : 'success', outcome: text.slice(0, 1000) || String(update.status) }] });
    }
    return events;
  }

  flushText(): StreamEvent[] {
    if (this.textCommitted || !this.finalText) return [];
    this.textCommitted = true;
    return this.visible(this.finalText);
  }

  get resultText(): string { return this.finalText.replace(/<!--\s*FILE_DELIVERY:[\s\S]*?-->/g, '').trim(); }

  finishText(): StreamEvent[] { return [...this.flushText(), ...this.visible('', true)]; }

  /** Remove complete delivery comments without exposing partial markers to clients. */
  private visible(text: string, final = false): StreamEvent[] {
    this.textBuffer += text;
    let output = '';
    while (this.textBuffer) {
      const start = this.textBuffer.indexOf('<!--');
      if (start < 0) {
        let keep = 0;
        if (!final) for (let n = 1; n <= 3; n++) if (this.textBuffer.endsWith('<!--'.slice(0, n))) keep = n;
        output += this.textBuffer.slice(0, this.textBuffer.length - keep);
        this.textBuffer = keep ? this.textBuffer.slice(-keep) : '';
        break;
      }
      output += this.textBuffer.slice(0, start);
      this.textBuffer = this.textBuffer.slice(start);
      const end = this.textBuffer.indexOf('-->');
      if (end < 0) {
        if (final || this.textBuffer.length > 8192) { output += this.textBuffer; this.textBuffer = ''; }
        break;
      }
      const comment = this.textBuffer.slice(0, end + 3);
      const match = comment.match(/^<!--\s*FILE_DELIVERY:([\s\S]*?)-->$/);
      if (match) {
        const file = match[1].trim();
        if (file && file.length <= 4096 && this.deliveries.length < 10) this.deliveries.push(file);
      } else output += comment;
      this.textBuffer = this.textBuffer.slice(end + 3);
    }
    return output ? [{ type: 'text', content: output, streaming: true }] : [];
  }
}
