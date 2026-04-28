import { memo, useCallback, useState, useEffect, useMemo } from "react";
import { fmtDate, fmtDateLong, fmtDateShort, getLabVal, MED_COLORS } from "./helpers";
import ChangesPopover from "./ChangesPopover";
import { TIME_SLOTS, getTimeSlots, buildMedCardPrintHTML } from "./VisitMedCard";
import { LAB_ORDER_CHIPS } from "../../config/chips";
import VisitGoals from "./VisitGoals";

function buildRxHTML(
  patient,
  doctor,
  activeDx,
  activeMeds,
  consultations,
  latestVitals,
  doctorNote,
  summary,
) {
  const today = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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
    if (latestVitals.bp_sys && latestVitals.bp_dia)
      parts.push(`BP: ${latestVitals.bp_sys}/${latestVitals.bp_dia} mmHg`);
    if (latestVitals.pulse) parts.push(`Pulse: ${latestVitals.pulse} bpm`);
    if (latestVitals.weight) parts.push(`Weight: ${latestVitals.weight} kg`);
    if (latestVitals.bmi) parts.push(`BMI: ${latestVitals.bmi}`);
    if (latestVitals.spo2) parts.push(`SpO2: ${latestVitals.spo2}%`);
    if (parts.length > 0) {
      vitalsHTML = `<div style="font-size:11px;color:#3d4f63;padding:8px 14px;background:#f8fafc;border:1px solid #eef1f5;border-radius:6px;margin-bottom:14px">${parts.join(" &middot; ")}</div>`;
    }
  }

  const dxHTML =
    activeDx.length > 0
      ? activeDx.map((d) => `${d.label || d.diagnosis_id} (${d.status})`).join(", ")
      : "";

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
  setTimeout(() => {
    win.focus();
    win.print();
  }, 300);
}

const DX_STATUS_ICON = (status) => {
  if (!status) return { icon: "·", color: "var(--t3)" };
  const s = status.toLowerCase();
  if (s === "controlled" || s === "improving" || s === "resolved")
    return { icon: "✓", color: "var(--green)" };
  if (s === "review" || s === "uncontrolled") return { icon: "⚠", color: "var(--amber)" };
  return { icon: "·", color: "var(--t3)" };
};

