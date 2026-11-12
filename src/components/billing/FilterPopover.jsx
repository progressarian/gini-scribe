import { useEffect, useId, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import "./filterPopover.css";

export default function FilterPopover({ active, cleared, onClear, children }) {
  const boxId = useId();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const escape = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="bfilter" ref={wrapRef}>
      <button
        type="button"
        className={`flow-btn flow-btn-mini ${active ? "flow-btn-primary" : "flow-btn-ghost"}`}
        aria-expanded={open}
        aria-controls={boxId}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={13} aria-hidden="true" /> Filters{active ? ` (${active})` : ""}
      </button>
      {open ? (
        <div id={boxId} className="bfilter__box bill-form" role="group" aria-label="More filters">
          {children}
          <div className="bfilter__foot">
            <button
              type="button"
              className="flow-btn flow-btn-mini flow-btn-ghost"
              disabled={cleared}
              onClick={onClear}
            >
              Clear filters
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-mini flow-btn-primary"
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
