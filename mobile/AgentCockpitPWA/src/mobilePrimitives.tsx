import type { ReactNode } from 'react';

export function Modal(props: { title: string; subtitle?: string; full?: boolean; className?: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className={['modal', props.full ? 'modal-full' : '', props.className].filter(Boolean).join(' ')}>
        <header className="modal-header">
          <div>
            <h2>{props.title}</h2>
            {props.subtitle ? <p>{props.subtitle}</p> : null}
          </div>
          <button className="sheet-close" type="button" onClick={props.onClose}>Close</button>
        </header>
        {props.children}
      </section>
    </div>
  );
}

export function Button(props: { label: string; variant?: 'primary' | 'danger'; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`btn ${props.variant || ''}`} disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

export function Choice(props: { label: string; selected?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`choice ${props.selected ? 'selected' : ''}`} disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner">{message}</div>;
}

export function ProgressBar({ progress }: { progress: number }) {
  return <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>;
}
