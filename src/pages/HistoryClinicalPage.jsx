import "./HistoryClinicalPage.css";
import { useNavigate } from "react-router-dom";
import { makeNavClick } from "../lib/navClick";
import useExamStore from "../stores/examStore.js";
import useLabStore from "../stores/labStore.js";
import {
  CONDITIONS,
  CONDITION_NAMES,
  COMMON_SURGERIES,
  COMMON_ALLERGIES,
} from "../config/conditions.js";

export default function HistoryClinicalPage() {
  const navigate = useNavigate();
  const navClick = makeNavClick(navigate);
  const {
    hxConditions,
    hxCondData,
    hxSurgeries,
    setHxSurgeries,
    hxSurgText,
    setHxSurgText,
    hxAllergies,
    setHxAllergies,
    hxAllergyText,
    setHxAllergyText,
    hxFamilyHx,
    setHxFamilyHx,
    dxSearch,
    setDxSearch,
    aiDxSuggestions,
    toggleHxCond,
    updHxCond,
    togHxMulti,
    getBiomarkerValues,
    getMissingBiomarkers,
  } = useExamStore();
  const { labRequisition, setLabRequisition } = useLabStore();

  const filteredDx = dxSearch
    ? CONDITION_NAMES.filter((c) => c.toLowerCase().includes(dxSearch.toLowerCase()))
    : CONDITION_NAMES;

  return (
    <div>
      <div className="hx-clinical__header">
        <span className="hx-clinical__header-icon">📜</span>
        <div className="hx-clinical__header-info">
          <div className="hx-clinical__header-title">Clinical History</div>
          <div className="hx-clinical__header-sub">Diagnoses · Surgeries · Allergies · Family</div>
        </div>
        <span className="hx-clinical__header-step">Step 2/6</span>
      </div>

      {/* ═══ KNOWN DIAGNOSES ═══ */}
      <div className="hx-clinical__section">
        <div className="hx-clinical__section-title">🏥 Known Diagnoses</div>
        <input
          value={dxSearch}
          onChange={(e) => setDxSearch(e.target.value)}
          placeholder="🔍 Search diagnosis..."
          className="hx-clinical__search"
        />
        <div className="hx-clinical__dx-chips">
          {filteredDx.map((name) => {
            const tmpl = CONDITIONS[name];
            return (
              <button
                key={name}
                onClick={() => toggleHxCond(name)}
                className="hx-clinical__dx-chip"
                style={{
                  border: `1.5px solid ${hxConditions.includes(name) ? tmpl.color : "#e2e8f0"}`,
                  background: hxConditions.includes(name) ? tmpl.color + "12" : "white",
                  color: hxConditions.includes(name) ? tmpl.color : "#64748b",
                }}
              >
                <span>{tmpl.icon}</span>
                {name}
              </button>
            );
          })}
          <button
            onClick={() => toggleHxCond("Other")}
            className="hx-clinical__dx-chip"
            style={{
              border: `1.5px solid ${hxConditions.includes("Other") ? "#64748b" : "#e2e8f0"}`,
              background: hxConditions.includes("Other") ? "#64748b12" : "white",
              color: hxConditions.includes("Other") ? "#64748b" : "#94a3b8",
            }}
          >
            + Other
          </button>
        </div>

        {aiDxSuggestions.filter((s) => !hxConditions.includes(s.name)).length > 0 && (
          <div className="hx-clinical__ai-suggestions">
            <div className="hx-clinical__ai-title">🤖 AI Suggested from Labs</div>
            {aiDxSuggestions
              .filter((s) => !hxConditions.includes(s.name))
              .map((s, i) => (
                <div
                  key={i}
                  className="hx-clinical__ai-suggestions"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 0",
                    background: "transparent",
                    border: "none",
                    marginBottom: 0,
                  }}
                >
                  <span>{CONDITIONS[s.name]?.icon}</span>
                  <span
                    className="hx-clinical__dx-chip"
                    style={{
                      border: "none",
                      background: "transparent",
                      flex: 1,
                      padding: 0,
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    {s.name} <span style={{ fontSize: 9, color: "#64748b" }}>— {s.reason}</span>
                  </span>
                  <button
                    onClick={() => toggleHxCond(s.name)}
                    style={{
                      fontSize: 9,
                      background: "#2563eb",
                      color: "white",
                      border: "none",
                      padding: "3px 8px",
                      borderRadius: 4,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    + Add
                  </button>
                </div>
              ))}
          </div>
        )}

        {hxConditions.map((cond) => {
          const tmpl = CONDITIONS[cond] || CONDITIONS["Other"];
          const data = hxCondData[cond] || {};
          const biomarkers = getBiomarkerValues(cond);
          return (
            <div
              key={cond}
              className="hx-clinical__condition-card"
              style={{ border: `2px solid ${tmpl.color}25` }}
            >
              <div
                className="hx-clinical__condition-header"
                style={{ background: tmpl.color + "08", borderBottom: `1px solid ${tmpl.color}15` }}
              >
                <span className="hx-clinical__condition-icon">{tmpl.icon}</span>
                <span className="hx-clinical__condition-name" style={{ color: tmpl.color }}>
                  {cond}
                </span>
                <div className="lab-portal__spacer" />
                <button
                  onClick={() => toggleHxCond(cond)}
                  className="hx-clinical__condition-remove"
                >
                  ✕ Remove
                </button>
              </div>

              {biomarkers.length > 0 && (
                <div className="hx-clinical__biomarkers">
                  <div className="hx-clinical__biomarker-title">📊 RELEVANT BIOMARKERS</div>
                  <div className="hx-clinical__biomarker-list">
                    {biomarkers.map((bm) => (
                      <div
                        key={bm.name}
                        className="hx-clinical__dx-chip"
                        style={{
                          background: bm.found
                            ? bm.flag === "H"
                              ? "#fef2f2"
                              : bm.flag === "L"
                                ? "#eff6ff"
                                : "#f0fdf4"
                            : "#f1f5f9",
                          color: bm.found
                            ? bm.flag === "H"
                              ? "#dc2626"
                              : bm.flag === "L"
                                ? "#2563eb"
                                : "#059669"
                            : "#94a3b8",
                          border: `1px solid ${bm.found ? (bm.flag === "H" ? "#fecaca" : bm.flag === "L" ? "#bfdbfe" : "#bbf7d0") : "#e2e8f0"}`,
                          padding: "3px 8px",
                          borderRadius: 4,
                          fontSize: 10,
                        }}
                      >
                        {bm.name}:{" "}
                        {bm.found ? (
                          <b>{bm.value}</b>
                        ) : (
                          <span style={{ fontStyle: "italic" }}>— need test</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tmpl.questions.length > 0 && (
                <div className="hx-clinical__questions">
                  <div className="hx-clinical__questions-grid">
                    {tmpl.questions.map((q) => (
                      <div key={q.id} style={q.type === "multi" ? { gridColumn: "1/-1" } : {}}>
                        <div className="hx-clinical__question-label">{q.label}</div>
                        {q.type === "text" && (
                          <input
                            value={data[q.id] || ""}
                            onChange={(e) => updHxCond(cond, q.id, e.target.value)}
                            placeholder={q.placeholder}
                            className="hx-clinical__question-input"
                          />
                        )}
                        {q.type === "select" && (
                          <select
                            value={data[q.id] || ""}
                            onChange={(e) => updHxCond(cond, q.id, e.target.value)}
                            className="hx-clinical__question-select"
                          >
                            <option value="">Select...</option>
                            {q.options.map((o) => (
                              <option key={o}>{o}</option>
                            ))}
                          </select>
                        )}
                        {q.type === "multi" && (
                          <div className="hx-clinical__multi-chips">
                            {q.options.map((o) => (
                              <button
                                key={o}
                                onClick={() => togHxMulti(cond, q.id, o)}
                                className="hx-clinical__dx-chip"
                                style={{
                                  border: `1.5px solid ${(data[q.id] || []).includes(o) ? tmpl.color : "#e2e8f0"}`,
                                  background: (data[q.id] || []).includes(o)
                                    ? tmpl.color + "12"
                                    : "white",
                                  color: (data[q.id] || []).includes(o) ? tmpl.color : "#64748b",
                                  padding: "4px 8px",
                                  borderRadius: 5,
                                  fontSize: 10,
                                }}
                              >
                                {o}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ═══ ALLERGIES ═══ */}
      <div className="hx-clinical__section">
        <div className="hx-clinical__section-title">⚠️ Allergies</div>
        <div className="hx-clinical__allergy-chips">
          {COMMON_ALLERGIES.map((a) => (
            <button
              key={a}
              onClick={() =>
                hxAllergies.includes(a)
                  ? setHxAllergies(hxAllergies.filter((x) => x !== a))
                  : setHxAllergies([...hxAllergies, a])
              }
              className="hx-clinical__dx-chip"
              style={{
                border: `1.5px solid ${hxAllergies.includes(a) ? "#dc2626" : "#e2e8f0"}`,
                background: hxAllergies.includes(a) ? "#fef2f2" : "white",
                color: hxAllergies.includes(a) ? "#dc2626" : "#64748b",
                padding: "4px 8px",
                borderRadius: 5,
                fontSize: 10,
              }}
            >
              {a}
            </button>
          ))}
        </div>
        <div className="hx-clinical__allergy-input-row">
          <input
            value={hxAllergyText}
            onChange={(e) => setHxAllergyText(e.target.value)}
            placeholder="Other allergy..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && hxAllergyText.trim()) {
                setHxAllergies([...hxAllergies, hxAllergyText.trim()]);
                setHxAllergyText("");
              }
            }}
            className="hx-clinical__question-input"
            style={{ flex: 1 }}
          />
        </div>
      </div>

      {/* ═══ SURGICAL HISTORY ═══ */}
      <div className="hx-clinical__section">
        <div className="hx-clinical__section-title">🔪 Past Surgical / Hospitalization History</div>
        <div className="hx-clinical__surgery-chips">
          {COMMON_SURGERIES.map((s) => (
            <button
              key={s}
              onClick={() =>
                hxSurgeries.some((x) => x.name === s)
                  ? setHxSurgeries(hxSurgeries.filter((x) => x.name !== s))
                  : setHxSurgeries([...hxSurgeries, { name: s, year: "", hospital: "" }])
              }
              className="hx-clinical__dx-chip"
              style={{
                border: `1.5px solid ${hxSurgeries.some((x) => x.name === s) ? "#475569" : "#e2e8f0"}`,
                background: hxSurgeries.some((x) => x.name === s) ? "#f1f5f9" : "white",
                color: hxSurgeries.some((x) => x.name === s) ? "#1e293b" : "#64748b",
                padding: "4px 8px",
                borderRadius: 5,
                fontSize: 10,
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="hx-clinical__surgery-input-row">
          <input
            value={hxSurgText}
            onChange={(e) => setHxSurgText(e.target.value)}
            placeholder="Other surgery/hospitalization..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && hxSurgText.trim()) {
                setHxSurgeries([
                  ...hxSurgeries,
                  { name: hxSurgText.trim(), year: "", hospital: "" },
                ]);
                setHxSurgText("");
              }
            }}
            className="hx-clinical__question-input"
            style={{ flex: 1 }}
          />
        </div>
        {hxSurgeries.map((s, i) => (
          <div key={i} className="hx-clinical__surgery-item">
            <span className="hx-clinical__surgery-name">{s.name}</span>
            <input
              value={s.year}
              onChange={(e) => {
                const u = [...hxSurgeries];
                u[i].year = e.target.value;
                setHxSurgeries(u);
              }}
              placeholder="Year"
              className="hx-clinical__surgery-year-input"
            />
            <input
              value={s.hospital || ""}
              onChange={(e) => {
                const u = [...hxSurgeries];
                u[i].hospital = e.target.value;
                setHxSurgeries(u);
              }}
              placeholder="Hospital"
              className="hx-clinical__surgery-hospital-input"
            />
            <button
              onClick={() => setHxSurgeries(hxSurgeries.filter((_, j) => j !== i))}
              className="hx-clinical__surgery-remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* ═══ FAMILY HISTORY ═══ */}
      <div className="hx-clinical__section">
        <div className="hx-clinical__section-title">👨‍👩‍👧‍👦 Family History</div>
        <div className="hx-clinical__family-chips">
          {[
            { k: "dm", l: "Diabetes" },
            { k: "htn", l: "Hypertension" },
            { k: "cardiac", l: "Heart Disease" },
            { k: "thyroid", l: "Thyroid" },
            { k: "cancer", l: "Cancer" },
            { k: "ckd", l: "Kidney Disease" },
            { k: "obesity", l: "Obesity" },
          ].map((f) => (
            <button
              key={f.k}
              onClick={() => setHxFamilyHx((prev) => ({ ...prev, [f.k]: !prev[f.k] }))}
              className="hx-clinical__dx-chip"
              style={{
                border: `1.5px solid ${hxFamilyHx[f.k] ? "#f59e0b" : "#e2e8f0"}`,
                background: hxFamilyHx[f.k] ? "#fef3c7" : "white",
                color: hxFamilyHx[f.k] ? "#92400e" : "#64748b",
                padding: "5px 10px",
                borderRadius: 6,
                fontSize: 11,
              }}
            >
              {f.l}
            </button>
          ))}
        </div>
        <input
          value={hxFamilyHx.notes}
          onChange={(e) => setHxFamilyHx((prev) => ({ ...prev, notes: e.target.value }))}
          placeholder="Details (e.g., Father — MI at 55, Mother — DM2)"
          className="hx-clinical__family-input"
        />
      </div>

      {/* Missing biomarkers → lab requisition */}
      {getMissingBiomarkers().length > 0 && (
        <div className="hx-clinical__missing-tests">
          <div className="hx-clinical__missing-title">
            🔬 Missing Tests — Need for Diagnosis Confirmation
          </div>
          <div className="hx-clinical__missing-chips">
            {getMissingBiomarkers().map((m) => (
              <button
                key={m.test}
                onClick={() => {
                  if (!labRequisition.includes(m.test))
                    setLabRequisition((prev) => [...prev, m.test]);
                }}
                className="hx-clinical__dx-chip"
                style={{
                  border: `1.5px solid ${labRequisition.includes(m.test) ? "#059669" : "#fde68a"}`,
                  background: labRequisition.includes(m.test) ? "#f0fdf4" : "white",
                  color: labRequisition.includes(m.test) ? "#059669" : "#92400e",
                  padding: "4px 8px",
                  borderRadius: 5,
                  fontSize: 10,
                }}
              >
                {labRequisition.includes(m.test) ? "✅" : "+"} {m.test}{" "}
                <span style={{ fontSize: 8, color: "#94a3b8" }}>({m.forCondition})</span>
              </button>
            ))}
          </div>
          {labRequisition.length > 0 && (
            <div
              style={{
                marginTop: 6,
                padding: 6,
                background: "#f0fdf4",
                borderRadius: 6,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ fontSize: 10, color: "#059669", fontWeight: 700 }}>
                ✅ {labRequisition.length} tests for requisition
              </div>
              <button
                style={{
                  padding: "4px 10px",
                  background: "#059669",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                🖨️ Print Requisition
              </button>
            </div>
          )}
        </div>
      )}

      <div className="hx-clinical__nav">
        <button onClick={navClick("/intake")} className="hx-clinical__back-btn">
          ← Intake
        </button>
        <button onClick={navClick("/exam")} className="hx-clinical__next-btn">
          Exam →
        </button>
      </div>
    </div>
  );
}
