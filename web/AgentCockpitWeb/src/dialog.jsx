import React from 'react';
import { Ico } from './icons.jsx';

/* Anchored popover dialog system for V2 — reusable replacement for
   window.alert / window.confirm / window.prompt.

   Exports on window:
     - Dialog         — low-level primitive component
     - DialogProvider — wraps the app, hosts the single active dialog
     - useDialog      — hook returning { confirm, prompt, alert, choice }
                        each returns a Promise that resolves with the
                        user's selection (or a cancel sentinel).

   Anchored to an HTMLElement (e.g. the button that triggered the
   dialog); falls back to viewport center when anchor is null. */

function useAnchorPosition(anchorEl, panelRef, open, { gap = 10, margin = 32 } = {}){
  const [pos, setPos] = React.useState(null);
  React.useEffect(() => {
    if (!open) return;
    const compute = () => {
      const panel = panelRef.current;
      const pw = panel ? panel.offsetWidth  : 400;
      const ph = panel ? panel.offsetHeight : 220;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (!anchorEl) {
        const top  = Math.max(margin, (vh - ph) / 2);
        const left = Math.max(margin, (vw - pw) / 2);
        setPos({ top, left, placeBelow: true, arrowX: pw / 2 - 6, anchored: false });
        return;
      }
      const r = anchorEl.getBoundingClientRect();
      const spaceBelow = vh - r.bottom - gap - margin;
      const spaceAbove = r.top - gap - margin;
      const placeBelow = spaceBelow >= ph || spaceBelow >= spaceAbove;
      const top = placeBelow
        ? Math.min(r.bottom + gap, vh - ph - margin)
        : Math.max(margin, r.top - gap - ph);
      const centerX = r.left + r.width / 2;
      let left = centerX - pw / 2;
      left = Math.max(margin, Math.min(left, vw - pw - margin));
      const arrowX = Math.max(14, Math.min(pw - 20, centerX - left - 6));
      setPos({ top, left, placeBelow, arrowX, anchored: true });
    };
    compute();
    const raf = requestAnimationFrame(compute);
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [anchorEl, open]);
  return pos;
}

function Dialog({ open, onClose, anchor, variant = 'confirm', title, body,
                  onConfirm, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
                  destructive = false, eyebrow, inputLabel, inputDefault = '', placeholder,
                  choices, defaultChoice,
                  singleAction = false, primaryOnly = false }){
  const panelRef = React.useRef(null);
  const pos = useAnchorPosition(anchor || null, panelRef, open);
  const [val, setVal] = React.useState(inputDefault);
  const [choice, setChoice] = React.useState(defaultChoice || (choices && choices[0] && choices[0].id));
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    setVal(inputDefault || '');
    setChoice(defaultChoice || (choices && choices[0] && choices[0].id));
    const t = setTimeout(() => {
      if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
      else if (panelRef.current) panelRef.current.focus();
    }, 60);
    return () => clearTimeout(t);
  }, [open, inputDefault]);

  const handleConfirm = React.useCallback(() => {
    if (!onConfirm) return;
    if (variant === 'text') onConfirm(val);
    else if (variant === 'choice') onConfirm(choice);
    else onConfirm(true);
  }, [onConfirm, variant, val, choice]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose && onClose(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleConfirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, handleConfirm, onClose]);

  if (!open) return null;

  const defaults = {
    confirm: { eyebrow: 'Confirm',       color: 'var(--text-3)',       icon: Ico.check },
    warn:    { eyebrow: 'Are you sure?', color: 'var(--status-error)', icon: Ico.alert },
    yesno:   { eyebrow: 'Question',      color: 'var(--accent)',       icon: Ico.info  },
    text:    { eyebrow: 'Rename',        color: 'var(--text-3)',       icon: Ico.edit  },
    error:   { eyebrow: 'Error',         color: 'var(--status-error)', icon: Ico.alert },
    info:    { eyebrow: 'Heads up',      color: 'var(--accent)',       icon: Ico.info  },
    choice:  { eyebrow: 'Pick one',      color: 'var(--accent)',       icon: Ico.chev  },
  };
  const meta = defaults[variant] || defaults.confirm;
  const eyebrowText = eyebrow != null ? eyebrow : meta.eyebrow;

  const panelWidth = variant === 'text' ? 380
                   : variant === 'error' ? 420
                   : variant === 'choice' ? 360
                   : variant === 'info' ? 380
                   : 400;

  const style = {
    position: 'fixed',
    width: panelWidth + 'px',
    ...(pos ? { top: pos.top + 'px', left: pos.left + 'px' } : { visibility: 'hidden', top: 0, left: 0 }),
  };
  const placeBelow = pos ? pos.placeBelow : true;
  const anchored = pos ? pos.anchored : true;
  const arrowLeft = pos ? pos.arrowX + 'px' : '50%';
  const hintText = (variant === 'info' || variant === 'error') ? 'Dismiss'
                 : destructive ? 'Confirm' : 'Confirm';

  return (
    <>
      <div className="dlg-scrim" onClick={() => onClose && onClose()} />
      <div className="dlg-panel" ref={panelRef} tabIndex={-1} style={style}
           role="dialog" aria-modal="true" aria-labelledby="dlg-title"
           data-variant={variant} data-destructive={destructive ? 'true' : 'false'}
           data-placement={placeBelow ? 'below' : 'above'}
           data-anchored={anchored ? 'true' : 'false'}>
        {anchored && <div className="dlg-arrow" style={{ left: arrowLeft }}/>}
        <header className="dlg-head">
          <span className="dlg-glyph" style={{ color: meta.color }}>{meta.icon && meta.icon(14)}</span>
          <span className="dlg-eyebrow">{eyebrowText}</span>
          <span className="dlg-esc">esc</span>
        </header>

        <h3 className="dlg-title" id="dlg-title">{title}</h3>

        {body ? <div className="dlg-body">{body}</div> : null}

        {variant === 'text' ? (
          <div className="dlg-input-wrap">
            {inputLabel ? <label className="dlg-label">{inputLabel}</label> : null}
            <input ref={inputRef}
              className="dlg-input"
              type="text"
              value={val}
              placeholder={placeholder || ''}
              onChange={e => setVal(e.target.value)}
            />
          </div>
        ) : null}

        {variant === 'choice' && choices ? (
          <div className="dlg-choices">
            {choices.map(c => (
              <label key={c.id} className={`dlg-choice ${choice === c.id ? 'active' : ''}`}>
                <input type="radio" name="dlg-choice" checked={choice === c.id} onChange={() => setChoice(c.id)}/>
                <span className="dlg-radio"/>
                <span className="dlg-choice-body">
                  <b>{c.label}</b>
                  {c.hint ? <em>{c.hint}</em> : null}
                </span>
              </label>
            ))}
          </div>
        ) : null}

        <footer className="dlg-foot">
          <span className="dlg-hint"><kbd>↵</kbd> {hintText}</span>
          <span style={{flex:1}}/>
          {!(primaryOnly || singleAction) ? (
            <button className="dlg-btn ghost" onClick={() => onClose && onClose()}>{cancelLabel}</button>
          ) : null}
          <button
            className={`dlg-btn primary ${destructive ? 'danger' : ''}`}
            onClick={handleConfirm}
            autoFocus
          >{confirmLabel}</button>
        </footer>
      </div>
    </>
  );
}

