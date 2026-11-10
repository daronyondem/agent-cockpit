import crypto from 'crypto';
import type { CortexRpcMessage, StreamEvent } from '../../types';
import { CortexAcpClient, cortexRecord } from './cortexProtocol';

interface PermissionOption { id: string; name: string; kind: string; description?: string; freeForm: boolean }
interface PendingDecision {
  message: CortexRpcMessage;
  id: string;
  kind: 'question' | 'plan';
  title: string;
  options: PermissionOption[];
  plan: string;
}

/** RPC IDs, native tool IDs and UI decision generations are separate identities. */
export class CortexInteractions {
  private pending: PendingDecision[] = [];
  private plan = '';
  private ordinal = 0;
  private generation = crypto.randomUUID();

  constructor(private client: CortexAcpClient, private sessionId: string, private emit: (event: StreamEvent) => void, private allowTools: boolean,
    private onInteractionRequired?: () => void) {}

  get pendingId(): string | null { return this.client.isClosed ? null : this.pending[0]?.id || null; }

  observe(message: CortexRpcMessage): void {
    if (message.method !== 'session/update' || message.params?.sessionId !== this.sessionId) return;
    const update = cortexRecord(message.params.update);
    const meta = cortexRecord(update._meta);
    if (update.sessionUpdate === 'plan' && meta.kind === 'plan_document' && typeof meta.planDocument === 'string') this.plan = meta.planDocument.slice(0, 50_000);
  }

  handle(message: CortexRpcMessage): boolean {
    if (message.id === undefined || message.method !== 'session/request_permission' || message.params?.sessionId !== this.sessionId) return false;
    const params = message.params;
    const call = cortexRecord(params.toolCall);
    const meta = cortexRecord(params._meta);
    const options: PermissionOption[] = Array.isArray(params.options) ? params.options.map(cortexRecord).flatMap(option =>
      typeof option.optionId === 'string' && Boolean(option.optionId.trim()) && typeof option.name === 'string' && Boolean(option.name.trim()) && typeof option.kind === 'string'
        ? [{ id: option.optionId, name: option.name, kind: option.kind,
          ...(typeof option.description === 'string' ? { description: option.description } : {}), freeForm: cortexRecord(option._meta).freeForm === true }] : []) : [];
    const deny = () => { this.client.respond(message.id!, { outcome: { outcome: 'cancelled' } }); this.onInteractionRequired?.(); return true; };
    if (!this.allowTools || !options.length || !Array.isArray(params.options) || options.length !== params.options.length
      || new Set(options.map(option => option.id)).size !== options.length || typeof call.toolCallId !== 'string' || typeof call.title !== 'string') return deny();
    const question = Number.isInteger(meta.questionIndex) && Number.isInteger(meta.totalQuestions)
      && Number(meta.questionIndex) >= 0 && Number(meta.questionIndex) < Number(meta.totalQuestions);
    const plan = call.kind === 'switch_mode';
    if (plan) {
      // 1.2.35 asks separately to enter planning; this never approves execution.
      const enter = call.title === 'Create a plan before executing?' && options.length === 2
        && options.some(option => option.id === 'approve' && option.kind === 'allow_once')
        && options.some(option => option.id === 'decline' && option.kind === 'reject_once');
      if (enter) {
        if (this.onInteractionRequired) return deny();
        this.client.respond(message.id, { outcome: { outcome: 'selected', optionId: 'approve' } });
        this.emit({ type: 'tool_activity', tool: 'EnterPlanMode', id: null, description: 'Preparing plan', isPlanMode: true, planAction: 'enter' });
        return true;
      }
      if (!this.plan.trim() || !options.some(option => option.id === 'proceed' && option.kind === 'allow_once')
        || !options.some(option => option.id === 'keep_planning' && option.kind === 'reject_once')) return deny();
    } else if (question) {
      if (meta.multiSelect === true || options.some(option => option.kind !== 'allow_once')) return deny();
    } else {
      // Only the observed ordinary allow/deny schema may be auto-approved.
      const allow = options.find(option => option.id === 'allow' && option.kind === 'allow_once');
      if (Object.hasOwn(meta, 'questionIndex') || Object.hasOwn(meta, 'totalQuestions') || call.kind !== 'other' || !allow || !options.some(option => option.id === 'deny' && option.kind === 'reject_once')) return deny();
      this.client.respond(message.id, { outcome: { outcome: 'selected', optionId: allow.id } });
      return true;
    }
    if (this.onInteractionRequired) return deny();
    this.pending.push({ message, id: `cortex-decision:${this.generation}:${++this.ordinal}`,
      kind: plan ? 'plan' : 'question', title: call.title, options, plan: this.plan });
    if (this.pending.length === 1) this.present();
    return true;
  }

  input(text: string, decisionId: string): boolean {
    const current = this.pending[0];
    if (this.client.isClosed || !current || current.id !== decisionId || !text.trim() || text.length > 16_000) return false;
    const value = text.trim();
    let outcome: Record<string, unknown>;
    if (current.kind === 'plan') {
      outcome = /^(cancel|abandon)$/i.test(value) ? { outcome: 'cancelled' }
        : /^(yes|approve|approved|continue|run)$/i.test(value) ? { outcome: 'selected', optionId: 'proceed' }
        : { outcome: 'selected', optionId: 'keep_planning', ...(/^(no|reject|rejected)$/i.test(value) ? {} : { _meta: { freeFormText: text } }) };
    } else {
      const matches = current.options.filter(option => option.id === value || option.name === value);
      if (matches.length > 1) return false;
      const option = matches[0];
      if (option?.freeForm) return false; // A free-form selector without actual text is not an answer.
      if (option) outcome = { outcome: 'selected', optionId: option.id };
      else if (/^(cancel|skip)$/i.test(value)) outcome = { outcome: 'cancelled' };
      else {
        const free = current.options.find(option => option.freeForm);
        if (!free) return false;
        outcome = { outcome: 'selected', optionId: free.id, _meta: { freeFormText: text } };
      }
    }
    if (!this.client.respond(current.message.id!, { outcome })) return false;
    this.pending.shift();
    this.emit({ type: 'tool_outcomes', outcomes: [{ toolUseId: current.id, isError: false,
      outcome: outcome.outcome === 'cancelled' ? 'cancelled' : current.kind === 'plan' && outcome.optionId === 'keep_planning' ? 'revision requested' : 'answered',
      status: outcome.outcome === 'cancelled' ? 'warning' : 'success' }] });
    this.present();
    return true;
  }

  cancel(): void {
    for (const item of this.pending) this.client.respond(item.message.id!, { outcome: { outcome: 'cancelled' } });
    this.pending = [];
    this.plan = '';
  }

  private present(): void {
    const current = this.pending[0];
    if (!current) return;
    if (current.kind === 'plan') {
      this.emit({ type: 'tool_activity', tool: 'EnterPlanMode', id: null, description: 'Preparing plan approval', isPlanMode: true, planAction: 'enter' });
      this.emit({ type: 'tool_activity', tool: 'ExitPlanMode', id: current.id, description: 'Plan ready for approval', isPlanMode: true, planAction: 'exit', planContent: current.plan, decisionBound: true });
    } else {
      this.emit({ type: 'tool_activity', tool: 'AskUserQuestion', id: current.id, description: 'Asking a question', isQuestion: true, decisionBound: true,
        questions: [{ question: current.title, options: current.options.map(option => ({ label: option.name, ...(option.description ? { description: option.description } : {}) })) }] });
    }
  }
}
