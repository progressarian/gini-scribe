import { memo, useState } from "react";
import { normalizeTestName } from "../../../config/labNormalization";
import { fmtDateShort } from "../helpers";

const flagStyle = (flag) => {
  if (flag === "H") return { color: "var(--red, #e53e3e)", fontWeight: 700 };
  if (flag === "L") return { color: "var(--blue, #3182ce)", fontWeight: 700 };
  return { color: "var(--t3)" };
};

const LabExtractionReviewModal = memo(function LabExtractionReviewModal({
  extracted,
  doc_date,
  onClose,
  onSave,
  saving,
}) {
  // Flatten all tests with panel label, init all selected
  const allTests = (extracted?.panels || []).flatMap((panel) =>
    (panel.tests || []).map((t) => ({
      ...t,
      panel_name: panel.panel_name || "",
      normalized: normalizeTestName(t.test_name),
    })),
  );

  const allVitals = extracted?.vitals || [];

  const [selected, setSelected] = useState(() => new Set(allTests.map((_, i) => i)));
  const [selectedVitals, setSelectedVitals] = useState(
    () => new Set(allVitals.map((_, i) => i)),
  );

  const toggle = (i) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const toggleAll = () =>
    setSelected(selected.size === allTests.length ? new Set() : new Set(allTests.map((_, i) => i)));

  const toggleVital = (i) =>
    setSelectedVitals((s) => {
      const next = new Set(s);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const selectedTests = allTests.filter((_, i) => selected.has(i));
  const selectedVitalsList = allVitals.filter((_, i) => selectedVitals.has(i));

  // Count unique dates across labs + vitals for the summary chip
  const dateSet = new Set();
  for (const t of allTests) if (t.test_date) dateSet.add(String(t.test_date).slice(0, 10));
  for (const v of allVitals) if (v.date) dateSet.add(String(v.date).slice(0, 10));

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox" style={{ width: 720, maxWidth: "95vw" }}>
        <div className="mttl">🧪 Review Extracted Lab Values &amp; Vitals</div>

        {/* Meta */}
        <div
          style={{ display: "flex", gap: 16, marginBottom: 10, fontSize: 12, color: "var(--t3)" }}
        >
          {extracted?.lab_name && (
            <span>
              <strong style={{ color: "var(--t2)" }}>{extracted.lab_name}</strong>
            </span>
          )}
          {dateSet.size > 0 && (
            <span>
              <strong style={{ color: "var(--t2)" }}>{dateSet.size}</strong> date
              {dateSet.size !== 1 ? "s" : ""} detected
            </span>
          )}
          {doc_date && dateSet.size === 0 && (
            <span>
              Report date:{" "}
              <strong style={{ color: "var(--t2)" }}>
                {new Date(doc_date).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </strong>
            </span>
          )}
          {(allTests.length > 0 || allVitals.length > 0) && (
            <span style={{ marginLeft: "auto" }}>
              {selected.size}/{allTests.length} labs · {selectedVitals.size}/{allVitals.length}{" "}
              vitals
            </span>
          )}
        </div>

        {allTests.length === 0 && allVitals.length === 0 ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: "var(--t3)", fontSize: 13 }}>
            No lab values or vitals could be extracted from this report.
          </div>
        ) : (
          <>
            {allTests.length > 0 && (
              <div
                style={{
                  maxHeight: 340,
                  overflowY: "auto",
                  border: "1px solid var(--border2)",
                  borderRadius: "var(--rs)",
                  marginBottom: 12,
                }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr
                      style={{ background: "var(--bg2)", borderBottom: "1px solid var(--border2)" }}
                    >
                      <th style={{ padding: "6px 8px", textAlign: "left", width: 28 }}>
                        <input
                          type="checkbox"
                          checked={selected.size === allTests.length}
                          onChange={toggleAll}
                          title="Select all"
                        />
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        Test
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "right", color: "var(--t2)" }}>
                        Result
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        Unit
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        Flag
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        Date
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        Ref Range
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {allTests.map((t, i) => {
                      const isFirst = i === 0 || allTests[i - 1].panel_name !== t.panel_name;
                      const effectiveDate = t.test_date || doc_date;
                      return [
                        isFirst && t.panel_name ? (
                          <tr key={`panel-${i}`}>
                            <td
                              colSpan={7}
                              style={{
                                padding: "5px 8px 3px",
                                fontSize: 11,
                                fontWeight: 600,
                                color: "var(--primary)",
                                background: "var(--pri-lt, #ebf8ff)",
                                borderTop: i > 0 ? "1px solid var(--border2)" : undefined,
                              }}
                            >
                              {t.panel_name}
                            </td>
                          </tr>
                        ) : null,
                        <tr
                          key={i}
                          style={{
                            borderBottom: "1px solid var(--border2)",
                            opacity: selected.has(i) ? 1 : 0.4,
                            cursor: "pointer",
                          }}
                          onClick={() => toggle(i)}
                        >
                          <td style={{ padding: "5px 8px" }}>
                            <input
                              type="checkbox"
                              checked={selected.has(i)}
                              onChange={() => toggle(i)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td style={{ padding: "5px 8px", color: "var(--t1)" }}>
                            <div style={{ fontWeight: 500 }}>{t.normalized}</div>
                            {t.normalized !== t.test_name && (
                              <div style={{ fontSize: 10, color: "var(--t4)" }}>{t.test_name}</div>
                            )}
                          </td>
                          <td
                            style={{
                              padding: "5px 8px",
                              textAlign: "right",
                              fontWeight: 600,
                              ...flagStyle(t.flag),
                            }}
                          >
                            {t.result_text || t.result}
                          </td>
                          <td style={{ padding: "5px 8px", color: "var(--t3)" }}>
                            {t.unit || "—"}
                          </td>
                          <td style={{ padding: "5px 8px", ...flagStyle(t.flag) }}>
                            {t.flag || "N"}
                          </td>
                          <td
                            style={{
                              padding: "5px 8px",
                              color: "var(--t2)",
                              fontSize: 11,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {effectiveDate ? fmtDateShort(effectiveDate) : "—"}
                          </td>
                          <td style={{ padding: "5px 8px", color: "var(--t3)", fontSize: 11 }}>
                            {t.ref_range || "—"}
                          </td>
                        </tr>,
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {allVitals.length > 0 && (
              <div
                style={{
                  border: "1px solid var(--border2)",
                  borderRadius: "var(--rs)",
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    padding: "5px 8px",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--primary)",
                    background: "var(--pri-lt, #ebf8ff)",
                  }}
                >
                  Dated Vitals ({allVitals.length})
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr
                      style={{ background: "var(--bg2)", borderBottom: "1px solid var(--border2)" }}
                    >
                      <th style={{ padding: "6px 8px", textAlign: "left", width: 28 }}></th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        Date
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        BP
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        Weight
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        BMI
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        Waist
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--t2)" }}>
                        Body Fat
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {allVitals.map((v, i) => (
                      <tr
                        key={i}
                        style={{
                          borderBottom:
                            i < allVitals.length - 1 ? "1px solid var(--border2)" : undefined,
                          opacity: selectedVitals.has(i) ? 1 : 0.4,
                          cursor: "pointer",
                        }}
                        onClick={() => toggleVital(i)}
                      >
                        <td style={{ padding: "5px 8px" }}>
                          <input
                            type="checkbox"
                            checked={selectedVitals.has(i)}
                            onChange={() => toggleVital(i)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td
                          style={{
                            padding: "5px 8px",
                            color: "var(--t2)",
                            fontSize: 11,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {v.date ? fmtDateShort(v.date) : "—"}
                        </td>
                        <td style={{ padding: "5px 8px", color: "var(--t1)" }}>
                          {v.bpSys && v.bpDia ? `${v.bpSys}/${v.bpDia}` : "—"}
                        </td>
                        <td style={{ padding: "5px 8px", color: "var(--t1)" }}>
                          {v.weight != null ? v.weight : "—"}
                        </td>
                        <td style={{ padding: "5px 8px", color: "var(--t1)" }}>
                          {v.bmi != null ? v.bmi : "—"}
                        </td>
                        <td style={{ padding: "5px 8px", color: "var(--t1)" }}>
                          {v.waist != null ? v.waist : "—"}
                        </td>
                        <td style={{ padding: "5px 8px", color: "var(--t1)" }}>
                          {v.bodyFat != null ? v.bodyFat : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <div className="macts">
          <button className="btn" onClick={onClose} disabled={saving}>
            Discard
          </button>
          <button
            className="btn-p"
            disabled={(selectedTests.length === 0 && selectedVitalsList.length === 0) || saving}
            onClick={() => onSave(selectedTests, doc_date, selectedVitalsList)}
          >
            {saving
              ? "Saving..."
              : `Save ${selectedTests.length} Test${selectedTests.length !== 1 ? "s" : ""}` +
                (selectedVitalsList.length > 0
                  ? ` + ${selectedVitalsList.length} Vitals`
                  : "")}
          </button>
        </div>
      </div>
    </div>
  );
});

export default LabExtractionReviewModal;
