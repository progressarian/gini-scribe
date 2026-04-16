import { create } from "zustand";
import api from "../services/api.js";
import { extractLab, extractImaging, convertHeicToJpeg, isHeic } from "../services/extraction.js";
import useAuthStore from "./authStore.js";

const useLabPortalStore = create((set, get) => ({
  // ── state ──
  labPortalFiles: [],
  labPortalDate: new Date().toISOString().slice(0, 10),
  expandedDocId: null,

  // ── simple setters ──
  setLabPortalFiles: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ labPortalFiles: val(state.labPortalFiles) })
        : { labPortalFiles: val },
    ),
  setLabPortalDate: (val) => set({ labPortalDate: val }),
  setExpandedDocId: (val) => set({ expandedDocId: val }),

  // ── actions ──

  handleLabPortalUpload: async (e, reportType) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    e.target.value = "";

    const isLab = [
      "Blood Test",
      "Thyroid Panel",
      "Lipid Profile",
      "Kidney Function",
      "Liver Function",
      "HbA1c",
      "CBC",
      "Urine",
      "Other Lab",
    ].includes(reportType);

    for (const file of files) {
      let base64, mediaType;
      if (isHeic(file)) {
        try {
          const converted = await convertHeicToJpeg(file);
          base64 = converted.base64;
          mediaType = "image/jpeg";
        } catch (err) {
          set((state) => ({
            labPortalFiles: [
              ...state.labPortalFiles,
              {
                id: Date.now() + Math.random(),
                type: reportType,
                category: isLab ? "lab" : "imaging",
                base64: null,
                mediaType: null,
                fileName: file.name,
                date: get().labPortalDate,
                extracting: false,
                extracted: true,
                data: null,
                error: "HEIC: " + (err?.message || "conversion failed"),
                saved: false,
              },
            ],
          }));
          continue;
        }
      } else {
        const result = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target.result);
          reader.readAsDataURL(file);
        });
        base64 = result.split(",")[1];
        mediaType = file.type || "image/jpeg";
      }

      set((state) => ({
        labPortalFiles: [
          ...state.labPortalFiles,
          {
            id: Date.now() + Math.random(),
            type: reportType,
            category: isLab ? "lab" : "imaging",
            base64,
            mediaType,
            fileName: file.name,
            date: get().labPortalDate,
            extracting: false,
            extracted: false,
            data: null,
            error: null,
            saved: false,
          },
        ],
      }));
    }
  },

  processLabPortalFile: async (fileId, dbPatientId, setPatientFullData) => {
    set((state) => ({
      labPortalFiles: state.labPortalFiles.map((f) =>
        f.id === fileId ? { ...f, extracting: true, error: null } : f,
      ),
    }));
    const file = get().labPortalFiles.find((f) => f.id === fileId);
    if (!file) return;
    const isLab = file.category === "lab";
    const extractFn = isLab ? extractLab : extractImaging;
    const { data, error } = await extractFn(file.base64, file.mediaType);
    // Use report_date from extraction if available, fall back to user-selected date
    const effectiveDate =
      data?.report_date ||
      file.date ||
      get().labPortalDate ||
      new Date().toISOString().split("T")[0];
    set((state) => ({
      labPortalFiles: state.labPortalFiles.map((f) =>
        f.id === fileId
          ? { ...f, extracting: false, extracted: true, data, error, date: effectiveDate }
          : f,
      ),
    }));
    // Auto-save to DB
    if (data && dbPatientId) {
      const { currentDoctor } = useAuthStore.getState();
      try {
        const body = {
          doc_type: isLab ? "lab_report" : data.report_type || file.type,
          title: `${file.type} \u2014 ${file.fileName}`,
          file_name: file.fileName,
          extracted_data: data,
          doc_date: effectiveDate,
          source: `upload_${currentDoctor?.short_name || "lab"}`,
          notes: isLab
            ? `${(data.panels || []).reduce((a, p) => a + p.tests.length, 0)} tests extracted`
            : data.impression || "",
        };
        const docResp = await api.post(`/api/patients/${dbPatientId}/documents`, body);
        const savedDoc = docResp.data;
        // Upload actual file to Supabase Storage
        if (savedDoc.id) {
          try {
            await api.post(`/api/documents/${savedDoc.id}/upload-file`, {
              base64: file.base64,
              mediaType: file.mediaType,
              fileName: file.fileName,
            });
          } catch (e) {
            console.log("File upload failed:", e.response?.data?.error || e.message);
          }
        }
        // PATCH triggers cascade: lab_results sync (with document_id + canonical_name), vitals sync, biomarker sync
        if (savedDoc.id && data && (data.panels || data.medications)) {
          await api
            .patch(`/api/documents/${savedDoc.id}`, { extracted_data: data })
            .catch((e) => console.warn("PATCH extracted_data failed:", e.message));
        }
        set((state) => ({
          labPortalFiles: state.labPortalFiles.map((f) =>
            f.id === fileId ? { ...f, saved: true } : f,
          ),
        }));
        // Refresh patient data so new labs show up
        if (dbPatientId) {
          try {
            const pd = (await api.get(`/api/patients/${dbPatientId}`)).data;
            if (setPatientFullData) setPatientFullData(pd);
          } catch (err) {
            console.warn("Failed to refresh patient data");
          }
        }
      } catch (e) {
        console.log("Lab save failed:", e.response?.data?.error || e.message);
        set((state) => ({
          labPortalFiles: state.labPortalFiles.map((f) =>
            f.id === fileId
              ? { ...f, error: "Save failed: " + (e.response?.data?.error || e.message) }
              : f,
          ),
        }));
      }
    }
  },

  removeLabPortalFile: (fileId) =>
    set((state) => ({ labPortalFiles: state.labPortalFiles.filter((f) => f.id !== fileId) })),
}));

export default useLabPortalStore;
