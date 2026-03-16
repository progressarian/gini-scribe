import { create } from "zustand";
import api, { callClaude } from "../services/api.js";
import { RX_EXTRACT_PROMPT, REPORT_EXTRACT_PROMPT } from "../config/prompts.js";
import { emptyHistory } from "../config/history.js";

const useHistoryStore = create((set, get) => ({
  // ── state ──
  historyForm: { ...emptyHistory },
  historyList: [],
  historySaving: false,
  rxText: "",
  rxExtracting: false,
  rxExtracted: false,
  reports: [],
  hxMode: "rx",
  bulkText: "",
  bulkParsing: false,
  bulkVisits: [],
  bulkSaving: false,
  bulkProgress: "",
  bulkSaved: 0,

  // ── simple setters ──
  setHistoryForm: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ historyForm: val(state.historyForm) })
        : { historyForm: val },
    ),
  setHistoryList: (val) => set({ historyList: val }),
  setHistorySaving: (val) => set({ historySaving: val }),
  setRxText: (val) => set({ rxText: val }),
  setRxExtracting: (val) => set({ rxExtracting: val }),
  setRxExtracted: (val) => set({ rxExtracted: val }),
  setReports: (val) =>
    set(
      typeof val === "function" ? (state) => ({ reports: val(state.reports) }) : { reports: val },
    ),
  setHxMode: (val) => set({ hxMode: val }),
  setBulkText: (val) => set({ bulkText: val }),
  setBulkParsing: (val) => set({ bulkParsing: val }),
  setBulkVisits: (val) => set({ bulkVisits: val }),
  setBulkSaving: (val) => set({ bulkSaving: val }),
  setBulkProgress: (val) => set({ bulkProgress: val }),
  setBulkSaved: (val) => set({ bulkSaved: val }),

  // ── actions ──

  updateHistoryField: (path, value) => {
    set((state) => {
      const next = JSON.parse(JSON.stringify(state.historyForm));
      const keys = path.split(".");
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!isNaN(keys[i + 1])) {
          obj = obj[keys[i]];
        } else if (!isNaN(keys[i])) {
          obj = obj[parseInt(keys[i])];
        } else {
          obj = obj[keys[i]];
        }
      }
      const lastKey = keys[keys.length - 1];
      if (!isNaN(lastKey)) obj[parseInt(lastKey)] = value;
      else obj[lastKey] = value;
      return { historyForm: next };
    });
  },

  addHistoryRow: (section) => {
    set((state) => {
      const next = { ...state.historyForm };
      if (section === "diagnoses")
        next.diagnoses = [...next.diagnoses, { id: "", label: "", status: "New" }];
      if (section === "medications")
        next.medications = [...next.medications, { name: "", dose: "", frequency: "", timing: "" }];
      if (section === "labs")
        next.labs = [
          ...next.labs,
          { test_name: "", result: "", unit: "", flag: "", ref_range: "" },
        ];
      return { historyForm: next };
    });
  },

  removeHistoryRow: (section, idx) => {
    set((state) => {
      const next = { ...state.historyForm };
      next[section] = next[section].filter((_, i) => i !== idx);
      return { historyForm: next };
    });
  },

  extractPrescription: async () => {
    const { rxText } = get();
    if (!rxText.trim()) return;
    set({ rxExtracting: true });
    try {
      const { data, error } = await callClaude(RX_EXTRACT_PROMPT, rxText);
      if (data && !error) {
        set((state) => ({
          historyForm: {
            ...state.historyForm,
            visit_date: data.visit_date || state.historyForm.visit_date,
            doctor_name: data.doctor_name || state.historyForm.doctor_name,
            specialty: data.specialty || state.historyForm.specialty,
            vitals: { ...state.historyForm.vitals, ...(data.vitals || {}) },
            diagnoses: data.diagnoses?.length > 0 ? data.diagnoses : state.historyForm.diagnoses,
            medications:
              data.medications?.length > 0 ? data.medications : state.historyForm.medications,
          },
          rxExtracted: true,
        }));
      }
    } catch (e) {
      console.error("Rx extract error:", e);
    }
    set({ rxExtracting: false });
  },

  handleReportFile: (e, reportType) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      const mediaType = file.type || "image/jpeg";
      set((state) => ({
        reports: [
          ...state.reports,
          {
            type: reportType,
            fileName: file.name,
            base64,
            mediaType,
            extracted: null,
            extracting: false,
            error: null,
          },
        ],
      }));
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  },

  extractReport: async (index) => {
    const { reports } = get();
    const report = reports[index];
    if (!report) return;
    set((state) => ({
      reports: state.reports.map((r, i) =>
        i === index ? { ...r, extracting: true, error: null } : r,
      ),
    }));
    try {
      const block =
        report.mediaType === "application/pdf"
          ? {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: report.base64 },
            }
          : {
              type: "image",
              source: { type: "base64", media_type: report.mediaType, data: report.base64 },
            };
      const resp = await api.post("/api/ai/complete", {
        messages: [
          { role: "user", content: [block, { type: "text", text: REPORT_EXTRACT_PROMPT }] },
        ],
        model: "sonnet",
        maxTokens: 8000,
      });
      const d = resp.data;
      const t = d.text || "";
      let clean = t
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();
      const parsed = JSON.parse(clean);
      // Add extracted labs to history form
      if (parsed.tests?.length > 0) {
        const newLabs = parsed.tests.map((t) => ({
          test_name: t.test_name,
          result: t.result?.toString() || t.result_text || "",
          unit: t.unit || "",
          flag: t.flag || "",
          ref_range: t.ref_range || "",
        }));
        set((state) => ({
          historyForm: {
            ...state.historyForm,
            labs: [...state.historyForm.labs.filter((l) => l.test_name), ...newLabs],
            ...(parsed.report_date && !state.historyForm.visit_date
              ? { visit_date: parsed.report_date }
              : {}),
          },
        }));
      }
      set((state) => ({
        reports: state.reports.map((r, i) =>
          i === index ? { ...r, extracting: false, extracted: parsed } : r,
        ),
      }));
    } catch (e) {
      console.error("Report extract error:", e);
      set((state) => ({
        reports: state.reports.map((r, i) =>
          i === index
            ? { ...r, extracting: false, error: e.response?.data?.error || e.message }
            : r,
        ),
      }));
    }
  },

  removeReport: (index) => {
    set((state) => ({ reports: state.reports.filter((_, i) => i !== index) }));
  },

  processBulkImport: async () => {
    const { bulkText } = get();
    if (!bulkText.trim()) return;
    set({ bulkParsing: true, bulkVisits: [], bulkProgress: "Splitting visits..." });
    try {
      const prompt =
        `You are a clinical data extraction AI. The user is pasting ALL visit history for a patient from another EMR system.

TASK: Split this into INDIVIDUAL VISITS. Each visit has a date and its own data.

Output ONLY valid JSON array, no backticks:
[
  {
    "visit_date": "YYYY-MM-DD",
    "doctor_name": "Dr. Name",
    "visit_type": "OPD",
    "vitals": { "bp_sys": null, "bp_dia": null, "weight": null, "height": null, "bmi": null, "pulse": null },
    "diagnoses": [{"id": "dm2", "label": "Type 2 DM", "status": "Controlled"}],
    "medications": [{"name": "BRAND NAME", "dose": "500mg", "frequency": "BD", "timing": "After meals"}],
    "labs": [{"test_name": "HbA1c", "result": "5.3", "unit": "%", "flag": "N", "ref_range": "<6.5"}],
    "chief_complaints": ["symptom1"],
    "notes": "Brief summary of this visit"
  }
]

RULES:
- Split by FOLLOW UP dates. Each date = separate visit object
- Extract ALL lab values for each visit date with proper units and flags (H/L/N)
- Extract vitals: height (cm), weight (kg), BMI, BP (split sys/dia), waist circumference
- Extract medications at each visit (they may change between visits)
- Diagnosis IDs: dm2,dm1,htn,cad,ckd,hypo,obesity,dyslipidemia,dfu,masld,nephropathy,osas,hashimotos
- Sort visits by date ASCENDING (oldest first)
- If a visit only has labs and no treatment changes, still create a visit entry
- flag: "H" if above range, "L" if below, "N" if normal
- Convert dates like "16/9/25" to "2025-09-16", "2nd December 2023" to "2023-12-02"
- Include the LATEST/TODAY visit as well
- ALWAYS include the full diagnosis list for EVERY visit (not just the first one)

TEXT TO PARSE:
` + bulkText.trim();

      const resp = await api.post("/api/ai/complete", {
        messages: [{ role: "user", content: prompt }],
        model: "haiku",
        maxTokens: 8000,
      });
      const result = resp.data;
      if (result.error) {
        set({ bulkProgress: "API error: " + result.error, bulkParsing: false });
        return;
      }
      const text = (result.text || "").trim();
      if (!text) {
        set({ bulkProgress: "Empty response from AI", bulkParsing: false });
        return;
      }
      const jsonStr = text.replace(/^```json\n?|```$/g, "").trim();
      const visits = JSON.parse(jsonStr);

      if (!Array.isArray(visits) || visits.length === 0) {
        set({ bulkProgress: "Could not parse visits. Try reformatting.", bulkParsing: false });
        return;
      }

      visits.sort((a, b) => new Date(a.visit_date) - new Date(b.visit_date));
      set({
        bulkVisits: visits,
        bulkProgress: `Found ${visits.length} visits. Review and click Save All.`,
      });
    } catch (e) {
      set({ bulkProgress: "Parse error: " + e.message });
    }
    set({ bulkParsing: false });
  },

  saveBulkVisits: async (dbPatientId, setPatientFullData, fetchOutcomes) => {
    const { bulkVisits } = get();
    if (!dbPatientId || !bulkVisits.length) return;
    set({ bulkSaving: true, bulkSaved: 0 });
    let saved = 0;
    for (const visit of bulkVisits) {
      try {
        set({
          bulkProgress: `Saving visit ${saved + 1}/${bulkVisits.length}: ${visit.visit_date}...`,
        });
        const payload = {
          visit_date: visit.visit_date,
          visit_type: visit.visit_type || "OPD",
          doctor_name: visit.doctor_name || "",
          specialty: visit.specialty || "",
          vitals: visit.vitals || {},
          diagnoses: (visit.diagnoses || []).filter((d) => d.label),
          medications: (visit.medications || []).filter((m) => m.name),
          labs: (visit.labs || []).filter((l) => l.test_name && l.result),
          notes: visit.notes || "",
        };
        const resp = await api.post(`/api/patients/${dbPatientId}/history`, payload);
        const result = resp.data;
        if (result.success) saved++;
      } catch (e) {
        console.warn("Failed to save history entry");
      }
      set({ bulkSaved: saved });
    }
    set({ bulkProgress: `Saved ${saved}/${bulkVisits.length} visits!`, bulkSaving: false });
    if (dbPatientId) {
      try {
        const full = (await api.get(`/api/patients/${dbPatientId}`)).data;
        if (full.id) {
          if (setPatientFullData) setPatientFullData(full);
          set({ historyList: full.consultations || [] });
        }
        if (fetchOutcomes) fetchOutcomes(dbPatientId);
      } catch (e) {
        console.warn("Failed to refresh after bulk save");
      }
    }
  },

  saveHistoryEntry: async (dbPatientId, setPatientFullData, fetchOutcomes) => {
    const { historyForm } = get();
    if (!dbPatientId || !historyForm.visit_date) return;
    set({ historySaving: true });
    try {
      const payload = {
        visit_date: historyForm.visit_date,
        visit_type: historyForm.visit_type,
        doctor_name: historyForm.doctor_name,
        specialty: historyForm.specialty,
        vitals: historyForm.vitals,
        diagnoses: historyForm.diagnoses.filter((d) => d.label),
        medications: historyForm.medications.filter((m) => m.name),
        labs: historyForm.labs.filter((l) => l.test_name && l.result),
      };
      const resp = await api.post(`/api/patients/${dbPatientId}/history`, payload);
      const result = resp.data;
      if (result.success) {
        set({
          historyForm: {
            ...emptyHistory,
            diagnoses: [{ id: "", label: "", status: "New" }],
            medications: [{ name: "", dose: "", frequency: "", timing: "" }],
            labs: [{ test_name: "", result: "", unit: "", flag: "", ref_range: "" }],
          },
          rxText: "",
          rxExtracted: false,
          reports: [],
        });
        // Refresh history list
        const full = (await api.get(`/api/patients/${dbPatientId}`)).data;
        set({ historyList: full.consultations || [] });
        if (setPatientFullData) setPatientFullData(full);
        if (fetchOutcomes) fetchOutcomes(dbPatientId);
      }
    } catch (e) {
      console.warn("Failed to save history entry");
    }
    set({ historySaving: false });
  },
}));

export default useHistoryStore;
