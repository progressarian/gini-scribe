import "./DashboardPage.css";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import usePatientStore from "../stores/patientStore";
import useVitalsStore from "../stores/vitalsStore";
import useAuthStore from "../stores/authStore";
import useVisitStore from "../stores/visitStore";
import useLabStore from "../stores/labStore";
import useMessagingStore from "../stores/messagingStore";

const today = () => new Date().toISOString().split("T")[0];

// Flexible lab name matching — handles extracted report names vs display names
const LAB_ALIASES = {
  HbA1c: ["HbA1c", "Glycated Hemoglobin", "A1c"],
  FBS: ["FBS", "Fasting Glucose", "Fasting Blood Sugar", "FPG", "FBG", "Fasting Plasma Glucose"],
  Creatinine: ["Creatinine", "Cr"],
  eGFR: ["eGFR"],
  LDL: ["LDL"],
  HDL: ["HDL"],
  Triglycerides: ["Triglycerides", "TG"],
  TSH: ["TSH"],
  UACR: ["UACR", "Microalbumin"],
  "Vitamin D": ["Vitamin D", "Vit D", "25-OH Vitamin D"],
  "Vitamin B12": ["Vitamin B12", "Vit B12"],
};
const findLab = (labs, name) =>
  labs.find((l) => {
    const aliases = LAB_ALIASES[name] || [name];
    return aliases.some((a) => l.test_name === a || l.canonical_name === a);
  });

const bookingSchema = z.object({
  dt: z
    .string()
    .min(1, "Date is required")
    .refine((v) => v >= today(), "Cannot book for a past date"),
  doc: z.string().min(1, "Doctor is required"),
});

