import { create } from "zustand";
import api from "../services/api.js";

const useReportsStore = create((set, get) => ({
  // ── CI state ──
  ciData: null,
  ciLoading: false,
  patientCI: null,
  patientCILoading: false,
  patientCIExpanded: true,
  ciPeriod: "month",
  ciExpandedCr: null,
  ciExpandedRx: null,

  // ── Reports state ──
  reportData: null,
  reportDx: null,
  reportDoctors: null,
  reportPeriod: "today",
  reportDoctor: "",
  reportLoading: false,
  reportQuery: "",
  reportQueryResult: "",
  reportQueryLoading: false,
  reportSection: "summary",
  reportDrillBio: null,
  reportDrillPt: null,

  // ── Outcomes state ──
  outcomesData: null,
  outcomesLoading: false,
  outcomePeriod: "all",
  expandedBiomarker: null,
  timelineFilter: "All",
  timelineDoctor: "",
  expandedDiagnosis: null,
  expandedPrescription: null,

  // ── Health summary ──
  healthSummary: null,
  summaryLoading: false,

  // ── New reports ──
  newReportsExpanded: false,
  newReportsIncluded: false,

  // ── simple setters ──
  setCiData: (val) => set({ ciData: val }),
  setCiLoading: (val) => set({ ciLoading: val }),
  setPatientCI: (val) => set({ patientCI: val }),
  setPatientCILoading: (val) => set({ patientCILoading: val }),
  setPatientCIExpanded: (val) => set({ patientCIExpanded: val }),
  setCiPeriod: (val) => set({ ciPeriod: val }),
  setCiExpandedCr: (val) => set({ ciExpandedCr: val }),
  setCiExpandedRx: (val) => set({ ciExpandedRx: val }),
  setReportData: (val) => set({ reportData: val }),
  setReportDx: (val) => set({ reportDx: val }),
  setReportDoctors: (val) => set({ reportDoctors: val }),
  setReportPeriod: (val) => set({ reportPeriod: val }),
  setReportDoctor: (val) => set({ reportDoctor: val }),
  setReportLoading: (val) => set({ reportLoading: val }),
  setReportQuery: (val) => set({ reportQuery: val }),
  setReportQueryResult: (val) => set({ reportQueryResult: val }),
  setReportQueryLoading: (val) => set({ reportQueryLoading: val }),
  setReportSection: (val) => set({ reportSection: val }),
  setReportDrillBio: (val) => set({ reportDrillBio: val }),
  setReportDrillPt: (val) => set({ reportDrillPt: val }),
  setOutcomesData: (val) => set({ outcomesData: val }),
  setOutcomesLoading: (val) => set({ outcomesLoading: val }),
  setOutcomePeriod: (val) => set({ outcomePeriod: val }),
  setExpandedBiomarker: (val) => set({ expandedBiomarker: val }),
  setTimelineFilter: (val) => set({ timelineFilter: val }),
  setTimelineDoctor: (val) => set({ timelineDoctor: val }),
  setExpandedDiagnosis: (val) => set({ expandedDiagnosis: val }),
  setExpandedPrescription: (val) => set({ expandedPrescription: val }),
  setHealthSummary: (val) => set({ healthSummary: val }),
  setSummaryLoading: (val) => set({ summaryLoading: val }),
  setNewReportsExpanded: (val) => set({ newReportsExpanded: val }),
  setNewReportsIncluded: (val) => set({ newReportsIncluded: val }),

  // ── actions ──

  loadCIReport: async (p) => {
    const { ciPeriod } = get();
    set({ ciLoading: true, ciData: null });
    try {
      const resp = await api.get(`/api/reports/clinical-intelligence?period=${p || ciPeriod}`);
      const data = resp.data;
      if (data && data.overview) {
        set({ ciData: data });
      } else {
        set({
          ciData: {
            overview: {
              cr_total: 0,
              cr_month: 0,
              rx_total: 0,
              rx_month: 0,
              agreement: [],
              audio_hours: 0,
            },
            reasoning_feed: [],
            rx_feed: [],
            doctor_stats: [],
            disagreement_tags: [],
          },
        });
      }
    } catch (e) {
      console.error("CI report error:", e.response?.data?.error || e.message);
      set({
        ciData: {
          overview: {
            cr_total: 0,
            cr_month: 0,
            rx_total: 0,
            rx_month: 0,
            agreement: [],
            audio_hours: 0,
          },
          reasoning_feed: [],
          rx_feed: [],
          doctor_stats: [],
          disagreement_tags: [],
          _error: e.response?.data?.error || e.message,
        },
      });
    }
    set({ ciLoading: false });
  },

  loadReports: async (period, doctor) => {
    set({ reportLoading: true });
    try {
      const params = new URLSearchParams();
      if (period) params.set("period", period);
      if (doctor) params.set("doctor", doctor);
      const [todayResp, dxResp, docResp] = await Promise.all([
        api.get(`/api/reports/today?${params}`),
        api.get("/api/reports/diagnoses"),
        api.get("/api/reports/doctors"),
      ]);
      set({ reportData: todayResp.data });
      set({ reportDx: dxResp.data });
      set({ reportDoctors: docResp.data });
    } catch (e) {
      console.warn("Failed to load reports");
    }
    set({ reportLoading: false });
  },

  runReportQuery: async () => {
    const { reportQuery } = get();
    if (!reportQuery.trim()) return;
    set({ reportQueryLoading: true, reportQueryResult: "" });
    try {
      const dataResp = await api.get("/api/reports/query-data");
      const data = dataResp.data;
      const dataStr = JSON.stringify(data.patients.slice(0, 100), null, 0);
      const prompt = `You are a clinical analytics assistant for Gini Advanced Care Hospital, Mohali.
You have access to structured patient data from the hospital database. Analyze and answer the query.
Be specific with numbers, names, and trends. Use tables for comparisons. Keep answers concise.
If the data doesn't contain enough info to answer accurately, say so.
Format: Use markdown. Bold key numbers. Use tables where helpful.`;
      const r = await api.post("/api/ai/complete", {
        messages: [
          {
            role: "user",
            content: `HOSPITAL DATA (${data.patient_count} patients):\n${dataStr}\n\nQUERY: ${reportQuery}`,
          },
        ],
        system: prompt,
        model: "sonnet",
        maxTokens: 3000,
      });
      set({ reportQueryResult: r.data.text || "" });
    } catch (e) {
      set({ reportQueryResult: "Error: " + (e.response?.data?.error || e.message) });
    }
    set({ reportQueryLoading: false });
  },

  fetchOutcomes: async (pid, period) => {
    if (!pid) return;
    const { outcomePeriod } = get();
    set({ outcomesLoading: true });
    try {
      const p = period || outcomePeriod;
      const url =
        p && p !== "all"
          ? `/api/patients/${pid}/outcomes?period=${p}`
          : `/api/patients/${pid}/outcomes`;
      const resp = await api.get(url);
      set({ outcomesData: resp.data });
    } catch (err) {
      console.warn("Failed to load outcomes");
    }
    set({ outcomesLoading: false });
  },

  generateHealthSummary: async (patient, patientFullData) => {
    const { outcomesData } = get();
    if (!outcomesData || !patientFullData) return;
    set({ summaryLoading: true });
    try {
      const summaryData = {
        patient: { name: patient.name, age: patient.age, sex: patient.sex },
        diagnoses: patientFullData.diagnoses?.map((d) => `${d.label}: ${d.status}`) || [],
        medications:
          patientFullData.medications
            ?.filter((m) => m.is_active)
            .map((m) => `${m.name} ${m.dose} ${m.frequency}`) || [],
        labs:
          patientFullData.lab_results
            ?.slice(0, 15)
            .map(
              (l) =>
                `${l.test_name}: ${l.result} ${l.unit} (${l.flag || "normal"}) on ${l.test_date}`,
            ) || [],
        vitals_trend: {
          hba1c: outcomesData.hba1c?.map((d) => `${d.result}% on ${d.test_date}`),
          bp: outcomesData.bp?.map((d) => `${d.bp_sys}/${d.bp_dia} on ${d.date}`),
          weight: outcomesData.weight?.map((d) => `${d.weight}kg on ${d.date}`),
        },
        diagnosis_journey: outcomesData.diagnosis_journey
          ?.slice(0, 20)
          .map((d) => `${d.label}: ${d.status} on ${d.visit_date}`),
      };

      const prompt = `You are a caring doctor writing a health journey summary for the patient.
Based on this data, write a 4-6 sentence plain English summary of the patient's health journey.
Include: 1) What conditions they have and how long 2) What's improving and what's not 3) What the biggest concerns are 4) An encouraging note about what's working.
Use simple language a patient can understand. Be specific with numbers. Use the patient's name.

Patient Data: ${JSON.stringify(summaryData)}

Write ONLY the summary paragraph, no headers or formatting.`;

      const r = await api.post("/api/ai/complete", {
        messages: [{ role: "user", content: prompt }],
        model: "sonnet",
        maxTokens: 500,
      });
      set({ healthSummary: r.data.text || "Could not generate summary." });
    } catch (e) {
      set({ healthSummary: "Error: " + (e.response?.data?.error || e.message) });
    }
    set({ summaryLoading: false });
  },

  buildCISnapshot: (
    patient,
    vitals,
    moData,
    conData,
    labData,
    patientFullData,
    assessDx,
    fuNewMeds,
    conPasteText,
    conTranscript,
    fuConNotes,
  ) => {
    var rawText = (
      (conPasteText || "") +
      " " +
      (conTranscript || "") +
      " " +
      (fuConNotes || "")
    ).toUpperCase();
    // Note: moTranscript intentionally not included to avoid matching MO dictation
    var findLab = function (keywords) {
      for (var ki = 0; ki < keywords.length; ki++) {
        var kw = keywords[ki].toUpperCase();
        var idx = rawText.indexOf(kw);
        if (idx === -1) continue;
        var after = rawText.slice(idx + kw.length, idx + kw.length + 25);
        var nm = after.match(/[:\s]*([0-9]+\.?[0-9]*)/);
        if (nm) return parseFloat(nm[1]);
      }
      return undefined;
    };
    var labTests = moData && moData.investigations ? moData.investigations : [];
    var labPanelTests = [];
    if (labData && labData.panels) {
      labData.panels.forEach(function (p) {
        (p.tests || []).forEach(function (t) {
          labPanelTests.push({ test: t.test_name, value: t.result_text || t.result });
        });
      });
    }
    var dbLabTests = [];
    if (patientFullData && patientFullData.lab_results) {
      var sortedDbLabs = [...patientFullData.lab_results].sort(function (a, b) {
        return new Date(b.test_date || 0) - new Date(a.test_date || 0);
      });
      sortedDbLabs.forEach(function (t) {
        dbLabTests.push({ test: t.test_name, value: t.result });
      });
    }
    var structLab = function (names) {
      for (var ni = 0; ni < names.length; ni++) {
        var n = names[ni].toUpperCase();
        for (var li = 0; li < labTests.length; li++) {
          if ((labTests[li].test || "").toUpperCase().indexOf(n) !== -1)
            return parseFloat(labTests[li].value);
        }
        for (var pi = 0; pi < labPanelTests.length; pi++) {
          if ((labPanelTests[pi].test || "").toUpperCase().indexOf(n) !== -1)
            return parseFloat(labPanelTests[pi].value);
        }
        for (var di = 0; di < dbLabTests.length; di++) {
          if ((dbLabTests[di].test || "").toUpperCase().indexOf(n) !== -1)
            return parseFloat(dbLabTests[di].value);
        }
      }
      return undefined;
    };
    var getLab = function (sn, tk) {
      var sv = structLab(sn);
      if (sv !== undefined && !isNaN(sv)) return sv;
      return findLab(tk || sn);
    };
    var medNames = [];
    if (moData && moData.previous_medications)
      moData.previous_medications.forEach(function (m) {
        if (m.name) medNames.push(m.name);
      });
    if (conData && conData.medications_confirmed)
      conData.medications_confirmed.forEach(function (m) {
        if (m.name) medNames.push(m.name);
      });
    if (fuNewMeds)
      fuNewMeds.forEach(function (m) {
        if (m.name) medNames.push(m.name);
      });
    var planSrc = conPasteText || conTranscript || "";
    planSrc.split("\n").forEach(function (line) {
      var t = line.trim();
      var prefix = t.slice(0, 4).toUpperCase();
      if (t.length > 4 && (prefix === "TAB " || prefix === "CAP " || prefix === "INJ ")) {
        var name = t.slice(0, 50);
        if (medNames.indexOf(name) === -1) medNames.push(name);
      }
    });
    var diagLabels = (moData && moData.diagnoses ? moData.diagnoses : [])
      .map(function (d) {
        return d.label || d;
      })
      .join(" ");
    var complicationLabels = (moData && moData.complications ? moData.complications : [])
      .map(function (c) {
        return (c.name || "") + " " + (c.detail || "");
      })
      .join(" ");
    var assessLabels = (assessDx || [])
      .map(function (d) {
        return d.label || d;
      })
      .join(" ");
    var dxAll = (
      diagLabels +
      " " +
      complicationLabels +
      " " +
      assessLabels +
      " " +
      rawText
    ).toUpperCase();
    var has = function (terms) {
      return terms.some(function (t) {
        return dxAll.indexOf(t.toUpperCase()) !== -1;
      });
    };
    var comorbidities = [];
    if (has(["CAD", "CORONARY", "STENT", "CABG"])) comorbidities.push("CAD");
    if (has(["CVA", "STROKE"]) && dxAll.indexOf("CVA-") === -1) comorbidities.push("post-CVA");
    if (has(["HEART FAILURE", "HFREF"])) comorbidities.push("HFrEF");
    if (has(["HYPERTENSION", "HTN"])) comorbidities.push("hypertension");
    if (has(["MASLD", "MASH", "NAFLD", "FATTY LIVER"])) comorbidities.push("MASLD");
    if (has(["NEUROPATHY"])) comorbidities.push("neuropathy");
    if (has(["NEPHROPATHY", "CKD"])) comorbidities.push("nephropathy");
    if (has(["RETINOPATHY"])) comorbidities.push("retinopathy");
    if (has(["HYPOTHYROID", "HASHIMOTO"])) comorbidities.push("hypothyroidism");
    if (has(["OBESITY", "ADIPOSITY"])) comorbidities.push("obesity");
    if (has(["RBBB", "BRADYCARDIA"])) comorbidities.push("cardiac-conduction");
    return {
      age: patient.age ? parseInt(patient.age) : undefined,
      sex: patient.sex || undefined,
      bmi: vitals.bmi ? parseFloat(vitals.bmi) : undefined,
      weight: vitals.weight ? parseFloat(vitals.weight) : undefined,
      bp_systolic: vitals.bp_sys ? parseInt(vitals.bp_sys) : undefined,
      bp_diastolic: vitals.bp_dia ? parseInt(vitals.bp_dia) : undefined,
      a1c: getLab(["HBA1C", "HB A1C", "GLYCATED"], ["HBA1C", "HB A1C", "A1C"]),
      egfr: getLab(["EGFR", "GFR"], ["EGFR", "GFR"]),
      uacr: getLab(["UACR", "ACR"], ["UACR", "ACR"]),
      ldl: getLab(["LDL"], ["LDL"]),
      tg: getLab(["TRIGLYCERIDE", "TG"], ["TG", "TRIGLYCERIDE"]),
      tsh: getLab(["TSH"], ["TSH"]),
      potassium: getLab(["POTASSIUM", "SERUM K"], ["POTASSIUM", " K:"]),
      creatinine: getLab(["CREATININE", "CREAT"], ["CREATININE", "CREAT"]),
      vit_d: getLab(["VITAMIN D", "VIT D", "25-OH"], ["VIT D", "VITAMIN D"]),
      comorbidities: comorbidities,
      current_medications: [],
      current_medication_names: medNames,
    };
  },

  runPatientCI: async (snapshot, patientFileNo, conName) => {
    set({ patientCILoading: true });
    try {
      const { data } = await api.post("/api/ai/clinical-intelligence", {
        patient_id: patientFileNo || "VISIT-" + Date.now(),
        snapshot,
        doctor_name: conName,
      });
      if (data.protocols_matched !== undefined) set({ patientCI: data });
    } catch (e) {
      console.error("CI error:", e.response?.data?.error || e.message);
    }
    set({ patientCILoading: false });
  },

  includeNewReportsInPlan: (newReportsSinceLastVisit, setConTranscript, setConData) => {
    const labSummary = newReportsSinceLastVisit
      .map(
        (l) =>
          `${l.test_name}: ${l.result} ${l.unit || ""} ${l.flag === "H" ? "(HIGH)" : l.flag === "L" ? "(LOW)" : ""} [${l.test_date}]`,
      )
      .join("\n");
    const injection = `\n\n--- NEW LAB RESULTS (since last visit) ---\n${labSummary}\n--- END NEW LABS ---`;
    setConTranscript((prev) => (prev || "") + injection);
    set({ newReportsIncluded: true, newReportsExpanded: false });
    setConData(null); // Reset so plan regenerates with new data
  },
}));

export default useReportsStore;
