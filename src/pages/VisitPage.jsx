import "./VisitPage.css";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import api from "../services/api";
import { useVisit } from "../queries/hooks/useVisit";
import { qk } from "../queries/keys";
import usePatientStore from "../stores/patientStore";
import useAuthStore from "../stores/authStore";
import useVisitStore from "../stores/visitStore";
import useClinicalStore from "../stores/clinicalStore";
import { toast } from "../stores/uiStore";
import {
  findLab,
  getLabVal,
  getLabHist,
  computeFlags,
  fmtDate,
  fmtDateShort,
  isSameDate,
} from "../components/visit/helpers";
import { extractLab } from "../services/extraction";
import { normalizeTestName } from "../config/labNormalization";
import { EXAM_SECTIONS } from "../config/exam.js";
import VisitTopbar from "../components/visit/VisitTopbar";
import VisitStrip from "../components/visit/VisitStrip";
import VisitSidebar from "../components/visit/VisitSidebar";
import VisitBiomarkers from "../components/visit/VisitBiomarkers";
import ChangesPopover from "../components/visit/ChangesPopover";
// import VitalsTrendChart from "../components/visit/VitalsTrendChart";
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
import VisitSummaryPanel from "../components/visit/VisitSummaryPanel";
import VisitCoordPrep from "../components/visit/VisitCoordPrep";
import SyncStatusBanner from "../components/visit/SyncStatusBanner";
import {
  AddLabModal,
  AddSymptomModal,
  AddDiagnosisModal,
  DiagnosisNoteModal,
  AddMedicationModal,
  EditMedicationModal,
  StopMedicationModal,
  DeleteMedicationModal,
  AddReferralModal,
  UploadReportModal,
  ChangeFollowUpModal,
  TemplateModal,
  LabExtractionReviewModal,
  PasteBiomarkersModal,
  ClinicalExtractionReviewModal,
} from "../components/visit/modals";
import { useVisitMutations } from "../hooks/useVisitMutations";
import { printMedCard } from "../components/visit/medCardPrint";

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
const sySelStyle = (s) => {
  if (!s) return {};
  const v = s.toLowerCase();
  if (v.includes("resolved") || v === "controlled")
    return { color: "var(--green)", borderColor: "var(--grn-bd)" };
  if (v === "improving") return { color: "var(--primary)", borderColor: "var(--primary)" };
  if (v === "got worse") return { color: "var(--red)", borderColor: "var(--red)" };
  return {};
};