const DialogContext = React.createContext(null);

function DialogProvider({ children }){
  const [pending, setPending] = React.useState(null);
  /* pending: null | { ...dialogProps, resolve, cancelValue } */

  const openDialog = React.useCallback((opts) => {
    return new Promise(resolve => {
      setPending(current => {
        if (current && current.resolve) current.resolve(current.cancelValue);
        return { ...opts, resolve };
      });
    });
  }, []);

  const close = React.useCallback((value) => {
    setPending(current => {
      if (current && current.resolve) current.resolve(value);
      return null;
    });
  }, []);

  const api = React.useMemo(() => ({
    confirm: (opts) => openDialog({
      variant: opts && opts.destructive ? 'warn' : ((opts && opts.variant) || 'confirm'),
      cancelValue: false,
      ...opts,
    }),
    prompt: (opts) => openDialog({
      variant: 'text',
      cancelValue: null,
      ...opts,
    }),
    alert: (opts) => openDialog({
      variant: (opts && opts.variant) || 'info',
      singleAction: true,
      cancelValue: undefined,
      confirmLabel: 'Got it',
      ...opts,
    }),
    choice: (opts) => openDialog({
      variant: 'choice',
      cancelValue: null,
      ...opts,
    }),
  }), [openDialog]);

  const isText   = pending && pending.variant === 'text';
  const isChoice = pending && pending.variant === 'choice';
  const isSingle = pending && pending.singleAction;

  const onCancel  = () => close(pending ? pending.cancelValue : undefined);
  const onConfirm = (v) => {
    if (!pending) return;
    const result = isText || isChoice ? v
                 : isSingle ? undefined
                 : true;
    close(result);
  };

  return (
    <DialogContext.Provider value={api}>
      {children}
      <Dialog
        open={!!pending}
        onClose={onCancel}
        onConfirm={onConfirm}
        {...(pending || {})}
      />
    </DialogContext.Provider>
  );
}

export function useDialog(){
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within a DialogProvider');
  return ctx;
}

export { Dialog, DialogProvider };