const VisitPlan = memo(function VisitPlan({
  consultations,
  apptPlan,
  goals,
  doctorNote,
  onDoctorNoteChange,
  patient,
  doctor,
  activeDx,
  activeMeds,
  stoppedMeds,
  latestVitals,
  summary,
  labResults,
  onEndVisit,
  onAddReferral,
  onChangeFollowUp,
  onOpenTemplate,
  onMedCardTab,
  referrals,
  symptoms,
  conData,
  setConData,
  onPrintRx,
  printingRx,
}) {
  const latestCon = consultations[0]?.con_data;
  const tests = latestCon?.investigations_to_order?.length
    ? latestCon.investigations_to_order
    : latestCon?.tests_ordered?.length
      ? latestCon.tests_ordered
      : apptPlan?.investigations_to_order || [];
  const followUp = latestCon?.follow_up || apptPlan?.follow_up;
  const today = new Date().toISOString().split("T")[0];
  const hba1c = getLabVal(labResults, "HbA1c");
  const fbs = getLabVal(labResults, "FBS");

  // Ensure conData has follow_up structure — initialise via effect, never during render
  useEffect(() => {
    if (!setConData) return;
    if (!conData) {
      setConData({ follow_up: { tests_to_bring: [] } });
    } else if (!conData.follow_up) {
      setConData({ ...conData, follow_up: { tests_to_bring: [] } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount — conData is intentionally omitted to avoid loop

  const activeConData = useMemo(() => {
    if (!conData) return { follow_up: { tests_to_bring: [] } };
    if (!conData.follow_up) return { ...conData, follow_up: { tests_to_bring: [] } };
    return conData;
  }, [conData]);
  // Backend PDF flow lives in VisitPage; keep a local fallback that no-ops
  // if the parent didn't wire onPrintRx.
  const handlePrintRx = useCallback(() => {
    if (onPrintRx) onPrintRx();
  }, [onPrintRx]);

  const handlePrintMedCard = useCallback(() => {
    const grouped = {};
    activeMeds.forEach((m, i) => {
      getTimeSlots(m).forEach((slot) => {
        if (!grouped[slot]) grouped[slot] = [];
        grouped[slot].push({ ...m, _idx: i });
      });
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
        lines.push(
          `${i + 1}. ${m.name}${m.dose ? " — " + m.dose : ""}${m.frequency ? " · " + m.frequency : ""}${m.timing ? " · " + m.timing : ""}`,
        );
      });
    }
    if (tests.length > 0) {
      lines.push(
        `\nTests Ordered: ${tests.map((t) => (typeof t === "string" ? t : t.name || t.test)).join(", ")}`,
      );
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

  // Changes: stopped meds this session
  const stoppedThisVisit = (stoppedMeds || []).filter(
    (m) => m.stopped_date && m.stopped_date.startsWith(new Date().toISOString().slice(0, 7)),
  );

  // Plan update summary — compare latest consultation's plan vs the previous one
  const planSummary = useMemo(() => {
    const latest = consultations?.[0];
    if (!latest) return null;
    const latestCon = latest.con_data || {};
    const prevCon = consultations?.[1]?.con_data || {};
    const latestTests = (latestCon.investigations_to_order || latestCon.tests_ordered || []).map(
      (t) => (typeof t === "string" ? t : t.name || t.test),
    );
    const prevTests = (prevCon.investigations_to_order || prevCon.tests_ordered || []).map((t) =>
      typeof t === "string" ? t : t.name || t.test,
    );
    const addedTests = latestTests.filter((t) => t && !prevTests.includes(t));
    const removedTests = prevTests.filter((t) => t && !latestTests.includes(t));

    const prevFU = prevCon.follow_up?.date || null;
    const latestFU = latestCon.follow_up?.date || null;
    const fuChanged = prevFU !== latestFU;

    const parts = [];
    if (addedTests.length === 1) parts.push(`${addedTests[0]} ordered`);
    else if (addedTests.length > 1) parts.push(`${addedTests.length} tests ordered`);
    if (removedTests.length > 0) parts.push(`${removedTests.length} removed`);
    if (fuChanged && latestFU) {
      parts.push(
        prevFU
          ? `follow-up ${fmtDateShort(prevFU)} → ${fmtDateShort(latestFU)}`
          : `follow-up ${fmtDateShort(latestFU)}`,
      );
    }

    const text = parts.length ? parts.join(", ") : "Plan updated";
    const date = latest.updated_at || latest.visit_date || latest.created_at;
    if (!date) return null;

    const addedDetails = addedTests.map((t) => ({ name: t, diff: ["ordered"] }));
    const changedDetails = [];
    removedTests.forEach((t) => changedDetails.push({ name: t, diff: ["ordered → —"] }));
    if (fuChanged) {
      changedDetails.push({
        name: "Follow-up",
        diff: [`${prevFU ? fmtDate(prevFU) : "—"} → ${latestFU ? fmtDate(latestFU) : "—"}`],
      });
    }
    return { text, date, added: addedDetails, changed: changedDetails };
  }, [consultations]);

  const getInitials = (name) => {
    if (!name) return "EN";
    const parts = name.replace(/^Dr\.\s*/i, "").split(" ");
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
  };

  return (
    <>
      {/* PLAN */}
      <div className="sc" id="plan">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📝</div>Plan for This Visit
            {planSummary && (
              <ChangesPopover
                date={planSummary.date}
                label={`${planSummary.text} — ${fmtDateShort(planSummary.date)}`}
                added={planSummary.added}
                changed={planSummary.changed}
              />
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn" onClick={() => onOpenTemplate(null)}>
              📋 Templates
            </button>
            <button className="bx bx-p" onClick={onAddReferral}>
              + Referral
            </button>
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
              <div className="plct">🗓 Tests for Next Appointment</div>
              {activeConData && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Test Chips */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {LAB_ORDER_CHIPS.map((test) => {
                      const isSelected = (activeConData?.follow_up?.tests_to_bring || []).includes(
                        test,
                      );
                      return (
                        <button
                          key={test}
                          onClick={() => {
                            const current = activeConData?.follow_up?.tests_to_bring || [];
                            const updated = isSelected
                              ? current.filter((t) => t !== test)
                              : [...current, test];
                            setConData((prev) => ({
                              ...prev,
                              follow_up: {
                                ...prev.follow_up,
                                tests_to_bring: updated,
                              },
                            }));
                          }}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 16,
                            border: isSelected ? "2px solid #3b82f6" : "1px solid #d1d5db",
                            background: isSelected ? "#dbeafe" : "white",
                            color: isSelected ? "#1e40af" : "#374151",
                            fontWeight: isSelected ? 600 : 500,
                            fontSize: 11,
                            cursor: "pointer",
                            transition: "all 0.15s",
                          }}
                        >
                          {test}
                        </button>
                      );
                    })}
                  </div>

                  {/* Selected Tests Summary */}
                  {(activeConData?.follow_up?.tests_to_bring || []).length > 0 && (
                    <div
                      style={{
                        padding: 8,
                        background: "#f0f9ff",
                        borderRadius: 4,
                        border: "1px solid #bfdbfe",
                        fontSize: 11,
                      }}
                    >
                      <div style={{ fontWeight: 600, color: "#1e40af", marginBottom: 4 }}>
                        Selected ({(activeConData?.follow_up?.tests_to_bring || []).length}):
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                        {(activeConData?.follow_up?.tests_to_bring || []).map((t) => (
                          <span
                            key={t}
                            style={{
                              fontSize: 10,
                              background: "#3b82f6",
                              color: "white",
                              padding: "2px 6px",
                              borderRadius: 2,
                            }}
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Date Input */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                    <label style={{ fontWeight: 600, color: "#475569", flexShrink: 0 }}>
                      Due date:
                    </label>
                    <input
                      type="date"
                      value={activeConData?.follow_up?.tests_due_date || ""}
                      onChange={(e) => {
                        setConData((prev) => ({
                          ...prev,
                          follow_up: {
                            ...prev.follow_up,
                            tests_due_date: e.target.value,
                          },
                        }));
                      }}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 4,
                        border: "1px solid #d1d5db",
                        fontSize: 11,
                      }}
                    />
                    {activeConData?.follow_up?.tests_due_date && (
                      <span style={{ fontSize: 10, color: "#059669", fontWeight: 600 }}>
                        {new Date(activeConData.follow_up.tests_due_date).toLocaleDateString(
                          "en-IN",
                          {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          },
                        )}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="plc">
              {/* Referrals */}
              {referrals.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div className="subsec" style={{ fontWeight: 600, marginBottom: 8 }}>
                    Referrals
                  </div>
                  {referrals.map((ref) => (
                    <div
                      key={ref.id}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 12,
                        padding: "12px",
                        background: "var(--bg, #ffffff)",
                        border: "1px solid var(--border, #e5e7eb)",
                        borderRadius: 8,
                        marginBottom: 8,
                      }}
                    >
                      <div
                        style={{
                          minWidth: 40,
                          height: 40,
                          borderRadius: 8,
                          backgroundColor: "var(--primary, #5c59f5)",
                          color: "#ffffff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: 600,
                          fontSize: 16,
                        }}
                      >
                        {getInitials(ref.doctor_name)}
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text, #111)" }}>
                          {ref.doctor_name}
                        </div>
                        <div style={{ fontSize: 13, color: "var(--t3, #6b7280)" }}>
                          {ref.speciality}
                        </div>
                        {ref.reason && (
                          <div style={{ fontSize: 13, color: "var(--primary, #5c59f5)" }}>
                            {ref.reason}
                          </div>
                        )}

                        {/* Status Badge (Commented Out)
                        <span
                          style={{
                            fontSize: 10,
                            padding: "2px 8px",
                            borderRadius: 10,
                            background: ref.status === "pending" ? "var(--amb-lt)" : "var(--grn-lt)",
                            color: ref.status === "pending" ? "var(--amber)" : "var(--green)",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: ".3px",
                            marginTop: 4,
                            alignSelf: "flex-start"
                          }}
                        >
                          {ref.status || "pending"}
                        </span>
                      */}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div
                className="addr"
                onClick={onAddReferral}
                style={{
                  marginTop: 8,
                  marginBottom: 16,
                  padding: "10px",
                  border: "1px dashed var(--border, #cbd5e1)",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                }}
              >
                <span style={{ fontSize: 18, color: "var(--t3, #6b7280)", lineHeight: 1 }}>+</span>
                <span
                  className="addr-lbl"
                  style={{ fontSize: 13, color: "var(--primary, #5c59f5)", fontWeight: 500 }}
                >
                  Add referral
                </span>
              </div>

              <div className="m-5" style={{ height: 16 }}></div>

              <div className="plct" style={{ fontWeight: 600, marginBottom: 12 }}>
                🏃 Lifestyle Instructions
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {latestCon?.diet_lifestyle?.length > 0 || apptPlan?.diet_lifestyle?.length > 0 ? (
                  (latestCon?.diet_lifestyle?.length > 0
                    ? latestCon.diet_lifestyle
                    : apptPlan.diet_lifestyle
                  ).map((d, i) => {
                    const text = typeof d === "string" ? d : d.instruction || JSON.stringify(d);

                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                          fontSize: 13,
                          color: "var(--t2, #374151)",
                          lineHeight: 1.6,
                        }}
                      >
                        <span>
                          {d.icon ||
                            (text.toLowerCase().includes("diet")
                              ? "🍽️"
                              : text.toLowerCase().includes("step")
                                ? "👣"
                                : "💉")}
                        </span>

                        <div dangerouslySetInnerHTML={{ __html: text }} />
                      </div>
                    );
                  })
                ) : (
                  <div style={{ fontSize: 13, color: "var(--t3, #6b7280)" }}>
                    No lifestyle instructions recorded
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* {followUp && (
                <div style={{ marginTop: 10 }}>
                  <div className="plct">Follow-up</div>
                  <div style={{ fontSize: 12, color: "var(--t2)" }}>
                    {followUp.date ? fmtDateLong(followUp.date) : followUp.notes || "Scheduled"}
                  </div>
                </div>
              )} */}

          <div className="subsec">Templates &amp; Patient Instructions</div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
            <button className="btn" onClick={() => onOpenTemplate("insulin_titration")}>
              📌 Insulin Titration Guide
            </button>
            <button className="btn" onClick={() => onOpenTemplate("diet_1000kcal")}>
              🥗 1000 kcal Diet Plan
            </button>
            <button className="btn" onClick={() => onOpenTemplate("mounjaro_guide")}>
              💉 Mounjaro Injection Guide
            </button>
            <button className="btn" onClick={() => onOpenTemplate("blood_sugar_log")}>
              🩸 Blood Sugar Log Sheet
            </button>
            <button className="btn" onClick={() => onOpenTemplate("fasting_lab")}>
              📋 Fasting Lab Instructions
            </button>
          </div>
          <div className="subsec">Doctor's Note</div>
          <textarea
            className="nf"
            value={doctorNote}
            onChange={(e) => onDoctorNoteChange(e.target.value)}
            placeholder="Add your notes for this visit..."
            style={{ marginBottom: 12 }}
          />

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
              <button className="bx bx-g" onClick={onChangeFollowUp}>
                Change Date
              </button>
              <button className="bx bx-p" onClick={handleSendReminder}>
                Send Reminder via WhatsApp
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* CHANGES MADE THIS VISIT */}
      {(() => {
        const newMeds = activeMeds.filter(
          (m) => m.prescribed_date && m.prescribed_date.startsWith(today),
        );
        const stoppedToday = (stoppedMeds || []).filter(
          (m) => m.stopped_date && m.stopped_date.startsWith(today),
        );
        const continuedMeds = activeMeds.filter(
          (m) => !m.prescribed_date || !m.prescribed_date.startsWith(today),
        );

        return (
          <div className="sc" id="changes" style={{ border: "2px solid var(--pri-lt)" }}>
            <div className="sch" style={{ background: "var(--pri-lt)" }}>
              <div className="sct" style={{ color: "var(--primary)" }}>
                <div className="sci" style={{ background: "var(--primary)", color: "white" }}>
                  ✏️
                </div>
                Changes Made This Visit
              </div>
              <span style={{ fontSize: 11, color: "var(--primary)", fontWeight: 600 }}>
                Auto-updates as you make changes above
              </span>
            </div>
            <div className="scb">
              <div className="chg-grid">
                {/* SYMPTOMS & CONCERNS */}
                <div>
                  <div className="chg-sec-lbl">Symptoms &amp; Concerns</div>
                  {(symptoms || []).length > 0 ? (
                    symptoms.map((sy) => {
                      const s = (sy.status || "").toLowerCase();
                      const icon =
                        s.includes("resolved") || s === "controlled"
                          ? "✓"
                          : s === "improving"
                            ? "○"
                            : s === "got worse"
                              ? "↑"
                              : s === "still present"
                                ? "·"
                                : "·";
                      const color =
                        s.includes("resolved") || s === "controlled"
                          ? "var(--green)"
                          : s === "improving"
                            ? "var(--primary)"
                            : s === "got worse"
                              ? "var(--red)"
                              : "var(--amber)";
                      return (
                        <div key={sy.id} className="chg-line">
                          <span style={{ color, marginRight: 5 }}>{icon}</span>
                          {sy.label}
                          {sy.status ? (
                            <span style={{ color: "var(--t3)" }}> — {sy.status}</span>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <div className="chg-line" style={{ color: "var(--t3)" }}>
                      No symptoms recorded
                    </div>
                  )}
                </div>

                {/* DIAGNOSIS UPDATES */}
                <div>
                  <div className="chg-sec-lbl">Diagnosis Updates</div>
                  {activeDx.length > 0 ? (
                    activeDx.map((dx) => {
                      const { icon, color } = DX_STATUS_ICON(dx.status);
                      return (
                        <div key={dx.id} className="chg-line">
                          <span style={{ color, marginRight: 5 }}>{icon}</span>
                          {dx.label || dx.diagnosis_id}
                          {dx.status ? (
                            <span style={{ color: "var(--t3)" }}> — {dx.status}</span>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <div className="chg-line" style={{ color: "var(--t3)" }}>
                      No diagnoses recorded
                    </div>
                  )}
                </div>

                {/* MEDICATION CHANGES */}
                <div>
                  <div className="chg-sec-lbl">Medication Changes</div>
                  {continuedMeds.length > 0 && newMeds.length === 0 && stoppedToday.length === 0 ? (
                    <div className="chg-line">
                      <span style={{ color: "var(--green)", marginRight: 5 }}>✓</span>
                      All {continuedMeds.length} med{continuedMeds.length !== 1 ? "s" : ""}{" "}
                      continued
                    </div>
                  ) : (
                    <>
                      {continuedMeds.length > 0 && (
                        <div className="chg-line">
                          <span style={{ color: "var(--green)", marginRight: 5 }}>✓</span>
                          {continuedMeds.length} med{continuedMeds.length !== 1 ? "s" : ""}{" "}
                          continued
                        </div>
                      )}
                    </>
                  )}
                  {newMeds.map((m) => (
                    <div key={m.id} className="chg-line">
                      <span style={{ color: "var(--primary)", marginRight: 5 }}>+</span>
                      {m.name}
                      {m.dose ? ` ${m.dose}` : ""} — added
                    </div>
                  ))}
                  {stoppedToday.map((m) => (
                    <div key={m.id} className="chg-line">
                      <span style={{ color: "var(--red)", marginRight: 5 }}>✗</span>
                      {m.name} — stopped
                    </div>
                  ))}
                  {activeMeds.length === 0 && stoppedToday.length === 0 && (
                    <div className="chg-line" style={{ color: "var(--t3)" }}>
                      No medications recorded
                    </div>
                  )}
                </div>

                {/* TESTS & PLAN */}
                <div>
                  <div className="chg-sec-lbl">Tests &amp; Plan</div>
                  {tests.length > 0 ? (
                    tests.map((t, i) => {
                      const name = typeof t === "string" ? t : t.name || t.test;
                      const urgent = t.urgency === "urgent";
                      return (
                        <div key={i} className="chg-line">
                          <span style={{ color: "var(--primary)", marginRight: 5 }}>+</span>
                          {name}
                          {urgent ? (
                            <span style={{ color: "var(--amber)", marginLeft: 4 }}>(urgent)</span>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <div className="chg-line" style={{ color: "var(--t3)" }}>
                      No tests ordered
                    </div>
                  )}
                  {referrals?.length > 0 && (
                    <div className="chg-line">
                      <span style={{ color: "var(--teal)", marginRight: 5 }}>↗</span>
                      {referrals.length} referral{referrals.length !== 1 ? "s" : ""} added
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* GOALS for next visit */}
      <VisitGoals patientId={patient?.id} goals={goals || []} />

      {/* SUMMARY */}
      <div className="sc" id="summary">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📄</div>Visit Summary &amp; Print
            <span
              style={{
                fontSize: 11,
                color: "var(--t3)",
                fontWeight: 400,
                marginLeft: 8,
                cursor: "default",
              }}
            >
              Generated — {fmtDateShort(today)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="btn"
              onClick={handlePrintRx}
              disabled={printingRx}
              style={printingRx ? { opacity: 0.6, cursor: "wait" } : undefined}
            >
              {printingRx ? "⏳ Generating…" : "🖨 Print Rx"}
            </button>
            <button className="btn" onClick={onMedCardTab}>
              💊 Print Med Card
            </button>
            <button className="btn" onClick={handleSendWhatsApp}>
              📱 Send via WhatsApp
            </button>
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
              <button
                className="btn"
                onClick={handlePrintRx}
                disabled={printingRx}
                style={printingRx ? { opacity: 0.6, cursor: "wait" } : undefined}
              >
                {printingRx ? "⏳ Generating…" : "Print Full Prescription"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
});

export default VisitPlan;
