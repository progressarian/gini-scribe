import { memo } from "react";
import { fmtDate, fmtDateLong, getLabVal, findLab, findLabHistory } from "./helpers";

// Get the most recent previous reading (before today's) from lab history
const getPrevLabVal = (labHistory, name) => {
  if (!labHistory) return null;
  const hist = findLabHistory(labHistory, name);
  if (!hist || hist.length === 0) return null;
  // History is oldest-first; last element is most recent prior reading
  const item = hist[hist.length - 1];
  return { result: item.result ?? item.value, date: item.date || item.test_date };
};

const fmtPrevDate = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
};

const STATUS_ICON = {
  controlled: "✓",
  Controlled: "✓",
  improving: "↑",
  Improving: "↑",
  review: "⚠",
  Review: "⚠",
  uncontrolled: "✖",
  Uncontrolled: "✖",
  monitoring: "○",
  Monitoring: "○",
  stable: "—",
  Stable: "—",
  resolved: "✓",
  Resolved: "✓",
};

const VisitRxPrint = memo(function VisitRxPrint({
  patient,
  doctor,
  summary,
  activeDx,
  activeMeds,
  stoppedMeds,
  latestVitals,
  prevVitals,
  labResults,
  labHistory,
  consultations,
  goals,
  flags,
  doctorNote,
  vitals,
}) {
  const today = new Date().toISOString().split("T")[0];
  const latestCon = consultations[0]?.con_data;
  const followUp = latestCon?.follow_up;
  const tests = latestCon?.investigations_to_order || latestCon?.tests_ordered || [];
  const lifestyle = latestCon?.diet_lifestyle || [];

  // Lab values
  const hba1c = getLabVal(labResults, "HbA1c");
  const fbs = getLabVal(labResults, "FBS");
  const ldl = getLabVal(labResults, "LDL");
  const tg = getLabVal(labResults, "Triglycerides");
  const creatinine = getLabVal(labResults, "Creatinine");
  const egfr = getLabVal(labResults, "eGFR");
  const tsh = getLabVal(labResults, "TSH");
  const hb = getLabVal(labResults, "Haemoglobin") || getLabVal(labResults, "Hemoglobin");
  const vitD = getLabVal(labResults, "Vitamin D");
  const uacr = getLabVal(labResults, "UACR");

  const bmi =
    latestVitals?.weight && latestVitals?.height
      ? (latestVitals.weight / (latestVitals.height / 100) ** 2).toFixed(1)
      : latestVitals?.bmi || null;

  // Build biomarker rows with goals (matching what UI shows)
  const biomarkerRows = [
    {
      label: "HbA1c",
      val: hba1c,
      prev: getPrevLabVal(labHistory, "HbA1c"),
      goal: "< 7.0%",
      unit: "%",
    },
    {
      label: "Fasting Blood Sugar",
      val: fbs,
      prev: getPrevLabVal(labHistory, "FBS"),
      goal: "< 100 mg/dL",
      unit: "mg/dL",
    },
    {
      label: "LDL Cholesterol",
      val: ldl,
      prev: getPrevLabVal(labHistory, "LDL"),
      goal: "< 70 mg/dL",
      unit: "mg/dL",
    },
    {
      label: "Triglycerides",
      val: tg,
      prev: getPrevLabVal(labHistory, "Triglycerides"),
      goal: "< 150 mg/dL",
      unit: "mg/dL",
    },
    {
      label: "Creatinine / eGFR",
      val: creatinine,
      extra: egfr,
      prev: getPrevLabVal(labHistory, "Creatinine"),
      goal: "eGFR > 60",
      unit: "mg/dL",
    },
    {
      label: "TSH",
      val: tsh,
      prev: getPrevLabVal(labHistory, "TSH"),
      goal: "< 4.5 µIU/mL",
      unit: "µIU/mL",
    },
    {
      label: "Haemoglobin",
      val: hb,
      prev: getPrevLabVal(labHistory, "Haemoglobin"),
      goal: "13–17 g/dL",
      unit: "g/dL",
    },
    {
      label: "Vitamin D",
      val: vitD,
      prev: getPrevLabVal(labHistory, "Vitamin D"),
      goal: "> 30 ng/mL",
      unit: "ng/mL",
    },
    {
      label: "UACR",
      val: uacr,
      prev: getPrevLabVal(labHistory, "UACR"),
      goal: "< 30 mg/g",
      unit: "mg/g",
    },
  ].filter((r) => r.val);

  // Weight change from previous visit
  const weightChange =
    latestVitals?.weight && prevVitals?.weight
      ? (latestVitals.weight - prevVitals.weight).toFixed(1)
      : null;

  // HbA1c first reading for journey (only meaningful if there are >1 entries)
  const hba1cHist = labHistory
    ? Object.entries(labHistory).find(
        ([k]) => k.toLowerCase().includes("hba1c") || k.toLowerCase().includes("a1c"),
      )
    : null;
  const hba1cHistArr = hba1cHist?.[1] || [];
  const hba1cFirstRaw = hba1cHistArr.length > 1 ? hba1cHistArr[0] : null;
  // Only show comparison if first reading differs from current
  const hba1cFirst =
    hba1cFirstRaw && String(hba1cFirstRaw.result || hba1cFirstRaw.value) !== String(hba1c?.result)
      ? hba1cFirstRaw
      : null;

  // Detect GLP-1/GIP agonist medications for side effect section
  const GLP1_KEYWORDS = [
    "tirzepatide",
    "semaglutide",
    "liraglutide",
    "dulaglutide",
    "mounjaro",
    "ozempic",
    "victoza",
    "rybelsus",
    "trulicity",
    "glp-1",
  ];
  const glp1Med = activeMeds.find((m) =>
    GLP1_KEYWORDS.some(
      (k) =>
        (m.name || "").toLowerCase().includes(k) || (m.composition || "").toLowerCase().includes(k),
    ),
  );

  // Insulin education from consultation
  const insulinEdu = latestCon?.insulin_education;
  const insulinMed = activeMeds.find(
    (m) =>
      (m.name || "").toLowerCase().includes("insulin") ||
      (m.composition || "").toLowerCase().includes("insulin") ||
      /ryzodeg|tresiba|lantus|basaglar|toujeo|novomix|mixtard/i.test(m.name || ""),
  );

  return (
    <div id="rx-print" style={{ display: "none" }}>
      {/* ═══════ HOSPITAL HEADER ═══════ */}
      <div className="rx-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="rx-logo">G</div>
          <div>
            <div className="rx-hosp-name">GINI ADVANCED CARE HOSPITAL</div>
            <div className="rx-hosp-sub">
              Shivalik Hospital, 2nd Floor, Sector 69, Mohali, Punjab · 01724120100 · +91 8146320100
            </div>
          </div>
        </div>
        <div>
          <div className="rx-dr-name">{doctor?.name || "Doctor"}</div>
          <div className="rx-dr-cred">
            {doctor?.qualification && (
              <>
                {doctor.qualification}
                <br />
              </>
            )}
            {doctor?.reg_no && <>Reg. No. {doctor.reg_no}</>}
          </div>
        </div>
      </div>

      {/* ═══════ PROGRAM PHASE BADGE ═══════ */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div className="rx-phase">
          INTENSIVE DIABETES MANAGEMENT PROGRAM
          {summary?.carePhase ? <> &nbsp;·&nbsp; {summary.carePhase}</> : ""}
          {summary?.totalVisits ? <> &nbsp;·&nbsp; Visit #{summary.totalVisits}</> : ""}
        </div>
      </div>

      {/* ═══════ PATIENT INFO ROW ═══════ */}
      <div className="rx-pt-row">
        <div className="rx-pt-field">
          <div className="rx-pt-lbl">Patient Name</div>
          <div className="rx-pt-val">{patient.name}</div>
        </div>
        <div className="rx-pt-field">
          <div className="rx-pt-lbl">Age / Sex</div>
          <div className="rx-pt-val">
            {patient.age ? `${patient.age} Years` : "—"} / {patient.sex || "—"}
          </div>
        </div>
        <div className="rx-pt-field">
          <div className="rx-pt-lbl">Patient ID</div>
          <div className="rx-pt-val">{patient.file_no || patient.id}</div>
        </div>
        <div className="rx-pt-field">
          <div className="rx-pt-lbl">Date</div>
          <div className="rx-pt-val">{fmtDateLong(today)}</div>
        </div>
      </div>

      {/* Blood Group & Allergies row */}
      {(patient.blood_group || patient.allergies) && (
        <div className="rx-pt-row" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
          {patient.blood_group && (
            <div className="rx-pt-field">
              <div className="rx-pt-lbl">Blood Group</div>
              <div className="rx-pt-val">{patient.blood_group}</div>
            </div>
          )}
          <div className="rx-pt-field">
            <div className="rx-pt-lbl">Allergies</div>
            <div className="rx-pt-val" style={{ color: patient.allergies ? "#ef4444" : "#6b7280" }}>
              {patient.allergies || "No known drug allergies"}
            </div>
          </div>
        </div>
      )}

      {/* ═══════ VITALS ═══════ */}
      {latestVitals && (
        <div className="rx-vitals">
          {latestVitals.height != null && (
            <div className="rx-vbox">
              <div className="rx-vv">{latestVitals.height} cm</div>
              <div className="rx-vl">Height</div>
            </div>
          )}
          {latestVitals.weight != null && (
            <div className="rx-vbox">
              <div className="rx-vv">{latestVitals.weight} kg</div>
              <div className="rx-vl">Weight</div>
            </div>
          )}
          {bmi && (
            <div className="rx-vbox">
              <div className="rx-vv">{bmi}</div>
              <div className="rx-vl">BMI</div>
            </div>
          )}
          {latestVitals.bp_sys != null && (
            <div className="rx-vbox">
              <div className="rx-vv">
                {latestVitals.bp_sys}/{latestVitals.bp_dia}
              </div>
              <div className="rx-vl">BP (mmHg)</div>
            </div>
          )}
          {(latestVitals.heart_rate || latestVitals.pulse) && (
            <div className="rx-vbox">
              <div className="rx-vv">{latestVitals.heart_rate || latestVitals.pulse}/min</div>
              <div className="rx-vl">Heart Rate</div>
            </div>
          )}
          {!!latestVitals.spo2 && (
            <div className="rx-vbox">
              <div className="rx-vv">{latestVitals.spo2}%</div>
              <div className="rx-vl">SpO2</div>
            </div>
          )}
          {!!latestVitals.temp && (
            <div className="rx-vbox">
              <div className="rx-vv">{latestVitals.temp}°F</div>
              <div className="rx-vl">Temp</div>
            </div>
          )}
          {!!latestVitals.waist && (
            <div className="rx-vbox">
              <div className="rx-vv">{latestVitals.waist} cm</div>
              <div className="rx-vl">Waist</div>
            </div>
          )}
          {!!latestVitals.body_fat && (
            <div className="rx-vbox">
              <div className="rx-vv">{latestVitals.body_fat}%</div>
              <div className="rx-vl">Body Fat</div>
            </div>
          )}
        </div>
      )}

      {/* ═══════ PATIENT JOURNEY — KEY MARKERS ═══════ */}
      {(summary?.totalVisits || hba1c || latestVitals?.weight) && (
        <>
          <div className="rx-sec-title">Patient Journey — Key Markers Trend</div>
          <div className="rx-journey">
            {summary?.monthsWithGini != null && (
              <div className="rx-jc">
                <div className="rx-jc-lbl">With Gini</div>
                <div className="rx-jc-val">
                  {summary.monthsWithGini >= 12
                    ? `${Math.floor(summary.monthsWithGini / 12)}+ yrs`
                    : `${summary.monthsWithGini}m`}
                </div>
                <div className="rx-jc-arrow" style={{ color: "#4466f5" }}>
                  {summary.totalVisits} visits
                </div>
              </div>
            )}
            {hba1c && (
              <div className="rx-jc">
                <div className="rx-jc-lbl">HbA1c</div>
                <div className="rx-jc-val">
                  {hba1c.result}
                  {hba1c.unit || "%"}
                </div>
                {hba1cFirst && (
                  <div
                    className="rx-jc-arrow"
                    style={{
                      color:
                        Number(hba1c.result) <= Number(hba1cFirst.result || hba1cFirst.value)
                          ? "#12b981"
                          : "#f59e0b",
                    }}
                  >
                    {Number(hba1c.result) <= Number(hba1cFirst.result || hba1cFirst.value)
                      ? "↓"
                      : "↑"}{" "}
                    from {hba1cFirst.result || hba1cFirst.value}%
                  </div>
                )}
              </div>
            )}
            {latestVitals?.weight != null && (
              <div className="rx-jc">
                <div className="rx-jc-lbl">Weight</div>
                <div className="rx-jc-val">{latestVitals.weight} kg</div>
                {weightChange && Number(weightChange) !== 0 && (
                  <div
                    className="rx-jc-arrow"
                    style={{ color: Number(weightChange) <= 0 ? "#12b981" : "#f59e0b" }}
                  >
                    {Number(weightChange) > 0 ? "↑" : "↓"} {Math.abs(Number(weightChange))} kg
                  </div>
                )}
              </div>
            )}
            {!!latestVitals?.waist && (
              <div className="rx-jc">
                <div className="rx-jc-lbl">Waist</div>
                <div className="rx-jc-val">{latestVitals.waist} cm</div>
                <div className="rx-jc-arrow" style={{ color: "#6b7280" }}>
                  —
                </div>
              </div>
            )}
            {!!latestVitals?.body_fat && (
              <div className="rx-jc">
                <div className="rx-jc-lbl">Body Fat</div>
                <div className="rx-jc-val">{latestVitals.body_fat}%</div>
                <div className="rx-jc-arrow" style={{ color: "#6b7280" }}>
                  —
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ═══════ CLINICAL ALERTS / FLAGS ═══════ */}
      {flags?.length > 0 && (
        <div
          style={{
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            borderRadius: 7,
            padding: "8px 14px",
            marginBottom: 12,
            fontSize: 11,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              color: "#92400e",
              textTransform: "uppercase",
              letterSpacing: ".5px",
              marginBottom: 4,
            }}
          >
            Clinical Alerts
          </div>
          {flags.map((f, i) => (
            <div
              key={i}
              style={{ color: f.type === "red" ? "#dc2626" : "#92400e", marginBottom: 2 }}
            >
              {f.icon} {f.text}
            </div>
          ))}
        </div>
      )}

      {/* ═══════ DIAGNOSES ═══════ */}
      {activeDx.length > 0 && (
        <>
          <div className="rx-sec-title">Diagnoses</div>
          <div className="rx-dx">
            {activeDx.map((d, i) => (
              <span key={i} className="rx-dx-tag">
                {STATUS_ICON[d.status] || "○"} {d.label || d.diagnosis_id}
                {d.since_year ? ` (Since ${d.since_year})` : ""}
                {d.status ? ` — ${d.status}` : ""}
              </span>
            ))}
          </div>
        </>
      )}

      {/* ═══════ TODAY'S KEY BIOMARKERS ═══════ */}
      {biomarkerRows.length > 0 && (
        <>
          <div className="rx-sec-title">Today's Key Biomarkers</div>
          <table className="rx-bm-table">
            <thead>
              <tr>
                <th>Test</th>
                <th>Today</th>
                <th>Previous</th>
                <th>Goal</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {biomarkerRows.map((r, i) => {
                const val = r.val;
                const result =
                  r.label === "Creatinine / eGFR" && r.extra
                    ? `${val.result} / ${r.extra.result}`
                    : `${val.result} ${val.unit || r.unit || ""}`;
                const prevText = r.prev?.result
                  ? `${r.prev.result}${r.prev.date ? ` (${fmtPrevDate(r.prev.date)})` : ""}`
                  : "—";
                // Lab flags from API: null = normal, "H" = high, "L" = low
                const isNormal = val.flag == null;
                const isHigh =
                  val.flag === "H" ||
                  val.flag === "high" ||
                  val.flag === "abnormal" ||
                  val.flag === "critical";
                const isLow = val.flag === "L" || val.flag === "low";
                const cls = isNormal ? "rx-ok" : isHigh ? "rx-ab" : "rx-wrn";
                const statusText = isNormal ? "✓ At Goal" : isHigh ? "↑ Review" : "↓ Low";
                return (
                  <tr key={i}>
                    <td>{r.label}</td>
                    <td>
                      <b>{result}</b>
                    </td>
                    <td style={{ color: "#6b7280" }}>{prevText}</td>
                    <td>{r.goal}</td>
                    <td className={cls}>{statusText}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {/* ═══════ MEDICATIONS (ACTIVE) ═══════ */}
      {activeMeds.length > 0 && (
        <>
          <div className="rx-sec-title">Medications</div>
          <div
            style={{
              border: "1px solid #e4e9f2",
              borderRadius: 8,
              overflow: "hidden",
              marginBottom: 12,
            }}
          >
            <div className="rx-med-row head">
              <span>MEDICINE (BRAND / GENERIC)</span>
              <span>DOSE</span>
              <span>WHEN TO TAKE</span>
              <span>FOR</span>
            </div>
            {activeMeds.map((m, i) => (
              <div key={i} className="rx-med-row">
                <div>
                  <div className="rx-med-nm">{m.name}</div>
                  {m.composition && <div className="rx-med-gen">{m.composition}</div>}
                  {m.route && <div className="rx-med-gen">{m.route}</div>}
                </div>
                <span>{m.dose || m.dosage || "—"}</span>
                <span>{[m.frequency, m.timing].filter(Boolean).join(" · ") || "—"}</span>
                <span>
                  {Array.isArray(m.for_diagnosis)
                    ? m.for_diagnosis.join(", ")
                    : m.for_diagnosis || m.indication || m.purpose || "—"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ═══════ STOPPED MEDICATIONS ═══════ */}
      {stoppedMeds?.length > 0 && (
        <>
          <div className="rx-sec-title" style={{ color: "#9ca3af" }}>
            Recently Stopped Medications
          </div>
          <div
            style={{
              border: "1px solid #e4e9f2",
              borderRadius: 8,
              overflow: "hidden",
              marginBottom: 12,
              opacity: 0.7,
            }}
          >
            {stoppedMeds.map((m, i) => (
              <div key={i} className="rx-med-row" style={{ fontSize: 10 }}>
                <div>
                  <div
                    className="rx-med-nm"
                    style={{ textDecoration: "line-through", fontSize: 11 }}
                  >
                    {m.name}
                  </div>
                  {m.composition && <div className="rx-med-gen">{m.composition}</div>}
                </div>
                <span>{m.dose || "—"}</span>
                <span>{m.stopped_date ? `Stopped ${fmtDate(m.stopped_date)}` : "Stopped"}</span>
                <span style={{ color: "#ef4444", fontSize: 10 }}>{m.stop_reason || "—"}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ═══════ GLP-1 SIDE EFFECT MANAGEMENT ═══════ */}
      {glp1Med && (
        <div className="rx-se">
          <div className="rx-se-title">{glp1Med.name} — Side Effect Management</div>
          <div>
            Nausea/Vomiting: Small bland meals · Tab Emset + Tab Rantac on Days 2–3 after injection
            · Diarrhoea: Tab Roko · Constipation: Increase fluids and fibre · Injection site: Rotate
            sites weekly
          </div>
        </div>
      )}

      {/* ═══════ TESTS ORDERED ═══════ */}
      {tests.length > 0 && (
        <div className="rx-inst">
          <div className="rx-inst-title">Investigations for Next Visit</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <tbody>
              {tests.map((t, i) => {
                const name = typeof t === "string" ? t : t.name || t.test;
                const urgent = t.urgency === "urgent";
                return (
                  <tr key={i} style={{ borderBottom: "1px solid #e4e9f2" }}>
                    <td style={{ padding: "4px 0", fontWeight: 600 }}>{name}</td>
                    <td style={{ padding: "4px 8px", textAlign: "right" }}>
                      {urgent ? (
                        <span style={{ color: "#ef4444", fontWeight: 700, fontSize: 10 }}>
                          URGENT
                        </span>
                      ) : (
                        <span style={{ color: "#6b7280", fontSize: 10 }}>Next visit</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════ FASTING LAB INSTRUCTIONS ═══════ */}
      {tests.length > 0 && (
        <div className="rx-inst">
          <div className="rx-inst-title">Fasting Lab Instructions (for next visit)</div>
          <ol>
            <li>
              Off all antidiabetic medications 24 hours before — Do NOT take any antidiabetic
              medicine the day before
            </li>
            <li>Nothing to eat or drink after 10 PM the previous night</li>
            <li>Collect sample between 8 AM – 9 AM</li>
            <li>Avoid alcohol the previous night</li>
            <li>No exercise, morning walk, or stairs on sample collection day</li>
          </ol>
        </div>
      )}

      {/* ═══════ LIFESTYLE INSTRUCTIONS ═══════ */}
      {lifestyle.length > 0 && (
        <div className="rx-inst">
          <div className="rx-inst-title">Lifestyle Instructions</div>
          <ul>
            {lifestyle.map((d, i) => (
              <li key={i}>
                {typeof d === "string"
                  ? d
                  : d.advice
                    ? `${d.advice}${d.detail ? ` · ${d.detail}` : ""}`
                    : d.instruction || JSON.stringify(d)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ═══════ GOALS SET ═══════ */}
      {goals?.length > 0 && (
        <div className="rx-inst" style={{ background: "#ecfdf5", border: "1px solid #a7f3d0" }}>
          <div className="rx-inst-title" style={{ color: "#065f46" }}>
            Goals Set for Patient
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th
                  style={{
                    textAlign: "left",
                    padding: "3px 0",
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#065f46",
                    textTransform: "uppercase",
                  }}
                >
                  Marker
                </th>
                <th
                  style={{
                    textAlign: "center",
                    padding: "3px 0",
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#065f46",
                    textTransform: "uppercase",
                  }}
                >
                  Current
                </th>
                <th
                  style={{
                    textAlign: "center",
                    padding: "3px 0",
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#065f46",
                    textTransform: "uppercase",
                  }}
                >
                  Target
                </th>
              </tr>
            </thead>
            <tbody>
              {goals.map((g, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #a7f3d0" }}>
                  <td style={{ padding: "4px 0", fontWeight: 600, color: "#047857" }}>
                    {g.marker}
                  </td>
                  <td style={{ padding: "4px 0", textAlign: "center", color: "#374151" }}>
                    {g.current_value}
                  </td>
                  <td
                    style={{
                      padding: "4px 0",
                      textAlign: "center",
                      fontWeight: 700,
                      color: "#047857",
                    }}
                  >
                    {g.target_value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════ INSULIN TITRATION GUIDE ═══════ */}
      {insulinEdu && (
        <div
          style={{
            background: "#f8f9fc",
            border: "1px solid #e4e9f2",
            borderRadius: 7,
            padding: "11px 14px",
            marginBottom: 10,
            pageBreakInside: "avoid",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              color: "#374151",
              textTransform: "uppercase",
              letterSpacing: ".5px",
              marginBottom: 8,
            }}
          >
            Insulin Titration Guide{insulinMed ? ` — ${insulinMed.name}` : ""}
            {insulinEdu.type ? ` (${insulinEdu.type})` : ""}
          </div>
          {insulinEdu.titration && (
            <div style={{ fontSize: 11, color: "#374151", marginBottom: 6 }}>
              {insulinEdu.titration}
            </div>
          )}
          {insulinEdu.hypo_management && (
            <div style={{ fontSize: 10, color: "#92400e", marginTop: 4 }}>
              Hypoglycaemia: {insulinEdu.hypo_management}
            </div>
          )}
          {insulinEdu.injection_sites?.length > 0 && (
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4 }}>
              Injection sites: {insulinEdu.injection_sites.join(", ")} — rotate weekly
            </div>
          )}
        </div>
      )}

      {/* ═══════ DOCTOR'S NOTE ═══════ */}
      {doctorNote && (
        <div className="rx-inst">
          <div className="rx-inst-title">Doctor's Note</div>
          <div style={{ whiteSpace: "pre-wrap", color: "#374151", lineHeight: 1.6 }}>
            {doctorNote}
          </div>
        </div>
      )}

      {/* ═══════ VITALS HISTORY TABLE ═══════ */}
      {vitals?.length > 1 && (
        <>
          <div className="rx-sec-title">
            Vitals History (Last {Math.min(vitals.length, 5)} Visits)
          </div>
          <table className="rx-bm-table" style={{ marginBottom: 14 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: "center" }}>Weight</th>
                <th style={{ textAlign: "center" }}>BMI</th>
                <th style={{ textAlign: "center" }}>BP</th>
                <th style={{ textAlign: "center" }}>Waist</th>
                <th style={{ textAlign: "center" }}>Body Fat</th>
              </tr>
            </thead>
            <tbody>
              {vitals.slice(0, 5).map((v, i) => (
                <tr key={v.id || i} style={{ fontWeight: i === 0 ? 700 : 400 }}>
                  <td>{fmtDate(v.recorded_at)}</td>
                  <td style={{ textAlign: "center" }}>{v.weight ? `${v.weight} kg` : "—"}</td>
                  <td style={{ textAlign: "center" }}>{v.bmi || "—"}</td>
                  <td style={{ textAlign: "center" }}>
                    {v.bp_sys && v.bp_dia ? `${v.bp_sys}/${v.bp_dia}` : "—"}
                  </td>
                  <td style={{ textAlign: "center" }}>{v.waist ? `${v.waist} cm` : "—"}</td>
                  <td style={{ textAlign: "center" }}>{v.body_fat ? `${v.body_fat}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ═══════ FOOTER ═══════ */}
      <div className="rx-footer">
        <div>
          <div
            style={{
              fontSize: 10,
              color: "#6b7280",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: ".5px",
              marginBottom: 3,
            }}
          >
            Next Visit
          </div>
          <div className="rx-next">
            {followUp?.date ? fmtDateLong(followUp.date) : "To be scheduled"}
          </div>
          {tests.length > 0 && (
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>
              Advice: {tests.map((t) => (typeof t === "string" ? t : t.name || t.test)).join(" · ")}
            </div>
          )}
        </div>
        <div className="rx-footer-contact">
          Gini Advanced Care Hospital
          <br />
          Shivalik Hospital, 2nd Floor, Sector 69, Mohali
          <br />
          01724120100 · WhatsApp: +91 8146320100
          <br />
          ginihealth.com
        </div>
      </div>

      {/* ═══════ SIGNATURE LINE ═══════ */}
      <div style={{ marginTop: 30, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ textAlign: "center", minWidth: 200 }}>
          <div
            style={{
              borderTop: "1px solid #374151",
              paddingTop: 6,
              fontSize: 11,
              fontWeight: 700,
              color: "#374151",
            }}
          >
            {doctor?.name || "Doctor's Signature"}
          </div>
          {doctor?.qualification && (
            <div style={{ fontSize: 9, color: "#6b7280" }}>{doctor.qualification}</div>
          )}
          {doctor?.reg_no && (
            <div style={{ fontSize: 9, color: "#6b7280" }}>Reg. No. {doctor.reg_no}</div>
          )}
        </div>
      </div>
    </div>
  );
});

export default VisitRxPrint;