export default function DashboardPage() {
  const navigate = useNavigate();
  const patient = usePatientStore((s) => s.patient);
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const pfd = usePatientStore((s) => s.getPfd());
  const vitals = useVitalsStore((s) => s.vitals);
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const fetchDoctorsList = useAuthStore((s) => s.fetchDoctorsList);
  const appointments = useVisitStore((s) => s.appointments);
  const setAppointments = useVisitStore((s) => s.setAppointments);
  const showBooking = useVisitStore((s) => s.showBooking);
  const setShowBooking = useVisitStore((s) => s.setShowBooking);
  const bookForm = useVisitStore((s) => s.bookForm);
  const setBookForm = useVisitStore((s) => s.setBookForm);
  const editApptId = useVisitStore((s) => s.editApptId);
  const startVisit = useVisitStore((s) => s.startVisit);
  const openBooking = useVisitStore((s) => s.openBooking);
  const saveBooking = useVisitStore((s) => s.saveBooking);
  const cancelAppt = useVisitStore((s) => s.cancelAppt);
  const labRequisition = useLabStore((s) => s.labRequisition);
  const setLabRequisition = useLabStore((s) => s.setLabRequisition);
  const unreadCount = useMessagingStore((s) => s.unreadCount);
  const inbox = useMessagingStore((s) => s.inbox);
  const setActiveThread = useMessagingStore((s) => s.setActiveThread);
  const fetchThread = useMessagingStore((s) => s.fetchThread);
  const markRead = useMessagingStore((s) => s.markRead);
  const [bookErrors, setBookErrors] = useState({});

  useEffect(() => {
    if (!doctorsList.length) fetchDoctorsList();
  }, [doctorsList.length, fetchDoctorsList]);

  const handleSaveBooking = () => {
    const result = bookingSchema.safeParse({ dt: bookForm.dt, doc: bookForm.doc });
    if (!result.success) {
      const errs = {};
      result.error.issues.forEach((issue) => {
        errs[issue.path[0]] = issue.message;
      });
      setBookErrors(errs);
      return;
    }
    setBookErrors({});
    saveBooking(null, { dbPatientId, patient });
  };

  return (
    <div>
      {/* Patient Card — works for new AND existing patients */}
      <div className="dashboard__patient-card">
        <div className="dashboard__patient-row">
          <div className="dashboard__patient-avatar">
            {(patient.name || "?").charAt(0).toUpperCase()}
          </div>
          <div className="dashboard__patient-info">
            <div className="dashboard__patient-name">{patient.name || "New Patient"}</div>
            <div className="dashboard__patient-details">
              {patient.age ? `${patient.age}Y` : ""}
              {patient.sex ? ` · ${patient.sex}` : ""}
              {patient.fileNo ? ` · ${patient.fileNo}` : ""}
              {!dbPatientId && <span className="dashboard__new-badge">NEW</span>}
            </div>
            {patient.phone && <div className="dashboard__patient-phone">📱 {patient.phone}</div>}
          </div>
          <button onClick={() => navigate("/patient")} className="dashboard__edit-btn">
            ✏️ Edit
          </button>
        </div>
      </div>

      {/* ═══ PATIENT BRIEF (v2 style) ═══ */}
      {dbPatientId && pfd && (
        <div
          style={{
            background: "linear-gradient(135deg,#f0f9ff,#faf5ff)",
            borderRadius: 12,
            border: "2px solid #c7d2fe",
            padding: 14,
            marginBottom: 12,
          }}
        >
          {/* One-liner Summary */}
          <div
            style={{
              fontSize: 11,
              color: "#374151",
              lineHeight: 1.7,
              padding: "8px 12px",
              background: "white",
              borderRadius: 8,
              border: "1px solid #e9d5ff",
              marginBottom: 10,
            }}
          >
            <b>
              {patient.name} | {patient.age}Y/{patient.sex?.charAt(0) || "?"} |{" "}
              {(pfd?.diagnoses || [])
                .slice(0, 4)
                .map((d) => d.label || d.diagnosis_id)
                .join(" + ") || "No known dx"}{" "}
              |{" "}
              {
                [
                  ...new Set(
                    (pfd?.medications || []).map((m) =>
                      (m.name || "").toUpperCase().replace(/\s+/g, ""),
                    ),
                  ),
                ].length
              }{" "}
              meds | {pfd?.consultations?.length || 0} visits
            </b>
          </div>

          {/* Risk Flags */}
          {(() => {
            const flags = [];
            const labs = pfd?.lab_results || [];
            const hba1c = findLab(labs, "HbA1c");
            if (hba1c && parseFloat(hba1c.result) > 8)
              flags.push({
                t: "🔴 HbA1c " + hba1c.result + "% — uncontrolled",
                c: "#dc2626",
                bg: "#fef2f2",
              });
            const cr = findLab(labs, "Creatinine");
            if (cr && parseFloat(cr.result) > 1.3)
              flags.push({
                t: "⚠️ Cr " + cr.result + " — renal concern",
                c: "#92400e",
                bg: "#fef3c7",
              });
            const egfr = findLab(labs, "eGFR");
            if (egfr && parseFloat(egfr.result) < 60)
              flags.push({ t: "⚠️ eGFR " + egfr.result + " — CKD", c: "#92400e", bg: "#fef3c7" });
            return flags.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                {flags.map((f, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: 9,
                      background: f.bg,
                      color: f.c,
                      padding: "3px 8px",
                      borderRadius: 4,
                      fontWeight: 700,
                    }}
                  >
                    {f.t}
                  </span>
                ))}
              </div>
            ) : null;
          })()}

          {/* Patient Trajectory Status & Biomarker Control */}
          {(() => {
            const labs = pfd?.lab_results || [];
            const consults = pfd?.consultations || [];
            if (labs.length === 0) return null;
            const biomarkers = [];
            const a1c = findLab(labs, "HbA1c");
            if (a1c) {
              const val = parseFloat(a1c.result);
              biomarkers.push({ name: "HbA1c", val: `${val}%`, atTarget: val < 7, target: "<7%" });
            }
            const fbg = findLab(labs, "FBS");
            if (fbg) {
              const val = parseFloat(fbg.result);
              biomarkers.push({ name: "FBG", val: `${val}`, atTarget: val < 110, target: "<110" });
            }
            const egfr = findLab(labs, "eGFR");
            if (egfr) {
              const val = parseFloat(egfr.result);
              biomarkers.push({ name: "eGFR", val: `${val}`, atTarget: val >= 60, target: "≥60" });
            }
            const ldl = findLab(labs, "LDL");
            if (ldl) {
              const val = parseFloat(ldl.result);
              biomarkers.push({ name: "LDL", val: `${val}`, atTarget: val < 100, target: "<100" });
            }
            const tsh = findLab(labs, "TSH");
            if (tsh) {
              const val = parseFloat(tsh.result);
              biomarkers.push({
                name: "TSH",
                val: `${val}`,
                atTarget: val >= 0.4 && val <= 4.5,
                target: "0.4-4.5",
              });
            }
            const bp = pfd?.vitals?.[0];
            if (bp?.bp_sys) {
              const atT = bp.bp_sys < 130 && (bp.bp_dia || 0) < 80;
              biomarkers.push({
                name: "BP",
                val: `${bp.bp_sys}/${bp.bp_dia || "?"}`,
                atTarget: atT,
                target: "<130/80",
              });
            }
            if (biomarkers.length === 0) return null;
            const controlled = biomarkers.filter((b) => b.atTarget).length;
            const total = biomarkers.length;
            const uncontrolled = biomarkers.filter((b) => !b.atTarget);
            let status, sC, sBg, sI;
            if (controlled / total >= 0.8) {
              status = "Well Controlled";
              sC = "#059669";
              sBg = "#f0fdf4";
              sI = "✅";
            } else if (controlled / total >= 0.5) {
              status = "Partially Controlled";
              sC = "#d97706";
              sBg = "#fffbeb";
              sI = "⚠️";
            } else {
              status = "Needs Attention";
              sC = "#dc2626";
              sBg = "#fef2f2";
              sI = "🔴";
            }
            return (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      background: sBg,
                      color: sC,
                      padding: "4px 12px",
                      borderRadius: 6,
                      border: `1.5px solid ${sC}30`,
                    }}
                  >
                    {sI} {status} — {controlled}/{total} at target
                  </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                  {biomarkers.map((b, i) => (
                    <span
                      key={i}
                      style={{
                        fontSize: 9,
                        padding: "3px 7px",
                        borderRadius: 4,
                        fontWeight: 700,
                        background: b.atTarget ? "#f0fdf4" : "#fef2f2",
                        color: b.atTarget ? "#059669" : "#dc2626",
                        border: `1px solid ${b.atTarget ? "#bbf7d0" : "#fecaca"}`,
                      }}
                    >
                      {b.atTarget ? "✓" : "✗"} {b.name}: {b.val}{" "}
                      {!b.atTarget ? `(→${b.target})` : ""}
                    </span>
                  ))}
                </div>
                {uncontrolled.length > 0 && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 10,
                      color: "#dc2626",
                      fontWeight: 600,
                      background: "#fef2f2",
                      padding: "4px 8px",
                      borderRadius: 4,
                      border: "1px solid #fecaca",
                    }}
                  >
                    ⚡ Focus:{" "}
                    {uncontrolled.map((b) => `${b.name} ${b.val} → ${b.target}`).join(" · ")}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Active Diagnoses */}
          {(pfd?.diagnoses || []).length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#6d28d9", marginBottom: 4 }}>
                CONDITIONS
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {[
                  ...new Map(
                    (pfd?.diagnoses || []).map((d) => [d.diagnosis_id || d.label, d]),
                  ).values(),
                ]
                  .slice(0, 8)
                  .map((d, i) => (
                    <span
                      key={i}
                      style={{
                        fontSize: 10,
                        padding: "3px 8px",
                        borderRadius: 5,
                        fontWeight: 600,
                        background:
                          d.status === "Uncontrolled"
                            ? "#fef2f2"
                            : d.status === "Controlled"
                              ? "#f0fdf4"
                              : "#fefce8",
                        color:
                          d.status === "Uncontrolled"
                            ? "#dc2626"
                            : d.status === "Controlled"
                              ? "#059669"
                              : "#92400e",
                      }}
                    >
                      {d.label || d.diagnosis_id}
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Key Lab Values */}
          {(pfd?.lab_results || []).length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#6d28d9", marginBottom: 4 }}>
                🔬 KEY LABS
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {[
                  { display: "HbA1c", match: ["HbA1c", "Glycated Hemoglobin"] },
                  {
                    display: "FBS",
                    match: ["FBS", "Fasting Glucose", "Fasting Blood Sugar", "FPG", "FBG"],
                  },
                  { display: "PPBS", match: ["PPBS", "Post Prandial Blood Sugar"] },
                  { display: "Creatinine", match: ["Creatinine"] },
                  { display: "eGFR", match: ["eGFR"] },
                  { display: "LDL", match: ["LDL"] },
                  { display: "HDL", match: ["HDL"] },
                  { display: "TG", match: ["Triglycerides", "TG"] },
                  { display: "TSH", match: ["TSH"] },
                  { display: "UACR", match: ["UACR", "Microalbumin"] },
                  { display: "Vit D", match: ["Vitamin D", "Vit D", "25-OH Vitamin D"] },
                  { display: "Vit B12", match: ["Vitamin B12", "Vit B12"] },
                ].map(({ display, match }) => {
                  const lab = (pfd?.lab_results || []).find((l) =>
                    match.some((m) => l.test_name === m || l.canonical_name === m),
                  );
                  if (!lab) return null;
                  return (
                    <span
                      key={display}
                      style={{
                        fontSize: 10,
                        padding: "2px 6px",
                        borderRadius: 4,
                        fontWeight: 600,
                        background:
                          lab.flag === "H" ? "#fef2f2" : lab.flag === "L" ? "#eff6ff" : "#f0fdf4",
                        color:
                          lab.flag === "H" ? "#dc2626" : lab.flag === "L" ? "#2563eb" : "#059669",
                        border: `1px solid ${lab.flag === "H" ? "#fecaca" : lab.flag === "L" ? "#bfdbfe" : "#bbf7d0"}`,
                      }}
                    >
                      {display}: <b>{lab.result}</b>
                      {lab.unit ? " " + lab.unit : ""}{" "}
                      {lab.flag === "H" ? "↑" : lab.flag === "L" ? "↓" : ""}
                      {lab.test_date && (
                        <span style={{ color: "#94a3b8", fontSize: 8, marginLeft: 2 }}>
                          {new Date(lab.test_date).toLocaleDateString("en-IN", {
                            day: "2-digit",
                            month: "short",
                          })}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* All Lab Results (from reports & manual) */}
          {(pfd?.lab_results || []).length > 0 &&
            (() => {
              const allLabs = pfd.lab_results;
              // Deduplicate: keep only latest value per test
              const seenTests = new Set();
              const dedupedLabs = allLabs.filter((l) => {
                const key = (l.canonical_name || l.test_name || "")
                  .toUpperCase()
                  .replace(/\s+/g, "");
                if (seenTests.has(key)) return false;
                seenTests.add(key);
                return true;
              });
              // Group by panel_name or source
              const panels = {};
              for (const l of dedupedLabs) {
                const pn = l.panel_name || "Other Tests";
                if (!panels[pn]) panels[pn] = [];
                panels[pn].push(l);
              }
              return (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#6d28d9", marginBottom: 4 }}>
                    📋 ALL LAB RESULTS ({dedupedLabs.length})
                  </div>
                  {Object.entries(panels).map(([panelName, tests]) => (
                    <div key={panelName} style={{ marginBottom: 6 }}>
                      <div
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          color: "#64748b",
                          textTransform: "uppercase",
                          letterSpacing: ".05em",
                          marginBottom: 3,
                        }}
                      >
                        {panelName}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
                        {tests.map((l, i) => (
                          <div
                            key={i}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              fontSize: 10,
                              padding: "3px 6px",
                              background:
                                l.flag === "H"
                                  ? "#fef2f2"
                                  : l.flag === "L"
                                    ? "#eff6ff"
                                    : i % 2
                                      ? "#f8fafc"
                                      : "white",
                              borderRadius: 3,
                              border: l.flag
                                ? `1px solid ${l.flag === "H" ? "#fecaca" : "#bfdbfe"}`
                                : "none",
                            }}
                          >
                            <span style={{ fontWeight: 600, color: "#374151" }}>{l.test_name}</span>
                            <span>
                              <b
                                style={{
                                  color:
                                    l.flag === "H"
                                      ? "#dc2626"
                                      : l.flag === "L"
                                        ? "#2563eb"
                                        : "#059669",
                                }}
                              >
                                {l.result}
                                {l.result_text || ""}
                              </b>
                              <span style={{ color: "#94a3b8", fontSize: 9, marginLeft: 2 }}>
                                {l.unit || ""}
                              </span>
                              {l.flag === "H" ? " ↑" : l.flag === "L" ? " ↓" : ""}
                              {l.test_date && (
                                <span style={{ color: "#94a3b8", fontSize: 8, marginLeft: 3 }}>
                                  {`(${new Date(l.test_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })})`}
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

          {/* Medications — current plan + active external only */}
          {(pfd?.medications || []).length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#6d28d9", marginBottom: 4 }}>
                💊 ACTIVE MEDICATIONS (
                {(pfd?.medications || []).filter((m) => m.is_active !== false).length})
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
                {(() => {
                  const seen = new Set();
                  return (pfd?.medications || [])
                    .filter((m) => {
                      if (m.is_active === false) return false;
                      const k = (m.name || "").toUpperCase().replace(/\s+/g, "");
                      if (seen.has(k)) return false;
                      seen.add(k);
                      return true;
                    })
                    .slice(0, 12)
                    .map((m, i) => (
                      <div
                        key={i}
                        style={{
                          fontSize: 10,
                          padding: "2px 6px",
                          background: m.is_new ? "#f0fdf4" : i % 2 ? "#f8fafc" : "white",
                          borderRadius: 3,
                        }}
                      >
                        <strong>{m.name}</strong>{" "}
                        <span style={{ color: "#64748b" }}>
                          {m.dose || ""} {m.frequency || ""}
                        </span>
                        {m.is_new && (
                          <span
                            style={{
                              fontSize: 7,
                              color: "#059669",
                              fontWeight: 800,
                              marginLeft: 3,
                            }}
                          >
                            NEW
                          </span>
                        )}
                      </div>
                    ));
                })()}
              </div>
            </div>
          )}

          {/* Recent Documents */}
          {(pfd?.documents || []).length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#6d28d9", marginBottom: 4 }}>
                📎 RECENT DOCUMENTS
              </div>
              {(pfd?.documents || []).slice(0, 4).map((d, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 0",
                    fontSize: 10,
                    borderBottom: i < 3 ? "1px solid #f1f5f9" : "none",
                  }}
                >
                  <span>
                    {d.doc_type === "lab" ? "🔬" : d.doc_type === "prescription" ? "💊" : "📋"}
                  </span>
                  <span style={{ fontWeight: 700, flex: 1 }}>{d.title || d.doc_type}</span>
                  <span style={{ fontSize: 9, color: "#94a3b8" }}>
                    {d.doc_date
                      ? new Date(d.doc_date).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                        })
                      : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Quick Stats */}
      {dbPatientId && (
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}
        >
          <div
            style={{ background: "#eff6ff", borderRadius: 10, padding: 12, textAlign: "center" }}
          >
            <div style={{ fontSize: 22, fontWeight: 800, color: "#2563eb" }}>
              {pfd?.consultations?.length || 0}
            </div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b" }}>Total Visits</div>
          </div>
          <div
            style={{ background: "#fef3c7", borderRadius: 10, padding: 12, textAlign: "center" }}
          >
            <div style={{ fontSize: 22, fontWeight: 800, color: "#d97706" }}>
              {pfd?.consultations?.[0]?.visit_date
                ? new Date(
                    String(pfd.consultations[0].visit_date).slice(0, 10) + "T12:00:00",
                  ).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
                : "—"}
            </div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b" }}>Last Visit</div>
          </div>
          <div
            style={{ background: "#f0fdf4", borderRadius: 10, padding: 12, textAlign: "center" }}
          >
            <div style={{ fontSize: 22, fontWeight: 800, color: "#059669" }}>
              {findLab(pfd?.lab_results || [], "HbA1c")?.result
                ? `${findLab(pfd.lab_results, "HbA1c").result}%`
                : "—"}
            </div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#64748b" }}>Last HbA1c</div>
          </div>
        </div>
      )}

      {/* ═══ START VISIT ═══ */}
      <div style={{ marginBottom: 12 }}>
        <button
          onClick={() => startVisit(null, { dbPatientId })}
          style={{
            width: "100%",
            padding: "14px",
            background: "linear-gradient(135deg,#059669,#10b981)",
            color: "white",
            border: "none",
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 800,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            boxShadow: "0 2px 8px rgba(5,150,105,.25)",
          }}
        >
          🩺 Start Visit
        </button>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button
            onClick={() => openBooking(null)}
            style={{
              flex: 1,
              padding: "10px",
              background: "#eff6ff",
              border: "1.5px solid #bfdbfe",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              color: "#1e40af",
            }}
          >
            📅 Book Appointment
          </button>
          <button
            onClick={() => {
              startVisit(null, { dbPatientId });
            }}
            style={{
              flex: 1,
              padding: "10px",
              background: "#fef3c7",
              border: "1.5px solid #fde68a",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              color: "#92400e",
            }}
          >
            🚶 Walk-in Visit
          </button>
        </div>
      </div>

      {/* ═══ BOOKING MODAL ═══ */}
      {showBooking && (
        <div
          style={{
            background: "white",
            border: "2px solid #3b82f6",
            borderRadius: 12,
            padding: 16,
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: "#1e40af" }}>
              {editApptId ? "✏️ Edit Appointment" : "📅 New Appointment"}
            </span>
            <button
              onClick={() => setShowBooking(false)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 14,
                color: "#94a3b8",
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: "#475569" }}>Date</label>
              <input
                type="date"
                value={bookForm.dt}
                min={today()}
                onChange={(e) => {
                  setBookForm({ ...bookForm, dt: e.target.value });
                  if (e.target.value) setBookErrors((p) => ({ ...p, dt: undefined }));
                }}
                style={{
                  width: "100%",
                  padding: "8px",
                  border: `1px solid ${bookErrors.dt ? "#ef4444" : "#e2e8f0"}`,
                  borderRadius: 6,
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              />
              {bookErrors.dt && (
                <div style={{ color: "#ef4444", fontSize: 10, marginTop: 2 }}>{bookErrors.dt}</div>
              )}
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: "#475569" }}>Time</label>
              <input
                type="time"
                value={bookForm.tm}
                onChange={(e) => setBookForm({ ...bookForm, tm: e.target.value })}
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: "#475569" }}>Type</label>
              <div style={{ display: "flex", gap: 3 }}>
                {["OPD", "Follow-up", "IPD", "Lab"].map((t) => (
                  <button
                    key={t}
                    onClick={() => setBookForm({ ...bookForm, ty: t })}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 6,
                      fontSize: 10,
                      fontWeight: 600,
                      cursor: "pointer",
                      border: `1.5px solid ${bookForm.ty === t ? "#2563eb" : "#e2e8f0"}`,
                      background: bookForm.ty === t ? "#eff6ff" : "white",
                      color: bookForm.ty === t ? "#2563eb" : "#64748b",
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 600, color: "#475569" }}>Specialty</label>
              <select
                value={bookForm.sp}
                onChange={(e) => setBookForm({ ...bookForm, sp: e.target.value })}
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  fontSize: 12,
                  boxSizing: "border-box",
                  color: "#1e293b",
                }}
              >
                <option value="" disabled>
                  Select Specialty
                </option>
                {[
                  "Endocrinology",
                  "Cardiology",
                  "Neurology",
                  "Orthopaedics",
                  "Urology",
                  "Pulmonology",
                  "General Medicine",
                  "Ophthalmology",
                  "Dermatology",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            <div style={{ gridColumn: "1/-1" }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: "#475569" }}>Doctor</label>
              <select
                value={bookForm.doc}
                onChange={(e) => {
                  setBookForm({ ...bookForm, doc: e.target.value });
                  if (e.target.value) setBookErrors((p) => ({ ...p, doc: undefined }));
                }}
                style={{
                  width: "100%",
                  padding: "8px",
                  border: `1px solid ${bookErrors.doc ? "#ef4444" : "#e2e8f0"}`,
                  borderRadius: 6,
                  fontSize: 12,
                  boxSizing: "border-box",
                  color: "#1e293b",
                }}
              >
                <option value="" disabled>
                  Select Doctor *
                </option>
                {doctorsList.map((d) => (
                  <option key={d.id} value={d.short_name || d.name}>
                    {d.name}
                    {d.specialty ? ` — ${d.specialty}` : ""}
                  </option>
                ))}
              </select>
              {bookErrors.doc && (
                <div style={{ color: "#ef4444", fontSize: 10, marginTop: 2 }}>{bookErrors.doc}</div>
              )}
            </div>
            <div style={{ gridColumn: "1/-1" }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: "#475569" }}>Notes</label>
              <input
                value={bookForm.notes}
                onChange={(e) => setBookForm({ ...bookForm, notes: e.target.value })}
                placeholder="Fasting required..."
                style={{
                  width: "100%",
                  padding: "8px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              />
            </div>
            {/* Lab-specific options */}
            {bookForm.ty === "Lab" && (
              <>
                <div style={{ gridColumn: "1/-1" }}>
                  <label
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: "#475569",
                      marginBottom: 4,
                      display: "block",
                    }}
                  >
                    Sample Collection
                  </label>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[
                      { v: "hospital", l: "🏥 At Hospital", bg: "#eff6ff", cl: "#2563eb" },
                      { v: "home", l: "🏠 Home Pickup", bg: "#f0fdf4", cl: "#059669" },
                    ].map((o) => (
                      <button
                        key={o.v}
                        onClick={() => setBookForm({ ...bookForm, labPickup: o.v })}
                        style={{
                          flex: 1,
                          padding: "8px",
                          borderRadius: 6,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: "pointer",
                          border: `2px solid ${bookForm.labPickup === o.v ? o.cl : "#e2e8f0"}`,
                          background: bookForm.labPickup === o.v ? o.bg : "white",
                          color: bookForm.labPickup === o.v ? o.cl : "#64748b",
                        }}
                      >
                        {o.l}
                      </button>
                    ))}
                  </div>
                  {bookForm.labPickup === "home" && (
                    <div
                      style={{
                        marginTop: 4,
                        padding: 6,
                        background: "#fffbeb",
                        borderRadius: 6,
                        border: "1px solid #fde68a",
                        fontSize: 10,
                        color: "#92400e",
                      }}
                    >
                      ⚠️ Home pickup: ₹200 extra charge. Fasting samples before 8:30 AM.
                    </div>
                  )}
                </div>
                <div style={{ gridColumn: "1/-1" }}>
                  <label
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: "#475569",
                      marginBottom: 4,
                      display: "block",
                    }}
                  >
                    Tests / Packages
                  </label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 6 }}>
                    {[
                      "HbA1c",
                      "Lipid Panel",
                      "RFT",
                      "LFT",
                      "CBC",
                      "Thyroid",
                      "Vit D",
                      "Vit B12",
                      "FBS",
                      "PPBS",
                      "Urine R/M",
                      "UACR",
                      "Iron Studies",
                    ].map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          const cur = bookForm.labTests || [];
                          setBookForm({
                            ...bookForm,
                            labTests: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
                          });
                        }}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 5,
                          fontSize: 10,
                          fontWeight: 600,
                          cursor: "pointer",
                          border: `1.5px solid ${(bookForm.labTests || []).includes(t) ? "#059669" : "#e2e8f0"}`,
                          background: (bookForm.labTests || []).includes(t) ? "#f0fdf4" : "white",
                          color: (bookForm.labTests || []).includes(t) ? "#059669" : "#64748b",
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  {/* Packages */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {[
                      {
                        l: "📦 DM Panel (HbA1c+FBS+PPBS+RFT+UACR)",
                        tests: ["HbA1c", "FBS", "PPBS", "RFT", "UACR"],
                      },
                      {
                        l: "📦 Annual Health (CBC+LFT+RFT+Lipid+Thyroid+VitD)",
                        tests: ["CBC", "LFT", "RFT", "Lipid Panel", "Thyroid", "Vit D"],
                      },
                      { l: "📦 Cardiac (Lipid+hs-CRP+NT-proBNP+ECG)", tests: ["Lipid Panel"] },
                    ].map((pkg) => (
                      <button
                        key={pkg.l}
                        onClick={() => {
                          const cur = bookForm.labTests || [];
                          const newTests = [...new Set([...cur, ...pkg.tests])];
                          setBookForm({ ...bookForm, labTests: newTests });
                        }}
                        style={{
                          padding: "5px 10px",
                          borderRadius: 6,
                          fontSize: 10,
                          fontWeight: 600,
                          cursor: "pointer",
                          border: "1.5px solid #7c3aed20",
                          background: "#faf5ff",
                          color: "#6d28d9",
                        }}
                      >
                        {pkg.l}
                      </button>
                    ))}
                  </div>
                  {(bookForm.labTests || []).length > 0 && (
                    <div style={{ marginTop: 4, fontSize: 10, color: "#059669", fontWeight: 700 }}>
                      ✅ {(bookForm.labTests || []).length} tests:{" "}
                      {(bookForm.labTests || []).join(", ")}
                    </div>
                  )}
                </div>
              </>
            )}
            <button
              onClick={handleSaveBooking}
              style={{
                gridColumn: "1/-1",
                padding: "10px",
                background: "#059669",
                color: "white",
                border: "none",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {editApptId ? "✅ Update" : "✅ Book Appointment"}
            </button>
          </div>
        </div>
      )}

      {/* ═══ UPCOMING APPOINTMENTS ═══ */}
      {appointments.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#94a3b8",
              marginBottom: 6,
              letterSpacing: ".5px",
            }}
          >
            UPCOMING APPOINTMENTS
          </div>
          {appointments.map((a) => {
            const st = a.st || "scheduled";
            const isDone = st === "completed" || st === "in-progress";
            const isCancelled = st === "cancelled";
            const isNoShow = st === "no_show";
            const statusColor =
              st === "completed"
                ? "#059669"
                : st === "in-progress"
                  ? "#d97706"
                  : st === "cancelled"
                    ? "#dc2626"
                    : st === "no_show"
                      ? "#6b7280"
                      : "#2563eb";
            const statusBg =
              st === "completed"
                ? "#f0fdf4"
                : st === "in-progress"
                  ? "#fffbeb"
                  : st === "cancelled"
                    ? "#fef2f2"
                    : st === "no_show"
                      ? "#f3f4f6"
                      : "#eff6ff";
            const statusLabel =
              st === "completed"
                ? "\u2713 Done"
                : st === "in-progress"
                  ? "\u25b6 In Progress"
                  : st === "cancelled"
                    ? "\u2715 Cancelled"
                    : st === "no_show"
                      ? "No Show"
                      : "\u25cf Scheduled";
            return (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 8,
                  marginBottom: 4,
                  background: a.ty === "Lab" ? "#f0fdf4" : "#f8fafc",
                  border: `1px solid ${a.ty === "Lab" ? "#bbf7d0" : "#e2e8f0"}`,
                  opacity: isCancelled || isNoShow ? 0.6 : 1,
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: a.ty === "Lab" ? "#059669" : a.ty === "OPD" ? "#3b82f6" : "#f59e0b",
                  }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#1e293b" }}>
                    {a.ty} {a.sp ? `— ${a.sp}` : ""}
                  </div>
                  <div style={{ fontSize: 10, color: "#64748b" }}>
                    {a.doc}
                    {a.notes ? ` · ${a.notes}` : ""}
                  </div>
                </div>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    fontSize: 9,
                    fontWeight: 700,
                    background: statusBg,
                    color: statusColor,
                    whiteSpace: "nowrap",
                  }}
                >
                  {statusLabel}
                </span>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, fontWeight: 700 }}>
                    {a.dt
                      ? new Date(a.dt).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                        })
                      : "TBD"}
                  </div>
                  {a.tm && <div style={{ fontSize: 9, color: "#64748b" }}>{a.tm}</div>}
                </div>
                {!isDone && !isCancelled && !isNoShow && (
                  <div style={{ display: "flex", gap: 3 }}>
                    <button
                      onClick={() => openBooking(a)}
                      title="Edit"
                      style={{
                        padding: "3px 6px",
                        background: "#eff6ff",
                        color: "#2563eb",
                        border: "none",
                        borderRadius: 4,
                        fontSize: 10,
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => cancelAppt(a.id)}
                      title="Cancel"
                      style={{
                        padding: "3px 6px",
                        background: "#fef2f2",
                        color: "#dc2626",
                        border: "none",
                        borderRadius: 4,
                        fontSize: 10,
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      ✕
                    </button>
                    {a.ty !== "Lab" && (
                      <button
                        onClick={() => startVisit(a.id, { dbPatientId })}
                        title="Start Visit"
                        style={{
                          padding: "3px 8px",
                          background: "#059669",
                          color: "white",
                          border: "none",
                          borderRadius: 4,
                          fontSize: 10,
                          cursor: "pointer",
                          fontWeight: 700,
                        }}
                      >
                        ▶ Start
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ LAB REQUISITION (from History tab) ═══ */}
      {labRequisition.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: 12,
            background: "#fffbeb",
            border: "1.5px solid #fde68a",
            borderRadius: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 14 }}>🔬</span>
            <span style={{ fontSize: 12, fontWeight: 800, color: "#92400e" }}>
              Lab Requisition — {labRequisition.length} tests
            </span>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => {
                const appt = {
                  id: "appt_" + Date.now(),
                  dt: new Date().toISOString().slice(0, 10),
                  tm: "08:30",
                  ty: "Lab",
                  sp: "Lab",
                  doc: "Gini Lab",
                  notes: `Tests: ${labRequisition.join(", ")}`,
                  labTests: labRequisition,
                  labPickup: "hospital",
                };
                setAppointments((prev) => [...prev, appt]);
              }}
              style={{
                padding: "4px 10px",
                background: "#059669",
                color: "white",
                border: "none",
                borderRadius: 6,
                fontSize: 10,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              📅 Schedule Lab
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {labRequisition.map((t) => (
              <span
                key={t}
                style={{
                  fontSize: 10,
                  padding: "3px 8px",
                  borderRadius: 5,
                  fontWeight: 600,
                  background: "white",
                  color: "#92400e",
                  border: "1px solid #fde68a",
                }}
              >
                {t}
                <button
                  onClick={() =>
                    setLabRequisition(useLabStore.getState().labRequisition.filter((x) => x !== t))
                  }
                  style={{
                    background: "none",
                    border: "none",
                    color: "#dc2626",
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 9,
                    marginLeft: 3,
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <button
            onClick={() => window.print()}
            style={{
              marginTop: 6,
              width: "100%",
              padding: "6px",
              background: "#92400e",
              color: "white",
              border: "none",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            🖨️ Print Requisition
          </button>
        </div>
      )}

      {/* Navigation Grid */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "#94a3b8",
          marginBottom: 8,
          letterSpacing: ".5px",
        }}
      >
        GO TO
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {[
          { path: "/quick", icon: "⚡", label: "Quick Dictation", color: "#dc2626", bg: "#fef2f2" },
          {
            path: "/patient",
            icon: "👤",
            label: "Patient Details",
            color: "#1e40af",
            bg: "#eff6ff",
          },
          { path: "/mo", icon: "🎤", label: "MO Entry", color: "#ea580c", bg: "#fff7ed" },
          { path: "/consultant", icon: "👨‍⚕️", label: "Consultant", color: "#0d9488", bg: "#f0fdfa" },
          { path: "/plan", icon: "📄", label: "Plan / Print", color: "#1e293b", bg: "#f1f5f9" },
          { path: "/docs", icon: "📎", label: "Documents", color: "#6366f1", bg: "#eef2ff" },
          { path: "/history", icon: "📜", label: "History", color: "#b45309", bg: "#fffbeb" },
          { path: "/outcomes", icon: "📊", label: "Outcomes", color: "#059669", bg: "#f0fdf4" },
        ].map((n) => (
          <button
            key={n.path}
            onClick={() => navigate(n.path)}
            style={{
              background: n.bg,
              border: `1px solid ${n.color}22`,
              borderRadius: 10,
              padding: "14px 8px",
              textAlign: "center",
              cursor: "pointer",
              transition: "all .15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.02)";
              e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,.08)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <div style={{ fontSize: 22, marginBottom: 4 }}>{n.icon}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: n.color }}>{n.label}</div>
          </button>
        ))}
      </div>

      {/* Unread Messages Widget */}
      {unreadCount > 0 && (
        <div
          style={{
            marginTop: 14,
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: 12,
            padding: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>
              💬 Patient Messages{" "}
              <span
                style={{
                  background: "#dc2626",
                  color: "white",
                  borderRadius: 10,
                  padding: "2px 7px",
                  fontSize: 11,
                  marginLeft: 6,
                }}
              >
                {unreadCount}
              </span>
            </div>
            <button
              onClick={() => navigate("/messages")}
              style={{
                fontSize: 11,
                color: "#2563eb",
                background: "none",
                border: "none",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              View All →
            </button>
          </div>
          {inbox
            .filter((m) => !m.is_read)
            .slice(0, 3)
            .map((m, i) => (
              <div
                key={i}
                onClick={() => {
                  setActiveThread(m);
                  fetchThread(m.patient_id);
                  markRead(m.id);
                  navigate("/messages");
                }}
                style={{
                  background: "white",
                  borderRadius: 8,
                  padding: "8px 10px",
                  marginBottom: 6,
                  cursor: "pointer",
                  borderLeft: "3px solid #f59e0b",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#1e293b" }}>
                    {m.patient_name}
                  </span>
                  <span style={{ fontSize: 10, color: "#94a3b8" }}>
                    {new Date(m.created_at).toLocaleTimeString("en-IN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#475569",
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.message}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Recent Visits */}
      {pfd?.consultations?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#94a3b8",
              marginBottom: 6,
              letterSpacing: ".5px",
            }}
          >
            RECENT VISITS
          </div>
          {pfd.consultations.slice(0, 5).map((c, i) => {
            const moData = c.mo_data || {};
            const conData = c.con_data || {};
            const diags = moData.diagnoses || [];
            const meds = conData.medications_confirmed || moData.previous_medications || [];
            const stoppedMeds = moData.stopped_medications || [];
            const isOPD = c.visit_type === "OPD";
            return (
              <div
                key={i}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  marginBottom: 4,
                  background: "#f8fafc",
                  border: "1px solid #f1f5f9",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", minWidth: 70 }}>
                    {new Date(String(c.visit_date).slice(0, 10) + "T12:00:00").toLocaleDateString(
                      "en-IN",
                      { day: "2-digit", month: "short", year: "2-digit" },
                    )}
                  </div>
                  <div style={{ flex: 1, fontSize: 11, color: "#64748b" }}>
                    {c.con_name || c.mo_name || "—"}
                  </div>
                  {isOPD && (
                    <span
                      style={{
                        fontSize: 8,
                        fontWeight: 700,
                        background: "#eff6ff",
                        color: "#2563eb",
                        padding: "1px 5px",
                        borderRadius: 3,
                        border: "1px solid #bfdbfe",
                      }}
                    >
                      OPD
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: c.status === "completed" ? "#059669" : "#d97706",
                      background: c.status === "completed" ? "#f0fdf4" : "#fefce8",
                      padding: "2px 8px",
                      borderRadius: 4,
                    }}
                  >
                    {c.status || "completed"}
                  </span>
                </div>
                {/* Diagnoses from this visit */}
                {diags.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 5 }}>
                    {diags.map((d, di) => (
                      <span
                        key={di}
                        style={{
                          fontSize: 9,
                          padding: "1px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                          background:
                            d.status === "Uncontrolled"
                              ? "#fef2f2"
                              : d.status === "New"
                                ? "#fffbeb"
                                : "#f0fdf4",
                          color:
                            d.status === "Uncontrolled"
                              ? "#dc2626"
                              : d.status === "New"
                                ? "#d97706"
                                : "#059669",
                          border: `1px solid ${d.status === "Uncontrolled" ? "#fecaca" : d.status === "New" ? "#fde68a" : "#bbf7d0"}`,
                        }}
                      >
                        {d.label || d.id}
                      </span>
                    ))}
                  </div>
                )}
                {/* Medications from this visit */}
                {meds.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                    {meds.slice(0, 6).map((m, mi) => (
                      <span
                        key={mi}
                        style={{
                          fontSize: 9,
                          padding: "1px 5px",
                          borderRadius: 3,
                          background: "#f0f9ff",
                          color: "#1e40af",
                          border: "1px solid #dbeafe",
                        }}
                      >
                        💊 {m.name}
                        {m.dose ? ` ${m.dose}` : ""}
                      </span>
                    ))}
                    {meds.length > 6 && (
                      <span style={{ fontSize: 9, color: "#94a3b8", padding: "1px 4px" }}>
                        +{meds.length - 6} more
                      </span>
                    )}
                  </div>
                )}
                {/* Stopped medications */}
                {stoppedMeds.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 3 }}>
                    {stoppedMeds.map((m, mi) => (
                      <span
                        key={mi}
                        style={{
                          fontSize: 9,
                          padding: "1px 5px",
                          borderRadius: 3,
                          background: "#fef2f2",
                          color: "#dc2626",
                          border: "1px solid #fecaca",
                          textDecoration: "line-through",
                        }}
                      >
                        🚫 {m.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
