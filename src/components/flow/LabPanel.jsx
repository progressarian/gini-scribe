import { useState } from "react";
import PdfViewerModal from "../visit/PdfViewerModal";

const KIND_ICON = {
  abi: "🫀",
  vpt: "🦶",
  xray: "🩻",
  x_ray: "🩻",
  eye: "👁️",
  kidney: "🫘",
  ecg: "💓",
  tmt: "🏃",
};

// What HealthRay knows about this patient's tests today. Read-only by design:
// pathology comes from lab_cases, imaging from documents, and neither has a
// "delivered" or "processing" signal for anyone to click.
export default function LabPanel({ lab, compact = false }) {
  const [showValues, setShowValues] = useState(false);
  // Same viewer the visit tab uses for prescriptions — it fetches the file from
  // the id, so the panel only has to hand it one.
  const [viewingDoc, setViewingDoc] = useState(null);
  const tests = lab?.tests || [];
  const values = lab?.values || [];
  const flagged = values.filter((v) => v.is_critical || (v.flag && v.flag !== "NORMAL"));
  if (!tests.length) return null;

  if (compact) {
    return (
      <span
        className={`flow-badge ${lab.awaiting ? "fb-amb" : "fb-grn"}`}
        title={tests
          .map((t) => (t.kind === "pathology" ? t.names.join(", ") : t.doc_type))
          .join(" · ")}
      >
        🧪 {lab.awaiting ? `${lab.awaiting} awaiting` : `${lab.ready} ready`}
      </span>
    );
  }

  return (
    <div className="lab-panel">
      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}
      <div className="flow-sec-title" style={{ marginBottom: 4 }}>
        Lab &amp; tests today
        <span className="q-count">{tests.length}</span>
      </div>
      <div className="flow-muted" style={{ marginBottom: 6 }}>
        Live from HealthRay — pathology from the lab case, imaging from the report on file.
      </div>
      {tests.map((t, i) =>
        t.kind === "pathology" ? (
          <div key={`c${t.case_no}-${i}`} className="lab-row">
            <span className="lab-icon">🩸</span>
            <div className="lab-main">
              <div className="lab-names">{t.names.join(" · ") || "Pathology"}</div>
              <div className="flow-muted">case {t.case_no}</div>
            </div>
            <span className={`flow-badge ${t.ready ? "fb-grn" : "fb-amb"}`}>
              {t.ready ? "results in" : "awaiting results"}
            </span>
          </div>
        ) : (
          <div key={`d${t.doc_type}-${i}`} className="lab-row">
            <span className="lab-icon">{KIND_ICON[t.doc_type] || "🧾"}</span>
            <div className="lab-main">
              <div className="lab-names">{t.doc_type.toUpperCase()}</div>
              <div className="flow-muted">
                {t.count} report{t.count > 1 ? "s" : ""} on file
              </div>
            </div>
            {t.doc_id ? (
              <button
                className="flow-btn flow-btn-ghost"
                onClick={() =>
                  setViewingDoc({
                    id: t.doc_id,
                    title: t.doc_type.toUpperCase(),
                    file_name: `${t.doc_type}.pdf`,
                  })
                }
              >
                View report
              </button>
            ) : (
              <span className="flow-badge fb-grn">report on file</span>
            )}
          </div>
        ),
      )}

      {values.length > 0 && (
        <div className="lab-values">
          <button
            className="lab-values-head"
            aria-expanded={showValues}
            onClick={() => setShowValues((v) => !v)}
          >
            <span className="clb-caret">{showValues ? "▾" : "▸"}</span>
            <span>Results</span>
            <span className="q-count">{values.length}</span>
            {flagged.length > 0 && (
              <span className="flow-badge fb-red">{flagged.length} out of range</span>
            )}
          </button>
          {showValues && (
            <ul className="lab-values-list">
              {[...values]
                .sort(
                  (a, b) =>
                    Number(!!b.is_critical) - Number(!!a.is_critical) ||
                    Number(!!b.flag) - Number(!!a.flag),
                )
                .map((r, i) => (
                  <li key={`${r.test_name}-${i}`}>
                    <span className="lab-v-name">{r.test_name}</span>
                    <span
                      className={`lab-v-result${r.is_critical ? " lab-v-crit" : r.flag ? " lab-v-flag" : ""}`}
                    >
                      {r.result}
                      {r.unit ? ` ${r.unit}` : ""}
                    </span>
                    {r.flag && <span className="flow-badge fb-amb">{r.flag}</span>}
                    {r.is_critical && <span className="flow-badge fb-red">critical</span>}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
