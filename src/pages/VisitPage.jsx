import "./VisitPage.css";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import usePatientStore from "../stores/patientStore";
import useAuthStore from "../stores/authStore";
import useVisitStore from "../stores/visitStore";
import { toast } from "../stores/uiStore";
import { findLab, getLabVal, getLabHist, computeFlags, fmtDate } from "../components/visit/helpers";
import { extractLab } from "../services/extraction";
import { normalizeTestName } from "../config/labNormalization";
import { EXAM_SECTIONS } from "../config/exam.js";
import VisitTopbar from "../components/visit/VisitTopbar";
import VisitStrip from "../components/visit/VisitStrip";
import VisitSidebar from "../components/visit/VisitSidebar";
import VisitBiomarkers from "../components/visit/VisitBiomarkers";
import VisitDiagnoses from "../components/visit/VisitDiagnoses";
import VisitMedications from "../components/visit/VisitMedications";
import VisitPlan from "../components/visit/VisitPlan";
import VisitRxPrint from "../components/visit/VisitRxPrint";
import VisitLabsPanel from "../components/visit/VisitLabsPanel";
import VisitHistoryPanel from "../components/visit/VisitHistoryPanel";
import VisitDocsPanel from "../components/visit/VisitDocsPanel";
import VisitMedCard from "../components/visit/VisitMedCard";
import VisitLoggedData from "../components/visit/VisitLoggedData";
import VisitAIPanel from "../components/visit/VisitAIPanel";
import VisitEndModal from "../components/visit/VisitEndModal";
import {
  AddLabModal,
  AddDiagnosisModal,
  DiagnosisNoteModal,
  AddMedicationModal,
  EditMedicationModal,
  StopMedicationModal,
  AddReferralModal,
  UploadReportModal,
  ChangeFollowUpModal,
  TemplateModal,
} from "../components/visit/modals";
import { useVisitMutations } from "../hooks/useVisitMutations";

// ── Tab definitions ──
const SY_STATUS_OPTS = [
  "Mild",
  "Improving",
  "Still present",
  "Resolved ✓",
  "Controlled",
  "Got worse",
];
const syDotColor = (s) => {
  if (!s) return "var(--t3)";
  const v = s.toLowerCase();
  if (v.includes("resolved") || v === "controlled") return "var(--green)";
  return "var(--amber)";
};

