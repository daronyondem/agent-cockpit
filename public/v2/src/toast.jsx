/* global React */

/* Toast notifications — non-blocking, corner-anchored, auto-dismiss.
   Complements the anchored-popover Dialog system for transient
   confirmations (save-success, copy-to-clipboard, reset-success, etc.)
   that don't warrant blocking the user with a popover. */

const ToastContext = React.createContext(null);

function ToastProvider({ children }){
  const [toasts, setToasts] = React.useState([]);
  const idRef = React.useRef(0);
  const timersRef = React.useRef(new Map());

  const dismiss = React.useCallback((id) => {
    const t = timersRef.current.get(id);
    if (t) { clearTimeout(t); timersRef.current.delete(id); }
    setToasts(prev => prev.filter(x => x.id !== id));
  }, []);

  const push = React.useCallback((toast) => {
    const id = ++idRef.current;
    const duration = Number.isFinite(toast.duration) ? toast.duration : 4000;
    setToasts(prev => [...prev, { ...toast, id }]);
    if (duration > 0) {
      const timer = setTimeout(() => dismiss(id), duration);
      timersRef.current.set(id, timer);
    }
    return id;
  }, [dismiss]);

  const normalize = (opts) => (typeof opts === 'string' ? { title: opts } : (opts || {}));
  const api = React.useMemo(() => ({
    info:    (opts) => push({ variant: 'info',    ...normalize(opts) }),
    success: (opts) => push({ variant: 'success', ...normalize(opts) }),
    warn:    (opts) => push({ variant: 'warn',    ...normalize(opts) }),
    error:   (opts) => push({ variant: 'error',   ...normalize(opts) }),
    dismiss,
  }), [push, dismiss]);

  /* Expose a global escape hatch so non-React modules (e.g.
     streamStore.js) can surface toasts without wiring React context. */
  React.useEffect(() => {
    window.ToastApi = api;
    return () => { if (window.ToastApi === api) window.ToastApi = null; };
  }, [api]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss}/>
    </ToastContext.Provider>
  );
}

function ToastStack({ toasts, onDismiss }){
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map(t => (
        <ToastRow key={t.id} toast={t} onDismiss={() => onDismiss(t.id)}/>
      ))}
    </div>
  );
}

function ToastRow({ toast, onDismiss }){
  return (
    <div className={`toast toast-${toast.variant || 'info'}`}>
      <div className="toast-body">
        {toast.title ? <div className="toast-title">{toast.title}</div> : null}
        {toast.message ? <div className="toast-msg">{toast.message}</div> : null}
      </div>
      <button className="toast-close" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">×</button>
    </div>
  );
}

function useToasts(){
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToasts must be used within a ToastProvider');
  return ctx;
}

window.ToastProvider = ToastProvider;
window.useToasts = useToasts;
