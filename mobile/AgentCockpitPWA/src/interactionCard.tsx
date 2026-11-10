import { Button } from './mobilePrimitives';
import type { BackendMetadata, PendingInteraction } from './types';
import { checkBackendRoleEligibility } from '../../../src/contracts/backendCapabilities';

/** Plan decisions send the same tokens as desktop; free text is revision feedback only where the backend accepts it. */
export function InteractionCard(props: {
  interaction: PendingInteraction;
  answer: string;
  backend?: BackendMetadata;
  pending?: boolean;
  setAnswer: (value: string) => void;
  onSubmit: (answer?: string) => void;
}) {
  const allowPlanFeedback = checkBackendRoleEligibility(props.backend, { role: 'planRevision' }).ok;
  if (props.interaction.kind === 'plan') {
    return (
      <section className="interaction-card">
        <strong>Plan Approval</strong>
        <p>{props.interaction.prompt}</p>
        {allowPlanFeedback ? (
          <textarea aria-label="Plan revision feedback" placeholder="Describe changes…" value={props.answer} disabled={props.pending} onChange={(event) => props.setAnswer(event.target.value)} rows={3} />
        ) : null}
        <div className="button-row">
          {allowPlanFeedback ? <Button label="Request changes" disabled={props.pending || !props.answer.trim()} onClick={() => props.onSubmit()} /> : null}
          <Button label="Reject" disabled={props.pending} variant="danger" onClick={() => props.onSubmit('no')} />
          <Button label="Approve & run" disabled={props.pending} variant="primary" onClick={() => props.onSubmit('yes')} />
        </div>
      </section>
    );
  }
  return (
    <section className="interaction-card">
      <strong>Question</strong>
      <p>{props.interaction.prompt}</p>
      <div className="button-row">
        {props.interaction.options.map((option) => <Button key={option.label} label={option.label} disabled={props.pending} onClick={() => props.interaction.kind === 'question' && props.interaction.allowFreeform === false ? props.onSubmit(option.label) : props.setAnswer(option.label)} />)}
      </div>
      {props.interaction.allowFreeform !== false ? <>
        <textarea aria-label="Question answer" value={props.answer} disabled={props.pending} onChange={(event) => props.setAnswer(event.target.value)} rows={3} />
        <Button label="Answer" variant="primary" disabled={props.pending || !props.answer.trim()} onClick={() => props.onSubmit()} />
      </> : null}
    </section>
  );
}
