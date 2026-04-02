import { memo } from "react";
import { fmtDate, fmtDateLong, getLabVal, findLab } from "./helpers";

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
      ? (latestVitals.weight / ((latestVitals.height / 100) ** 2)).toFixed(1)
      : latestVitals?.bmi || null;

  // Build biomarker rows with goals (matching what UI shows)
  const biomarkerRows = [
    { label: "HbA1c", val: hba1c, goal: "< 7.0%", unit: "%" },
    { label: "Fasting Blood Sugar", val: fbs, goal: "< 100 mg/dL", unit: "mg/dL" },
    { label: "LDL Cholesterol", val: ldl, goal: "< 70 mg/dL", unit: "mg/dL" },
    { label: "Triglycerides", val: tg, goal: "< 150 mg/dL", unit: "mg/dL" },
    { label: "Creatinine / eGFR", val: creatinine, extra: egfr, goal: "eGFR > 60", unit: "mg/dL" },
    { label: "TSH", val: tsh, goal: "< 4.5 µIU/mL", unit: "µIU/mL" },
    { label: "Haemoglobin", val: hb, goal: "13–17 g/dL", unit: "g/dL" },
    { label: "Vitamin D", val: vitD, goal: "> 30 ng/mL", unit: "ng/mL" },
    { label: "UACR", val: uacr, goal: "< 30 mg/g", unit: "mg/g" },
  ].filter((r) => r.val);

  // Weight change from previous visit
  const weightChange =
    latestVitals?.weight && prevVitals?.weight
      ? (latestVitals.weight - prevVitals.weight).toFixed(1)
      : null;

  // HbA1c first reading for journey
  const hba1cHist = labHistory ? Object.entries(labHistory).find(([k]) =>
    k.toLowerCase().includes("hba1c") || k.toLowerCase().includes("a1c")
  ) : null;
  const hba1cHistArr = hba1cHist?.[1] || [];
  const hba1cFirst = hba1cHistArr.length > 0 ? hba1cHistArr[0] : null;

  return (
    <div id="rx-print">
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
            {doctor?.qualification && <>{doctor.qualification}<br /></>}
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
            <div className="rx-vbox"><div className="rx-vv">{latestVitals.height} cm</div><div className="rx-vl">Height</div></div>
          )}
          {latestVitals.weight != null && (
            <div className="rx-vbox"><div className="rx-vv">{latestVitals.weight} kg</div><div className="rx-vl">Weight</div></div>
          )}
          {bmi && (
            <div className="rx-vbox"><div className="rx-vv">{bmi}</div><div className="rx-vl">BMI</div></div>
          )}
          {latestVitals.bp_sys != null && (
            <div className="rx-vbox"><div className="rx-vv">{latestVitals.bp_sys}/{latestVitals.bp_dia}</div><div className="rx-vl">BP (mmHg)</div></div>
          )}
          {(latestVitals.heart_rate || latestVitals.pulse) && (
            <div className="rx-vbox"><div className="rx-vv">{latestVitals.heart_rate || latestVitals.pulse}/min</div><div className="rx-vl">Heart Rate</div></div>
          )}
          {latestVitals.spo2 != null && (
            <div className="rx-vbox"><div className="rx-vv">{latestVitals.spo2}%</div><div className="rx-vl">SpO2</div></div>
          )}
          {latestVitals.temp != null && (
            <div className="rx-vbox"><div className="rx-vv">{latestVitals.temp}°F</div><div className="rx-vl">Temp</div></div>
          )}
          {latestVitals.waist != null && (
            <div className="rx-vbox"><div className="rx-vv">{latestVitals.waist} cm</div><div className="rx-vl">Waist</div></div>
          )}
          {latestVitals.body_fat != null && (
            <div className="rx-vbox"><div className="rx-vv">{latestVitals.body_fat}%</div><div className="rx-vl">Body Fat</div></div>
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
                <div className="rx-jc-val">{summary.monthsWithGini >= 12 ? `${Math.floor(summary.monthsWithGini / 12)}+ yrs` : `${summary.monthsWithGini}m`}</div>
                <div className="rx-jc-arrow" style={{ color: "#4466f5" }}>{summary.totalVisits} visits</div>
              </div>
            )}
            {hba1c && (
              <div className="rx-jc">
                <div className="rx-jc-lbl">HbA1c</div>
                <div className="rx-jc-val">{hba1c.result}{hba1c.unit || "%"}</div>
                {hba1cFirst && (
                  <div className="rx-jc-arrow" style={{ color: Number(hba1c.result) <= Number(hba1cFirst.result || hba1cFirst.value) ? "#12b981" : "#f59e0b" }}>
                    {Number(hba1c.result) <= Number(hba1cFirst.result || hba1cFirst.value) ? "↓" : "↑"} from {hba1cFirst.result || hba1cFirst.value}%
                  </div>
                )}
              </div>
            )}
            {latestVitals?.weight != null && (
              <div className="rx-jc">
                <div className="rx-jc-lbl">Weight</div>
                <div className="rx-jc-val">{latestVitals.weight} kg</div>
                {weightChange && (
                  <div className="rx-jc-arrow" style={{ color: Number(weightChange) <= 0 ? "#12b981" : "#f59e0b" }}>
                    {Number(weightChange) > 0 ? "↑" : "↓"} {Math.abs(Number(weightChange))} kg
                  </div>
                )}
              </div>
            )}
            {latestVitals?.waist != null && (
              <div className="rx-jc">
                <div className="rx-jc-lbl">Waist</div>
                <div className="rx-jc-val">{latestVitals.waist} cm</div>
                <div className="rx-jc-arrow" style={{ color: "#6b7280" }}>—</div>
              </div>
            )}
            {latestVitals?.body_fat != null && (
              <div className="rx-jc">
                <div className="rx-jc-lbl">Body Fat</div>
                <div className="rx-jc-val">{latestVitals.body_fat}%</div>
                <div className="rx-jc-arrow" style={{ color: "#6b7280" }}>—</div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ═══════ CLINICAL ALERTS / FLAGS ═══════ */}
      {flags?.length > 0 && (
        <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 7, padding: "8px 14px", marginBottom: 12, fontSize: 11 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#92400e", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 4 }}>
            Clinical Alerts
          </div>
          {flags.map((f, i) => (
            <div key={i} style={{ color: f.type === "red" ? "#dc2626" : "#92400e", marginBottom: 2 }}>
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
                {STATUS_ICON[d.status] || "○"}{" "}
                {d.label || d.diagnosis_id}
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
                <th>Goal</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {biomarkerRows.map((r, i) => {
                const val = r.val;
                const result = r.label === "Creatinine / eGFR" && r.extra
                  ? `${val.result} / ${r.extra.result}`
                  : `${val.result} ${val.unit || r.unit || ""}`;
                const isOk = val.flag === "normal" || val.flag === "ok";
                const isAb = val.flag === "abnormal" || val.flag === "high" || val.flag === "critical";
                const cls = isOk ? "rx-ok" : isAb ? "rx-ab" : "rx-wrn";
                const statusText = isOk ? "✓ At Goal" : isAb ? "↑ Review" : "⚠ Borderline";
                return (
                  <tr key={i}>
                    <td>{r.label}</td>
                    <td><b>{result}</b></td>
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
          <div className="rx-sec-title">Medications ({activeMeds.length} Active)</div>
          <div style={{ border: "1px solid #e4e9f2", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
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
                <span>
                  {[m.frequency, m.timing].filter(Boolean).join(" · ") || "—"}
                </span>
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
          <div className="rx-sec-title" style={{ color: "#9ca3af" }}>Recently Stopped Medications</div>
          <div style={{ border: "1px solid #e4e9f2", borderRadius: 8, overflow: "hidden", marginBottom: 12, opacity: 0.7 }}>
            {stoppedMeds.map((m, i) => (
              <div key={i} className="rx-med-row" style={{ fontSize: 10 }}>
                <div>
                  <div className="rx-med-nm" style={{ textDecoration: "line-through", fontSize: 11 }}>{m.name}</div>
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

      {/* ═══════ TESTS ORDERED ═══════ */}
      {tests.length > 0 && (
        <div className="rx-inst">
          <div className="rx-inst-title">Tests Ordered</div>
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
                        <span style={{ color: "#ef4444", fontWeight: 700, fontSize: 10 }}>URGENT</span>
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

      {/* ═══════ LIFESTYLE INSTRUCTIONS ═══════ */}
      {lifestyle.length > 0 && (
        <div className="rx-inst">
          <div className="rx-inst-title">Lifestyle Instructions</div>
          <ul>
            {lifestyle.map((d, i) => (
              <li key={i}>{typeof d === "string" ? d : d.instruction || JSON.stringify(d)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ═══════ GOALS SET ═══════ */}
      {goals?.length > 0 && (
        <div className="rx-inst" style={{ background: "#ecfdf5", border: "1px solid #a7f3d0" }}>
          <div className="rx-inst-title" style={{ color: "#065f46" }}>Goals Set for Patient</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "3px 0", fontSize: 9, fontWeight: 700, color: "#065f46", textTransform: "uppercase" }}>Marker</th>
                <th style={{ textAlign: "center", padding: "3px 0", fontSize: 9, fontWeight: 700, color: "#065f46", textTransform: "uppercase" }}>Current</th>
                <th style={{ textAlign: "center", padding: "3px 0", fontSize: 9, fontWeight: 700, color: "#065f46", textTransform: "uppercase" }}>Target</th>
              </tr>
            </thead>
            <tbody>
              {goals.map((g, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #a7f3d0" }}>
                  <td style={{ padding: "4px 0", fontWeight: 600, color: "#047857" }}>{g.marker}</td>
                  <td style={{ padding: "4px 0", textAlign: "center", color: "#374151" }}>{g.current_value}</td>
                  <td style={{ padding: "4px 0", textAlign: "center", fontWeight: 700, color: "#047857" }}>{g.target_value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══════ DOCTOR'S NOTE ═══════ */}
      {doctorNote && (
        <div className="rx-inst">
          <div className="rx-inst-title">Doctor's Note</div>
          <div style={{ whiteSpace: "pre-wrap", color: "#374151", lineHeight: 1.6 }}>{doctorNote}</div>
        </div>
      )}

      {/* ═══════ VITALS HISTORY TABLE ═══════ */}
      {vitals?.length > 1 && (
        <>
          <div className="rx-sec-title">Vitals History (Last {Math.min(vitals.length, 5)} Visits)</div>
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
                  <td style={{ textAlign: "center" }}>{v.bp_sys && v.bp_dia ? `${v.bp_sys}/${v.bp_dia}` : "—"}</td>
                  <td style={{ textAlign: "center" }}>{v.waist ? `${v.waist} cm` : "—"}</td>
                  <td style={{ textAlign: "center" }}>{v.body_fat ? `${v.body_fat}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ═══════ VISIT SUMMARY ═══════ */}
      <div style={{ background: "#f8f9fc", borderRadius: 7, border: "1px solid #e4e9f2", padding: "10px 14px", marginBottom: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#374151", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 8 }}>
          Visit Summary — {fmtDate(today)}
        </div>
        <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
          <tbody>
            <tr style={{ borderBottom: "1px solid #e4e9f2" }}>
              <td style={{ padding: "4px 0", fontWeight: 700, color: "#6b7280", width: 100 }}>Patient</td>
              <td style={{ padding: "4px 0", color: "#1a1f2e" }}>
                {patient.name}, {patient.age}{patient.sex?.[0]} · ID: {patient.file_no || patient.id}
                {doctor?.name ? ` · ${doctor.name}` : ""}
              </td>
            </tr>
            <tr style={{ borderBottom: "1px solid #e4e9f2" }}>
              <td style={{ padding: "4px 0", fontWeight: 700, color: "#6b7280" }}>Program</td>
              <td style={{ padding: "4px 0", color: "#1a1f2e" }}>
                {summary?.carePhase || "—"} · Visit #{summary?.totalVisits || "—"}
              </td>
            </tr>
            <tr style={{ borderBottom: "1px solid #e4e9f2" }}>
              <td style={{ padding: "4px 0", fontWeight: 700, color: "#6b7280" }}>Diagnoses</td>
              <td style={{ padding: "4px 0", color: "#1a1f2e" }}>
                {activeDx.map((d) => `${d.label || d.diagnosis_id} (${d.status})`).join(", ") || "None"}
              </td>
            </tr>
            <tr style={{ borderBottom: "1px solid #e4e9f2" }}>
              <td style={{ padding: "4px 0", fontWeight: 700, color: "#6b7280" }}>Key Markers</td>
              <td style={{ padding: "4px 0", color: "#1a1f2e" }}>
                {[
                  hba1c && `HbA1c ${hba1c.result}%`,
                  fbs && `FPG ${fbs.result}`,
                  latestVitals?.bp_sys && `BP ${latestVitals.bp_sys}/${latestVitals.bp_dia}`,
                  latestVitals?.weight && `Weight ${latestVitals.weight}kg`,
                  ldl && `LDL ${ldl.result}`,
                  tsh && `TSH ${tsh.result}`,
                ].filter(Boolean).join(", ") || "—"}
              </td>
            </tr>
            <tr style={{ borderBottom: "1px solid #e4e9f2" }}>
              <td style={{ padding: "4px 0", fontWeight: 700, color: "#6b7280" }}>Medications</td>
              <td style={{ padding: "4px 0", color: "#1a1f2e" }}>
                {activeMeds.map((m) => m.name).join(" · ") || "None"}
              </td>
            </tr>
            {tests.length > 0 && (
              <tr style={{ borderBottom: "1px solid #e4e9f2" }}>
                <td style={{ padding: "4px 0", fontWeight: 700, color: "#6b7280" }}>Tests Ordered</td>
                <td style={{ padding: "4px 0", color: "#1a1f2e" }}>
                  {tests.map((t) => typeof t === "string" ? t : t.name || t.test).join(", ")}
                </td>
              </tr>
            )}
            <tr>
              <td style={{ padding: "4px 0", fontWeight: 700, color: "#6b7280" }}>Next Visit</td>
              <td style={{ padding: "4px 0", color: "#1a1f2e", fontWeight: 700 }}>
                {followUp?.date ? fmtDateLong(followUp.date) : followUp?.notes || "To be scheduled"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ═══════ FOOTER ═══════ */}
      <div className="rx-footer">
        <div>
          <div style={{ fontSize: 10, color: "#6b7280", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 3 }}>
            Next Visit
          </div>
          <div className="rx-next">
            {followUp?.date ? fmtDateLong(followUp.date) : "To be scheduled"}
          </div>
          {tests.length > 0 && (
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>
              Advice: {tests.map((t) => typeof t === "string" ? t : t.name || t.test).join(" · ")}
            </div>
          )}
        </div>
        <div className="rx-footer-contact">
          Gini Advanced Care Hospital<br />
          Shivalik Hospital, 2nd Floor, Sector 69, Mohali<br />
          01724120100 · WhatsApp: +91 8146320100<br />
          ginihealth.com
        </div>
      </div>

      {/* ═══════ SIGNATURE LINE ═══════ */}
      <div style={{ marginTop: 30, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ textAlign: "center", minWidth: 200 }}>
          <div style={{ borderTop: "1px solid #374151", paddingTop: 6, fontSize: 11, fontWeight: 700, color: "#374151" }}>
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
