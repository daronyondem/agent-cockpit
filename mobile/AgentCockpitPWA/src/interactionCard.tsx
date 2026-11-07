import { Button } from './mobilePrimitives';
import type { BackendMetadata, PendingInteraction } from './types';
import { checkBackendRoleEligibility } from '../../../src/contracts/backendCapabilities';

/** Plan decisions send the same tokens as desktop; free text is revision feedback only where the backend accepts it. */
export function InteractionCard(props: {
  interaction: PendingInteraction;
  answer: string;
  backend?: BackendMetadata;
  respondPending?: boolean;
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
          <textarea aria-label="Plan revision feedback" placeholder="Describe changes…" value={props.answer} disabled={props.respondPending} onChange={(event) => props.setAnswer(event.target.value)} rows={3} />
        ) : null}
        <div className="button-row">
          {allowPlanFeedback ? <Button label="Request changes" disabled={props.respondPending || !props.answer.trim()} onClick={() => props.onSubmit()} /> : null}
          <Button label="Reject" disabled={props.respondPending} variant="danger" onClick={() => props.onSubmit('no')} />
          <Button label="Approve & run" disabled={props.respondPending} variant="primary" onClick={() => props.onSubmit('yes')} />
        </div>
      </section>
    );
  }
  return (
    <section className="interaction-card">
      <strong>Question</strong>
      <p>{props.interaction.prompt}</p>
      <div className="button-row">
        {props.interaction.options.map((option) => <Button key={option.label} label={option.label} disabled={props.respondPending} onClick={() => props.setAnswer(option.label)} />)}
      </div>
      <textarea aria-label="Question answer" value={props.answer} disabled={props.respondPending} onChange={(event) => props.setAnswer(event.target.value)} rows={3} />
      <Button label="Answer" variant="primary" disabled={props.respondPending || !props.answer.trim()} onClick={() => props.onSubmit()} />
    </section>
  );
}