function VisitSymptomsSection({ symptoms = [], onAddSymptom, onStatusChange }) {
  const symptomSummary = useMemo(() => {
    if (!symptoms.length) return null;

    const latest = symptoms.reduce((max, sy) => {
      const d = sy.updated_at || sy.created_at;
      return d && d > (max || "") ? d : max;
    }, null);
    if (!latest) return null;

    const onDate = symptoms.filter((sy) => {
      const d = sy.updated_at || sy.created_at;
      return d && isSameDate(d, latest);
    });

    const added = onDate.filter((sy) => isSameDate(sy.created_at, latest));
    const modified = onDate.filter((sy) => !isSameDate(sy.created_at, latest));

    const parts = [];
    if (added.length === 1) {
      parts.push(`${added[0].label} added`);
    } else if (added.length > 1) {
      parts.push(`${added.length} symptoms added`);
    }
    if (modified.length === 1) {
      const sy = modified[0];
      parts.push(
        sy.prev_status
          ? `${sy.label} ${sy.prev_status} → ${sy.status || "Active"}`
          : `${sy.label} → ${sy.status || "Active"}`,
      );
    } else if (modified.length > 1) {
      parts.push(`${modified.length} statuses updated`);
    }

    const text = parts.length > 0 ? parts.join(", ") : "Updated";

    const addedDetails = added.map((sy) => ({
      name: sy.label,
      diff: [sy.status || "Active"],
    }));
    const changedDetails = modified.map((sy) => ({
      name: sy.label,
      diff: [`${sy.prev_status || "—"} → ${sy.status || "Active"}`],
    }));

    return { text, date: latest, added: addedDetails, changed: changedDetails };
  }, [symptoms]);

  return (
    <div className="sc" id="symptoms">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-a">🩹</div>Symptoms &amp; Concerns
          {symptomSummary && (
            <ChangesPopover
              date={symptomSummary.date}
              label={`${symptomSummary.text} — ${fmtDateShort(symptomSummary.date)}`}
              added={symptomSummary.added}
              changed={symptomSummary.changed}
            />
          )}
        </div>
        <button className="bx bx-p" onClick={onAddSymptom}>
          + Add Symptom
        </button>
      </div>
      <div className="scb">
        {symptoms.length > 0 ? (
          <>
            <div className="subsec">Active / Historical — Update Status</div>
            <div className="syg">
              {symptoms.map((sy) => {
                const meta = [sy.related_to, sy.since_date ? `Since ${sy.since_date}` : ""]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div key={sy.id} className="syi">
                    <div className="sy-dot" style={{ background: syDotColor(sy.status) }} />
                    <div style={{ flex: 1 }}>
                      <div className="sy-nm">{sy.label}</div>
                      {meta && <div className="sy-meta">{meta}</div>}
                    </div>
                    <select
                      className="sy-sel"
                      value={sy.status}
                      style={sySelStyle(sy.status)}
                      onChange={(e) => onStatusChange(sy.id, e.target.value)}
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
        <div className="addr" onClick={onAddSymptom}>
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
  const qc = useQueryClient();
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const doctor = useAuthStore((s) => s.currentDoctor);
  const endVisitAction = useVisitStore((s) => s.endVisit);
  const conData = useClinicalStore((s) => s.conData);
  const setConData = useClinicalStore((s) => s.setConData);

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
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") || "visit";
  const setTab = (t) => {
    setSearchParams(
      (prev) => {
        prev.set("tab", t);
        return prev;
      },
      { replace: true },
    );
  };
  const [jumpTarget, setJumpTarget] = useState("biomarkers");
  const [aiOpen, setAiOpen] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [doctorNote, setDoctorNote] = useState("");
  const [modal, setModal] = useState(null); // { type, data? }
  const [labExtractSaving, setLabExtractSaving] = useState(false);
  const [clinicalExtractSaving, setClinicalExtractSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const scrollRef = useRef(null);
  const noteTimerRef = useRef(null);

  const saveDoctorNote = useCallback(
    (note) => {
      clearTimeout(noteTimerRef.current);
      noteTimerRef.current = setTimeout(async () => {
        try {
          await api.patch(`/api/visit/${dbPatientId}/doctor-note`, {
            note,
            appointment_id: opdApptId || null,
          });
        } catch {
          // silent fail — note will retry on next keystroke
        }
      }, 1200);
    },
    [dbPatientId, opdApptId],
  );

  const handleDoctorNoteChange = useCallback(
    (val) => {
      setDoctorNote(val);
      saveDoctorNote(val);
    },
    [saveDoctorNote],
  );

  // ── Redirect if no patient — restore is handled by the patient store ──
  useEffect(() => {
    const savedId = sessionStorage.getItem("gini_active_patient");
    if (!dbPatientId && !savedId) navigate("/");
  }, [dbPatientId, navigate]);

  // ── React Query owns the visit fetch ──
  // - Auto-refetches on mount (staleTime: 0) and on window focus.
  // - Mutations elsewhere (saveConsultation, biomarkers, compliance) invalidate
  //   this key and trigger a background refetch without any manual refreshData call.
  const visitQuery = useVisit(dbPatientId, opdApptId);

  // Run the one-time medication reconcile after the first successful load.
  // If any rows are stopped, invalidate the visit cache so it refetches with
  // the new state. The reconcile call is non-critical — silent on error.
  const reconciledOnceRef = useRef(null);
  useEffect(() => {
    if (!visitQuery.data || !dbPatientId) return;
    if (reconciledOnceRef.current === dbPatientId) return;
    reconciledOnceRef.current = dbPatientId;
    (async () => {
      try {
        const rec = await api.patch(`/api/visit/${dbPatientId}/medications/reconcile`);
        if (rec.data?.stopped > 0) {
          visitQuery.refetch();
        }
      } catch {
        // non-critical
      }
    })();
  }, [dbPatientId, visitQuery.data, visitQuery.refetch]);

  // Sync query data → local `data` state so the existing transforms
  // (examFindings, doctorNote seed) keep working unchanged. When the query
  // updates (refetch / invalidation), this effect re-runs and `setData` is
  // called with the freshest payload.
  useEffect(() => {
    const d = visitQuery.data;
    if (!d) return;
    setData({ ...d, examFindings: buildExamFindings(d.consultations?.[0]?.exam_data) });
    if (d.appt_doctor_note) {
      setDoctorNote(d.appt_doctor_note);
    } else if (d.consultations?.[0]?.con_data?.assessment_summary) {
      setDoctorNote(d.consultations[0].con_data.assessment_summary);
    }
  }, [visitQuery.data]);

  useEffect(() => {
    setLoading(visitQuery.isPending);
  }, [visitQuery.isPending]);

  useEffect(() => {
    if (visitQuery.isError) toast("Failed to load visit data", "error");
  }, [visitQuery.isError]);

  // ── Refresh data after mutations — delegate to React Query ──
  const refreshData = useCallback(async () => {
    await visitQuery.refetch();
  }, [visitQuery]);

  // ── Poll for new lab data (background sync) and auto-refresh biomarkers ──
  const labCountRef = useRef(null);
  useEffect(() => {
    if (!dbPatientId) return;
    // Seed the ref from currently loaded data
    labCountRef.current = data?.labResults?.length ?? null;

    const interval = setInterval(async () => {
      try {
        const { data: counts } = await api.get(`/api/visit/${dbPatientId}/lab-count`);
        if (labCountRef.current !== null && counts.total > labCountRef.current) {
          console.log("[LabPoll] New lab data detected, refreshing...");
          await refreshData();
          labCountRef.current = counts.total;
        } else if (labCountRef.current === null) {
          labCountRef.current = counts.total;
        }
      } catch {
        // silent — polling is non-critical
      }
    }, 120_000);

    return () => clearInterval(interval);
  }, [dbPatientId, refreshData, data?.labResults?.length]);

  const mutations = useVisitMutations(dbPatientId, refreshData, opdApptId);
  const closeModal = useCallback(() => setModal(null), []);

  // ── Derived data (memoized) ──
  const derived = useMemo(() => {
    if (!data) return null;
    console.log("data", data);
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
          // Take the newer row whole — including its id. Pinning the older
          // row's id made the delete button target a stale record.
          grouped[key] = { ...m };
        }
      });
      return Object.values(grouped);
    };
    const uniqueActiveMeds = dedupMeds(data.activeMeds);
    const uniqueStoppedMeds = dedupMeds(data.stoppedMeds);

    // Filter to latest prescription date only (for sidebar — mirrors the
    // lastVisitMeds split inside VisitMedications). Source of truth is
    // `last_prescribed_date` (re-set on every re-prescription); meds without
    // it are kept (legacy/active rows) so they don't disappear.
    const _activeOnly = uniqueActiveMeds.filter((m) => m.is_active !== false);
    const _dayKey = (d) => (d ? String(d).slice(0, 10) : null);
    const _dates = _activeOnly.map((m) => _dayKey(m.last_prescribed_date)).filter(Boolean);
    const _latestDate = _dates.length ? _dates.reduce((a, b) => (a > b ? a : b)) : null;
    const latestVisitMeds = _latestDate
      ? _activeOnly.filter(
          (m) => !m.last_prescribed_date || _dayKey(m.last_prescribed_date) === _latestDate,
        )
      : _activeOnly;

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
          waist: v.waist || g.waist || null,
          body_fat: v.body_fat || g.body_fat || null,
          muscle_mass: v.muscle_mass || g.muscle_mass || null,
          bp_sys: v.bp_sys || g.bp_systolic || null,
          bp_dia: v.bp_dia || g.bp_diastolic || null,
        };
      }),
    ];
    const clinicDates = new Set(vitals.map((v) => String(v.recorded_at).slice(0, 10)));
    genieVitals.forEach((g) => {
      const d = String(g.recorded_date).slice(0, 10);
      if (!clinicDates.has(d) && (g.waist || g.body_fat || g.muscle_mass || g.weight_kg)) {
        anthropoRows.push({
          date: g.recorded_date,
          weight: g.weight_kg || null,
          bmi: g.bmi || null,
          waist: g.waist || null,
          body_fat: g.body_fat || null,
          muscle_mass: g.muscle_mass || null,
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
      latestVisitMeds,
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
  const handlePrintMedCard = useCallback(() => {
    const patient = data?.patient;
    const activeMeds = derived?.uniqueActiveMeds || [];
    if (!patient) return;
    printMedCard(patient, activeMeds);
  }, [data, derived]);
  const handlePrintBoth = useCallback(() => {
    // Open the med-card popup synchronously so the user-gesture isn't lost,
    // use a longer delay since the Rx dialog also queues up.
    const patient = data?.patient;
    const activeMeds = derived?.uniqueActiveMeds || [];
    if (patient) printMedCard(patient, activeMeds, 700);
    window.print();
  }, [data, derived]);
  const handlePasteNotes = useCallback(() => setModal({ type: "pasteText" }), []);

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
    const visibleDocs = data.documents.filter(
      (d) => d.storage_path || d.file_url || d.source === "healthray",
    );
    return {
      labs: visibleDocs.filter((d) => d.doc_type === "lab_report").length || null,
      docs: visibleDocs.length || null,
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
    appt_plan,
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
    latestVisitMeds,
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
        onPasteNotes={handlePasteNotes}
        onPrintRx={handlePrint}
        onPrintMedCard={handlePrintMedCard}
        onPrintBoth={handlePrintBoth}
        visitStart={visitStart}
        hasActiveVisit={hasActiveVisit}
      />

      <VisitStrip
        summary={summary}
        hba1cCurr={hba1cCurr}
        hba1cFirst={hba1cFirst}
        latestVitals={latestV}
        prevVitals={prevV}
        activeMeds={uniqueActiveMeds}
      />

      {/* Extraction in progress modal overlay */}
      {extracting && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: 12,
              padding: "32px",
              textAlign: "center",
              boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
              maxWidth: 320,
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16, animation: "spin 2s linear infinite" }}>
              ⏳
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#1a1f2e", marginBottom: 8 }}>
              Extracting Lab Values
            </div>
            <div style={{ fontSize: 13, color: "#6b7280" }}>
              Please wait while we extract the lab results from your report...
            </div>
          </div>
        </div>
      )}

      <div className="bodywrap">
        <VisitSidebar
          summary={summary}
          latestVitals={latestV}
          activeDx={activeDx}
          activeMeds={latestVisitMeds}
          flags={flags}
          labResults={labResults}
          onSaveVitals={(data) => mutations.updateVitals(data, latestV)}
          onSaveLab={(data) => mutations.addLab(data)}
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
              <SyncStatusBanner syncStatus={data.syncStatus} />
              <VisitSummaryPanel patientId={dbPatientId} appointmentId={opdApptId} />
              <VisitBiomarkers
                labResults={labResults}
                labLatest={data.labLatest}
                labHistory={labHistory}
                vitals={vitals}
                flags={flags}
                onOpenAI={() => setAiOpen(true)}
                onAddLab={() => setModal({ type: "addLab" })}
              />
              {/* <VitalsTrendChart vitals={vitals} /> */}
              {/* <VisitCoordPrep prep={data.prep} /> */}
              <VisitSymptomsSection
                symptoms={data.symptoms || []}
                onAddSymptom={() => setModal({ type: "addSymptom" })}
                onStatusChange={(id, status) => mutations.updateSymptomStatus(id, status)}
              />
              <VisitDiagnoses
                activeDx={activeDx}
                healthrayDiagnoses={data.healthrayDiagnoses}
                labResults={data.labResults}
                vitals={data.vitals}
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
                onDeleteMed={(m) => setModal({ type: "deleteMed", data: m })}
                onRestartMed={(m) => mutations.restartMedication(m.id)}
              />
              <VisitPlan
                consultations={consultations}
                apptPlan={appt_plan}
                goals={goals}
                doctorNote={doctorNote}
                onDoctorNoteChange={handleDoctorNoteChange}
                patient={patient}
                doctor={doctor}
                activeDx={activeDx}
                activeMeds={uniqueActiveMeds}
                stoppedMeds={uniqueStoppedMeds}
                latestVitals={latestV}
                summary={summary}
                labResults={labResults}
                symptoms={data.symptoms || []}
                onEndVisit={hasActiveVisit ? openEndModal : null}
                referrals={referrals || []}
                onAddReferral={() => setModal({ type: "addReferral" })}
                onChangeFollowUp={() => setModal({ type: "changeFollowUp" })}
                onOpenTemplate={(tpl) => setModal({ type: "template", data: tpl })}
                onMedCardTab={() => setTab("medcard")}
                conData={conData}
                setConData={setConData}
              />
              <div style={{ height: 28 }} />
            </div>
          </div>

          {/* ═══ OTHER PANELS ═══ */}
          <div className={`panel ${tab === "labs" ? "on" : ""}`}>
            <VisitLabsPanel
              documents={documents}
              patientId={patient?.id}
              labResults={labResults}
              labLatest={data.labLatest}
              labOrders={data.labOrders}
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
                    <div className="visit-exam-grid">
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
                    <div className="visit-exam-grid">
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
                            {[
                              "Date",
                              "Weight",
                              "BMI",
                              "Waist",
                              "Body Fat %",
                              "Muscle Mass",
                              "BP",
                            ].map((h) => (
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
                                {v.muscle_mass ? `${v.muscle_mass} kg` : "—"}
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
              patientId={patient?.id}
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
        symptoms={data.symptoms || []}
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
      {modal?.type === "addSymptom" && (
        <AddSymptomModal
          activeDx={activeDx}
          activeMeds={uniqueActiveMeds}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.addSymptom(d);
            if (r.success) closeModal();
          }}
        />
      )}
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
          patient={data.patient}
          labResults={data.labResults}
          activeMeds={derived.uniqueActiveMeds}
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
      {modal?.type === "deleteMed" && (
        <DeleteMedicationModal
          medication={modal.data}
          onClose={closeModal}
          onSubmit={async (id) => {
            const r = await mutations.deleteMedication(id);
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
            // For lab reports with a file, extract and show review modal
            if (d.doc_type === "lab_report" && d.base64) {
              setExtracting(true);
              try {
                const mediaType = d.fileName?.match(/\.pdf$/i)
                  ? "application/pdf"
                  : d.fileName?.match(/\.png$/i)
                    ? "image/png"
                    : "image/jpeg";
                console.log("[LabExtract] Starting extraction", {
                  fileName: d.fileName,
                  mediaType,
                });
                const { data: extracted, error } = await extractLab(d.base64, mediaType);
                console.log("[LabExtract] Result:", { extracted, error });
                setExtracting(false);
                if (error) {
                  toast(`Extraction error: ${error}`, "warn");
                } else if (!extracted?.panels?.length) {
                  toast("No lab values found in report", "warn");
                } else {
                  // PATCH document with extracted_data to trigger backend sync (labs + vitals + biomarkers)
                  if (r.docId) {
                    api
                      .patch(`/api/documents/${r.docId}`, { extracted_data: extracted })
                      .catch(() => {});
                  }
                  setModal({ type: "labReview", data: { extracted, doc_date: d.doc_date } });
                }
              } catch (e) {
                console.error("[LabExtract] Exception:", e);
                setExtracting(false);
                toast(`Lab extraction failed: ${e.message}`, "warn");
              }
            } else if (d.doc_type === "lab_report" && !d.base64) {
              toast("No file attached — attach a file to extract lab values", "warn");
            }
          }}
        />
      )}
      {modal?.type === "pasteText" && (
        <PasteBiomarkersModal
          patientId={dbPatientId}
          onClose={closeModal}
          onExtracted={({ extracted, doc_date, raw_text }) => {
            closeModal();
            setModal({
              type: "clinicalReview",
              data: { extracted, doc_date, raw_text },
            });
          }}
        />
      )}
      {modal?.type === "labReview" && (
        <LabExtractionReviewModal
          extracted={modal.data.extracted}
          doc_date={modal.data.doc_date}
          saving={labExtractSaving}
          onClose={closeModal}
          onSave={async (tests, doc_date, vitals = []) => {
            setLabExtractSaving(true);
            const source = modal.data.source || "lab";
            let savedLabs = 0;
            let savedVitals = 0;
            for (const test of tests) {
              try {
                await api.post(`/api/patients/${dbPatientId}/labs`, {
                  test_name: normalizeTestName(test.test_name),
                  result: String(test.result_text || test.result),
                  unit: test.unit || "",
                  flag: test.flag || "N",
                  ref_range: test.ref_range || "",
                  test_date: test.test_date || doc_date || null,
                  source,
                });
                savedLabs++;
              } catch (e) {
                console.error("Failed to save lab:", e.message);
              }
            }
            for (const v of vitals) {
              try {
                await api.post(`/api/visit/${dbPatientId}/vitals`, {
                  bp_sys: v.bpSys ?? null,
                  bp_dia: v.bpDia ?? null,
                  weight: v.weight ?? null,
                  height: v.height ?? null,
                  bmi: v.bmi ?? null,
                  waist: v.waist ?? null,
                  body_fat: v.bodyFat ?? null,
                  recorded_at: v.date || doc_date || null,
                });
                savedVitals++;
              } catch (e) {
                console.error("Failed to save vitals:", e.message);
              }
            }
            // Refresh the OPD biomarker chip strip from the new lab_results
            // so /opd reflects the latest values alongside /visit and /outcomes.
            if (savedLabs > 0) {
              try {
                await api.post(`/api/visit/${dbPatientId}/biomarkers/refresh`);
              } catch (e) {
                console.error("Biomarker refresh failed:", e.message);
              }
            }
            // Refresh data and wait a moment for state to update
            await refreshData();
            // Invalidate OPD appointments cache so the chip strip repaints when
            // the user navigates there. Outcomes page refetches on mount (no
            // cache invalidation needed there).
            qc.invalidateQueries({ queryKey: qk.opd.all });
            await new Promise((r) => setTimeout(r, 500));
            setLabExtractSaving(false);
            closeModal();
            const parts = [];
            if (savedLabs > 0) parts.push(`${savedLabs} lab${savedLabs !== 1 ? "s" : ""}`);
            if (savedVitals > 0)
              parts.push(`${savedVitals} vitals reading${savedVitals !== 1 ? "s" : ""}`);
            toast(parts.length ? `${parts.join(" + ")} saved` : "Nothing saved", "success");
            // Delayed second refresh to catch async backend autoExtractLab results
            setTimeout(() => refreshData(), 3000);
          }}
        />
      )}
      {modal?.type === "clinicalReview" && (
        <ClinicalExtractionReviewModal
          extracted={modal.data.extracted}
          doc_date={modal.data.doc_date}
          currentSymptoms={data.symptoms || []}
          currentDiagnoses={activeDx}
          currentMedications={uniqueActiveMeds}
          saving={clinicalExtractSaving}
          onClose={closeModal}
          onSave={async (picked) => {
            setClinicalExtractSaving(true);
            const docDate = modal.data.doc_date;
            const counts = { sx: 0, dx: 0, meds: 0, stop: 0, labs: 0, vit: 0, inv: 0 };
            const silent = { silent: true, skipRefresh: true };
            const failed = [];

            // Symptoms
            for (const s of picked.symptoms) {
              const r = await mutations.addSymptom(
                {
                  name: s.name,
                  since: s.since_date || null,
                  severity: s.severity || "Mild",
                  related_to: s.related_to || "",
                },
                silent,
              );
              if (r.success) counts.sx++;
              else failed.push(`symptom "${s.name}"`);
            }

            // Diagnoses
            for (const d of picked.diagnoses) {
              const notes = [d.details, d.since ? `Since ${d.since}` : null]
                .filter(Boolean)
                .join(" · ");
              const r = await mutations.addDiagnosis(
                {
                  name: d.name,
                  status: d.status === "Absent" ? "Resolved" : "Newly Diagnosed",
                  category: "primary",
                  notes,
                  key_value: "",
                },
                silent,
              );
              if (r.success) counts.dx++;
              else failed.push(`diagnosis "${d.name}"`);
            }

            // Medications
            for (const m of picked.medications) {
              const r = await mutations.addMedication(
                {
                  name: m.name,
                  dose: m.dose || "",
                  frequency: m.frequency || "OD",
                  timing: m.timing || "",
                  route: m.route || "Oral",
                  started_date: docDate || null,
                },
                silent,
              );
              if (r.success) counts.meds++;
              else failed.push(`medication "${m.name}"`);
            }

            // Stop previous meds
            for (const sm of picked.stopMeds) {
              const r = await mutations.stopMedication(
                sm.id,
                { reason: sm.reason || "Previous visit" },
                silent,
              );
              if (r.success) counts.stop++;
              else failed.push(`stop "${sm.name}"`);
            }

            // Labs
            for (const lab of picked.labs) {
              try {
                await api.post(`/api/patients/${dbPatientId}/labs`, {
                  test_name: normalizeTestName(lab.test_name),
                  result: String(lab.result_text || lab.result),
                  unit: lab.unit || "",
                  flag: lab.flag || "N",
                  ref_range: lab.ref_range || "",
                  test_date: lab.test_date || docDate || null,
                  source: "report_extract",
                });
                counts.labs++;
              } catch (e) {
                console.error("Failed to save lab:", e.message);
                failed.push(`lab "${lab.test_name}"`);
              }
            }

            // Vitals
            for (const v of picked.vitals) {
              try {
                await api.post(`/api/visit/${dbPatientId}/vitals`, {
                  bp_sys: v.bpSys ?? null,
                  bp_dia: v.bpDia ?? null,
                  weight: v.weight ?? null,
                  height: v.height ?? null,
                  bmi: v.bmi ?? null,
                  waist: v.waist ?? null,
                  body_fat: v.bodyFat ?? null,
                  recorded_at: v.date || docDate || null,
                });
                counts.vit++;
              } catch (e) {
                console.error("Failed to save vitals:", e.message);
                failed.push("vitals");
              }
            }

            // Investigations (single batched call)
            if (picked.investigations.length > 0) {
              const r = await mutations.addInvestigations(
                picked.investigations.map((x) => ({
                  name: x.name,
                  urgency: x.urgency || "routine",
                })),
                silent,
              );
              if (r.success) counts.inv = r.added || picked.investigations.length;
              else failed.push("investigations");
            }

            if (counts.labs > 0) {
              try {
                await api.post(`/api/visit/${dbPatientId}/biomarkers/refresh`);
              } catch (e) {
                console.error("Biomarker refresh failed:", e.message);
              }
            }

            // Build a "confirmed" payload reflecting only what the doctor
            // accepted in the review modal, then save it as a Scribe-tagged
            // prescription PDF in the patient's documents. Anything the doctor
            // unchecked is excluded from the printable record.
            const totalPicked =
              counts.sx +
              counts.dx +
              counts.meds +
              counts.stop +
              counts.labs +
              counts.vit +
              counts.inv;
            if (totalPicked > 0) {
              const srcExtracted = modal.data.extracted || {};
              const confirmedParsed = {
                symptoms: picked.symptoms,
                diagnoses: picked.diagnoses,
                medications: picked.medications,
                previous_medications: picked.stopMeds.map((sm) => ({
                  name: sm.name,
                  status: "stopped",
                  reason: sm.reason,
                })),
                labs: picked.labs.map((l) => ({
                  test: l.test_name,
                  value: l.result_text || l.result,
                  unit: l.unit,
                  date: l.test_date,
                })),
                vitals: picked.vitals,
                investigations_to_order: picked.investigations,
                lifestyle: srcExtracted.lifestyle || {},
                follow_up: srcExtracted.follow_up || {},
                advice: srcExtracted.advice || "",
              };
              api
                .post(`/api/visit/${dbPatientId}/scribe-prescription`, {
                  patient,
                  doctor,
                  parsed: confirmedParsed,
                  raw_text: modal.data.raw_text || "",
                  doc_date: docDate || null,
                })
                .catch((e) => console.error("Scribe prescription PDF save failed:", e.message));
            }

            await refreshData();
            qc.invalidateQueries({ queryKey: qk.opd.all });
            setClinicalExtractSaving(false);
            closeModal();

            const parts = [];
            if (counts.sx) parts.push(`${counts.sx} symptom${counts.sx !== 1 ? "s" : ""}`);
            if (counts.dx) parts.push(`${counts.dx} diagnos${counts.dx !== 1 ? "es" : "is"}`);
            if (counts.meds) parts.push(`${counts.meds} med${counts.meds !== 1 ? "s" : ""}`);
            if (counts.stop) parts.push(`${counts.stop} stopped`);
            if (counts.labs) parts.push(`${counts.labs} lab${counts.labs !== 1 ? "s" : ""}`);
            if (counts.vit) parts.push(`${counts.vit} vitals`);
            if (counts.inv) parts.push(`${counts.inv} test${counts.inv !== 1 ? "s" : ""}`);
            // PDF generation disabled — parsed payload + raw text are still
            // saved server-side. Re-add "Rx PDF" line when prescription output returns.
            // if (totalPicked > 0) parts.push("Rx PDF");
            if (failed.length > 0) {
              const savedMsg = parts.length ? `Saved ${parts.join(", ")}. ` : "";
              toast(`${savedMsg}Failed: ${failed.join(", ")}`, "error");
            } else {
              toast(parts.length ? `Saved: ${parts.join(", ")}` : "Nothing saved", "success");
            }
            setTimeout(() => refreshData(), 3000);
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
