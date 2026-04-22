import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmtDate } from "./helpers";

const ChangesPopover = memo(function ChangesPopover({ date, label, added = [], changed = [] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, maxWidth: 420 });
  const anchorRef = useRef(null);
  const hasContent = added.length > 0 || changed.length > 0;

  // Position the popover using the anchor's viewport rect. `position: fixed`
  // escapes ancestor overflow:hidden (e.g. `.sc { overflow: hidden }`) that
  // would otherwise clip a section-level popover.
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const compute = () => {
      const rect = anchorRef.current.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const MARGIN = 8;
      const MAX_W = Math.min(420, vw - MARGIN * 2);
      // Prefer left-aligned to anchor; flip to right-aligned if it would overflow.
      let left = rect.left;
      if (left + MAX_W > vw - MARGIN) left = Math.max(MARGIN, vw - MAX_W - MARGIN);
      setPos({ top: rect.bottom + 6, left, maxWidth: MAX_W });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open]);

  // Close on outside tap / escape — important on mobile where mouseleave
  // doesn't fire and the popover would otherwise stay pinned open.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={anchorRef}
      style={{ position: "relative", marginLeft: 8 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        style={{
          fontSize: 11,
          color: "var(--t3)",
          fontWeight: 400,
          cursor: hasContent ? "pointer" : "default",
          textDecoration: hasContent ? "underline dotted" : "none",
          textUnderlineOffset: 3,
        }}
        onClick={() => hasContent && setOpen((v) => !v)}
      >
        {label}
      </span>
      {open && hasContent && (
        <div
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            zIndex: 1000,
            minWidth: 0,
            width: "max-content",
            maxWidth: pos.maxWidth,
            maxHeight: "70vh",
            overflowY: "auto",
            background: "#ffffff",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            padding: "10px 12px",
            fontSize: 12,
            color: "var(--text)",
            fontWeight: 400,
            lineHeight: 1.5,
            cursor: "default",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--t4)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 6,
            }}
          >
            Changes on {fmtDate(date)}
          </div>
          {added.length > 0 && (
            <div style={{ marginBottom: changed.length > 0 ? 8 : 0 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--green)",
                  marginBottom: 4,
                }}
              >
                + Added ({added.length})
              </div>
              {added.map((a, i) => (
                <div key={i} style={{ padding: "2px 0" }}>
                  <div style={{ fontWeight: 600 }}>{a.name}</div>
                  {(a.diff || []).map((d, j) => (
                    <div key={j} style={{ color: "var(--t2)", fontSize: 11 }}>
                      {d}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {changed.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--amber)",
                  marginBottom: 4,
                }}
              >
                • Changed ({changed.length})
              </div>
              {changed.map((c, i) => (
                <div key={i} style={{ padding: "2px 0" }}>
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  {(c.diff || []).map((d, j) => (
                    <div key={j} style={{ color: "var(--t2)", fontSize: 11 }}>
                      {d}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
});

export default ChangesPopover;
