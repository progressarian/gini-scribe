import { create } from "zustand";
import { callClaude } from "../services/api.js";
import { CONDITIONS } from "../config/conditions.js";
import { EXAM_SECTIONS } from "../config/exam.js";
import { CONDITION_CHIPS } from "../config/chips.js";
import { ts } from "../config/constants.js";
import usePatientStore from "./patientStore.js";
import useVitalsStore from "./vitalsStore.js";
import useVisitStore from "./visitStore.js";
import useLabStore from "./labStore.js";

const useExamStore = create((set, get) => ({
  // ── Exam state ──
  examSpecialty: "General",
  examData: {},
  examOpen: null,
  examNotes: "",

  // ── Assess state ──
  assessDx: [],
  assessLabs: [],
  assessNotes: "",

  // ── Shadow AI state ──
  shadowAI: false,
  shadowData: null,
  shadowOriginal: null,
  shadowTxDecisions: {},
  shadowLoading: false,
  showShadow: false,
  showShadowDiff: false,

  // ── History (Hx) state ──
  hxConditions: [],
  hxCondData: {},
  hxSurgeries: [],
  hxSurgText: "",
  hxAllergies: [],
  hxAllergyText: "",
  hxFamilyHx: {
    dm: false,
    htn: false,
    cardiac: false,
    thyroid: false,
    cancer: false,
    ckd: false,
    obesity: false,
    notes: "",
  },
  hxHospitalizations: [],
  hxHospText: "",

  // ── Dx search state ──
  dxSearch: "",
  aiDxSuggestions: [],

  // ── simple setters ──
  setExamSpecialty: (val) => set({ examSpecialty: val }),
  setExamData: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ examData: valOrFn(state.examData) }));
    } else {
      set({ examData: valOrFn });
    }
  },
  setExamOpen: (val) => set({ examOpen: val }),
  setExamNotes: (val) => set({ examNotes: val }),
  setAssessDx: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ assessDx: valOrFn(state.assessDx) }));
    } else {
      set({ assessDx: valOrFn });
    }
  },
  setAssessLabs: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ assessLabs: valOrFn(state.assessLabs) }));
    } else {
      set({ assessLabs: valOrFn });
    }
  },
  setAssessNotes: (val) => set({ assessNotes: val }),
  setShadowAI: (val) => set({ shadowAI: val }),
  setShadowData: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ shadowData: valOrFn(state.shadowData) }));
    } else {
      set({ shadowData: valOrFn });
    }
  },
  setShadowOriginal: (val) => set({ shadowOriginal: val }),
  setShadowTxDecisions: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ shadowTxDecisions: valOrFn(state.shadowTxDecisions) }));
    } else {
      set({ shadowTxDecisions: valOrFn });
    }
  },
  setShadowLoading: (val) => set({ shadowLoading: val }),
  setShowShadow: (val) => set({ showShadow: val }),
  setShowShadowDiff: (val) => set({ showShadowDiff: val }),
  setHxConditions: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ hxConditions: valOrFn(state.hxConditions) }));
    } else {
      set({ hxConditions: valOrFn });
    }
  },
  setHxCondData: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ hxCondData: valOrFn(state.hxCondData) }));
    } else {
      set({ hxCondData: valOrFn });
    }
  },
  setHxSurgeries: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ hxSurgeries: valOrFn(state.hxSurgeries) }));
    } else {
      set({ hxSurgeries: valOrFn });
    }
  },
  setHxSurgText: (val) => set({ hxSurgText: val }),
  setHxAllergies: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ hxAllergies: valOrFn(state.hxAllergies) }));
    } else {
      set({ hxAllergies: valOrFn });
    }
  },
  setHxAllergyText: (val) => set({ hxAllergyText: val }),
  setHxFamilyHx: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ hxFamilyHx: valOrFn(state.hxFamilyHx) }));
    } else {
      set({ hxFamilyHx: valOrFn });
    }
  },
  setHxHospitalizations: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ hxHospitalizations: valOrFn(state.hxHospitalizations) }));
    } else {
      set({ hxHospitalizations: valOrFn });
    }
  },
  setHxHospText: (val) => set({ hxHospText: val }),
  setDxSearch: (val) => set({ dxSearch: val }),
  setAiDxSuggestions: (val) => set({ aiDxSuggestions: val }),

  // ── actions ──

  toggleExamFinding: (sectionId, finding) => {
    const key = sectionId + "_v";
    set((state) => {
      const cur = state.examData[key] || [];
      return {
        examData: {
          ...state.examData,
          [key]: cur.includes(finding) ? cur.filter((x) => x !== finding) : [...cur, finding],
        },
      };
    });
  },

  toggleExamNAD: (sectionId) => {
    const key = sectionId + "_n";
    set((state) => ({
      examData: { ...state.examData, [key]: !state.examData[key] },
    }));
  },

  markAllNAD: () => {
    const { examSpecialty, examData } = get();
    const sections = EXAM_SECTIONS[examSpecialty] || [];
    const updates = {};
    sections.forEach((s) => {
      if (!(examData[s.id + "_v"] || []).length) updates[s.id + "_n"] = true;
    });
    set({ examData: { ...examData, ...updates } });
  },

  getExamSummary: () => {
    const { examData, examNotes } = get();
    const parts = [];
    Object.entries(EXAM_SECTIONS).forEach(([sp, sections]) => {
      sections.forEach((s) => {
        const vals = examData[s.id + "_v"] || [];
        const nad = examData[s.id + "_n"];
        if (vals.length > 0) parts.push(`${s.l}: ${vals.join(", ")}`);
        else if (nad) parts.push(`${s.l}: NAD`);
      });
    });
    if (examNotes) parts.push(`Notes: ${examNotes}`);
    return parts.join(". ");
  },

  toggleHxCond: (name) => {
    set((state) => ({
      hxConditions: state.hxConditions.includes(name)
        ? state.hxConditions.filter((c) => c !== name)
        : [...state.hxConditions, name],
    }));
  },

  updHxCond: (cond, field, val) => {
    set((state) => ({
      hxCondData: {
        ...state.hxCondData,
        [cond]: { ...(state.hxCondData[cond] || {}), [field]: val },
      },
    }));
  },

  togHxMulti: (cond, field, opt) => {
    const { hxCondData } = get();
    const cur = hxCondData[cond]?.[field] || [];
    get().updHxCond(cond, field, cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]);
  },

  autoDetectDiagnoses: () => {
    const { vitals } = useVitalsStore.getState();
    const { labData } = useLabStore.getState();
    if (!labData?.panels) return;
    const allTests = labData.panels.flatMap((p) => p.tests);
    const suggestions = [];
    Object.entries(CONDITIONS).forEach(([name, tmpl]) => {
      if (name === "Other") return;
      for (const rule of tmpl.autoDetect || []) {
        // Check lab tests
        const match = allTests.find((t) => {
          const tName = (t.test_name || "").toLowerCase();
          return tName.includes(rule.test.toLowerCase());
        });
        if (match) {
          const numVal = parseFloat(match.result);
          if (!isNaN(numVal)) {
            if ((rule.op === ">" && numVal > rule.val) || (rule.op === "<" && numVal < rule.val)) {
              suggestions.push({
                name,
                test: match.test_name,
                value: `${match.result} ${match.unit || ""}`,
                flag: match.flag,
                reason: `${match.test_name} ${match.result} (ref: ${rule.op}${rule.val})`,
              });
            }
          }
        }
        // Check vitals
        if (rule.vitalKey && vitals[rule.vitalKey]) {
          const numVal = parseFloat(vitals[rule.vitalKey]);
          if (
            !isNaN(numVal) &&
            ((rule.op === ">" && numVal > rule.val) || (rule.op === "<" && numVal < rule.val))
          ) {
            suggestions.push({
              name,
              test: rule.test,
              value: vitals[rule.vitalKey],
              flag: "H",
              reason: `${rule.test} ${vitals[rule.vitalKey]}`,
            });
          }
        }
      }
    });
    // Deduplicate by condition name
    const unique = [...new Map(suggestions.map((s) => [s.name, s])).values()];
    set({ aiDxSuggestions: unique });
    return unique;
  },

  getBiomarkerValues: (condName) => {
    const { labData } = useLabStore.getState();
    const tmpl = CONDITIONS[condName];
    if (!tmpl || !labData?.panels) return [];
    const allTests = labData.panels.flatMap((p) => p.tests);
    return tmpl.biomarkers.map((bm) => {
      const match = allTests.find((t) =>
        (t.test_name || "").toLowerCase().includes(bm.toLowerCase()),
      );
      return {
        name: bm,
        found: !!match,
        value: match ? `${match.result}${match.unit ? " " + match.unit : ""}` : null,
        flag: match?.flag || null,
      };
    });
  },

  getMissingBiomarkers: () => {
    const { hxConditions } = get();
    const { labData } = useLabStore.getState();
    const allTests =
      labData?.panels?.flatMap((p) => p.tests.map((t) => (t.test_name || "").toLowerCase())) || [];
    const missing = [];
    hxConditions.forEach((cond) => {
      const tmpl = CONDITIONS[cond];
      if (!tmpl) return;
      tmpl.biomarkers.forEach((bm) => {
        if (!allTests.some((t) => t.includes(bm.toLowerCase()))) {
          missing.push({ test: bm, forCondition: cond });
        }
      });
    });
    return [...new Map(missing.map((m) => [m.test, m])).values()];
  },

  runShadowAI: async () => {
    set({ shadowLoading: true });
    const { assessDx, assessNotes, hxFamilyHx } = get();
    const { complaints, fuChecks, fuExtMeds, fuNewConditions } = useVisitStore.getState();
    const { vitals } = useVitalsStore.getState();
    const { patientFullData } = usePatientStore.getState();
    const examSummary = get().getExamSummary();
    const { labData } = useLabStore.getState();
    // Build pfd reference
    const pfd = patientFullData;

    const parts = [];
    if (complaints.length) parts.push("Chief Complaints: " + complaints.join(", "));
    if (examSummary) parts.push("Examination: " + examSummary);
    if (assessDx.length) {
      const dxLabels = assessDx.map((id) => CONDITION_CHIPS.find((c) => c.id === id)?.l || id);
      parts.push("Diagnoses: " + dxLabels.join(", "));
    }
    if (assessNotes) parts.push("Notes: " + assessNotes);
    if (vitals.bp_sys)
      parts.push(
        `Vitals: BP ${vitals.bp_sys}/${vitals.bp_dia}, Pulse ${vitals.pulse}, SpO2 ${vitals.spo2}, Wt ${vitals.weight}kg, BMI ${vitals.bmi}`,
      );
    if (labData?.panels) {
      const tests = labData.panels.flatMap((p) =>
        p.tests.map(
          (t) =>
            `${t.test_name}: ${t.result_text || t.result} ${t.unit || ""} ${t.flag === "H" ? "[HIGH]" : t.flag === "L" ? "[LOW]" : ""}`,
        ),
      );
      parts.push("Labs: " + tests.join(", "));
    }
    // Previous meds from brief
    if (patientFullData?.medications?.length) {
      parts.push(
        "Current Medications: " +
          patientFullData.medications
            .slice(0, 15)
            .map((m) => `${m.name} ${m.dose || ""} ${m.frequency || ""}`)
            .join(", "),
      );
    }
    // Follow-up context for shadow
    if (pfd?.consultations?.length > 0) {
      const fuParts = [];
      if (fuChecks.medCompliance) fuParts.push(`Med Compliance: ${fuChecks.medCompliance}`);
      if (fuChecks.dietExercise) fuParts.push(`Diet/Exercise: ${fuChecks.dietExercise}`);
      if (fuChecks.sideEffects) fuParts.push(`Side Effects: ${fuChecks.sideEffects}`);
      if (fuChecks.newSymptoms) fuParts.push(`New Symptoms: ${fuChecks.newSymptoms}`);
      if (fuChecks.challenges) fuParts.push(`Challenges: ${fuChecks.challenges}`);
      if (fuParts.length) parts.push("Follow-up Assessment: " + fuParts.join(", "));
      if (fuExtMeds.length)
        parts.push(
          "New external medicines: " +
            fuExtMeds
              .map((m) => `${m.name} ${m.dose} ${m.doctor ? `(from ${m.doctor})` : ""}`)
              .join(", "),
        );
      if (fuNewConditions.length) parts.push("New conditions: " + fuNewConditions.join(", "));
    }
    const shadowPrompt = `You are an endocrinology AI assistant. Given the clinical data below, provide:
1. DIAGNOSES: List each diagnosis with status (Controlled/Uncontrolled/New) and brief reasoning
2. TREATMENT_PLAN: For each medication suggest ADD/CONTINUE/MODIFY/STOP with brief reason
3. INVESTIGATIONS: Tests you'd order with reason
4. RED_FLAGS: Any urgent concerns

CRITICAL CLASSIFICATION RULES:
- Type 2 DM: HbA1c < 7% = "Controlled", HbA1c 7-8% = "Uncontrolled", HbA1c > 8% = "Uncontrolled" (severely)
- Hypertension: BP < 130/80 = "Controlled"
- Dyslipidemia: LDL at target for risk category = "Controlled"
- Do NOT mark a condition as "Uncontrolled" if the key biomarker is within accepted target range

Respond as JSON: {"diagnoses":[{"label":"...","status":"...","reason":"..."}],"treatment_plan":[{"action":"ADD|CONTINUE|MODIFY|STOP","drug":"...","detail":"...","reason":"..."}],"investigations":["..."],"red_flags":["..."]}

CLINICAL DATA:
${parts.join("\n")}`;
    try {
      const { data, error } = await callClaude(
        shadowPrompt,
        "Analyze this patient and provide your independent clinical assessment.",
      );
      if (data) {
        set({ shadowData: data, shadowAI: true });
      }
    } catch (e) {
      console.error("Shadow AI:", e);
    }
    set({ shadowLoading: false });
  },

  // Create plan from shadow AI
  // Returns the built conData so the caller can pass it to clinicalStore.setConData
  createPlanFromShadow: (setTab, setConData) => {
    const { shadowData, shadowTxDecisions } = get();
    const { patient } = usePatientStore.getState();
    if (!shadowData) return null;
    // Save original for diff comparison
    set({ shadowOriginal: JSON.parse(JSON.stringify(shadowData)) });
    // Build conData from shadow AI
    const adopted = (shadowData.treatment_plan || []).filter((t) => {
      const key = t.drug || `tx_${(shadowData.treatment_plan || []).indexOf(t)}`;
      return shadowTxDecisions[key] !== "disagree";
    });
    const newConData = {
      assessment_summary: `${patient.name}: ${(shadowData.diagnoses || []).map((d) => `${d.label} (${d.status})`).join(", ")}. ${(shadowData.red_flags || []).length > 0 ? shadowData.red_flags[0] : ""}`,
      key_issues: (shadowData.diagnoses || []).map((d) => `${d.label} — ${d.status}: ${d.reason}`),
      medications_confirmed: adopted
        .filter((t) => t.action !== "STOP")
        .map((t) => ({
          name: (t.drug || "").toUpperCase(),
          composition: t.drug || "",
          dose: t.dose || t.detail || "",
          frequency: t.frequency || "OD",
          timing: t.timing || "Morning",
          route: "Oral",
          forDiagnosis: t.forDiagnosis || [],
          isNew: t.action === "ADD",
          _shadowAction: t.action,
          _shadowReason: t.reason,
        })),
      medications_stopped: adopted
        .filter((t) => t.action === "STOP")
        .map((t) => ({
          name: (t.drug || "").toUpperCase(),
          reason: t.reason || "",
        })),
      investigations_ordered: (shadowData.investigations || []).map(ts),
      diet_lifestyle: [],
      follow_up: {
        duration: "6 weeks",
        tests_to_bring: (shadowData.investigations || []).slice(0, 5).map(ts),
      },
      goals: [],
      self_monitoring: [],
      future_plan: [],
      _fromShadow: true,
    };
    // Set conData via provided setter (avoids circular import with clinicalStore)
    if (setConData) setConData(newConData);
    if (setTab) setTab("plan");
    return newConData;
  },

  // Edit shadow AI suggestion inline
  editShadowItem: (section, index, field, value) => {
    set((state) => {
      const updated = { ...state.shadowData };
      if (updated[section]?.[index]) {
        updated[section] = [...updated[section]];
        updated[section][index] = { ...updated[section][index], [field]: value };
      }
      return { shadowData: updated };
    });
  },

  addShadowItem: (section, item) => {
    set((state) => ({
      shadowData: { ...state.shadowData, [section]: [...(state.shadowData[section] || []), item] },
    }));
  },

  removeShadowItem: (section, index) => {
    set((state) => ({
      shadowData: {
        ...state.shadowData,
        [section]: (state.shadowData[section] || []).filter((_, i) => i !== index),
      },
    }));
  },

  // Reset all exam/assess/hx state
  resetExam: () => {
    set({
      examSpecialty: "General",
      examData: {},
      examOpen: null,
      examNotes: "",
      assessDx: [],
      assessLabs: [],
      assessNotes: "",
      shadowAI: false,
      shadowData: null,
      shadowOriginal: null,
      shadowTxDecisions: {},
      shadowLoading: false,
      showShadow: false,
      showShadowDiff: false,
      hxConditions: [],
      hxCondData: {},
      hxSurgeries: [],
      hxSurgText: "",
      hxAllergies: [],
      hxAllergyText: "",
      hxFamilyHx: {
        dm: false,
        htn: false,
        cardiac: false,
        thyroid: false,
        cancer: false,
        ckd: false,
        obesity: false,
        notes: "",
      },
      hxHospitalizations: [],
      hxHospText: "",
      dxSearch: "",
      aiDxSuggestions: [],
    });
  },
}));

export default useExamStore;
