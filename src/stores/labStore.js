import { create } from "zustand";
import api from "../services/api.js";
import { normalizeTestName } from "../config/labNormalization.js";
import { extractLab, extractImaging, convertHeicToJpeg, isHeic } from "../services/extraction.js";
import useAuthStore from "./authStore.js";
import { toast } from "./uiStore.js";

const useLabStore = create((set, get) => ({
  // ── state ──
  labData: null,
  labImageData: null,
  labMismatch: null,
  intakeReports: [],
  imagingFiles: [],
  labRequisition: [],

  // ── internal refs (not reactive) ──
  _intakeSavedIds: new Set(),

  // ── simple setters ──
  setLabData: (val) => set({ labData: val }),
  setLabImageData: (val) => set({ labImageData: val }),
  setLabMismatch: (val) => set({ labMismatch: val }),
  setIntakeReports: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ intakeReports: val(state.intakeReports) })
        : { intakeReports: val },
    ),
  setImagingFiles: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ imagingFiles: val(state.imagingFiles) })
        : { imagingFiles: val },
    ),
  setLabRequisition: (val) => set({ labRequisition: val }),

  // ── actions ──

  handleLabUpload: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (isHeic(f)) {
      try {
        const converted = await convertHeicToJpeg(f);
        set({
          labImageData: { base64: converted.base64, mediaType: "image/jpeg", fileName: f.name },
        });
      } catch (err) {
        // Caller should handle errors via a toast or errors state
        console.error("HEIC conversion failed:", err?.message);
      }
    } else {
      const reader = new FileReader();
      reader.onload = (ev) =>
        set({
          labImageData: {
            base64: ev.target.result.split(",")[1],
            mediaType: f.type.startsWith("image/") ? f.type : "application/pdf",
            fileName: f.name,
          },
        });
      reader.readAsDataURL(f);
    }
  },

  processLab: async (patient, dbPatientId, tab, runPatientCI) => {
    const { labImageData } = get();
    if (!labImageData) return;
    const { data, error } = await extractLab(labImageData.base64, labImageData.mediaType);
    if (error) {
      console.error("Lab extraction error:", error);
      return { error };
    }
    set({ labData: data });
    if (data?.patient_on_report?.name && patient?.name) {
      const rn = data.patient_on_report.name.toLowerCase(),
        pn = patient.name.toLowerCase();
      if (rn && pn && !rn.includes(pn.split(" ")[0]) && !pn.includes(rn.split(" ")[0]))
        set({ labMismatch: `Report: "${data.patient_on_report.name}" \u2260 "${patient.name}"` });
      else set({ labMismatch: null });
    }
    // Save to DB
    if (data && dbPatientId) {
      await get().saveIntakeReportToDB(
        {
          id: "single_lab_" + Date.now(),
          type: "lab",
          base64: labImageData.base64,
          mediaType: labImageData.mediaType,
          fileName: labImageData.fileName,
        },
        data,
        dbPatientId,
      );
    }
    // Refresh CI panel with newly uploaded labs
    if ((tab === "fu_gen" || tab === "consultant") && runPatientCI) runPatientCI();
    return { data };
  },

  handleImagingUpload: async (e, reportType) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    for (const f of files) {
      if (isHeic(f)) {
        try {
          const converted = await convertHeicToJpeg(f);
          set((state) => ({
            imagingFiles: [
              ...state.imagingFiles,
              {
                id: Date.now() + Math.random(),
                type: reportType || "Unknown",
                base64: converted.base64,
                mediaType: "image/jpeg",
                fileName: f.name,
                data: null,
                extracting: false,
                error: null,
              },
            ],
          }));
        } catch (err) {
          set((state) => ({
            imagingFiles: [
              ...state.imagingFiles,
              {
                id: Date.now() + Math.random(),
                type: reportType || "Unknown",
                base64: null,
                mediaType: null,
                fileName: f.name,
                data: null,
                extracting: false,
                error: "HEIC: " + (err?.message || "conversion failed"),
              },
            ],
          }));
        }
      } else {
        const result = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target.result);
          reader.readAsDataURL(f);
        });
        set((state) => ({
          imagingFiles: [
            ...state.imagingFiles,
            {
              id: Date.now() + Math.random(),
              type: reportType || "Unknown",
              base64: result.split(",")[1],
              mediaType: f.type.startsWith("image/") ? f.type : "application/pdf",
              fileName: f.name,
              data: null,
              extracting: false,
              error: null,
            },
          ],
        }));
      }
    }
  },

  processImaging: async (fileId, dbPatientId) => {
    set((state) => ({
      imagingFiles: state.imagingFiles.map((f) =>
        f.id === fileId ? { ...f, extracting: true, error: null } : f,
      ),
    }));
    const file = get().imagingFiles.find((f) => f.id === fileId);
    if (!file) return;
    const { data, error } = await extractImaging(file.base64, file.mediaType);
    set((state) => ({
      imagingFiles: state.imagingFiles.map((f) =>
        f.id === fileId ? { ...f, extracting: false, data, error } : f,
      ),
    }));
    // Auto-save to DB if patient loaded
    if (data && dbPatientId) {
      try {
        const { data: savedDoc } = await api.post(`/api/patients/${dbPatientId}/documents`, {
          doc_type: data.report_type || file.type,
          title: `${data.report_type || file.type} \u2014 ${file.fileName}`,
          file_name: file.fileName,
          extracted_data: data,
          doc_date: data.date || new Date().toISOString().split("T")[0],
          source: "upload",
          notes: data.impression,
        });
        if (savedDoc.id) {
          await get().uploadFileToStorage(savedDoc.id, file.base64, file.mediaType, file.fileName);
        }
      } catch (e) {
        console.log("Doc save failed:", e.message);
      }
    }
  },

  removeImaging: (fileId) =>
    set((state) => ({ imagingFiles: state.imagingFiles.filter((f) => f.id !== fileId) })),

  saveIntakeReportToDB: async (rpt, data, pid) => {
    const { _intakeSavedIds } = get();
    const { currentDoctor } = useAuthStore.getState();
    const patientId = pid;
    if (!data || !patientId) return false;
    if (_intakeSavedIds.has(rpt.id)) return true; // Already saved
    _intakeSavedIds.add(rpt.id); // Mark early to prevent race
    try {
      const isLab = rpt.type === "lab";
      const effectiveDate = data.report_date || data.collection_date || data.date || null;
      // 1. Save document
      const { data: savedDoc } = await api.post(`/api/patients/${patientId}/documents`, {
        doc_type: isLab ? "lab_report" : data.report_type || rpt.type,
        title: `${isLab ? data.lab_name || "Lab Report" : data.report_type || rpt.type} \u2014 ${rpt.fileName}`,
        file_name: rpt.fileName,
        extracted_data: data,
        doc_date: effectiveDate,
        source: data.lab_name || `intake_${currentDoctor?.short_name || "mo"}`,
        notes: isLab
          ? `${data.lab_name || ""} | ${(data.panels || []).reduce((a, p) => a + p.tests.length, 0)} tests | ${effectiveDate || ""}`
          : data.impression || "",
      });
      console.log("Document saved:", savedDoc.id, rpt.fileName);
      // 2. Upload file to storage
      if (savedDoc.id && rpt.base64)
        await get().uploadFileToStorage(savedDoc.id, rpt.base64, rpt.mediaType, rpt.fileName);
      // 3. PATCH document with extracted_data — triggers backend lab sync, vitals sync, biomarker sync
      if (savedDoc.id && data && (data.panels || data.medications)) {
        await api
          .patch(`/api/documents/${savedDoc.id}`, { extracted_data: data })
          .catch((e) => console.warn("PATCH extracted_data failed:", e.message));
      }
      set((state) => ({
        intakeReports: state.intakeReports.map((r) =>
          r.id === rpt.id ? { ...r, saved: true, saveError: null } : r,
        ),
      }));
      return true;
    } catch (e) {
      _intakeSavedIds.delete(rpt.id); // Allow retry
      set((state) => ({
        intakeReports: state.intakeReports.map((r) =>
          r.id === rpt.id ? { ...r, saveError: e.message } : r,
        ),
      }));
      return false;
    }
  },

  saveAllIntakeReports: async (pid) => {
    const patientId = pid;
    if (!patientId) {
      toast("Search or create patient first", "warn");
      return;
    }
    const unsaved = get().intakeReports.filter((r) => r.data && !r.saved);
    for (const rpt of unsaved) {
      set((state) => ({
        intakeReports: state.intakeReports.map((r) =>
          r.id === rpt.id ? { ...r, saving: true } : r,
        ),
      }));
      await get().saveIntakeReportToDB(rpt, rpt.data, patientId);
      set((state) => ({
        intakeReports: state.intakeReports.map((r) =>
          r.id === rpt.id ? { ...r, saving: false } : r,
        ),
      }));
    }
    // Refresh patient data
    try {
      const { data } = await api.get(`/api/patients/${patientId}`);
      // Return data for caller to update patientFullData
      return data;
    } catch (e) {
      console.warn("Failed to refresh patient data");
    }
  },

  uploadFileToStorage: async (documentId, base64, mediaType, fileName) => {
    try {
      await api.post(`/api/documents/${documentId}/upload-file`, {
        base64,
        mediaType,
        fileName,
      });
    } catch (e) {
      console.log("File upload failed:", e.message);
    }
  },

  resetLab: () =>
    set({
      labData: null,
      labImageData: null,
      labMismatch: null,
      intakeReports: [],
      imagingFiles: [],
      labRequisition: [],
    }),
}));

export default useLabStore;
