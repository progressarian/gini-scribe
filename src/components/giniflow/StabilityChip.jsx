import { STABILITY_RECENT_MONTHS } from "../../../shared/biomarkerClassify.js";

const LABEL = {
  unstable: "⚠ Unstable",
  stable: "✓ Stable",
  first: "First visit",
  no_reports: "No recent reports",
};

const SUMMARY = {
  unstable: "A key report is off target, or reports are worse or mixed since last visit",
  stable: "Reports steady or better than last visit, none off target",
  first: "Nothing from an earlier visit to compare with",
  no_reports: `No test results in the last ${STABILITY_RECENT_MONTHS} months`,
};

export default function StabilityChip({ stability, detail = false, className = "" }) {
  if (!stability?.state || !LABEL[stability.state]) return null;
  const reasons = stability.reasons || [];
  const title = [SUMMARY[stability.state], ...reasons].join("\n");
  return (
    <span className={`stab-chip stab-${stability.state} ${className}`.trim()} title={title}>
      {LABEL[stability.state]}
      {detail && reasons.length > 0 && <span className="stab-why"> · {reasons.join(", ")}</span>}
    </span>
  );
}
