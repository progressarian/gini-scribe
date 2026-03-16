import { create } from "zustand";
import api from "../services/api.js";
import { sa } from "../config/constants.js";
import useAuthStore from "./authStore.js";

const usePlanStore = create((set, get) => ({
  // ── state ──
  planHidden: new Set(),
  planEdits: {},
  clarifications: {},
  medRecon: {},
  medReconReasons: {},
  showMedCard: false,
  nextVisitDate: "",
  planAddMode: null,
  planAddText: "",
  planAddMed: { name: "", dose: "", frequency: "OD", timing: "Morning" },
  planCopied: false,

  // ── simple setters ──
  setPlanHidden: (val) => set({ planHidden: val }),
  setPlanEdits: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ planEdits: val(state.planEdits) })
        : { planEdits: val },
    ),
  setClarifications: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ clarifications: val(state.clarifications) })
        : { clarifications: val },
    ),
  setMedRecon: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ medRecon: val(state.medRecon) })
        : { medRecon: val },
    ),
  setMedReconReasons: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ medReconReasons: val(state.medReconReasons) })
        : { medReconReasons: val },
    ),
  setShowMedCard: (val) => set({ showMedCard: val }),
  setNextVisitDate: (val) => set({ nextVisitDate: val }),
  setPlanAddMode: (val) => set({ planAddMode: val }),
  setPlanAddText: (val) => set({ planAddText: val }),
  setPlanAddMed: (val) => set({ planAddMed: val }),
  setPlanCopied: (val) => set({ planCopied: val }),

  // ── plan editing helpers ──

  toggleBlock: (id) =>
    set((state) => {
      const s = new Set(state.planHidden);
      s.has(id) ? s.delete(id) : s.add(id);
      return { planHidden: s };
    }),

  editPlan: (key, val) => set((state) => ({ planEdits: { ...state.planEdits, [key]: val } })),

  getPlan: (key, fallback) => {
    const { planEdits } = get();
    return planEdits[key] !== undefined ? planEdits[key] : fallback;
  },

  resetPlanEdits: () => set({ planHidden: new Set(), planEdits: {} }),

  editMedField: (medObj, field, value, conData, setConData, moData, setMoData) => {
    // Find in conData.medications_confirmed or moData.previous_medications
    const conMeds = conData?.medications_confirmed || [];
    const conIdx = conMeds.indexOf(medObj);
    if (conIdx >= 0) {
      const updated = [...conMeds];
      updated[conIdx] = { ...updated[conIdx], [field]: value };
      setConData((prev) => ({ ...prev, medications_confirmed: updated }));
      return;
    }
    const moMeds = moData?.previous_medications || [];
    const moIdx = moMeds.indexOf(medObj);
    if (moIdx >= 0) {
      const updated = [...moMeds];
      updated[moIdx] = { ...updated[moIdx], [field]: value };
      setMoData((prev) => ({ ...prev, previous_medications: updated }));
    }
  },

  editLifestyleField: (itemObj, field, value, conData, setConData) => {
    const items = conData?.diet_lifestyle || [];
    const idx = items.indexOf(itemObj);
    if (idx >= 0) {
      const updated = [...items];
      updated[idx] =
        typeof updated[idx] === "string"
          ? { advice: value, detail: "", category: "Exercise", helps: [] }
          : { ...updated[idx], [field]: value };
      setConData((prev) => ({ ...prev, diet_lifestyle: updated }));
    }
  },

  addMedToPlan: (med, conData, setConData) => {
    if (!conData) return;
    const updated = {
      ...conData,
      medications_confirmed: [...(conData.medications_confirmed || []), med],
    };
    setConData(updated);
  },

  addLifestyleToPlan: (item, conData, setConData) => {
    if (!conData) return;
    const updated = { ...conData, diet_lifestyle: [...(conData.diet_lifestyle || []), item] };
    setConData(updated);
  },

  addGoalToPlan: (goal, conData, setConData) => {
    if (!conData) return;
    const updated = { ...conData, goals: [...(conData.goals || []), goal] };
    setConData(updated);
  },

  addFutureToPlan: (item, conData, setConData) => {
    if (!conData) return;
    const updated = { ...conData, future_plan: [...(conData.future_plan || []), item] };
    setConData(updated);
  },

  addMonitorToPlan: (item, conData, setConData) => {
    if (!conData) return;
    const updated = { ...conData, self_monitoring: [...(conData.self_monitoring || []), item] };
    setConData(updated);
  },

  addInvestigationToPlan: (test, conData, setConData) => {
    if (!conData) return;
    const key = conData.investigations_ordered
      ? "investigations_ordered"
      : "investigations_to_order";
    setConData((prev) => ({ ...prev, [key]: [...(prev[key] || []), test] }));
  },

  addDiagToPlan: (diag, moData, setMoData) => {
    if (!moData) return;
    setMoData((prev) => ({ ...prev, diagnoses: [...(prev.diagnoses || []), diag] }));
  },

  addComplaintToPlan: (text, moData, setMoData) => {
    if (!moData) return;
    setMoData((prev) => ({ ...prev, chief_complaints: [...(prev.chief_complaints || []), text] }));
  },

  removeMed: (idx) =>
    set((state) => ({
      planEdits: {
        ...state.planEdits,
        _removedMeds: [...(state.planEdits._removedMeds || []), idx],
      },
    })),
  removeLifestyle: (idx) =>
    set((state) => ({
      planEdits: {
        ...state.planEdits,
        _removedLifestyle: [...(state.planEdits._removedLifestyle || []), idx],
      },
    })),
  removeFuture: (idx) =>
    set((state) => ({
      planEdits: {
        ...state.planEdits,
        _removedFuture: [...(state.planEdits._removedFuture || []), idx],
      },
    })),
  removeGoal: (idx) =>
    set((state) => ({
      planEdits: {
        ...state.planEdits,
        _removedGoals: [...(state.planEdits._removedGoals || []), idx],
      },
    })),
  removeMonitor: (idx) =>
    set((state) => ({
      planEdits: {
        ...state.planEdits,
        _removedMonitors: [...(state.planEdits._removedMonitors || []), idx],
      },
    })),
  removeDiag: (idx) =>
    set((state) => ({
      planEdits: {
        ...state.planEdits,
        _removedDiags: [...(state.planEdits._removedDiags || []), idx],
      },
    })),

  handlePrintPlan: async (
    dbPatientId,
    conData,
    moData,
    patient,
    vitals,
    planEdits,
    pfd,
    conName,
    currentDoctor,
  ) => {
    // Save plan document to DB if patient is loaded (only once per session)
    if (dbPatientId && conData) {
      try {
        const planDoc = {
          doc_type: "prescription",
          title: `Treatment Plan \u2014 ${conName || "Doctor"} \u2014 ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`,
          file_name: `plan_${dbPatientId}_${Date.now()}.json`,
          extracted_data: {
            patient: {
              name: patient.name,
              age: patient.age,
              sex: patient.sex,
              phone: patient.phone,
              fileNo: patient.fileNo,
            },
            doctor: conName,
            mo: useAuthStore.getState().moName,
            date: new Date().toISOString(),
            diagnoses: moData?.diagnoses || [],
            complications: moData?.complications || [],
            medications: conData.medications_confirmed || [],
            diet_lifestyle: conData.diet_lifestyle || [],
            self_monitoring: conData.self_monitoring || [],
            goals: conData.goals || [],
            follow_up: conData.follow_up || {},
            future_plan: conData.future_plan || [],
            chief_complaints: moData?.chief_complaints || [],
            assessment_summary: conData.assessment_summary || "",
            investigations: moData?.investigations || [],
            vitals: { ...vitals },
            plan_edits: planEdits,
          },
          doc_date: new Date().toISOString().split("T")[0],
          source: "scribe_print",
          notes: `Printed by ${currentDoctor?.name || conName}`,
          consultation_id: pfd?.consultations?.[0]?.id || null,
        };
        const resp = await api.post(`/api/patients/${dbPatientId}/documents`, planDoc);
        const saved = resp.data;
        if (saved.id) {
          console.log("Plan saved as document #" + saved.id);
          // Generate PDF from plan area and upload
          try {
            const planEl =
              document.querySelector("[data-plan-area]") || document.querySelector(".print-area");
            if (planEl) {
              // Dynamically load html2pdf.js from CDN
              if (!window.html2pdf) {
                await new Promise((resolve, reject) => {
                  const script = document.createElement("script");
                  script.src =
                    "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
                  script.onload = resolve;
                  script.onerror = reject;
                  document.head.appendChild(script);
                });
              }
              const pdfBlob = await window
                .html2pdf()
                .set({
                  margin: [8, 8, 8, 8],
                  filename: `Treatment_Plan_${patient.name}_${new Date().toISOString().split("T")[0]}.pdf`,
                  image: { type: "jpeg", quality: 0.95 },
                  html2canvas: { scale: 2, useCORS: true, logging: false },
                  jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
                })
                .from(planEl)
                .outputPdf("blob");
              // Convert blob to base64
              const reader = new FileReader();
              const base64 = await new Promise((resolve) => {
                reader.onload = () => resolve(reader.result.split(",")[1]);
                reader.readAsDataURL(pdfBlob);
              });
              try {
                await api.post(`/api/documents/${saved.id}/upload-file`, {
                  base64,
                  mediaType: "application/pdf",
                  fileName: `Treatment_Plan_${patient.name}.pdf`,
                });
              } catch (e) {
                console.log("File upload failed:", e.response?.data?.error || e.message);
              }
              console.log("PDF uploaded for plan #" + saved.id);
            }
          } catch (pdfErr) {
            console.log("PDF generation:", pdfErr.message);
          }
        }
      } catch (e) {
        console.log("Plan save on print:", e.response?.data?.error || e.message);
      }
    }
    // Then print
    window.print();
  },

  buildMedicineSchedule: (planMeds, externalMeds, medRecon, conName) => {
    const allActiveMeds = [
      ...planMeds.map((m) => ({ ...m, prescriber: conName || "Gini", isGini: true })),
      ...externalMeds.filter((m) => medRecon[m.name] !== "stop" && medRecon[m.name] !== "hold"),
    ];
    // Deduplicate by name — prefer Gini version over external
    const seenExact = new Set();
    const dedupedMeds = [];
    // First pass: add all Gini meds
    allActiveMeds
      .filter((m) => m.isGini)
      .forEach((m) => {
        const key = (m.name || "").toUpperCase().replace(/\s+/g, "");
        seenExact.add(key);
        dedupedMeds.push(m);
      });
    // Second pass: add external meds only if not already covered by Gini
    allActiveMeds
      .filter((m) => !m.isGini)
      .forEach((m) => {
        const key = (m.name || "").toUpperCase().replace(/\s+/g, "");
        if (!seenExact.has(key)) {
          seenExact.add(key);
          dedupedMeds.push(m);
        }
      });

    const slots = [
      {
        id: "morning",
        label: "Morning",
        time: "7:00 AM",
        match: (t) =>
          /\b(morning|wake|6.?am|7.?am|8.?am|9.?am)\b/i.test(t) &&
          !/before.*break|30.*min/i.test(t),
      },
      {
        id: "beforeBreak",
        label: "Before Breakfast (30 min)",
        time: "7:30 AM",
        match: (t) =>
          /before.*break|30.*min.*before|empty.*stomach.*break|before.*meal.*morn/i.test(t),
      },
      {
        id: "afterBreak",
        label: "After Breakfast",
        time: "8:30 AM",
        match: (t) => /after.*break|after.*meal.*morn/i.test(t) && !/before/i.test(t),
      },
      {
        id: "afterLunch",
        label: "After Lunch",
        time: "1:30 PM",
        match: (t) => /after.*lunch|lunch|afternoon|1.*pm|2.*pm/i.test(t),
      },
      {
        id: "evening",
        label: "Evening",
        time: "5:00 PM",
        match: (t) => /\b(evening|5.?pm|SOS|as.?needed|repeat|fever)\b/i.test(t),
      },
      {
        id: "beforeDinner",
        label: "Before Dinner (30 min)",
        time: "7:30 PM",
        match: (t) => /before.*dinner|30.*min.*before.*dinner/i.test(t),
      },
      {
        id: "afterDinner",
        label: "After Dinner",
        time: "8:30 PM",
        match: (t) => /after.*dinner|after.*meal.*night/i.test(t),
      },
      {
        id: "bedtime",
        label: "Night / Bedtime",
        time: "10:00 PM",
        match: (t) =>
          /\b(night|HS|bedtime|bed|8.?pm|9.?pm|10.?pm|11.?pm|with.*milk|at.*bed)\b/i.test(t),
      },
      { id: "asDirected", label: "As Directed", time: "", match: () => false },
    ];

    // Helper: extract explicit clock time from timing string
    const getExplicitSlot = (timing) => {
      const s = (timing || "").toLowerCase();
      const m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
      if (!m) return null;
      let hr = parseInt(m[1]);
      const ampm = m[3].toLowerCase();
      if (ampm === "pm" && hr !== 12) hr += 12;
      if (ampm === "am" && hr === 12) hr = 0;
      if (hr >= 5 && hr < 10 && !/before.*break|30.*min/i.test(s)) return "morning";
      if (hr >= 10 && hr < 14) return "morning";
      if (hr >= 14 && hr < 17) return "afterLunch";
      if (hr >= 17 && hr < 19) return "evening";
      if (hr >= 19 && hr <= 23) return "bedtime";
      return null;
    };

    const schedule = slots.map((s) => ({ ...s, meds: [] }));
    dedupedMeds.forEach((m) => {
      const timing = (m.timing || "").trim();
      const freq = (m.frequency || "").trim();
      const t = `${timing} ${freq}`.trim();
      let placed = false;

      // 1. Explicit time
      const explicitSlot = getExplicitSlot(timing);
      if (explicitSlot) {
        schedule.find((s) => s.id === explicitSlot)?.meds.push(m);
        placed = true;
      }

      // 2. BD with before breakfast AND dinner
      if (
        !placed &&
        /\bBD\b/i.test(freq) &&
        /before.*break/i.test(timing) &&
        /dinner|evening|night/i.test(timing)
      ) {
        schedule.find((s) => s.id === "beforeBreak")?.meds.push(m);
        schedule.find((s) => s.id === "beforeDinner")?.meds.push(m);
        placed = true;
      }

      // 3. Before breakfast only / 30 min before (OD)
      if (!placed && /before.*break|30.*min.*before|before.*meal.*morn/i.test(t)) {
        schedule.find((s) => s.id === "beforeBreak")?.meds.push(m);
        placed = true;
      }

      // 4. BD = after breakfast + after dinner
      if (!placed && /\bBD\b/i.test(freq) && !/TDS/i.test(freq)) {
        schedule.find((s) => s.id === "afterBreak")?.meds.push(m);
        schedule.find((s) => s.id === "afterDinner")?.meds.push(m);
        placed = true;
      }

      // 5. TDS = after breakfast + after lunch + after dinner
      if (!placed && /\bTDS\b/i.test(freq)) {
        schedule.find((s) => s.id === "afterBreak")?.meds.push(m);
        schedule.find((s) => s.id === "afterLunch")?.meds.push(m);
        schedule.find((s) => s.id === "afterDinner")?.meds.push(m);
        placed = true;
      }

      // 6. Keyword matching
      if (!placed) {
        for (const slot of schedule) {
          if (slot.match(timing)) {
            slot.meds.push(m);
            placed = true;
            break;
          }
        }
      }

      // 7. Fallback: OD = morning, else As Directed
      if (!placed) {
        if (/\bOD\b/i.test(freq) || /\bOD\b/i.test(timing))
          schedule.find((s) => s.id === "morning")?.meds.push(m);
        else schedule.find((s) => s.id === "asDirected")?.meds.push(m);
      }
    });
    return schedule.filter((s) => s.meds.length > 0);
  },

  // ── computed helpers (call these as functions, passing current moData/conData) ──

  getPlanDiags: (moData) => {
    const { planEdits } = get();
    return sa(moData, "diagnoses").filter((_, i) => !(planEdits._removedDiags || []).includes(i));
  },

  getPlanMeds: (allMeds) => {
    const { planEdits } = get();
    return allMeds.filter((_, i) => !(planEdits._removedMeds || []).includes(i));
  },

  getPlanLifestyle: (conData) => {
    const { planEdits } = get();
    return sa(conData, "diet_lifestyle").filter(
      (_, i) => !(planEdits._removedLifestyle || []).includes(i),
    );
  },

  getPlanGoals: (conData) => {
    const { planEdits } = get();
    return sa(conData, "goals").filter((_, i) => !(planEdits._removedGoals || []).includes(i));
  },

  getPlanMonitors: (conData) => {
    const { planEdits } = get();
    return sa(conData, "self_monitoring").filter(
      (_, i) => !(planEdits._removedMonitors || []).includes(i),
    );
  },

  getPlanFuture: (conData) => {
    const { planEdits } = get();
    return sa(conData, "future_plan").filter(
      (_, i) => !(planEdits._removedFuture || []).includes(i),
    );
  },

  getAllMeds: (conData, moData, clarifications) => {
    return [
      ...(sa(conData, "medications_confirmed").length > 0
        ? sa(conData, "medications_confirmed")
        : sa(moData, "previous_medications").map((m) => ({
            ...m,
            isNew: false,
            route: m.route || "Oral",
          }))),
      ...sa(conData, "medications_needs_clarification")
        .map((m, i) => {
          const c = clarifications[i] || {};
          return c.resolved_name
            ? {
                ...m,
                name: c.resolved_name,
                dose: c.resolved_dose || m.default_dose || "",
                frequency: c.resolved_freq || "OD",
                timing: c.resolved_timing || m.default_timing || "",
                resolved: true,
                isNew: true,
              }
            : null;
        })
        .filter(Boolean),
    ];
  },

  getExternalMeds: (pfd, moData, conData, conName) => {
    const meds = pfd?.medications || [];
    if (meds.length === 0) {
      return sa(moData, "previous_medications").map((m) => ({
        ...m,
        prescriber: "Previous",
        isNew: false,
        route: m.route || "Oral",
      }));
    }
    const currentDoc = conName || pfd?.consultations?.[0]?.con_name || "";
    const planMedNames = new Set(
      sa(conData, "medications_confirmed").map((m) =>
        (m.name || "").toUpperCase().replace(/\s+/g, ""),
      ),
    );
    const seen = new Set();
    return meds
      .filter((m) => {
        const key = (m.name || "").toUpperCase().replace(/\s+/g, "");
        if (seen.has(key)) return false;
        seen.add(key);
        if (m.is_active === false) return false;
        if (planMedNames.has(key)) return false;
        const medDoctor = m.prescriber || m.con_name || "";
        if (currentDoc && medDoctor === currentDoc) return false;
        return true;
      })
      .map((m) => ({
        name: m.name || m.pharmacy_match || "",
        composition: m.composition || "",
        dose: m.dose || "",
        frequency: m.frequency || "",
        timing: m.timing || "",
        route: m.route || "Oral",
        isNew: m.is_new || false,
        forDiagnosis: m.for_diagnosis ? [m.for_diagnosis] : [],
        prescriber: m.prescriber || m.con_name || "External",
        specialty: "",
        hospital: "",
        visitDate: m.prescribed_date || m.started_date || m.created_at || "",
        consultationId: m.consultation_id,
      }));
  },

  getExternalMedsByDoctor: (pfd) => {
    const meds = pfd?.medications || [];
    if (meds.length === 0) return [];
    const grouped = {};
    meds
      .filter((m) => m.is_active !== false)
      .forEach((m) => {
        const raw = m.prescriber || m.con_name || "Unknown";
        const specMatch = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
        const doctor = specMatch ? specMatch[1].trim() : raw;
        const specialty = specMatch ? specMatch[2].trim() : "";
        const key = doctor;
        if (!grouped[key])
          grouped[key] = {
            doctor,
            specialty,
            hospital: "",
            date: m.prescribed_date || m.created_at,
            meds: [],
          };
        const medKey = (m.name || "").toUpperCase().replace(/\s+/g, "");
        if (
          !grouped[key].meds.some(
            (em) => (em.name || "").toUpperCase().replace(/\s+/g, "") === medKey,
          )
        ) {
          grouped[key].meds.push({
            name: m.name || "",
            composition: m.composition || "",
            dose: m.dose || "",
            frequency: m.frequency || "",
            timing: m.timing || "",
            route: m.route || "Oral",
            isNew: m.is_new || false,
            prescriber: raw,
            visitDate: m.prescribed_date || m.created_at || "",
          });
        }
        if (m.prescribed_date && (!grouped[key].date || m.prescribed_date > grouped[key].date))
          grouped[key].date = m.prescribed_date;
        if (specialty && !grouped[key].specialty) grouped[key].specialty = specialty;
      });
    return Object.values(grouped).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  },
}));

export default usePlanStore;
