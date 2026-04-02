import { memo, useCallback } from "react";
import { fmtDate, fmtDateLong, getLabVal, MED_COLORS } from "./helpers";
import { TIME_SLOTS, getTimeSlot, buildMedCardPrintHTML } from "./VisitMedCard";

function buildRxHTML(patient, doctor, activeDx, activeMeds, consultations, latestVitals, doctorNote, summary) {
  const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const latestCon = consultations[0]?.con_data;
  const tests = latestCon?.investigations_to_order || latestCon?.tests_ordered || [];
  const followUp = latestCon?.follow_up;
  const lifestyle = latestCon?.diet_lifestyle || [];

  let medsHTML = "";
  if (activeMeds.length > 0) {
    medsHTML = `<table style="width:100%;border-collapse:collapse;margin-top:8px">
      <thead><tr style="background:#f8fafc">
        <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">#</th>
        <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Medicine</th>
        <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Dose</th>
        <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Frequency / Timing</th>
        <th style="text-align:left;padding:6px 10px;font-size:10px;font-weight:700;color:#6b7d90;border-bottom:1px solid #dde3ea">Duration</th>
      </tr></thead><tbody>`;
    activeMeds.forEach((m, i) => {
      const dotColor = MED_COLORS[i % MED_COLORS.length];
      medsHTML += `<tr style="border-bottom:1px solid #eef1f5">
        <td style="padding:7px 10px;font-size:12px">${i + 1}</td>
        <td style="padding:7px 10px;font-size:12px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};margin-right:6px;vertical-align:middle"></span>
          <strong>${m.name}</strong>${m.composition ? `<br><span style="font-size:10px;color:#6b7d90;margin-left:14px">${m.composition}</span>` : ""}
        </td>
        <td style="padding:7px 10px;font-size:12px">${m.dose || ""}</td>
        <td style="padding:7px 10px;font-size:12px">${m.frequency || "OD"}${m.timing ? ` \u00b7 ${m.timing}` : ""}</td>
        <td style="padding:7px 10px;font-size:12px">${m.duration || ""}</td>
      </tr>`;
    });
    medsHTML += `</tbody></table>`;
  } else {
    medsHTML = `<div style="font-size:12px;color:#6b7d90;padding:10px">No medications prescribed</div>`;
  }

  let testsHTML = "";
  if (tests.length > 0) {
    testsHTML = `<div style="margin-top:16px"><div style="font-size:12px;font-weight:700;color:#1a2332;margin-bottom:6px">Investigations Ordered</div><div style="display:flex;flex-wrap:wrap;gap:6px">`;
    tests.forEach((t) => {
      const name = typeof t === "string" ? t : t.name || t.test;
      const urgency = t.urgency === "urgent" ? " (Urgent)" : "";
      testsHTML += `<span style="font-size:11px;padding:4px 10px;background:#f0f4f7;border:1px solid #dde3ea;border-radius:4px">${name}${urgency}</span>`;
    });
    testsHTML += `</div></div>`;
  }

  let vitalsHTML = "";
  if (latestVitals) {
    const parts = [];
    if (latestVitals.bp_sys && latestVitals.bp_dia) parts.push(`BP: ${latestVitals.bp_sys}/${latestVitals.bp_dia} mmHg`);
    if (latestVitals.pulse) parts.push(`Pulse: ${latestVitals.pulse} bpm`);
    if (latestVitals.weight) parts.push(`Weight: ${latestVitals.weight} kg`);
    if (latestVitals.bmi) parts.push(`BMI: ${latestVitals.bmi}`);
    if (latestVitals.spo2) parts.push(`SpO2: ${latestVitals.spo2}%`);
    if (parts.length > 0) {
      vitalsHTML = `<div style="font-size:11px;color:#3d4f63;padding:8px 14px;background:#f8fafc;border:1px solid #eef1f5;border-radius:6px;margin-bottom:14px">${parts.join(" &middot; ")}</div>`;
    }
  }

  const dxHTML = activeDx.length > 0 ? activeDx.map((d) => `${d.label || d.diagnosis_id} (${d.status})`).join(", ") : "";

  let lifestyleHTML = "";
  if (lifestyle.length > 0) {
    lifestyleHTML = `<div style="margin-top:16px"><div style="font-size:12px;font-weight:700;color:#1a2332;margin-bottom:6px">Lifestyle Instructions</div><ul style="font-size:12px;color:#3d4f63;padding-left:20px;line-height:1.8">`;
    lifestyle.forEach((d) => {
      lifestyleHTML += `<li>${typeof d === "string" ? d : d.instruction || JSON.stringify(d)}</li>`;
    });
    lifestyleHTML += `</ul></div>`;
  }

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Prescription \u2014 ${patient.name}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, -apple-system, sans-serif; color: #1a2332; line-height: 1.5; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head><body>
<div style="max-width:700px;margin:0 auto">
  <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #009e8c;padding-bottom:12px;margin-bottom:16px">
    <div>
      <div style="font-size:22px;font-weight:700;color:#009e8c;letter-spacing:-.5px">Gini Health</div>
      <div style="font-size:10px;color:#6b7d90">Prescription</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:13px;font-weight:600">${doctor?.name || "Doctor"}</div>
      ${doctor?.qualification ? `<div style="font-size:10px;color:#6b7d90">${doctor.qualification}</div>` : ""}
      ${doctor?.reg_no ? `<div style="font-size:10px;color:#6b7d90">Reg. No: ${doctor.reg_no}</div>` : ""}
    </div>
  </div>
  <div style="display:flex;justify-content:space-between;padding:10px 14px;background:#f8fafc;border:1px solid #eef1f5;border-radius:8px;margin-bottom:14px">
    <div>
      <div style="font-size:13px;font-weight:600">${patient.name}</div>
      <div style="font-size:11px;color:#6b7d90">${patient.age ? patient.age + "Y" : ""}${patient.sex ? " \u00b7 " + patient.sex : ""}${patient.file_no ? " \u00b7 ID #" + patient.file_no : ""}${patient.blood_group ? " \u00b7 " + patient.blood_group : ""}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:#6b7d90">Date: ${today}</div>
      <div style="font-size:11px;color:#6b7d90">Visit #${summary.totalVisits}</div>
    </div>
  </div>
  ${vitalsHTML}
  ${dxHTML ? `<div style="margin-bottom:14px"><div style="font-size:12px;font-weight:700;color:#1a2332;margin-bottom:4px">Diagnosis</div><div style="font-size:12px;color:#3d4f63">${dxHTML}</div></div>` : ""}
  <div style="font-size:18px;font-weight:700;color:#009e8c;margin-bottom:6px">\u211e</div>
  ${medsHTML}
  ${testsHTML}
  ${lifestyleHTML}
  ${followUp ? `<div style="margin-top:16px;padding:10px 14px;background:#e6f6f4;border-radius:8px;border:1px solid rgba(0,158,140,.22)"><div style="font-size:11px;font-weight:700;color:#009e8c;margin-bottom:2px">Follow-up</div><div style="font-size:12px;color:#047857">${followUp.date ? new Date(followUp.date).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : followUp.notes || "Scheduled"}</div></div>` : ""}
  ${doctorNote ? `<div style="margin-top:14px"><div style="font-size:12px;font-weight:700;color:#1a2332;margin-bottom:4px">Doctor's Note</div><div style="font-size:12px;color:#3d4f63;white-space:pre-wrap">${doctorNote}</div></div>` : ""}
  <div style="margin-top:40px;text-align:right">
    <div style="border-top:1px solid #1a2332;display:inline-block;padding-top:6px;min-width:200px">
      <div style="font-size:12px;font-weight:600">${doctor?.name || "Doctor"}</div>
      ${doctor?.qualification ? `<div style="font-size:10px;color:#6b7d90">${doctor.qualification}</div>` : ""}
    </div>
  </div>
</div>
</body></html>`;
}

function openPrintWindow(html) {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 300);
}

const VisitPlan = memo(function VisitPlan({
  consultations,
  goals,
  doctorNote,
  onDoctorNoteChange,
  patient,
  doctor,
  activeDx,
  activeMeds,
  latestVitals,
  summary,
  labResults,
  onEndVisit,
  onAddReferral,
  onChangeFollowUp,
  onOpenTemplate,
  referrals,
}) {
  const latestCon = consultations[0]?.con_data;
  const tests = latestCon?.investigations_to_order || latestCon?.tests_ordered || [];
  const followUp = latestCon?.follow_up;
  const today = new Date().toISOString().split("T")[0];
  const hba1c = getLabVal(labResults, "HbA1c");
  const fbs = getLabVal(labResults, "FBS");

  const handlePrintRx = useCallback(() => {
    const html = buildRxHTML(patient, doctor, activeDx, activeMeds, consultations, latestVitals, doctorNote, summary);
    openPrintWindow(html);
  }, [patient, doctor, activeDx, activeMeds, consultations, latestVitals, doctorNote, summary]);

  const handlePrintMedCard = useCallback(() => {
    const grouped = {};
    activeMeds.forEach((m, i) => {
      const slot = getTimeSlot(m);
      if (!grouped[slot]) grouped[slot] = [];
      grouped[slot].push({ ...m, _idx: i });
    });
    const slotsWithMeds = TIME_SLOTS.filter((s) => grouped[s.key]?.length > 0);
    const html = buildMedCardPrintHTML(patient, grouped, slotsWithMeds, activeMeds);
    openPrintWindow(html);
  }, [patient, activeMeds]);

  const handleSendWhatsApp = useCallback(() => {
    const lines = [`*Visit Summary — ${fmtDate(today)}*`];
    lines.push(`Patient: ${patient.name}, ${patient.age || ""}${patient.sex?.[0] || ""}`);
    lines.push(`Doctor: ${doctor?.name || "Doctor"} · Visit #${summary.totalVisits}`);
    if (activeDx.length > 0) {
      lines.push(`\nDiagnoses: ${activeDx.map((d) => d.label || d.diagnosis_id).join(", ")}`);
    }
    if (activeMeds.length > 0) {
      lines.push(`\nMedications:`);
      activeMeds.forEach((m, i) => {
        lines.push(`${i + 1}. ${m.name}${m.dose ? " — " + m.dose : ""}${m.frequency ? " · " + m.frequency : ""}${m.timing ? " · " + m.timing : ""}`);
      });
    }
    if (tests.length > 0) {
      lines.push(`\nTests Ordered: ${tests.map((t) => typeof t === "string" ? t : t.name || t.test).join(", ")}`);
    }
    if (followUp?.date) {
      lines.push(`\nFollow-up: ${fmtDateLong(followUp.date)}`);
    }
    lines.push(`\n— Gini Health`);
    const text = encodeURIComponent(lines.join("\n"));
    const phone = (patient.phone || patient.mobile || "").replace(/\D/g, "");
    const url = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
    window.open(url, "_blank");
  }, [patient, doctor, activeDx, activeMeds, tests, followUp, summary, today]);

  const handleSendReminder = useCallback(() => {
    const lines = [`*Follow-up Reminder*`];
    lines.push(`Namaste ${patient.name} ji,`);
    if (followUp?.date) {
      lines.push(`\nYour next visit is scheduled on *${fmtDateLong(followUp.date)}*.`);
    } else {
      lines.push(`\nPlease schedule your next follow-up visit.`);
    }
    lines.push(`Please bring your updated reports and medicine list.`);
    if (followUp?.notes) {
      lines.push(`\nNote: ${followUp.notes}`);
    }
    lines.push(`\nDoctor: ${doctor?.name || "Doctor"}`);
    lines.push(`\n— Gini Health\nContact: +91 8146320100`);
    const text = encodeURIComponent(lines.join("\n"));
    const phone = (patient.phone || patient.mobile || "").replace(/\D/g, "");
    const url = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
    window.open(url, "_blank");
  }, [patient, doctor, followUp]);

  return (
    <>
      {/* PLAN */}
      <div className="sc" id="plan">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📝</div>Plan for This Visit
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn" onClick={() => onOpenTemplate("insulin_titration")}>📋 Templates</button>
            <button className="bx bx-p" onClick={onAddReferral}>+ Referral</button>
          </div>
        </div>
        <div className="scb">
          <div className="plg">
            <div className="plc">
              <div className="plct">🧪 Tests Ordered</div>
              {tests.length > 0 ? (
                tests.map((t, i) => (
                  <div key={i} className="ti">
                    <span className="ti-nm">{typeof t === "string" ? t : t.name || t.test}</span>
                    <span className={`urg ${t.urgency === "urgent" ? "u-u" : "u-n"}`}>
                      {t.urgency === "urgent" ? "Urgent" : "Next visit"}
                    </span>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 12, color: "var(--t3)" }}>No tests ordered</div>
              )}
            </div>
            <div className="plc">
              <div className="plct">🏃 Lifestyle Instructions</div>
              {latestCon?.diet_lifestyle?.length > 0 ? (
                latestCon.diet_lifestyle.map((d, i) => (
                  <div key={i} style={{ fontSize: 12, color: "var(--t2)", lineHeight: 1.9 }}>
                    {typeof d === "string" ? d : d.instruction || JSON.stringify(d)}
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 12, color: "var(--t3)" }}>
                  No lifestyle instructions recorded
                </div>
              )}
              {followUp && (
                <div style={{ marginTop: 10 }}>
                  <div className="plct">Follow-up</div>
                  <div style={{ fontSize: 12, color: "var(--t2)" }}>
                    {followUp.date ? fmtDateLong(followUp.date) : followUp.notes || "Scheduled"}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Referrals */}
          {referrals.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="subsec">Referrals</div>
              {referrals.map((ref) => (
                <div key={ref.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, marginBottom: 4, fontSize: 12 }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{ref.doctor_name}</span>
                  <span style={{ color: "var(--t3)" }}>·</span>
                  <span style={{ color: "var(--primary)" }}>{ref.speciality}</span>
                  {ref.reason && <>
                    <span style={{ color: "var(--t3)" }}>·</span>
                    <span style={{ color: "var(--t2)", flex: 1 }}>{ref.reason}</span>
                  </>}
                  <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: ref.status === "pending" ? "var(--amb-lt)" : "var(--grn-lt)", color: ref.status === "pending" ? "var(--amber)" : "var(--green)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".3px" }}>
                    {ref.status || "pending"}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="subsec">Templates &amp; Patient Instructions</div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
            <button className="btn" onClick={() => onOpenTemplate("insulin_titration")}>📌 Insulin Titration Guide</button>
            <button className="btn" onClick={() => onOpenTemplate("diet_1000kcal")}>🥗 1000 kcal Diet Plan</button>
            <button className="btn" onClick={() => onOpenTemplate("mounjaro_guide")}>💉 Mounjaro Injection Guide</button>
            <button className="btn" onClick={() => onOpenTemplate("blood_sugar_log")}>🩸 Blood Sugar Log Sheet</button>
            <button className="btn" onClick={() => onOpenTemplate("fasting_lab")}>📋 Fasting Lab Instructions</button>
          </div>
          <div className="subsec">Doctor's Note</div>
          <textarea
            className="nf"
            value={doctorNote}
            onChange={(e) => onDoctorNoteChange(e.target.value)}
            placeholder="Add your notes for this visit..."
            style={{ marginBottom: 12 }}
          />

          {goals.length > 0 && (
            <div className="nv-row" style={{ marginBottom: 12 }}>
              <div>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#065f46",
                    textTransform: "uppercase",
                    letterSpacing: ".5px",
                  }}
                >
                  Goals Set
                </div>
                <div style={{ fontSize: 12, color: "#047857" }}>
                  {goals
                    .slice(0, 3)
                    .map((g) => `${g.marker}: ${g.current_value} → ${g.target_value}`)
                    .join(" · ")}
                </div>
              </div>
            </div>
          )}

          {/* Next Visit row */}
          <div className="nv-row">
            <div>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: "#065f46",
                  textTransform: "uppercase",
                  letterSpacing: ".5px",
                }}
              >
                Next Visit Scheduled
              </div>
              <div className="nv-date">
                {followUp?.date ? fmtDateLong(followUp.date) : "Not yet scheduled"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              <button className="bx bx-g" onClick={onChangeFollowUp}>Change Date</button>
              <button className="bx bx-p" onClick={handleSendReminder}>Send Reminder via WhatsApp</button>
            </div>
          </div>
        </div>
      </div>

      {/* SUMMARY */}
      <div className="sc" id="summary">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📄</div>Visit Summary &amp; Print
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn" onClick={handlePrintRx}>🖨 Print Rx</button>
            <button className="btn" onClick={handlePrintMedCard}>💊 Print Med Card</button>
            <button className="btn" onClick={handleSendWhatsApp}>📱 Send via WhatsApp</button>
          </div>
        </div>
        <div className="scb">
          <div className="sumcard">
            <div className="sum-title">Visit Summary — {fmtDate(today)}</div>
            <div className="sum-row">
              <span className="sum-k">Patient</span>
              <span className="sum-v">
                {patient.name}, {patient.age}
                {patient.sex?.[0]} · ID: {patient.file_no || patient.id} ·{" "}
                {doctor?.name || "Doctor"}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-k">Program</span>
              <span className="sum-v">
                {summary.carePhase} · Visit #{summary.totalVisits}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-k">Diagnoses</span>
              <span className="sum-v">
                {activeDx.map((d) => `${d.label || d.diagnosis_id} (${d.status})`).join(", ") ||
                  "None"}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-k">Key Markers</span>
              <span className="sum-v">
                {[
                  hba1c && `HbA1c ${hba1c.result}%`,
                  fbs && `FPG ${fbs.result}`,
                  latestVitals?.bp_sys && `BP ${latestVitals.bp_sys}/${latestVitals.bp_dia}`,
                  latestVitals?.weight && `Weight ${latestVitals.weight}kg`,
                ]
                  .filter(Boolean)
                  .join(", ") || "—"}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-k">Medications</span>
              <span className="sum-v">{activeMeds.map((m) => m.name).join(" · ") || "None"}</span>
            </div>
            <div className="sum-acts">
              {onEndVisit && (
                <button className="btn-p" onClick={onEndVisit}>
                  ✓ Complete &amp; Save Visit
                </button>
              )}
              <button className="btn" onClick={handlePrintRx}>Print Full Prescription</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
});

export default VisitPlan;
