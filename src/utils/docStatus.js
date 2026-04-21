// Shared helper for rendering a doc's extraction status on doctor-facing
// pages. Derives the state from the persisted `extracted_data` column, so
// it works across OPD / Visit / Docs / Lab Portal / Dashboard without
// access to the companion Zustand pendingExtractions map.

export function parseExtractedData(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

// Returns one of:
//   { kind: "pending",   label: "⏳ Extracting…",   color, bg, border }
//   { kind: "mismatch",  label: "⚠️ Needs Review", color, bg, border }
//   { kind: "extracted", label: "✅ Extracted",     color, bg, border }
//   { kind: "none",      label: null, ... }        (no extraction data yet)
export function getDocStatus(doc) {
  const ext = parseExtractedData(doc?.extracted_data);
  const status = ext?.extraction_status;

  if (status === "mismatch_review") {
    return {
      kind: "mismatch",
      label: "⚠️ Needs Review",
      color: "#b91c1c",
      bg: "#fee2e2",
      border: "#fecaca",
    };
  }
  if (status === "pending") {
    return {
      kind: "pending",
      label: "⏳ Extracting…",
      color: "#7c3aed",
      bg: "#ede9fe",
      border: "#c4b5fd",
    };
  }
  if (ext && (ext.panels || ext.medications || ext.findings || ext.impression)) {
    return {
      kind: "extracted",
      label: "✅ Extracted",
      color: "#15803d",
      bg: "#dcfce7",
      border: "#bbf7d0",
    };
  }
  return { kind: "none", label: null, color: null, bg: null, border: null };
}