function VisitSymptomsSection({ consultations }) {
  const con = consultations[0]?.con_data;
  const mo = consultations[0]?.mo_data;
  const symptoms =
    con?.symptoms || con?.chief_complaints || mo?.symptoms || mo?.chief_complaints || [];
  return (
    <div className="sc" id="symptoms">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-a">🩹</div>Symptoms &amp; Concerns
        </div>
      </div>
      <div className="scb">
        {symptoms.length > 0 ? (
          <>
            <div className="subsec">Active / Historical — Update Status</div>
            <div className="syg">
              {symptoms.map((sy, i) => {
                const name =
                  typeof sy === "string" ? sy : sy.name || sy.symptom || sy.complaint || String(sy);
                const meta =
                  typeof sy === "object"
                    ? sy.notes || sy.meta || sy.duration || sy.since || ""
                    : "";
                const status = typeof sy === "object" ? sy.status || "Mild" : "Mild";
                return (
                  <div key={i} className="syi">
                    <div className="sy-dot" style={{ background: syDotColor(status) }} />
                    <div style={{ flex: 1 }}>
                      <div className="sy-nm">{name}</div>
                      {meta && <div className="sy-meta">{meta}</div>}
                    </div>
                    <select
                      className="sy-sel"
                      defaultValue={status}
                      style={{
                        color: syDotColor(status) === "var(--green)" ? "var(--green)" : undefined,
                      }}
                    >
                      {SY_STATUS_OPTS.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: "var(--t3)", padding: 16, textAlign: "center" }}>
            No symptoms or concerns recorded for this visit
          </div>
        )}
        <div className="addr">
          <span style={{ fontSize: 16, color: "var(--t3)" }}>+</span>
          <span className="addr-lbl">Add new symptom or concern for this visit</span>
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { id: "visit", label: "📋 Visit" },
  { id: "labs", label: "🧪 Labs", badgeKey: "labs" },
  { id: "exam", label: "🩺 Exam" },
  { id: "history", label: "📅 History" },
  { id: "messages", label: "💬 Messages", badgeKey: "messages", badgeCls: "am" },
  { id: "docs", label: "📁 Docs", badgeKey: "docs" },
  { id: "medcard", label: "💊 Med Card" },
  { id: "logdata", label: "📊 Logged Data" },
];

const JUMP_SECTIONS = [
  { id: "biomarkers", label: "📊 Biomarkers" },
  { id: "symptoms", label: "🩹 Symptoms" },
  { id: "diagnoses", label: "🏷 Diagnoses" },
  { id: "medications", label: "💊 Medications" },
  { id: "plan", label: "📝 Plan" },
  { id: "summary", label: "📄 Summary" },
];

// Transform raw exam_data from DB into display-ready array
function buildExamFindings(rawExam) {
  if (!rawExam?.findings || typeof rawExam.findings !== "object") return null;
  const result = [];
  Object.values(EXAM_SECTIONS).forEach((sections) => {
    sections.forEach((s) => {
      const vals = rawExam.findings[s.id + "_v"] || [];
      const nad = rawExam.findings[s.id + "_n"];
      if (vals.length > 0) result.push({ icon: s.ic, system: s.l, findings: vals.join(", ") });
      else if (nad) result.push({ icon: s.ic, system: s.l, findings: "NAD" });
    });
  });
  return result.length ? result : null;
}

export default function VisitPage() {
  const navigate = useNavigate();
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const doctor = useAuthStore((s) => s.currentDoctor);
  const endVisitAction = useVisitStore((s) => s.endVisit);

  // ── OPD appointment sync ──
  const [opdApptId] = useState(() => {
    const id = sessionStorage.getItem("gini_opd_appt_id");
    return id ? Number(id) : null;
  });
  const [visitStart, setVisitStart] = useState(
    () => sessionStorage.getItem("gini_visit_start") || null,
  );
  const hasActiveVisit = !!opdApptId;

  // ── UI state ──
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("visit");
  const [jumpTarget, setJumpTarget] = useState("biomarkers");
  const [aiOpen, setAiOpen] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [doctorNote, setDoctorNote] = useState("");
  const [modal, setModal] = useState(null); // { type, data? }
  const scrollRef = useRef(null);

  // ── Redirect if no patient ──
  useEffect(() => {
    const savedId = sessionStorage.getItem("gini_active_patient");
    if (!dbPatientId && !savedId) {
      navigate("/");
      return;
    }
    if (!dbPatientId) return; // restore in progress — wait
    (async () => {
      setLoading(true);
      try {
        const { data: d } = await api.get(`/api/visit/${dbPatientId}`);
        setData({ ...d, examFindings: buildExamFindings(d.consultations?.[0]?.exam_data) });
        if (d.consultations?.[0]?.con_data?.assessment_summary) {
          setDoctorNote(d.consultations[0].con_data.assessment_summary);
        }
      } catch {
        toast("Failed to load visit data", "error");
      }
      setLoading(false);
    })();
  }, [dbPatientId, navigate]);

  // ── Refresh data after mutations ──
  const refreshData = useCallback(async () => {
    try {
      const { data: d } = await api.get(`/api/visit/${dbPatientId}`);
      setData({ ...d, examFindings: buildExamFindings(d.consultations?.[0]?.exam_data) });
    } catch {
      /* silent */
    }
  }, [dbPatientId]);

  const mutations = useVisitMutations(dbPatientId, refreshData, opdApptId);
  const closeModal = useCallback(() => setModal(null), []);

  // ── Derived data (memoized) ──
  const derived = useMemo(() => {
    if (!data) return null;
    const { vitals, diagnoses, labResults, labHistory } = data;
    const latestV = vitals?.[0] || null;
    const prevV = vitals?.[1] || null;
    const activeDx = diagnoses.filter((d) => d.is_active !== false);
    const flags = computeFlags(data);

    // Deduplicate meds by name (same med can appear from multiple visits)
    const dedupMeds = (meds) => {
      const grouped = {};
      (meds || []).forEach((m) => {
        const key = (m.pharmacy_match || m.name || "").toUpperCase();
        if (!key) return;
        if (!grouped[key]) {
          grouped[key] = { ...m };
        } else if (
          m.prescribed_date &&
          (!grouped[key].prescribed_date || m.prescribed_date > grouped[key].prescribed_date)
        ) {
          const id = grouped[key].id;
          Object.assign(grouped[key], m, { id });
        }
      });
      return Object.values(grouped);
    };
    const uniqueActiveMeds = dedupMeds(data.activeMeds);
    const uniqueStoppedMeds = dedupMeds(data.stoppedMeds);

    // HbA1c trend for the summary strip
    const hba1cH = getLabHist(labHistory, "HbA1c");
    const hba1cFirst = hba1cH.length > 0 ? hba1cH[0] : null;
    const hba1cCurr = getLabVal(labResults, "HbA1c");

    // AI context string
    const aiContext = `Patient: ${data.patient?.name}. Context: ${JSON.stringify({
      diagnoses: activeDx.map((d) => d.label),
      meds: data.activeMeds?.map((m) => m.name),
      vitals: latestV,
    })}`;

    // AI initial summary
    const aiParts = [`Visit #${data.summary.totalVisits} — ${data.patient.name} Summary`];
    const hba1cLab = findLab(labResults, "HbA1c");
    if (hba1cLab)
      aiParts.push(`\nHbA1c: ${hba1cLab.result}${hba1cLab.unit ? ` ${hba1cLab.unit}` : "%"}`);
    const fbsLab = findLab(labResults, "FBS");
    if (fbsLab) aiParts.push(`FPG: ${fbsLab.result} ${fbsLab.unit || "mg/dL"}`);
    flags.forEach((f) => aiParts.push(`\n${f.icon} ${f.text}`));
    const aiInitialMsg = aiParts.join("\n");

    // Anthropometry: merge clinic vitals + Genie app vitals
    const genieVitals = data.loggedData?.vitals || [];
    const genieByDate = {};
    genieVitals.forEach((g) => {
      const d = String(g.recorded_date).slice(0, 10);
      if (!genieByDate[d]) genieByDate[d] = g;
    });
    const anthropoRows = [
      ...vitals.map((v) => {
        const d = String(v.recorded_at).slice(0, 10);
        const g = genieByDate[d] || {};
        return {
          date: v.recorded_at,
          weight: v.weight || g.weight_kg || null,
          bmi: v.bmi || g.bmi || null,
          waist: g.waist || null,
          body_fat: g.body_fat || null,
          bp_sys: v.bp_sys || g.bp_systolic || null,
          bp_dia: v.bp_dia || g.bp_diastolic || null,
        };
      }),
    ];
    const clinicDates = new Set(vitals.map((v) => String(v.recorded_at).slice(0, 10)));
    genieVitals.forEach((g) => {
      const d = String(g.recorded_date).slice(0, 10);
      if (!clinicDates.has(d) && (g.waist || g.body_fat || g.weight_kg)) {
        anthropoRows.push({
          date: g.recorded_date,
          weight: g.weight_kg || null,
          bmi: g.bmi || null,
          waist: g.waist || null,
          body_fat: g.body_fat || null,
          bp_sys: g.bp_systolic || null,
          bp_dia: g.bp_diastolic || null,
        });
      }
    });
    anthropoRows.sort((a, b) => new Date(b.date) - new Date(a.date));
    const topRows = anthropoRows.slice(0, 6);

    const withWaist = anthropoRows
      .filter((r) => r.waist)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const withFat = anthropoRows
      .filter((r) => r.body_fat)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const trendParts = [];
    if (withWaist.length >= 2) {
      const diff = (withWaist[0].waist - withWaist[withWaist.length - 1].waist).toFixed(1);
      if (Math.abs(diff) >= 1)
        trendParts.push(`${Math.abs(diff)} cm ${diff > 0 ? "reduction" : "increase"} in waist`);
    }
    if (withFat.length >= 2) {
      const diff = (withFat[0].body_fat - withFat[withFat.length - 1].body_fat).toFixed(1);
      if (Math.abs(diff) >= 0.5)
        trendParts.push(`${Math.abs(diff)}% body fat ${diff > 0 ? "reduction" : "increase"}`);
    }
    const anthropoTrend = trendParts.length ? trendParts.join(" and ") : null;

    return {
      latestV,
      prevV,
      activeDx,
      flags,
      hba1cCurr,
      hba1cFirst,
      aiContext,
      aiInitialMsg,
      uniqueActiveMeds,
      uniqueStoppedMeds,
      anthropoRows: topRows,
      anthropoTrend,
    };
  }, [data]);

  // ── Callbacks (stable references) ──
  const handleJump = useCallback((id) => {
    setJumpTarget(id);
    const el = document.getElementById(id);
    const scrl = scrollRef.current;
    if (el && scrl) {
      const scrollTop =
        el.getBoundingClientRect().top - scrl.getBoundingClientRect().top + scrl.scrollTop - 16;
      scrl.scrollTo({ top: scrollTop, behavior: "smooth" });
    }
  }, []);

  const toggleAI = useCallback(() => setAiOpen((o) => !o), []);
  const openEndModal = useCallback(() => setShowEndModal(true), []);
  const closeEndModal = useCallback(() => setShowEndModal(false), []);
  const handlePrint = useCallback(() => window.print(), []);

  // ── Scroll spy: update jumpTarget based on scroll position ──
  useEffect(() => {
    const scrl = scrollRef.current;
    if (!scrl) return;
    const onScroll = () => {
      const containerTop = scrl.getBoundingClientRect().top;
      let current = JUMP_SECTIONS[0].id;
      for (const sec of JUMP_SECTIONS) {
        const el = document.getElementById(sec.id);
        if (el) {
          const elTop = el.getBoundingClientRect().top - containerTop;
          if (elTop <= 60) current = sec.id;
        }
      }
      setJumpTarget(current);
    };
    scrl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrl.removeEventListener("scroll", onScroll);
  }, [data]);

  const handleEndVisit = useCallback(async () => {
    // Mark appointment as "seen" in OPD (creates consultation record)
    const apptId = sessionStorage.getItem("gini_opd_appt_id");
    if (apptId) {
      try {
        await api.patch(`/api/appointments/${apptId}`, { status: "seen" });
      } catch {
        // non-critical — OPD will still show correct state on refresh
      }
      sessionStorage.removeItem("gini_opd_appt_id");
      sessionStorage.removeItem("gini_visit_start");
    }
    endVisitAction(true);
    toast("Visit completed", "success");
    navigate("/opd");
  }, [endVisitAction, navigate]);

  // ── Tab badge counts (memoized) ──
  const tabBadges = useMemo(() => {
    if (!data) return {};
    return {
      labs: data.documents.filter((d) => d.doc_type === "lab_report").length || null,
      docs: data.documents.length || null,
      messages: null, // populated when messaging is wired up
    };
  }, [data]);

  // ── Loading / empty states ──
  if (loading) {
    return (
      <div className="visit-page">
        <div className="vp-loading">
          <div className="vp-spin" /> Loading visit data...
        </div>
      </div>
    );
  }

  if (!data || !derived) {
    return (
      <div className="visit-page">
        <div className="vp-loading">
          No visit data found.{" "}
          <button className="btn" onClick={() => navigate("/")}>
            Go Home
          </button>
        </div>
      </div>
    );
  }

  const {
    patient,
    activeMeds,
    stoppedMeds,
    labResults,
    labHistory,
    consultations,
    documents,
    referrals,
    goals,
    loggedData,
    summary,
    vitals,
  } = data;
  const {
    latestV,
    prevV,
    activeDx,
    flags,
    hba1cCurr,
    hba1cFirst,
    aiContext,
    aiInitialMsg,
    uniqueActiveMeds,
    uniqueStoppedMeds,
    anthropoRows,
    anthropoTrend,
  } = derived;

  return (
    <div className="visit-page">
      <VisitTopbar
        patient={patient}
        doctor={doctor}
        summary={summary}
        latestVitals={latestV}
        onToggleAI={toggleAI}
        onEndVisit={hasActiveVisit ? openEndModal : null}
        onPrint={handlePrint}
        visitStart={visitStart}
      />

      <VisitStrip
        summary={summary}
        hba1cCurr={hba1cCurr}
        hba1cFirst={hba1cFirst}
        latestVitals={latestV}
        prevVitals={prevV}
        activeMeds={uniqueActiveMeds}
      />

      <div className="bodywrap">
        <VisitSidebar
          summary={summary}
          latestVitals={latestV}
          activeDx={activeDx}
          activeMeds={uniqueActiveMeds}
          flags={flags}
        />

        <div className="main">
          {/* ── Tabs ── */}
          <div className="stabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`stab ${tab === t.id ? "on" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.badgeKey && tabBadges[t.badgeKey] > 0 && (
                  <span className={`tbadge${t.badgeCls ? ` ${t.badgeCls}` : ""}`}>
                    {tabBadges[t.badgeKey]}
                  </span>
                )}
              </button>
            ))}
            <div className="stabs-r">
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--green)",
                  background: "var(--grn-lt)",
                  padding: "3px 10px",
                  borderRadius: 20,
                  border: "1px solid var(--grn-bd)",
                }}
              >
                ↓ Improving — {summary.carePhase}
              </span>
            </div>
          </div>

          {/* ═══ VISIT PANEL ═══ */}
          <div className={`panel ${tab === "visit" ? "on" : ""}`}>
            <div className="jnav">
              <span className="jlbl">Jump to</span>
              {JUMP_SECTIONS.map((j) => (
                <button
                  key={j.id}
                  className={`jbtn ${jumpTarget === j.id ? "on" : ""}`}
                  onClick={() => handleJump(j.id)}
                >
                  {j.label}
                </button>
              ))}
              <div className="jdiv" />
              <button
                className="jbtn"
                onClick={() => handleJump("changes")}
                style={{ color: "var(--green)" }}
              >
                ✏️ This Visit
              </button>
              <button className="ai-btn" onClick={toggleAI}>
                ✦ Gini AI
              </button>
            </div>
            <div className="scrl" ref={scrollRef}>
              <VisitBiomarkers
                labResults={labResults}
                labHistory={labHistory}
                vitals={vitals}
                flags={flags}
                onOpenAI={() => setAiOpen(true)}
                onAddLab={() => setModal({ type: "addLab" })}
              />
              {/* <VisitSymptomsSection consultations={consultations} /> */}
              <VisitDiagnoses
                activeDx={activeDx}
                onAddDiagnosis={() => setModal({ type: "addDiagnosis" })}
                onDiagnosisNote={(dx) => setModal({ type: "diagnosisNote", data: dx })}
                onUpdateDiagnosis={(id, d) => mutations.updateDiagnosis(id, d)}
              />
              <VisitMedications
                activeMeds={uniqueActiveMeds}
                stoppedMeds={uniqueStoppedMeds}
                onAddMed={() => setModal({ type: "addMed" })}
                onEditMed={(m) => setModal({ type: "editMed", data: m })}
                onStopMed={(m) => setModal({ type: "stopMed", data: m })}
              />
              <VisitPlan
                consultations={consultations}
                goals={goals}
                doctorNote={doctorNote}
                onDoctorNoteChange={setDoctorNote}
                patient={patient}
                doctor={doctor}
                activeDx={activeDx}
                activeMeds={uniqueActiveMeds}
                stoppedMeds={uniqueStoppedMeds}
                latestVitals={latestV}
                summary={summary}
                labResults={labResults}
                onEndVisit={hasActiveVisit ? openEndModal : null}
                referrals={referrals || []}
                onAddReferral={() => setModal({ type: "addReferral" })}
                onChangeFollowUp={() => setModal({ type: "changeFollowUp" })}
                onOpenTemplate={(tpl) => setModal({ type: "template", data: tpl })}
                onMedCardTab={() => setTab("medcard")}
              />
              <div style={{ height: 28 }} />
            </div>
          </div>

          {/* ═══ OTHER PANELS ═══ */}
          <div className={`panel ${tab === "labs" ? "on" : ""}`}>
            <VisitLabsPanel
              documents={documents}
              labResults={labResults}
              onUploadReport={() => setModal({ type: "uploadReport" })}
            />
          </div>
          <div className={`panel ${tab === "exam" ? "on" : ""}`}>
            <div className="panel-body">
              <div className="sc">
                <div className="sch">
                  <div className="sct">
                    <div className="sci ic-g">🩺</div>Physical Exam · Visit #{summary.totalVisits}
                  </div>
                  <button className="bx bx-p" onClick={() => navigate("/exam")}>
                    + Record Exam
                  </button>
                </div>
                <div className="scb">
                  {data.examFindings ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {data.examFindings.map((ef, i) => (
                        <div
                          key={i}
                          style={{
                            border: "1px solid var(--border)",
                            borderRadius: "var(--rs)",
                            padding: 12,
                          }}
                        >
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: "var(--text)",
                              marginBottom: 8,
                            }}
                          >
                            {ef.icon || ""} {ef.system}
                          </div>
                          <div style={{ fontSize: 12, color: "var(--t2)", lineHeight: 2 }}>
                            {ef.findings}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "var(--rs)",
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--text)",
                            marginBottom: 8,
                          }}
                        >
                          ❤️ Cardiovascular
                        </div>
                        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 2 }}>
                          No exam recorded
                        </div>
                      </div>
                      <div
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "var(--rs)",
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--text)",
                            marginBottom: 8,
                          }}
                        >
                          🫁 Respiratory
                        </div>
                        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 2 }}>
                          No exam recorded
                        </div>
                      </div>
                      <div
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "var(--rs)",
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--text)",
                            marginBottom: 8,
                          }}
                        >
                          🫃 Abdomen
                        </div>
                        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 2 }}>
                          No exam recorded
                        </div>
                      </div>
                      <div
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "var(--rs)",
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--text)",
                            marginBottom: 8,
                          }}
                        >
                          🦶 Diabetic Foot
                        </div>
                        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 2 }}>
                          No exam recorded
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {/* Anthropometry History */}
              {anthropoRows.length > 0 && (
                <div className="sc">
                  <div className="sch">
                    <div className="sct">
                      <div className="sci ic-a">📏</div>Anthropometry History
                    </div>
                  </div>
                  <div className="scb">
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: "var(--bg)" }}>
                            {["Date", "Weight", "BMI", "Waist", "Body Fat %", "BP"].map((h) => (
                              <th
                                key={h}
                                style={{
                                  padding: "7px 12px",
                                  textAlign: h === "Date" ? "left" : "center",
                                  fontSize: 9,
                                  fontWeight: 700,
                                  color: "var(--t4)",
                                  textTransform: "uppercase",
                                  letterSpacing: ".5px",
                                }}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {anthropoRows.map((v, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                              <td
                                style={{
                                  padding: "7px 12px",
                                  fontWeight: i === 0 ? 700 : 400,
                                  color: i === 0 ? "var(--primary)" : "var(--text)",
                                }}
                              >
                                {fmtDate(v.date)}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.weight ? `${v.weight} kg` : "—"}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.bmi || "—"}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.waist ? `${v.waist} cm` : "—"}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.body_fat ? `${v.body_fat}%` : "—"}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.bp_sys && v.bp_dia ? `${v.bp_sys}/${v.bp_dia}` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {anthropoTrend && (
                      <div className="noticebar grn" style={{ marginTop: 10 }}>
                        <span>✓</span>
                        <span className="ni grn">{anthropoTrend} since earliest record.</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className={`panel ${tab === "history" ? "on" : ""}`}>
            <VisitHistoryPanel consultations={consultations} />
          </div>
          <div className={`panel ${tab === "messages" ? "on" : ""}`}>
            <div className="panel-body">
              <div className="sc">
                <div className="sch">
                  <div className="sct">
                    <div className="sci ic-p">💬</div>Messages &amp; WhatsApp Logs
                  </div>
                  <button className="bx bx-p">Log Call</button>
                </div>
                <div className="scb" style={{ maxWidth: 600 }}>
                  {data.messages?.length > 0 ? (
                    <>
                      {data.messages.map((msg, i) => {
                        const isTeam = msg.sender === "team" || msg.sender === "doctor";
                        const isUnread = msg.is_unread;
                        return (
                          <div key={msg.id || i}>
                            {(i === 0 || msg.date_label) && (
                              <div
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: "var(--t4)",
                                  letterSpacing: ".5px",
                                  textTransform: "uppercase",
                                  margin: i > 0 ? "12px 0 10px" : "0 0 10px",
                                }}
                              >
                                {msg.date_label || fmtDate(msg.sent_at)}
                                {isUnread ? " — UNREAD ⚠" : ""}
                              </div>
                            )}
                            <div
                              className={`msg-bubble ${isUnread ? "unread" : isTeam ? "team" : "patient"}`}
                            >
                              {!isTeam && <strong>{msg.sender_name || patient.name}</strong>}
                              {!isTeam && <br />}
                              {msg.text || msg.message}
                              <div className={`msg-meta ${isTeam ? "team" : "patient"}`}>
                                {msg.channel || "WhatsApp"} · {fmtDate(msg.sent_at)}
                                {isUnread ? " · UNREAD" : ""}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ marginTop: 12, display: "flex", gap: 7 }}>
                        <input
                          className="mi"
                          style={{ flex: 1, height: 36 }}
                          placeholder="Type reply..."
                        />
                        <button className="btn-p" style={{ height: 36 }}>
                          Send via WhatsApp
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div
                        style={{
                          fontSize: 13,
                          color: "var(--t3)",
                          padding: 20,
                          textAlign: "center",
                        }}
                      >
                        No messages yet
                      </div>
                      <div style={{ marginTop: 12, display: "flex", gap: 7 }}>
                        <input
                          className="mi"
                          style={{ flex: 1, height: 36 }}
                          placeholder="Type message..."
                        />
                        <button className="btn-p" style={{ height: 36 }}>
                          Send via WhatsApp
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className={`panel ${tab === "docs" ? "on" : ""}`}>
            <VisitDocsPanel
              documents={documents}
              onUploadReport={() => setModal({ type: "uploadReport" })}
            />
          </div>
          <div className={`panel ${tab === "medcard" ? "on" : ""}`}>
            <VisitMedCard patient={patient} activeMeds={uniqueActiveMeds} />
          </div>
          <div className={`panel ${tab === "logdata" ? "on" : ""}`}>
            <VisitLoggedData loggedData={loggedData} />
          </div>
        </div>
      </div>

      {/* ── Print Prescription (hidden on screen, shown on print) ── */}
      <VisitRxPrint
        patient={patient}
        doctor={doctor}
        summary={summary}
        activeDx={activeDx}
        activeMeds={uniqueActiveMeds}
        stoppedMeds={uniqueStoppedMeds}
        latestVitals={latestV}
        prevVitals={prevV}
        labResults={labResults}
        labHistory={labHistory}
        consultations={consultations}
        goals={goals}
        flags={flags}
        doctorNote={doctorNote}
        vitals={vitals}
      />

      {/* ── AI Panel ── */}
      <VisitAIPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        patientContext={aiContext}
        initialMessage={aiInitialMsg}
      />

      {/* ── End Visit Modal ── */}
      {showEndModal && (
        <VisitEndModal
          patient={patient}
          summary={summary}
          onClose={closeEndModal}
          onConfirm={handleEndVisit}
        />
      )}

      {/* ── Action Modals ── */}
      {modal?.type === "addLab" && (
        <AddLabModal
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.addLab(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "addDiagnosis" && (
        <AddDiagnosisModal
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.addDiagnosis(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "diagnosisNote" && (
        <DiagnosisNoteModal
          diagnosis={modal.data}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.updateDiagnosis(modal.data.id, d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "addMed" && (
        <AddMedicationModal
          diagnoses={activeDx}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.addMedication(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "editMed" && (
        <EditMedicationModal
          medication={modal.data}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.editMedication(modal.data.id, d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "stopMed" && (
        <StopMedicationModal
          medication={modal.data}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.stopMedication(modal.data.id, d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "addReferral" && (
        <AddReferralModal
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.addReferral(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "uploadReport" && (
        <UploadReportModal
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.uploadDocument(d);
            if (!r.success) return;
            closeModal();
            // Auto-extract lab values for lab reports
            if (d.doc_type === "lab_report" && d.base64) {
              toast("Extracting lab values...", "info");
              try {
                const mediaType = d.fileName?.match(/\.pdf$/i)
                  ? "application/pdf"
                  : d.fileName?.match(/\.png$/i)
                    ? "image/png"
                    : "image/jpeg";
                const { data: extracted, error } = await extractLab(d.base64, mediaType);
                if (error || !extracted?.panels?.length) {
                  toast("Could not extract lab values from report", "warn");
                } else {
                  const effectiveDate = d.doc_date || null;
                  let count = 0;
                  for (const panel of extracted.panels) {
                    for (const test of panel.tests || []) {
                      await api
                        .post(`/api/patients/${dbPatientId}/labs`, {
                          test_name: normalizeTestName(test.test_name),
                          result: String(test.result_text || test.result),
                          unit: test.unit || "",
                          flag: test.flag || "N",
                          ref_range: test.ref_range || "",
                          test_date: effectiveDate,
                        })
                        .catch(() => {});
                      count++;
                    }
                  }
                  await refreshData();
                  toast(`${count} lab value${count !== 1 ? "s" : ""} extracted`, "success");
                }
              } catch {
                toast("Lab extraction failed", "warn");
              }
            }
          }}
        />
      )}
      {modal?.type === "changeFollowUp" && (
        <ChangeFollowUpModal
          currentDate={consultations[0]?.con_data?.follow_up?.date || ""}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.updateFollowUp(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "template" && (
        <TemplateModal templateKey={modal.data} patient={patient} onClose={closeModal} />
      )}
    </div>
  );
}
