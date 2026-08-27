import { useEffect, useRef, useState } from "react";

// Shared "Blocked" pill. Derives everything from the block object returned by
// usePatientBlockStatus, which the server has already redacted for the caller's
// role — reception and OBT get { blocked: true } and nothing else, so this
// component shows them the badge and "contact administration" without needing
// to know the rules.
//
// Props:
//   block       — the block object for this patient, or null/undefined
//   size        — "sm" (dense lists) | "md" (default)
//   onHistory   — optional; renders a "View history" button when provided
export default function BlockedBadge({ block, size = "md", onHistory }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
    };
  }, [open]);

  if (!block?.blocked) return null;

  const fontSize = size === "sm" ? 10 : 11;
  const pad = size === "sm" ? "3px 7px" : "4px 10px";
  const detailed = !!block.reason_code || !!block.note;
  const title = detailed
    ? [block.label, block.note].filter(Boolean).join(" — ")
    : "Blocked · contact administration";

  return (
    <span
      ref={wrapRef}
      style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 3 }}
    >
      <button
        type="button"
        title={title}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize,
          fontWeight: 700,
          padding: pad,
          borderRadius: 10,
          background: "#fef2f2",
          color: "#b91c1c",
          border: "1px solid #fecaca",
          whiteSpace: "nowrap",
          cursor: "pointer",
          fontFamily: "inherit",
          letterSpacing: 0.3,
        }}
      >
        BLOCKED
        <span style={{ opacity: 0.7 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <span
          style={{
            fontSize: size === "sm" ? 10 : 11,
            color: "#991b1b",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            padding: "6px 9px",
            lineHeight: 1.4,
            fontWeight: 500,
            whiteSpace: "normal",
            wordBreak: "break-word",
            maxWidth: 280,
          }}
        >
          {detailed ? (
            <>
              <strong style={{ display: "block" }}>Blocked — {block.label}</strong>
              {block.note && <span style={{ display: "block" }}>{block.note}</span>}
              <span style={{ display: "block", opacity: 0.8, marginTop: 2 }}>
                {[block.blocked_by, block.blocked_at ? fmtDate(block.blocked_at) : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {onHistory && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onHistory();
                  }}
                  style={{
                    marginTop: 5,
                    fontSize,
                    fontWeight: 600,
                    padding: "2px 7px",
                    borderRadius: 6,
                    background: "#fff",
                    color: "#b91c1c",
                    border: "1px solid #fecaca",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  View history
                </button>
              )}
            </>
          ) : (
            "Blocked · contact administration"
          )}
        </span>
      )}
    </span>
  );
}

function fmtDate(v) {
  try {
    return new Date(v).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}
