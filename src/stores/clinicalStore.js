import { create } from "zustand";
import { callClaude, callClaudeFast } from "../services/api.js";
import {
  MO_PROMPT,
  CONSULTANT_PROMPT,
  QUICK_EXTRACT_PROMPT,
  QUICK_PLAN_PROMPT,
} from "../config/prompts.js";
import { fixMoMedicines, fixConMedicines } from "../medmatch.js";
import { sa, ts } from "../config/constants.js";
import useAuthStore from "./authStore.js";
import usePatientStore from "./patientStore.js";
import useVitalsStore from "./vitalsStore.js";
import useUiStore from "./uiStore.js";
import useVisitStore from "./visitStore.js";
import useExamStore from "./examStore.js";
import useLabStore from "./labStore.js";
import { getDxStatusFromBiomarkers } from "../components/visit/helpers.jsx";

// Helper: Merge qualifiers like "Young onset" into diagnosis labels (e.g., "Type 2 DM (Young onset)")
function mergeQualifiersIntoDiagnoses(diagnoses) {
  if (!diagnoses?.length) return diagnoses;

  // Pattern for labels like "Young Onset Type 2 DM" → extract qualifier + base condition
  const qualifierInLabelPattern =
    /(young\s*onset|juvenile|early\s*onset|late\s*onset|new\s*onset)\s+(.+)/i;

  const result = [];
  const processed = new Set();

  diagnoses.forEach((d) => {
    const label = d.label || "";
    const match = label.match(qualifierInLabelPattern);

    if (match) {
      // This is a label like "Young Onset Type 2 DM" — extract qualifier + base
      const qualifier = match[1].trim();
      const baseCondition = match[2].trim();

      // Find matching main diagnosis (e.g., "Type 2 DM")
      const mainDx = diagnoses.find((main) => {
        const mainLabel = (main.label || "").toLowerCase();
        const baseLower = baseCondition.toLowerCase();
        return mainLabel === baseLower || mainLabel.includes(baseLower);
      });

      if (mainDx && !processed.has(mainDx.diagnosis_id || mainDx.label)) {
        // Merge qualifier into main diagnosis label
        result.push({
          ...mainDx,
          label: `${mainDx.label} (${qualifier})`,
        });
        processed.add(mainDx.diagnosis_id || mainDx.label);
        processed.add(d.diagnosis_id || d.label); // Mark this entry as merged
      } else if (!processed.has(d.diagnosis_id || d.label)) {
        result.push(d);
        processed.add(d.diagnosis_id || d.label);
      }
    } else if (!processed.has(d.diagnosis_id || d.label)) {
      result.push(d);
      processed.add(d.diagnosis_id || d.label);
    }
  });

  return result;
}

// Helper: Sync diagnosis status from biomarker values (only if biomarkers available)
function syncDxStatusFromBiomarkers(diagnoses, labResults) {
  if (!diagnoses?.length || !labResults?.length) return diagnoses;

  return diagnoses.map((dx) => {
    const bioStatus = getDxStatusFromBiomarkers(dx.diagnosis_id || dx.id, labResults);
    // Only override status if biomarker logic returns a result and status differs
    if (bioStatus && bioStatus !== dx.status) {
      return { ...dx, status: bioStatus };
    }
    return dx;
  });
}

