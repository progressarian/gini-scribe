import { useMemo, useState } from "react";
import { API_URL } from "../../../services/api";

// Labs & graphs — gini-doctor-final.html `s-labs`.
//
// Five tabs, then the actual report PDFs. Reports are opened here, never
// re-uploaded: uploading is the lab station's job, and a report filed under the
// wrong document type is fixed at the classifier rather than worked around with
// a second upload button (plan §7).

const TABS = [
  {
    key: "diabetes",
    label: "🩸 Diabetes",
    match: ["hba1c", "glucose", "fbs", "fasting", "post", "insulin", "homa"],
  },
  { key: "lipids", label: "💛 Lipids", match: ["cholesterol", "ldl", "hdl", "triglyceride", "tg"] },
  {
    key: "renal",
    label: "🫘 Renal",
    match: ["creatinine", "egfr", "urea", "uacr", "albumin", "urine"],
  },
  { key: "body", label: "⚖️ Body / vitals", match: ["weight", "bmi", "waist", "bp", "pulse"] },
];

const matches = (test, words) => {
  const t = (test || "").toLowerCase();
  return words.some((w) => t.includes(w));
};

// PDFs open in a new tab, so the URL has to authenticate itself — the API
// accepts ?token= for exactly this (README, auth). Same helper shape the GHM
// record modal uses.
const streamUrl = (docId) =>
  `${API_URL}/api/documents/${docId}/stream?token=${encodeURIComponent(
    localStorage.getItem("gini_auth_token") || "",
  )}`;

const flagClass = (flag) =>
  flag === "HIGH" ? "lab-hi" : flag === "LOW" ? "lab-lo" : flag ? "lab-hi" : "";

export default function LabsSection({ consult, onTrend }) {
  const [tab, setTab] = useState("diabetes");
  const { labs, reports } = consult;

  const shown = useMemo(() => {
    if (tab === "reports") return [];
    const spec = TABS.find((t) => t.key === tab);
    const inTab = labs.filter((l) => matches(l.test, spec.match));
    // A tab with nothing in it would read as "this patient has no lipids" when
    // it may mean "nothing matched the filter" — so the empty state says which.
    return inTab;
  }, [labs, tab]);

  const other = useMemo(
    () => labs.filter((l) => !TABS.some((t) => matches(l.test, t.match))),
    [labs],
  );

  return (
    <section className="csec" id="s-labs">
      <div className="cs-head">
        <h2>📊 Labs &amp; graphs</h2>
        <span className="cs-sub">{labs.length} tests on file</span>
      </div>

      <div className="ltabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className={tab === "other" ? "on" : ""}
          onClick={() => setTab("other")}
        >
          Other ({other.length})
        </button>
        <button
          type="button"
          className={tab === "reports" ? "on" : ""}
          onClick={() => setTab("reports")}
        >
          📄 Reports ({reports.length})
        </button>
      </div>

      {tab === "reports" ? (
        <div className="lreports">
          {reports.length === 0 && <div className="cn-empty">No documents on file.</div>}
          {reports.map((r) => (
            <a className="lrep" key={r.id} href={streamUrl(r.id)} target="_blank" rel="noreferrer">
              <span className="lr-ico">🧪</span>
              <span className="lr-t">
                <strong>{r.title || r.doc_type}</strong>
                <em>{r.doc_date || (r.created_at || "").slice(0, 10)}</em>
              </span>
              <span className="lr-go">View →</span>
            </a>
          ))}
        </div>
      ) : (
        // A results table has five columns of numbers and cannot usefully
        // narrow. It scrolls inside its own box rather than pushing the page
        // sideways.
        <div className="ltablewrap">
          <table className="ltable">
            <thead>
              <tr>
                <th>Test</th>
                <th>Result</th>
                <th>Reference</th>
                <th>Date</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(tab === "other" ? other : shown).length === 0 && (
                <tr>
                  <td colSpan={5} className="cn-empty">
                    No results in this group.
                  </td>
                </tr>
              )}
              {(tab === "other" ? other : shown).map((l) => (
                <tr key={`${l.test}-${l.test_date}`}>
                  <td>{l.test_name || l.test}</td>
                  <td className={flagClass(l.flag)}>
                    {l.result ?? l.result_text ?? "—"} {l.unit || ""}
                  </td>
                  <td className="lt-ref">{l.ref_range || "—"}</td>
                  <td className="lt-ref">{l.test_date || "—"}</td>
                  <td>
                    <button type="button" className="lt-graph" onClick={() => onTrend(l)}>
                      Graph →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
