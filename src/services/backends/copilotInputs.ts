import crypto from 'crypto';
import type { CopilotSession, SessionConfigBase, SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { BackendInputRequest, BackendInputResult, StreamEvent } from '../../types';

type UserInputHandler = NonNullable<SessionConfigBase['onUserInputRequest']>;
type UserInputRequest = Parameters<UserInputHandler>[0];
type UserInputResponse = Awaited<ReturnType<UserInputHandler>>;

interface Question {
  id: string;
  request: UserInputRequest;
  resolve: (response: UserInputResponse) => void;
  reject: (error: Error) => void;
}
interface Steering {
  text: string;
  messageId?: string;
  acknowledgement?: Promise<string | null>;
  completion?: Promise<void>;
  pollTimer?: ReturnType<typeof setTimeout>;
  resolve: (result: BackendInputResult) => void;
}
const rejected = (error: string, status: 400 | 409 | 503 = 409): BackendInputResult => ({ accepted: false, status, error });

/** Own correlated questions and pause native follow-ups so only Cockpit drains its queue. */
export class CopilotInputs {
  readonly turnId = crypto.randomUUID();
  private questions: Question[] = [];
  private steering: Steering | null = null;
  private consumed = new Set<string>();
  private inputIds = new Set<string>();
  private ready = false;
  private ended = false;
  private cancelled = false;
  private ending?: Promise<void>;

  constructor(private session: CopilotSession, private emit: (event: StreamEvent) => void,
    private request: <T>(promise: Promise<T>) => Promise<T>, private fail: (message: string) => void) {}

  async enableSteering(): Promise<void> {
    if (this.ended) return;
    let acquired = false;
    try {
      await this.request(this.session.rpc.queue.pendingItems());
      if (this.ended) return;
      await this.request(this.session.rpc.queue.setDrainPaused({ paused: true })); acquired = true;
      if (this.ended) return;
      await this.request(this.session.rpc.queue.setDrainPaused({ paused: false }));
    } catch {
      if (acquired && !this.cancelled) this.fail('Copilot could not release its native queue pause; the turn was stopped.');
      return; // Older runtimes retain chat/questions without exposing unsafe steering.
    }
    if (!this.ended) { this.ready = true; this.emit({ type: 'input_ready', turnId: this.turnId }); }
  }

  ask(request: UserInputRequest): Promise<UserInputResponse> {
    if (this.ended) return Promise.reject(new Error('Copilot input request is no longer active.'));
    return new Promise((resolve, reject) => {
      this.questions.push({ id: crypto.randomUUID(), request, resolve, reject });
      if (this.questions.length === 1) this.present();
    });
  }

  async deliver(input: BackendInputRequest): Promise<BackendInputResult> {
    if (this.ended) return rejected('This Copilot turn has ended. Your input was not sent.');
    const text = input.text.trim();
    if (!text) return rejected('Input text is required.', 400);
    if (input.requestId) {
      const question = this.questions[0];
      if (!question || question.id !== input.requestId) return rejected('This question is no longer awaiting an answer.');
      const wasFreeform = !question.request.choices?.includes(text);
      if (wasFreeform && question.request.allowFreeform === false) return rejected('Choose one of the offered answers.', 400);
      this.questions.shift();
      this.resolved(question.id, 'answered');
      question.resolve({ answer: text, wasFreeform });
      this.present();
      return { accepted: true };
    }
    if (!input.turnId || !input.inputId) return rejected('Correlated question or steering input is required.', 400);
    if (input.turnId !== this.turnId || !this.ready) return rejected('This Copilot turn is not accepting steering. Your draft was preserved.');
    if (this.questions.length) return rejected('Answer the pending question before steering.');
    if (this.steering || this.inputIds.has(input.inputId)) return rejected('This input is already pending or was submitted previously.');
    this.inputIds.add(input.inputId);
    return new Promise(resolve => {
      const steering: Steering = { text, resolve };
      this.steering = steering;
      // The paused queued lane prevents a late immediate message becoming an
      // automatic second execution. Only a native steering-delivery event accepts it.
      steering.acknowledgement = (async () => {
        await this.request(this.session.rpc.queue.setDrainPaused({ paused: true }));
        if (this.ended) { this.settleSteering(steering, rejected('The turn finished before consuming your steering. Your draft was preserved.')); return null; }
        return this.request(this.session.send({ prompt: text, mode: 'immediate' }));
      })();
      void steering.acknowledgement.then(id => {
        if (!id || this.cancelled) return;
        steering.messageId = id;
        if (this.consumed.has(id)) void this.completeSteering(steering, true).catch(() => {});
        else this.pollSteering(steering);
      }, () => {
        if (!this.cancelled) this.fail('Copilot steering delivery failed. Delivery is uncertain; the turn was stopped.');
        this.settleSteering(steering, rejected('Copilot steering delivery failed. Do not automatically resend this input.', 503));
      });
    });
  }

  handle(event: SessionEvent): void {
    if (this.ended || event.agentId || event.type !== 'user.message' || event.data.delivery !== 'steering') return;
    const id = event.data.messageId;
    if (!id) return;
    this.consumed.add(id);
    if (this.steering?.messageId === id) void this.completeSteering(this.steering, true).catch(() => {});
  }

  finish(): Promise<void> {
    if (this.ending) return this.ending;
    this.endQuestions();
    this.ending = (async () => {
      const steering = this.steering;
      if (!steering || this.cancelled) return;
      const messageId = await steering.acknowledgement;
      if (!messageId || this.cancelled) return;
      await this.completeSteering(steering, this.consumed.has(messageId));
    })().catch(error => {
      if (this.cancelled) return;
      if (this.steering) this.settleSteering(this.steering, rejected('Copilot could not safely discard late steering. The turn was stopped; do not automatically resend.', 503));
      throw error;
    });
    return this.ending;
  }

  cancel(): void {
    this.cancelled = true;
    this.endQuestions();
    if (this.steering) this.settleSteering(this.steering, rejected('Copilot input was cancelled. Your draft was preserved.'));
  }

  private endQuestions(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.ready) this.emit({ type: 'input_ready', turnId: null });
    this.ready = false;
    if (this.steering) clearTimeout(this.steering.pollTimer);
    for (const question of this.questions) {
      this.resolved(question.id, 'cancelled');
      question.reject(new Error('Copilot input request was cancelled.'));
    }
    this.questions = [];
  }

  private completeSteering(steering: Steering, accepted: boolean): Promise<void> {
    if (steering.completion) return steering.completion;
    clearTimeout(steering.pollTimer);
    steering.completion = (async () => {
      if (!accepted) {
        const removed = await this.request(this.session.rpc.queue.withdrawMessage({ messageId: steering.messageId!, expectedPrompt: steering.text }));
        if (!removed.removed || removed.interrupted) throw new Error('Copilot could not safely withdraw unconsumed steering.');
      }
      if (this.cancelled) return;
      // Native background-completion notifications also use this queued lane.
      // Resume them only after consumption or exact removal of our message.
      await this.request(this.session.rpc.queue.setDrainPaused({ paused: false }));
      this.settleSteering(steering, accepted ? { accepted: true }
        : rejected('The current work finished before consuming your steering. Your draft was preserved; send or queue it when ready.'));
    })().catch(error => {
      if (this.cancelled) return;
      this.fail('Copilot input cleanup failed; the turn was stopped without retry.');
      this.settleSteering(steering, rejected('Copilot input delivery could not be safely completed. The turn was stopped; do not automatically resend.', 503));
      throw error;
    });
    return steering.completion;
  }

  private pollSteering(steering: Steering): void {
    if (this.ended || this.steering !== steering || steering.completion) return;
    steering.pollTimer = setTimeout(() => {
      void (async () => {
        const pending = await this.request(this.session.rpc.queue.pendingItems());
        if (this.cancelled || this.steering !== steering) return;
        // Promotion is observable even before session idle when native
        // background notifications are waiting behind the paused correction.
        if (pending.items.some(item => item.messageId === steering.messageId)) await this.completeSteering(steering, false);
        else this.pollSteering(steering);
      })().catch(() => {
        if (this.cancelled || this.steering !== steering) return;
        this.fail('Copilot steering queue inspection failed; the turn was stopped without retry.');
        this.settleSteering(steering, rejected('Copilot steering status is uncertain. The turn was stopped; do not automatically resend.', 503));
      });
    }, 100);
  }

  private settleSteering(steering: Steering, result: BackendInputResult): void {
    if (this.steering !== steering) return;
    clearTimeout(steering.pollTimer);
    this.steering = null;
    steering.resolve(result);
  }

  private present(): void {
    const question = this.questions[0];
    if (!question) return;
    this.emit({ type: 'tool_activity', tool: 'AskUserQuestion', id: question.id, inputRequestId: question.id, description: 'Copilot needs an answer', isQuestion: true,
      questions: [{ question: question.request.question, options: question.request.choices?.map(label => ({ label })), allowFreeform: question.request.allowFreeform !== false }] });
  }

  private resolved(id: string, outcome: string): void {
    this.emit({ type: 'tool_outcomes', outcomes: [{ toolUseId: id, isError: false, outcome, status: 'success' }] });
  }
}