const useClinicalStore = create((set, get) => ({
  // ── state ──
  moTranscript: "",
  conTranscript: "",
  moData: null,
  conData: null,
  moBrief: null,
  moBriefLoading: false,
  quickTranscript: "",
  quickMode: false,
  quickProgress: "",
  conPasteMode: false,
  conPasteText: "",
  conSourceMode: "merge",
  planCopied: false,
  clarifications: {},

  // ── simple setters ──
  setMoTranscript: (val) => set({ moTranscript: val }),
  setConTranscript: (val) => set({ conTranscript: val }),
  setMoData: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ moData: valOrFn(state.moData) }));
    } else {
      set({ moData: valOrFn });
    }
  },
  setConData: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ conData: valOrFn(state.conData) }));
    } else {
      set({ conData: valOrFn });
    }
  },
  setMoBrief: (val) => set({ moBrief: val }),
  setMoBriefLoading: (val) => set({ moBriefLoading: val }),
  setQuickTranscript: (val) => set({ quickTranscript: val }),
  setQuickMode: (val) => set({ quickMode: val }),
  setQuickProgress: (val) => set({ quickProgress: val }),
  setConPasteMode: (val) => set({ conPasteMode: val }),
  setConPasteText: (val) => set({ conPasteText: val }),
  setConSourceMode: (val) => set({ conSourceMode: val }),
  setPlanCopied: (val) => set({ planCopied: val }),
  setClarifications: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ clarifications: valOrFn(state.clarifications) }));
    } else {
      set({ clarifications: valOrFn });
    }
  },

  // ── actions ──

  processMO: async (overrideTranscript) => {
    const { moTranscript } = get();
    const txt = overrideTranscript || moTranscript;
    if (!txt) return;
    const { setLoading, clearErr, setErrors } = useUiStore.getState();
    const { vitals } = useVitalsStore.getState();
    const { patientFullData } = usePatientStore.getState();
    const { fuChecks, fuExtMeds, fuNewConditions } = useVisitStore.getState();
    setLoading((p) => ({ ...p, mo: true }));
    clearErr("mo");
    // Access labData from labStore via cross-store
    const { labData } = useLabStore.getState();
    let extra = "";
    if (labData?.panels) {
      const tests = labData.panels.flatMap((p) =>
        p.tests.map(
          (t) =>
            `${t.test_name}: ${t.result_text || t.result} ${t.unit || ""} ${t.flag === "H" ? "[HIGH]" : t.flag === "L" ? "[LOW]" : ""}`,
        ),
      );
      extra = `\n\nLAB RESULTS:\n${tests.join("\n")}`;
    }
    if (vitals.bp_sys)
      extra += `\nVITALS: BP ${vitals.bp_sys}/${vitals.bp_dia}, Pulse ${vitals.pulse}, SpO2 ${vitals.spo2}%, Wt ${vitals.weight}kg, BMI ${vitals.bmi}`;
    // Follow-up context
    const pfd = patientFullData;
    if (pfd?.consultations?.length > 0) {
      extra += `\n\nFOLLOW-UP VISIT CONTEXT:`;
      if (fuChecks.medCompliance) extra += `\nMedication Compliance: ${fuChecks.medCompliance}`;
      if (fuChecks.dietExercise) extra += `\nDiet/Exercise Adherence: ${fuChecks.dietExercise}`;
      if (fuChecks.sideEffects) extra += `\nSide Effects: ${fuChecks.sideEffects}`;
      if (fuChecks.newSymptoms) extra += `\nNew Symptoms: ${fuChecks.newSymptoms}`;
      if (fuChecks.challenges) extra += `\nChallenges: ${fuChecks.challenges}`;
      const uniqueDx = [
        ...new Map((pfd.diagnoses || []).map((d) => [d.diagnosis_id || d.label, d])).values(),
      ];
      if (uniqueDx.length)
        extra += `\nKnown Diagnoses: ${uniqueDx.map((d) => `${d.label} (${d.status})`).join(", ")}`;
      if (fuExtMeds.length)
        extra += `\nNew external medicines: ${fuExtMeds.map((m) => `${m.name} ${m.dose} ${m.doctor ? `(from ${m.doctor})` : ""}`).join(", ")}`;
      if (fuNewConditions.length)
        extra += `\nNew conditions since last visit: ${fuNewConditions.join(", ")}`;
      const lastCon = pfd.consultations[0];
      const { conData } = get();
      const lastGoals = conData?.goals || lastCon?.con_data?.goals || [];
      if (lastGoals.length)
        extra += `\nPrevious Goals: ${lastGoals.map((g) => `${g.marker}: ${g.current} -> target ${g.target}`).join(", ")}`;
    }
    // Add imaging findings context
    const imagingFiles = useLabStore.getState().imagingFiles || [];
    const extractedImaging = imagingFiles.filter((f) => f.data);
    if (extractedImaging.length > 0) {
      extra += `\n\nIMAGING REPORTS:\n${extractedImaging.map((f) => `${f.data.report_type}: ${f.data.impression || ""} ${(f.data.findings || []).map((fi) => `${fi.parameter}=${fi.value}${fi.unit || ""} (${fi.interpretation})`).join(", ")}`).join("\n")}`;
    }
    const { data, error } = await callClaude(MO_PROMPT, txt + extra);
    if (error) setErrors((p) => ({ ...p, mo: error }));
    else if (data) {
      const fixedData = fixMoMedicines(data);
      // Merge qualifiers like "Young onset" into diagnosis labels
      if (fixedData.diagnoses?.length) {
        fixedData.diagnoses = mergeQualifiersIntoDiagnoses(fixedData.diagnoses);
        // Sync diagnosis status from biomarker values (if labs are available)
        const labResults = useLabStore.getState().labData?.panels?.flatMap((p) => p.tests) || [];
        fixedData.diagnoses = syncDxStatusFromBiomarkers(fixedData.diagnoses, labResults);
      }
      set({ moData: fixedData });
    } else setErrors((p) => ({ ...p, mo: "No data returned" }));
    setLoading((p) => ({ ...p, mo: false }));
  },

  processConsultant: async () => {
    const { conTranscript, moData, conSourceMode } = get();
    if (!conTranscript) return;
    const { setLoading, clearErr, setErrors } = useUiStore.getState();
    const { vitals } = useVitalsStore.getState();
    const { shadowData, shadowTxDecisions } = useExamStore.getState();
    setLoading((p) => ({ ...p, con: true }));
    clearErr("con");
    // Include MO context so consultant can reference existing data
    let context = conTranscript;
    if (moData) {
      const diagList = sa(moData, "diagnoses")
        .map((d) => d.label)
        .join(", ");
      const medList = sa(moData, "previous_medications")
        .map((m) => `${m.name} ${m.dose}`)
        .join(", ");
      const invList = sa(moData, "investigations")
        .map((i) => `${i.test}: ${i.value}${i.unit}`)
        .join(", ");
      context += `\n\nPATIENT CONTEXT FROM MO:\nDiagnoses: ${diagList}\nPrevious Meds: ${medList}\nInvestigations: ${invList}`;
      if (vitals.bp_sys)
        context += `\nVitals: BP ${vitals.bp_sys}/${vitals.bp_dia}, Wt ${vitals.weight}kg, BMI ${vitals.bmi}`;
      // Add imaging findings
      const imagingFiles = useLabStore.getState().imagingFiles || [];
      const extractedImaging = imagingFiles.filter((f) => f.data);
      if (extractedImaging.length > 0) {
        context += `\nImaging: ${extractedImaging.map((f) => `${f.data.report_type}: ${f.data.impression || (f.data.findings || []).map((fi) => `${fi.parameter}=${fi.value}`).join(", ")}`).join("; ")}`;
      }
    }
    // MERGE MODE: Include adopted Shadow AI items as baseline
    if (conSourceMode === "merge" && shadowData) {
      const adopted = (shadowData.treatment_plan || []).filter((t) => {
        const key = t.drug || `tx_${(shadowData.treatment_plan || []).indexOf(t)}`;
        return shadowTxDecisions[key] !== "disagree";
      });
      const rejected = (shadowData.treatment_plan || []).filter((t) => {
        const key = t.drug || `tx_${(shadowData.treatment_plan || []).indexOf(t)}`;
        return shadowTxDecisions[key] === "disagree";
      });
      let shadowCtx = "\n\n═══ AI SHADOW ANALYSIS (adopted by consultant as baseline) ═══";
      shadowCtx += `\nDiagnoses: ${(shadowData.diagnoses || []).map((d) => `${d.label} (${d.status}) — ${d.reason}`).join("; ")}`;
      if (adopted.length > 0) {
        shadowCtx += `\nAdopted Treatment Plan:`;
        adopted.forEach((t) => {
          shadowCtx += `\n  ${t.action}: ${t.drug} ${t.dose || ""} ${t.frequency || ""} ${t.timing || ""} — ${t.reason || ""}`;
        });
      }
      if (rejected.length > 0) {
        shadowCtx += `\nRejected by consultant (DO NOT include):`;
        rejected.forEach((t) => {
          shadowCtx += `\n  ${t.action}: ${t.drug} — REJECTED`;
        });
      }
      if ((shadowData.investigations || []).length > 0) {
        shadowCtx += `\nSuggested investigations: ${shadowData.investigations.map(ts).join(", ")}`;
      }
      if ((shadowData.red_flags || []).length > 0) {
        shadowCtx += `\nRed flags: ${shadowData.red_flags.join("; ")}`;
      }
      shadowCtx += `\n\nIMPORTANT: The consultant's verbal notes OVERRIDE the AI baseline. If the consultant says "change insulin to bedtime" or "add vitamin D" or "stop the second statin", apply those changes to the AI baseline. The final output should be the MERGED result: AI baseline + consultant's modifications.`;
      shadowCtx += `\nIf consultant says "agree with AI" or doesn't mention specific changes, keep the AI recommendations as-is.`;
      shadowCtx += `\n═══ END AI CONTEXT ═══`;
      context += shadowCtx;
    }
    const { data, error } = await callClaude(CONSULTANT_PROMPT, context);
    if (error) setErrors((p) => ({ ...p, con: error }));
    else if (data) set({ conData: fixConMedicines(data) });
    else setErrors((p) => ({ ...p, con: "No data returned" }));
    setLoading((p) => ({ ...p, con: false }));
  },

  generateMOBrief: () => {
    const { patientFullData, patient } = usePatientStore.getState();
    const { vitals } = useVitalsStore.getState();
    const { moData, conData } = get();
    const briefData = patientFullData;
    if (!briefData) return null;

    const sortedCons = (briefData.consultations || []).sort((a, b) => {
      const d = new Date(b.visit_date) - new Date(a.visit_date);
      return d !== 0 ? d : new Date(b.created_at) - new Date(a.created_at);
    });
    const isFollowUp = sortedCons.length > 0;
    const lastVisit = sortedCons[0];

    // Current diagnoses
    const diags = briefData.diagnoses || [];
    const uniqueDiags = [];
    const seen = new Set();
    diags.forEach((d) => {
      if (!seen.has(d.diagnosis_id || d.label)) {
        seen.add(d.diagnosis_id || d.label);
        uniqueDiags.push(d);
      }
    });

    // Current medications (from most recent visit)
    const meds = (briefData.medications || []).filter((m) => {
      if (!lastVisit) return true;
      return m.consultation_id === lastVisit.id;
    });
    // If no meds from last visit, get all active meds
    const activeMeds = meds.length > 0 ? meds : (briefData.medications || []).slice(0, 15);

    // Vitals comparison
    const sortedVitals = (briefData.vitals || []).sort(
      (a, b) => new Date(b.recorded_at) - new Date(a.recorded_at),
    );
    const currentVitals = vitals.bp_sys ? vitals : sortedVitals[0];
    const prevVitals = sortedVitals.length > 1 ? sortedVitals[1] : null;

    // Lab trends — group by test, compare latest to previous
    const labsByTest = {};
    (briefData.lab_results || []).forEach((l) => {
      if (!labsByTest[l.test_name]) labsByTest[l.test_name] = [];
      labsByTest[l.test_name].push(l);
    });
    const labTrends = [];
    const keyTests = [
      "HbA1c",
      "Fasting Glucose",
      "FBS",
      "PPBS",
      "Post Prandial Glucose",
      "Creatinine",
      "eGFR",
      "EGFR",
      "Total Cholesterol",
      "LDL",
      "HDL",
      "Triglycerides",
      "TSH",
      "SGPT",
      "ALT",
      "SGOT",
      "AST",
      "Hemoglobin",
      "Hb",
      "UACR",
      "Microalbumin",
    ];
    Object.entries(labsByTest).forEach(([name, results]) => {
      const sorted = results.sort((a, b) => new Date(b.test_date) - new Date(a.test_date));
      const latest = sorted[0];
      const prev = sorted[1];
      if (!latest?.result) return;
      const isKey = keyTests.some((k) => name.toLowerCase().includes(k.toLowerCase()));
      if (!isKey && sorted.length < 2) return; // skip non-key single results
      const latestNum = parseFloat(latest.result);
      const prevNum = prev ? parseFloat(prev.result) : null;
      let trend = "stable";
      if (prevNum !== null && !isNaN(latestNum) && !isNaN(prevNum)) {
        const pctChange = ((latestNum - prevNum) / Math.abs(prevNum || 1)) * 100;
        if (pctChange > 10) trend = "worsening";
        else if (pctChange < -10) trend = "improving";
      }
      if (isKey || trend !== "stable") {
        labTrends.push({
          name,
          latest: latest.result,
          latestUnit: latest.unit || "",
          latestDate: latest.test_date,
          latestFlag: latest.flag,
          previous: prev?.result || null,
          prevDate: prev?.test_date || null,
          trend,
          isKey,
        });
      }
    });

    // New labs since last visit
    const lastDate = lastVisit?.visit_date ? String(lastVisit.visit_date).slice(0, 10) : null;
    const newLabs = lastDate
      ? (briefData.lab_results || []).filter(
          (l) => l.test_date && String(l.test_date).slice(0, 10) > lastDate,
        )
      : [];

    // Days since last visit
    const daysSince = lastVisit
      ? Math.round((Date.now() - new Date(lastVisit.visit_date)) / 86400000)
      : null;

    // Build brief text for reading out
    let briefText = "";
    if (isFollowUp) {
      briefText += `FOLLOW-UP PATIENT — ${patient.name}, ${patient.age}Y/${patient.sex}`;
      if (patient.fileNo) briefText += `, File #${patient.fileNo}`;
      briefText += `\n\n`;
      briefText += `KNOWN CONDITIONS: ${uniqueDiags.map((d) => `${d.label} (${d.status})`).join(", ") || "None recorded"}\n\n`;
      briefText += `LAST VISIT: ${lastVisit.visit_date ? new Date(lastVisit.visit_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "Unknown"} — ${daysSince} days ago`;
      if (lastVisit.con_name) briefText += ` — seen by ${lastVisit.con_name}`;
      briefText += `\n\n`;
      briefText += `CURRENT MEDICATIONS:\n${activeMeds.length ? activeMeds.map((m) => `  • ${m.name} ${m.dose || ""} ${m.timing || m.frequency || ""}`).join("\n") : "  None recorded"}\n\n`;

      // What's changed
      const improving = labTrends.filter((l) => l.trend === "improving");
      const worsening = labTrends.filter((l) => l.trend === "worsening");
      if (improving.length)
        briefText += `IMPROVING: ${improving.map((l) => `${l.name} ${l.previous}->${l.latest}${l.latestUnit}`).join(", ")}\n`;
      if (worsening.length)
        briefText += `WORSENING: ${worsening.map((l) => `${l.name} ${l.previous}->${l.latest}${l.latestUnit}`).join(", ")}\n`;
      if (newLabs.length)
        briefText += `\nNEW LABS (${newLabs.length}): ${[...new Set(newLabs.map((l) => l.test_name))].join(", ")}\n`;

      if (currentVitals?.bp_sys) {
        briefText += `\nTODAY'S VITALS: BP ${currentVitals.bp_sys}/${currentVitals.bp_dia}`;
        if (prevVitals?.bp_sys) briefText += ` (prev: ${prevVitals.bp_sys}/${prevVitals.bp_dia})`;
        if (currentVitals.weight) {
          briefText += `, Wt ${currentVitals.weight}kg`;
          if (prevVitals?.weight) {
            const d = (parseFloat(currentVitals.weight) - parseFloat(prevVitals.weight)).toFixed(1);
            if (d != 0) briefText += ` (${d > 0 ? "+" : ""}${d}kg)`;
          }
        }
        if (currentVitals.bmi) briefText += `, BMI ${currentVitals.bmi}`;
        briefText += `\n`;
      }
    } else {
      briefText += `NEW PATIENT — ${patient.name}, ${patient.age}Y/${patient.sex}`;
      if (patient.fileNo) briefText += `, File #${patient.fileNo}`;
      if (patient.address) briefText += `\nAddress: ${patient.address}`;
      briefText += `\n\n`;
      if (moData) {
        briefText += `CHIEF COMPLAINTS: ${(moData.chief_complaints || []).join(", ") || "—"}\n\n`;
        briefText += `DIAGNOSES: ${
          sa(moData, "diagnoses")
            .map((d) => `${d.label} (${d.status})`)
            .join(", ") || "To be determined"
        }\n\n`;
        briefText += `MEDICATIONS: ${
          sa(moData, "previous_medications")
            .map((m) => `${m.name} ${m.dose || ""}`)
            .join(", ") || "None"
        }\n\n`;
      }
      if (currentVitals?.bp_sys) {
        briefText += `VITALS: BP ${currentVitals.bp_sys}/${currentVitals.bp_dia}, Pulse ${currentVitals.pulse || "—"}, Wt ${currentVitals.weight || "—"}kg, BMI ${currentVitals.bmi || "—"}\n`;
      }
    }

    const result = {
      isFollowUp,
      daysSince,
      briefText,
      diagnoses: uniqueDiags,
      medications: activeMeds,
      labTrends,
      newLabs,
      improving: labTrends.filter((l) => l.trend === "improving"),
      worsening: labTrends.filter((l) => l.trend === "worsening"),
      currentVitals,
      prevVitals,
      lastVisit,
      totalVisits: sortedCons.length,
    };
    set({ moBrief: result });
    return result;
  },

  processQuickMode: async (transcript, setTab) => {
    set({ quickTranscript: transcript });
    const { setLoading, setErrors } = useUiStore.getState();
    setLoading((l) => ({ ...l, quick: true }));
    setErrors((e) => ({ ...e, quick: null }));
    set({ quickProgress: "Sending to AI (parallel mode)..." });
    const startTime = Date.now();
    try {
      // Run BOTH calls in parallel — each uses Haiku (3-5x faster than Sonnet)
      const [extractResult, planResult] = await Promise.all([
        (async () => {
          set({ quickProgress: "Extracting patient data..." });
          return await callClaudeFast(QUICK_EXTRACT_PROMPT, transcript, 3000);
        })(),
        (async () => {
          return await callClaudeFast(QUICK_PLAN_PROMPT, transcript, 4000);
        })(),
      ]);

      set({ quickProgress: "Building treatment plan..." });

      // Handle extract errors
      if (extractResult.error && planResult.error)
        throw new Error(`Extract: ${extractResult.error} | Plan: ${planResult.error}`);

      const extractData = extractResult.data || {};
      const planData = planResult.data || {};

      // Fill patient
      if (extractData.patient) {
        const p = extractData.patient;
        let age = p.age;
        if (p.dob && !age) {
          const dob = new Date(p.dob);
          if (!isNaN(dob))
            age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        }
        const { patient, setPatient } = usePatientStore.getState();
        setPatient({
          ...patient,
          name: p.name || patient.name,
          age: age || patient.age,
          sex: p.sex || patient.sex,
          phone: p.phone || patient.phone,
          fileNo: p.fileNo || patient.fileNo,
          dob: p.dob || patient.dob,
        });
      }

      // Fill vitals
      if (extractData.vitals) {
        const v = extractData.vitals;
        const { vitals, setVitals } = useVitalsStore.getState();
        const updated = {
          ...vitals,
          bp_sys: v.bp_sys || vitals.bp_sys,
          bp_dia: v.bp_dia || vitals.bp_dia,
          pulse: v.pulse || vitals.pulse,
          spo2: v.spo2 || vitals.spo2,
          weight: v.weight || vitals.weight,
          height: v.height || vitals.height,
        };
        if (v.weight && v.height) {
          const h = parseFloat(v.height) / 100;
          if (h > 0) updated.bmi = (parseFloat(v.weight) / (h * h)).toFixed(1);
        }
        setVitals(updated);
      }

      // Fill MO
      if (extractData.mo) set({ moData: fixMoMedicines(extractData.mo) });

      // Fill consultant — merge plan data as consultant
      if (planData) set({ conData: fixConMedicines(planData) });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      set({ quickProgress: `Done in ${elapsed}s` });
      if (setTab) setTab("plan");
    } catch (err) {
      setErrors((e) => ({ ...e, quick: err.message }));
      set({ quickProgress: "" });
    } finally {
      setLoading((l) => ({ ...l, quick: false }));
    }
  },

  handleClarification: (i, k, v) => {
    set((state) => ({
      clarifications: {
        ...state.clarifications,
        [i]: { ...(state.clarifications[i] || {}), [k]: v },
      },
    }));
  },

  // Load last prescription into consultant transcript
  copyLastRx: () => {
    const { patientFullData } = usePatientStore.getState();
    const lastCon = patientFullData?.consultations?.[0];
    if (!lastCon) return;
    // Build Rx text from last visit's stored data
    const lastMeds = patientFullData?.medications || [];
    const lastDiags = patientFullData?.diagnoses || [];
    let rxText = "PREVIOUS PRESCRIPTION (copied for editing):\n";
    if (lastDiags.length)
      rxText += `Diagnoses: ${lastDiags.map((d) => `${d.label} - ${d.status}`).join(", ")}\n`;
    if (lastMeds.length) {
      rxText += "Medications:\n";
      lastMeds.forEach((m) => {
        rxText += `- ${m.name} ${m.dose || ""} ${m.frequency || ""} ${m.timing || ""}\n`;
      });
    }
    if (lastCon.con_name) rxText += `Last seen by: ${lastCon.con_name}\n`;
    set({ conTranscript: rxText, conData: null });
  },

  // Paste Rx text and process through AI
  processPastedRx: () => {
    const { conPasteText } = get();
    if (!conPasteText.trim()) return;
    set({
      conTranscript: conPasteText,
      conData: null,
      conPasteMode: false,
      conPasteText: "",
    });
  },

  // Copy entire treatment plan as text
  copyPlanToClipboard: ({
    planDiags,
    planMeds,
    planGoals,
    planLifestyle,
    planMonitors,
    getPlan,
  } = {}) => {
    const { conData, moData } = get();
    const { patient } = usePatientStore.getState();
    const { conName } = useAuthStore.getState();

    let text = `GINI ADVANCED CARE HOSPITAL — Treatment Plan\n`;
    text += `Patient: ${patient.name} | ${patient.age}Y/${patient.sex} | ${patient.phone || ""} | ${patient.fileNo || ""}\n`;
    text += `Doctor: ${conName} | Date: ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}\n`;
    text += `${"─".repeat(50)}\n\n`;

    if (conData?.assessment_summary) {
      text += `SUMMARY:\n${getPlan ? getPlan("summary", conData.assessment_summary) : conData.assessment_summary}\n\n`;
    }
    const cc = (moData?.chief_complaints || []).filter(
      (c) =>
        !["no gmi", "no hypoglycemia", "routine follow-up"].some((s) =>
          String(c).toLowerCase().includes(s),
        ),
    );
    if (cc.length) text += `CHIEF COMPLAINTS: ${cc.join(", ")}\n\n`;

    if (planDiags?.length) {
      text += `DIAGNOSES:\n`;
      planDiags.forEach((d) => {
        text += `• ${d.label} — ${d.status}\n`;
      });
      text += `\n`;
    }
    if (planMeds?.length) {
      text += `MEDICATIONS:\n`;
      planMeds.forEach((m) => {
        text += `• ${m.name} | ${m.dose || ""} | ${m.frequency || ""} ${m.timing || ""} | For: ${(m.forDiagnosis || []).join(", ") || "—"}\n`;
      });
      text += `\n`;
    }
    if (planGoals?.length) {
      text += `GOALS:\n`;
      planGoals.forEach((g) => {
        text += `• ${g.marker}: ${g.current || ""} -> ${g.target || ""} (${g.timeline || ""})\n`;
      });
      text += `\n`;
    }
    if (planLifestyle?.length) {
      text += `LIFESTYLE:\n`;
      planLifestyle.forEach((l) => {
        text +=
          typeof l === "string" ? `• ${l}\n` : `• ${l.advice}${l.detail ? ` — ${l.detail}` : ""}\n`;
      });
      text += `\n`;
    }
    const invs = (conData?.investigations_ordered || conData?.investigations_to_order || []).map(
      ts,
    );
    if (invs.length) text += `INVESTIGATIONS: ${invs.join(", ")}\n\n`;

    if (planMonitors?.length) {
      text += `SELF-MONITORING:\n`;
      planMonitors.forEach((sm) => {
        text +=
          typeof sm === "string"
            ? `• ${sm}\n`
            : `• ${sm.title}${sm.targets ? ` — Target: ${sm.targets}` : ""}\n`;
      });
      text += `\n`;
    }
    if (conData?.follow_up) {
      text += `FOLLOW-UP: ${conData.follow_up.timing || conData.follow_up.when || ""}\n`;
      if (conData.follow_up.instructions)
        text += `Instructions: ${conData.follow_up.instructions}\n`;
    }

    navigator.clipboard.writeText(text).then(() => {
      set({ planCopied: true });
      setTimeout(() => set({ planCopied: false }), 2000);
    });
  },

  // Reset all clinical state
  resetClinical: () => {
    set({
      moTranscript: "",
      conTranscript: "",
      moData: null,
      conData: null,
      moBrief: null,
      moBriefLoading: false,
      quickTranscript: "",
      quickMode: false,
      quickProgress: "",
      conPasteMode: false,
      conPasteText: "",
      conSourceMode: "merge",
      planCopied: false,
      clarifications: {},
    });
  },
}));

export default useClinicalStore;
