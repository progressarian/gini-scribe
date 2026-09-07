import { useMemo, useState } from "react";
import ReportsList from "../../../components/giniflow/ReportsList";

// Labs & graphs — gini-doctor-final.html `s-labs`.
//
// Six tabs, then the actual report PDFs. Reports are opened here, never
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

// A patient on file since 2025 has 41 rows in All, and the consultant reads the
// top of the list — today's panel — not the tail. The table had no cap at all,
// so every tab rendered its whole history and pushed the rest of the consult
// screen off the page. Same preview-and-toggle the lab station's "left the
// floor" list uses.
const PREVIEW_ROWS = 12;

const flagClass = (flag) =>
  flag === "HIGH" ? "lab-hi" : flag === "LOW" ? "lab-lo" : flag ? "lab-hi" : "";

export default function LabsSection({ consult, onTrend }) {
  const [tab, setTab] = useState("all");
  const [showAll, setShowAll] = useState(false);
  const { labs, reports, visitDate } = consult;

  // Everything that fits none of the panels above. Computed first because the
  // "Other" tab shows exactly this list.
  const other = useMemo(
    () => labs.filter((l) => !TABS.some((t) => matches(l.test, t.match))),
    [labs],
  );

  // Newest first. The list arrived in whatever order the query produced —
  // roughly alphabetical — so a panel run this morning sat scattered between
  // results from last November, and the consultant had to read the date column
  // of forty rows to find the ones they are consulting about.
  const byNewest = useMemo(() => {
    const when = (l) => l.test_date || "";
    return (list) =>
      [...list].sort(
        (a, b) =>
          when(b).localeCompare(when(a)) ||
          (a.test_name || a.test || "").localeCompare(b.test_name || b.test || ""),
      );
  }, []);

  const shown = useMemo(() => {
    if (tab === "reports") return [];
    if (tab === "all") return byNewest(labs);
    // "Other" and "Reports" are tabs without a TABS entry — they are computed,
    // not matched. Looking one up returned undefined and reading `.match` off it
    // crashed the whole section the moment anybody opened Other.
    if (tab === "other") return byNewest(other);
    const spec = TABS.find((t) => t.key === tab);
    if (!spec) return [];
    // A tab with nothing in it would read as "this patient has no lipids" when
    // it may mean "nothing matched the filter" — so the empty state says which.
    return byNewest(labs.filter((l) => matches(l.test, spec.match)));
  }, [labs, tab, other, byNewest]);

  // Switching tabs collapses again — a new list should open at its top, not
  // half-way down someone else's expansion.
  const pick = (key) => {
    setTab(key);
    setShowAll(false);
  };

  const rows = showAll ? shown : shown.slice(0, PREVIEW_ROWS);
  const hidden = shown.length - rows.length;

  return (
    <section className="csec" id="s-labs">
      <div className="cs-head">
        <h2>📊 Labs &amp; graphs</h2>
        <span className="cs-sub">{labs.length} tests on file</span>
      </div>

      <div className="ltabs">
        <button type="button" className={tab === "all" ? "on" : ""} onClick={() => pick("all")}>
          All ({labs.length})
        </button>
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => pick(t.key)}
          >
            {t.label}
          </button>
        ))}
        <button type="button" className={tab === "other" ? "on" : ""} onClick={() => pick("other")}>
          Other ({other.length})
        </button>
        <button
          type="button"
          className={tab === "reports" ? "on" : ""}
          onClick={() => pick("reports")}
        >
          📄 Reports ({reports.length})
        </button>
      </div>

      {tab === "reports" ? (
        <ReportsList reports={reports} visitDate={visitDate} />
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
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} className="cn-empty">
                    No results in this group.
                  </td>
                </tr>
              )}
              {rows.map((l) => (
                <tr key={`${l.test}-${l.test_date}`}>
                  <td>{l.test_name || l.test}</td>
                  <td className={flagClass(l.flag)}>
                    {l.result ?? l.result_text ?? "—"} {l.unit || ""}
                  </td>
                  <td className="lt-ref">{l.ref_range || "—"}</td>
                  <td className="lt-ref">
                    {/* Same words the reports list beneath this table uses for
                        the same idea — a result from today's visit is the one
                        the consultation is actually about. */}
                    {visitDate && l.test_date === visitDate ? (
                      <span className="lt-today">🟢 Today&apos;s visit</span>
                    ) : (
                      l.test_date || "—"
                    )}
                  </td>
                  <td>
                    <button type="button" className="lt-graph" onClick={() => onTrend(l)}>
                      Graph →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(hidden > 0 || showAll) && shown.length > PREVIEW_ROWS && (
            <button
              type="button"
              className="more-note more-btn"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll
                ? `Show fewer — ${shown.length} tests in this group`
                : `+ ${hidden} older ${hidden === 1 ? "test" : "tests"} — show all`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
