import { create } from "zustand";
import api from "../services/api.js";
import { callClaude } from "../services/api.js";
import { PATIENT_VOICE_PROMPT } from "../config/prompts.js";
import useUiStore from "./uiStore.js";
import useVitalsStore from "./vitalsStore.js";
import useVisitStore from "./visitStore.js";
import useClinicalStore from "./clinicalStore.js";
import usePlanStore from "./planStore.js";
import useExamStore from "./examStore.js";
import useLabStore from "./labStore.js";
import useHistoryStore from "./historyStore.js";
import useRxReviewStore from "./rxReviewStore.js";
import useChatStore from "./chatStore.js";

let dupCheckTimer = null;

const EMPTY_PATIENT = {
  name: "",
  phone: "",
  dob: "",
  fileNo: "",
  age: "",
  sex: "Male",
  abhaId: "",
  aadhaar: "",
  healthId: "",
  govtId: "",
  govtIdType: "",
  address: "",
};

const usePatientStore = create((set, get) => ({
  // ── state ──
  patient: { ...EMPTY_PATIENT },
  dbPatientId: null,
  patientFullData: null,
  duplicateWarning: null,
  savedPatients: (() => {
    try {
      return JSON.parse(localStorage.getItem("gini_patients") || "[]");
    } catch {
      return [];
    }
  })(),

  // ── simple setters ──
  setPatient: (val) => set({ patient: val }),
  setDbPatientId: (val) => set({ dbPatientId: val }),
  setPatientFullData: (val) => set({ patientFullData: val }),
  setDuplicateWarning: (val) => set({ duplicateWarning: val }),
  setSavedPatients: (val) => set({ savedPatients: val }),

  // ── computed getters (call these as functions) ──
  getPfd: () => {
    const { patientFullData, dbPatientId } = get();
    return !patientFullData || !dbPatientId || patientFullData.id !== dbPatientId
      ? null
      : patientFullData;
  },
  getIsFollowUp: () => {
    const pfd = get().getPfd();
    return (pfd?.consultations?.length || 0) > 0;
  },

  // ── updatePatient: includes proactive dup check ──
  updatePatient: (k, v) => {
    const { dbPatientId } = get();
    set((state) => {
      const u = { ...state.patient, [k]: v };
      if (k === "dob" && v) {
        const a = Math.floor((Date.now() - new Date(v).getTime()) / 31557600000);
        u.age = a > 0 ? String(a) : "";
      }
      return { patient: u };
    });
    // Proactive duplicate check when fileNo or phone is entered (only for new patients)
    if (!dbPatientId && (k === "fileNo" || k === "phone") && v && v.length >= 3) {
      clearTimeout(dupCheckTimer);
      dupCheckTimer = setTimeout(async () => {
        try {
          const params = new URLSearchParams();
          if (k === "fileNo") params.set("file_no", v);
          if (k === "phone") params.set("phone", v);
          const { data } = await api.get(`/api/patients/check-duplicate?${params}`);
          if (data.exists && data.patient) set({ duplicateWarning: data.patient });
          else set({ duplicateWarning: null });
        } catch (e) {
          /* Duplicate check -- non-critical */
        }
      }, 600);
    }
  },

  // ── voiceFillPatient ──
  voiceFillPatient: async (transcript) => {
    // Uses uiStore for loading/errors

    useUiStore.getState().setLoading((p) => ({ ...p, pv: true }));
    useUiStore.getState().clearErr("pv");
    const { data, error } = await callClaude(PATIENT_VOICE_PROMPT, transcript);
    if (error) useUiStore.getState().setErrors((p) => ({ ...p, pv: error }));
    else if (data) {
      set((state) => ({
        patient: {
          name: data.name || state.patient.name,
          phone: data.phone || state.patient.phone,
          dob: data.dob || state.patient.dob,
          fileNo: data.fileNo || state.patient.fileNo,
          age: data.age ? String(data.age) : state.patient.age,
          sex: data.sex || state.patient.sex,
        },
      }));
    }
    useUiStore.getState().setLoading((p) => ({ ...p, pv: false }));
  },

  // ── savePatient: create or update patient in DB ──
  savePatient: async () => {
    const { patient, dbPatientId } = get();
    if (!patient.name?.trim()) return { error: "Patient name is required" };

    const payload = {
      name: patient.name,
      phone: patient.phone || null,
      dob: patient.dob || null,
      age: patient.age ? parseInt(patient.age) : null,
      sex: patient.sex || null,
      file_no: patient.fileNo || null,
      abha_id: patient.abhaId || null,
      health_id: patient.healthId || null,
      aadhaar: patient.aadhaar || null,
      govt_id: patient.govtId || null,
      govt_id_type: patient.govtIdType || null,
      address: patient.address || null,
    };

    try {
      let result;
      if (dbPatientId) {
        result = await api.put(`/api/patients/${dbPatientId}`, payload);
      } else {
        result = await api.post("/api/patients", payload);
      }
      const saved = result.data;
      set({
        dbPatientId: saved.id,
        patientFullData: null,
      });
      sessionStorage.setItem("gini_active_patient", String(saved.id));
      // Reload full patient data
      try {
        const { data: full } = await api.get(`/api/patients/${saved.id}`);
        set({ patientFullData: full });
      } catch {
        /* non-critical */
      }
      return { data: saved };
    } catch (e) {
      return { error: e.response?.data?.error || "Failed to save patient" };
    }
  },

  // ── restorePatient: called on app load to re-fetch active patient ──
  restorePatient: async () => {
    const id = sessionStorage.getItem("gini_active_patient");
    if (!id) return;
    try {
      const { data: full } = await api.get(`/api/patients/${id}`);
      set({
        patient: {
          name: full.name || "",
          phone: full.phone || "",
          age: full.age || "",
          sex: full.sex || "Male",
          fileNo: full.file_no || "",
          dob: full.dob ? String(full.dob).slice(0, 10) : "",
          abhaId: full.abha_id || "",
          healthId: full.health_id || "",
          aadhaar: full.aadhaar || "",
          govtId: full.govt_id || "",
          govtIdType: full.govt_id_type || "",
          address: full.address || "",
        },
        dbPatientId: full.id,
        patientFullData: full,
      });
      if (full.vitals?.length > 0) {
        const v = full.vitals[0];
        useVitalsStore.getState().setVitals((prev) => ({
          ...prev,
          bp_sys: v.bp_sys || "",
          bp_dia: v.bp_dia || "",
          pulse: v.pulse || "",
          spo2: v.spo2 || "",
          weight: v.weight || "",
          height: v.height || "",
          bmi: v.bmi || "",
        }));
      }
    } catch {
      sessionStorage.removeItem("gini_active_patient");
    }
  },

  // ── newPatient: resets all patient state ──
  newPatient: (setTab) => {
    set({
      patient: { ...EMPTY_PATIENT },
      dbPatientId: null,
      patientFullData: null,
      duplicateWarning: null,
    });
    sessionStorage.removeItem("gini_active_patient");
    // Reset vitals store
    useVitalsStore.getState().resetVitals();
    // Reset UI store
    useUiStore.getState().clearSearch();
    useUiStore.getState().setSaveStatus("");
    localStorage.removeItem("gini_scribe_session");
    // Clear visit mode in frontend (DB record persists for later restore)
    useVisitStore.setState({
      visitActive: false,
      visitId: null,
      visitPatientId: null,
      activeApptId: null,
      visitStatus: null,
    });
    // Reset all clinical stores
    useClinicalStore.getState().resetClinical();
    usePlanStore.getState().resetPlanEdits();
    useExamStore.getState().resetExam();
    useLabStore.getState().resetLab();
    useRxReviewStore.getState().resetRxReview();
    useHistoryStore.getState().setHistoryList([]);
    useChatStore.getState().resetChat();
    if (setTab) setTab("patient");
  },

  // ── loadPatient: loads from localStorage record ──
  loadPatient: async (record, setTab, toast) => {
    const p = record.patient || {};
    set({ patient: p });
    // Set vitals in vitals store
    useVitalsStore.getState().setVitals(record.vitals || {});
    // Reset all clinical stores
    useClinicalStore.getState().resetClinical();
    usePlanStore.getState().resetPlanEdits();
    useExamStore.getState().resetExam();
    useLabStore.getState().resetLab();
    useRxReviewStore.getState().resetRxReview();
    useHistoryStore.getState().setHistoryList([]);
    useChatStore.getState().resetChat();
    useUiStore.getState().setShowSearch(false);
    if (setTab) setTab("patient");
    // Try to find this patient in the DB by name or phone
    if (p.name || p.phone) {
      try {
        const q = p.phone || p.name;
        const { data: results } = await api.get(`/api/patients?q=${encodeURIComponent(q)}`);
        if (results.length > 0) {
          const match = results.find((r) => r.name === p.name || r.phone === p.phone) || results[0];
          set({ dbPatientId: match.id });
          // Load full data for outcomes
          const { data: full } = await api.get(`/api/patients/${match.id}`);
          set({ patientFullData: full });
        }
      } catch (err) {
        if (toast) toast("Failed to load patient record", "warn");
      }
    }
  },

  // ── loadPatientDB: loads full patient from DB ──
  loadPatientDB: async (dbRecord, setTab, toast) => {
    set({
      patient: {
        name: dbRecord.name || "",
        phone: dbRecord.phone || "",
        age: dbRecord.age || "",
        sex: dbRecord.sex || "Male",
        fileNo: dbRecord.file_no || "",
        dob: dbRecord.dob ? String(dbRecord.dob).slice(0, 10) : "",
        abhaId: dbRecord.abha_id || "",
        healthId: dbRecord.health_id || "",
        aadhaar: dbRecord.aadhaar || "",
        govtId: dbRecord.govt_id || "",
        govtIdType: dbRecord.govt_id_type || "",
        address: dbRecord.address || "",
      },
      dbPatientId: dbRecord.id,
      duplicateWarning: null,
      patientFullData: null,
    });
    if (dbRecord.id) sessionStorage.setItem("gini_active_patient", String(dbRecord.id));
    // Reset vitals store
    useVitalsStore.getState().resetVitals();
    // Reset all clinical stores
    useClinicalStore.getState().resetClinical();
    usePlanStore.getState().resetPlanEdits();
    useExamStore.getState().resetExam();
    useLabStore.getState().resetLab();
    useRxReviewStore.getState().resetRxReview();
    useHistoryStore.getState().setHistoryList([]);
    useChatStore.getState().resetChat();
    // Reset UI store
    useUiStore.getState().setErrors({});
    useUiStore.getState().setShowSearch(false);
    // Load full patient record
    if (dbRecord.id) {
      try {
        const { data: full } = await api.get(`/api/patients/${dbRecord.id}`);
        set({ patientFullData: full });
        // Sort to get truly latest consultation (by date + creation time)
        const sortedCons = (full.consultations || []).sort((a, b) => {
          const d = new Date(b.visit_date) - new Date(a.visit_date);
          return d !== 0 ? d : new Date(b.created_at) - new Date(a.created_at);
        });
        if (sortedCons.length > 0) {
          const latest = sortedCons[0];
          try {
            await api.get(`/api/consultations/${latest.id}`);
            // NOTE: moData/conData/transcripts live outside this store;
            // caller is responsible for setting them from conDetail.
            // Return conDetail for the caller to handle.
          } catch {
            if (toast) toast("Failed to load last consultation", "warn");
          }
        }
        if (full.vitals?.length > 0) {
          const v = full.vitals[0];
          useVitalsStore.getState().setVitals((prev) => ({
            ...prev,
            bp_sys: v.bp_sys || "",
            bp_dia: v.bp_dia || "",
            pulse: v.pulse || "",
            spo2: v.spo2 || "",
            weight: v.weight || "",
            height: v.height || "",
            bmi: v.bmi || "",
          }));
        }
      } catch (err) {
        if (toast) toast("Failed to load patient record");
      }
    }
    // Sync visit state from backend — show visit mode only if this patient actually has an in-progress visit
    await useVisitStore.getState().syncVisitForPatient(dbRecord.id);
    if (setTab) setTab("dashboard");
  },

  // ── init: load saved patients from localStorage ──
  loadSavedPatients: () => {
    try {
      const saved = JSON.parse(localStorage.getItem("gini_patients") || "[]");
      set({ savedPatients: saved });
    } catch {
      /* localStorage parse error -- safe to ignore */
    }
  },
}));

export default usePatientStore;
