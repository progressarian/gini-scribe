import { memo, useState } from "react";
import { fmtDate } from "./helpers";

const ChangesPopover = memo(function ChangesPopover({ date, label, added = [], changed = [] }) {
  const [open, setOpen] = useState(false);
  const hasContent = added.length > 0 || changed.length > 0;

  return (
    <span
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
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 50,
            minWidth: 320,
            maxWidth: 420,
            background: "#ffffff",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            padding: "10px 12px",
            fontSize: 12,
            color: "var(--text)",
            fontWeight: 400,
            lineHeight: 1.5,
            cursor: "default",
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
