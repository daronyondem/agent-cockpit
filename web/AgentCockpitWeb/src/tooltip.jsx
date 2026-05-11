import React from 'react';
/* ============================================================
   Tooltip — editorial + cockpit hybrid
   Usage A (declarative, hover):
     <Tip content="Copy link">
       <button>...</button>
     </Tip>
   Usage B (programmatic — pass a ref):
     const ref = useTip();
     <Tip ref={ref} content={...}><button>...</button></Tip>
     ref.show() / ref.hide() / ref.toggle()  // without needing a hover
   Usage C (rich variants — pass `variant` + `rich` content):
     <Tip variant="stat" rich={<TokenCard/>}><span>18.4k</span></Tip>
   ============================================================ */

const TipContext = React.createContext(null);

function useAnchorPos(anchorRef, panelRef, open, { gap = 8, margin = 16 } = {}){
  const [pos, setPos] = React.useState(null);
  React.useEffect(() => {
    if (!open || !anchorRef.current) return;
    const compute = () => {
      const a = anchorRef.current.getBoundingClientRect();
      const p = panelRef.current;
      const pw = p ? p.offsetWidth  : 200;
      const ph = p ? p.offsetHeight : 60;
      const vw = window.innerWidth, vh = window.innerHeight;
      const below = vh - a.bottom - gap - margin;
      const above = a.top - gap - margin;
      const placeBelow = below >= ph || below >= above;
      const top = placeBelow
        ? Math.min(a.bottom + gap, vh - ph - margin)
        : Math.max(margin, a.top - gap - ph);
      const centerX = a.left + a.width/2;
      let left = centerX - pw/2;
      left = Math.max(margin, Math.min(left, vw - pw - margin));
      const arrowX = Math.max(12, Math.min(pw - 18, centerX - left - 5));
      setPos({ top, left, placeBelow, arrowX });
    };
    compute();
    const raf = requestAnimationFrame(compute);
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open]);
  return pos;
}

export const Tip = React.forwardRef(function Tip(props, outerRef){
  const {
    children, content, rich, variant = "label",
    delay = 300, closeDelay = 80,
    kb, pinned: pinnedProp,
    ...rest
  } = props;
  const anchorRef = React.useRef(null);
  const panelRef  = React.useRef(null);
  const [open, setOpen]   = React.useState(false);
  const [pinned, setPinned] = React.useState(!!pinnedProp);
  const openTimer  = React.useRef(null);
  const closeTimer = React.useRef(null);

  const pos = useAnchorPos(anchorRef, panelRef, open);

  const clear = () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); };
  const show  = () => { clear(); openTimer.current  = setTimeout(()=>setOpen(true),  delay); };
  const hide  = () => {
    if (pinned) return;
    clear(); closeTimer.current = setTimeout(()=>setOpen(false), closeDelay);
  };
  const showNow = () => { clear(); setOpen(true); };
  const hideNow = () => { clear(); setOpen(false); setPinned(false); };

  // expose imperative API
  React.useImperativeHandle(outerRef, () => ({
    show: showNow, hide: hideNow, toggle: () => setOpen(o=>!o),
    pin: () => { setPinned(true); setOpen(true); },
    unpin: () => setPinned(false),
    anchor: () => anchorRef.current,
  }), []);

  // click-outside when pinned
  React.useEffect(() => {
    if (!pinned) return;
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      if (anchorRef.current?.contains(e.target)) return;
      setPinned(false); setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pinned]);

  // Clone the single child to attach handlers + ref
  const child = React.Children.only(children);
  const merged = {
    ref: (node) => {
      anchorRef.current = node;
      const r = child.ref;
      if (typeof r === "function") r(node);
      else if (r && typeof r === "object") r.current = node;
    },
    onMouseEnter: (e) => { child.props.onMouseEnter && child.props.onMouseEnter(e); show(); },
    onMouseLeave: (e) => { child.props.onMouseLeave && child.props.onMouseLeave(e); hide(); },
    onFocus:      (e) => { child.props.onFocus && child.props.onFocus(e); showNow(); },
    onBlur:       (e) => { child.props.onBlur && child.props.onBlur(e); if (!pinned) hideNow(); },
    "aria-describedby": open ? "tt-active" : undefined,
  };
  const anchor = React.cloneElement(child, merged);

  const placeBelow = pos ? pos.placeBelow : true;
  const style = pos
    ? { top: pos.top, left: pos.left }
    : { visibility: "hidden", top: 0, left: 0 };
  const arrowStyle = { left: pos ? pos.arrowX : 12 };

  const body = (() => {
    if (variant === "label"){
      return (
        <>
          {content}
          {kb && <span className="tt-kb">{kb}</span>}
        </>
      );
    }
    if (variant === "shortcut"){
      return (
        <>
          {content && <span>{content}</span>}
          {kb && kb.split(" ").map((k,i,arr) => (
            <React.Fragment key={i}>
              <span className="kbd">{k}</span>
              {i < arr.length - 1 && <span className="sep">then</span>}
            </React.Fragment>
          ))}
        </>
      );
    }
    return rich;
  })();

  return (
    <>
      {anchor}
      {open && (
        <div
          id="tt-active"
          role="tooltip"
          ref={panelRef}
          className="tt"
          data-variant={variant}
          data-placement={placeBelow ? "below" : "above"}
          data-pinned={pinned ? "true" : "false"}
          style={style}
          onMouseEnter={() => { if (!pinned) clear(); }}
          onMouseLeave={hide}
        >
          <span className="tt-arrow" style={arrowStyle}/>
          {body}
        </div>
      )}
    </>
  );
});

/* Convenience hook so usage is one-liner */
export function useTip(){
  return React.useRef(null);
}
