import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import useDismissOnOutside from "../../hooks/useDismissOnOutside.js";
import "./FilterPopover.css";

// Filters anchored under their own button rather than centred on screen: the
// filters describe the list right behind them, and a centred dialog hid that
// list while you chose.
//
// The caller owns the draft state and receives it back on Apply, so the fields
// inside can be anything. `activeCount` drives the badge — count only the
// filters that actually narrow the list, or the badge is permanently lit.
export default function FilterPopover({
  activeCount = 0,
  label = "Filters",
  title = "Filters",
  hint,
  onApply,
  onReset,
  applyLabel = "Apply filters",
  children,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // The wrapper holds the button too: without it, clicking the button while the
  // panel is open would dismiss and re-open in the same gesture.
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutside(wrapRef, close, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <div className="fpop-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`fpop__btn ${activeCount ? "fpop__btn--on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
        {label}
        {activeCount > 0 && <span className="fpop__badge">{activeCount}</span>}
      </button>

      {open && (
        <div className="fpop" role="dialog" aria-label={title}>
          <div className="fpop__hdr">
            <span className="fpop__title">
              <SlidersHorizontal size={16} aria-hidden="true" />
              {title}
            </span>
            <button type="button" className="fpop__x" onClick={close} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          <div className="fpop__body">
            <div className="fpop__grid">{children}</div>
            {hint && <p className="fpop__hint">{hint}</p>}
          </div>

          <div className="fpop__foot">
            <button type="button" className="fpop__reset" onClick={onReset}>
              <RotateCcw size={14} aria-hidden="true" />
              Reset
            </button>
            <button
              type="button"
              className="fpop__apply"
              onClick={() => {
                onApply?.();
                close();
              }}
            >
              <Check size={15} aria-hidden="true" />
              {applyLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
