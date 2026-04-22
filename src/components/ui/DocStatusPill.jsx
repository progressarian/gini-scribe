import { useEffect, useRef, useState } from "react";
import { getDocStatus } from "../../utils/docStatus";
import { useRetryExtraction } from "../../queries/hooks/useRetryExtraction";

// Shared status pill for documents. Reads the DB state via getDocStatus
// (pending / failed / extracted / mismatch) and, for the "failed" kind,
// renders a small "↻ Retry" button that POSTs to the server retry
// endpoint. Same component in Visit / OPD / Docs / Dashboard / Companion
// so fail+retry UX is consistent everywhere a doc row shows up.
//
// Props:
//   doc         — document row (must have id + extracted_data)
//   patientId   — patient id, passed to the retry mutation so it can
//                 invalidate the right patient cache
//   size        — "sm" (compact, used in dense lists) | "md" (default)
//   onRetry     — optional callback fired after retry kicks off
export default function DocStatusPill({ doc, patientId, size = "md", onRetry }) {
  const status = getDocStatus(doc);
  const retry = useRetryExtraction();
  const [reasonOpen, setReasonOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close the click-opened reason popover on outside tap (mobile).
  useEffect(() => {
    if (!reasonOpen) return;
    const onDoc = (e) => {
      if (!wrapRef.current?.contains(e.target)) setReasonOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
    };
  }, [reasonOpen]);

  if (!status.label) return null;

  const fontSize = size === "sm" ? 10 : 11;
  const pad = size === "sm" ? "3px 7px" : "4px 10px";
  const isFailed = status.kind === "failed";
  const hasReason = isFailed && status.error;

  const pill = (
    <span
      title={hasReason ? humanizeError(status.error) : undefined}
      onClick={(e) => {
        if (!hasReason) return;
        e.stopPropagation();
        e.preventDefault();
        setReasonOpen((v) => !v);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize,
        fontWeight: 700,
        padding: pad,
        borderRadius: 10,
        background: status.bg,
        color: status.color,
        border: `1px solid ${status.border}`,
        whiteSpace: "nowrap",
        cursor: hasReason ? "pointer" : "default",
      }}
    >
      {status.label}
      {hasReason && <span style={{ opacity: 0.7 }}>{reasonOpen ? "▴" : "▾"}</span>}
    </span>
  );

  // Show the retry button for failed docs (obvious case) and for pending
  // docs (so users can unstick extractions that have hung — e.g., the
  // original P_106360 symptom where Claude never returned a response).
  const showRetry = status.kind === "failed" || status.kind === "pending";
  if (!showRetry) return pill;

  const isRetrying = retry.isPending;
  const handleRetry = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (isRetrying || !doc?.id) return;
    retry.mutate(
      { docId: doc.id, patientId },
      {
        onSuccess: () => onRetry && onRetry(),
      },
    );
  };

  const isPending = status.kind === "pending";
  const btnColor = isPending ? "#7c3aed" : "#b91c1c";
  const btnBorder = isPending ? "#c4b5fd" : "#fecaca";
  const btnTitle = isPending
    ? "Extraction is still running — click to restart it if it seems stuck"
    : status.error || "Retry extraction";

  // Reason is hidden by default and surfaced on demand: hover (title
  // tooltip on the pill, desktop) or tap (click toggles an inline panel,
  // works on mobile where hover isn't available). Keeps rows compact
  // while still letting doctors diagnose WHY extraction failed.
  const reasonText = hasReason ? humanizeError(status.error) : null;

  return (
    <span
      ref={wrapRef}
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 3,
        maxWidth: 260,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {pill}
        <button
          type="button"
          onClick={handleRetry}
          disabled={isRetrying}
          title={btnTitle}
          style={{
            fontSize,
            fontWeight: 700,
            padding: pad,
            borderRadius: 10,
            background: isRetrying ? "#f3f4f6" : "#fff",
            color: isRetrying ? "#9ca3af" : btnColor,
            border: `1px solid ${isRetrying ? "#e5e7eb" : btnBorder}`,
            cursor: isRetrying ? "wait" : "pointer",
            whiteSpace: "nowrap",
            fontFamily: "inherit",
          }}
        >
          {isRetrying ? "⏳ Retrying…" : "↻ Retry"}
        </button>
      </span>
      {reasonOpen && reasonText && (
        <span
          style={{
            fontSize: size === "sm" ? 10 : 11,
            color: "#991b1b",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            padding: "4px 8px",
            lineHeight: 1.35,
            fontWeight: 500,
            whiteSpace: "normal",
            wordBreak: "break-word",
          }}
        >
          {reasonText}
        </span>
      )}
    </span>
  );
}

// Pretty-print the raw error string. We get a mix of:
//   - "Claude timeout after 180s"
//   - "Claude returned incomplete data after 3 attempts — try re-uploading a clearer scan"
//   - "File unavailable: No file attached to this document"
//   - "Anthropic 429: { ... long JSON ... }"
// Trim Anthropic error payload noise so the user sees a useful sentence,
// and cap length so the card doesn't sprawl.
function humanizeError(raw) {
  if (!raw) return null;
  let s = String(raw);
  // Strip embedded JSON/error bodies from Anthropic 4xx/5xx responses.
  const colonIdx = s.indexOf(": {");
  if (colonIdx !== -1) s = s.slice(0, colonIdx);
  s = s.trim();
  if (/timeout|aborted/i.test(s)) return `Reason: ${s} — network may be slow, click Retry`;
  if (/incomplete data/i.test(s)) return `Reason: ${s}`;
  if (/no file|file unavailable|download failed/i.test(s))
    return `Reason: ${s} — please re-upload the file`;
  if (/anthropic 4\d\d/i.test(s)) return `Reason: ${s} — Claude API rejected the request`;
  if (/anthropic 5\d\d/i.test(s)) return `Reason: ${s} — Claude API is having issues, try again`;
  if (s.length > 140) s = s.slice(0, 137) + "…";
  return `Reason: ${s}`;
}
