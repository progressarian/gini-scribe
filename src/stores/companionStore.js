import { create } from "zustand";
import api from "../services/api.js";
import { extractLab } from "../services/extraction.js";
import { toast } from "./uiStore.js";
import { docCategories } from "../companion/constants";

const retryPost = async (url, body, maxRetries = 3) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await api.post(url, body);
    } catch (e) {
      if (e.response?.status === 529 && attempt < maxRetries) {
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
};

// Convert extractLab() panels output → flat labs[] for companion review UI
function labPanelsToFlatLabs(extractedLab) {
  if (!extractedLab?.panels) return { labs: [], patient_name: null };
  const labs = [];
  for (const panel of extractedLab.panels) {
    for (const test of panel.tests || []) {
      labs.push({
        test_name: test.test_name,
        result: test.result_text || test.result,
        unit: test.unit || "",
        flag: test.flag === "H" ? "HIGH" : test.flag === "L" ? "LOW" : "NORMAL",
        ref_range: test.ref_range || "",
      });
    }
  }
  return {
    labs,
    patient_name: extractedLab.patient_on_report?.name || null,
    report_date: extractedLab.report_date || null,
    lab_name: extractedLab.lab_name || null,
    summary: null,
  };
}

const useCompanionStore = create((set, get) => ({
  // Patient list (server-paginated)
  patients: [],
  totalPatients: 0,
  currentPage: 0,
  totalPages: 0,
  loadingPatients: false,
  hasMore: true,
  searchText: "",
  selectedPatient: null,
  setSelectedPatient: (p) => set({ selectedPatient: p }),

  // Patient detail
  patientData: null,
  patientTab: "records",
  setPatientTab: (t) => set({ patientTab: t }),
  loading: false,

  // Capture
  captureStep: "camera",
  currentCapture: null,
  currentCategory: null,
  setCurrentCategory: (c) => set({ currentCategory: c }),
  captureMeta: { doctor: "", hospital: "", specialty: "", date: "" },
  setCaptureMeta: (v) =>
    set((s) => ({ captureMeta: typeof v === "function" ? v(s.captureMeta) : v })),
  extractedData: null,
  captureCount: 0,
  extracting: false,
  captureError: null,
  nameMismatch: null,
  categoryMismatch: null,
  changeCategory: (newCat) => set({ currentCategory: newCat, categoryMismatch: null }),
  saveStatus: null,

  // ── Data loading ──────────────────────────────────────────
  setSearchText: (t) => {
    set({ searchText: t, patients: [], currentPage: 0, hasMore: true });
    get().loadPatients(1, t);
  },

  loadPatients: async (page = 1, search) => {
    const { loadingPatients } = get();
    if (loadingPatients) return;
    set({ loadingPatients: true });
    try {
      const q = search ?? get().searchText;
      const params = new URLSearchParams({ page, limit: 30 });
      if (q) params.set("q", q);
      const r = await api.get(`/api/patients?${params}`);
      const { data, total, totalPages } = r.data;
      set((s) => ({
        patients: page === 1 ? data : [...s.patients, ...data],
        totalPatients: total,
        currentPage: page,
        totalPages,
        hasMore: page < totalPages,
      }));
    } catch (e) {
      console.error("Load patients:", e);
    }
    set({ loadingPatients: false });
  },

  loadMore: () => {
    const { currentPage, hasMore } = get();
    if (hasMore) get().loadPatients(currentPage + 1);
  },

  loadPatientData: async (patientId) => {
    set({ loading: true });
    try {
      const r = await api.get(`/api/patients/${patientId}`);
      set((s) => ({
        patientData: r.data,
        selectedPatient: s.selectedPatient ?? r.data,
      }));
    } catch (e) {
      console.error("Load patient:", e);
    }
    set({ loading: false });
  },

  // ── Navigation actions ────────────────────────────────────
  selectPatient: (p) => {
    set({ selectedPatient: p, patientTab: "records" });
    get().loadPatientData(p.id);
  },

  resetCapture: () => {
    set({
      captureStep: "camera",
      currentCapture: null,
      currentCategory: null,
      extractedData: null,
      captureError: null,
      nameMismatch: null,
      captureCount: 0,
    });
  },

  // ── Capture actions ───────────────────────────────────────
  handleFileSelect: (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();

    reader.onload = () => {
      set({
        currentCapture: {
          file,
          preview: reader.result,
          base64: reader.result.split(",")[1],
          fileName: file.name,
          mediaType: file.type || "image/jpeg",
          timestamp: new Date().toLocaleTimeString("en-IN", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
        captureStep: "categorize",
        nameMismatch: null,
        captureError: null,
      });
    };
    reader.readAsDataURL(file);
  },

  discardCapture: () => {
    set({
      captureStep: "camera",
      currentCapture: null,
      currentCategory: null,
      captureMeta: {},
      extractedData: null,
      captureError: null,
      nameMismatch: null,
    });
  },

  retryCapture: () => {
    set({
      captureStep: "categorize",
      extractedData: null,
      captureError: null,
      nameMismatch: null,
      categoryMismatch: null,
    });
  },

  extractDocument: async () => {
    const { currentCapture, currentCategory } = get();
    if (!currentCapture?.preview || !currentCategory) return;
    set({ extracting: true, captureError: null, nameMismatch: null, captureStep: "extracting" });

    try {
      const isRx = currentCategory === "prescription";
      const isLab = ["blood_test", "thyroid", "lipid", "kidney", "hba1c", "urine"].includes(
        currentCategory,
      );

      if (isLab) {
        // Use the same extractLab() as /opd and /visit for consistent, comprehensive extraction
        const imgData = currentCapture.base64;
        const mediaType = currentCapture.mediaType === "application/pdf"
          ? "application/pdf"
          : currentCapture.mediaType?.startsWith("image/")
            ? currentCapture.mediaType
            : "image/jpeg";

        const { data: labResult, error } = await extractLab(imgData, mediaType);
        if (error) throw new Error(error);
        if (!labResult?.panels?.length) throw new Error("No lab values found in report");

        // Convert panels format to flat labs format for review UI
        const uiData = labPanelsToFlatLabs(labResult);
        // Stash raw panels so saveCapture() can send to PATCH for full cascade sync
        uiData._rawExtraction = labResult;

        const updates = { extractedData: uiData, captureStep: "review" };

        if (uiData.report_date) {
          updates.captureMeta = { ...get().captureMeta, date: uiData.report_date };
        }
        if (uiData.lab_name) {
          updates.captureMeta = {
            ...(updates.captureMeta || get().captureMeta),
            hospital: uiData.lab_name,
          };
        }

        const mismatch = get().checkNameMismatch(uiData);
        if (mismatch) updates.nameMismatch = mismatch;
        updates.categoryMismatch = null;

        set(updates);
      } else {
        // Prescription and other categories — existing inline prompt extraction
        const prompt = isRx
          ? `Extract from this prescription image. Return JSON:
{"patient_name":"name on document","doctor_name":"","specialty":"","hospital_name":"","visit_date":"YYYY-MM-DD","diagnoses":[{"id":"dm2","label":"Type 2 DM","status":"Active"}],"medications":[{"name":"BRAND","composition":"Generic","dose":"dose","frequency":"OD","timing":"Morning"}],"labs":[{"test_name":"HbA1c","result":"7.2","unit":"%","flag":"HIGH","ref_range":"<6.5"}],"vitals":{"bp_sys":null,"bp_dia":null,"weight":null},"follow_up":"date or duration","advice":"key advice"}`
          : `Extract key findings from this medical document. Return JSON:
{"patient_name":"name on document","doc_type":"${currentCategory}","findings":"","date":"YYYY-MM-DD","doctor":"","notes":""}`;

        const imgData = currentCapture.base64;
        const isPdf = currentCapture.mediaType === "application/pdf";
        const mediaType = isPdf
          ? "application/pdf"
          : currentCapture.mediaType?.startsWith("image/")
            ? currentCapture.mediaType
            : "image/jpeg";

        const docBlock = isPdf
          ? {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: imgData },
            }
          : { type: "image", source: { type: "base64", media_type: mediaType, data: imgData } };

        const r = await retryPost("/api/ai/complete", {
          messages: [
            {
              role: "user",
              content: [
                docBlock,
                {
                  type: "text",
                  text: prompt + "\n\nReturn ONLY valid JSON. No markdown, no backticks.",
                },
              ],
            },
          ],
          model: "sonnet",
          maxTokens: 2000,
        });

        const data = r.data;
        const text = data.text || "";
        const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

        const updates = { extractedData: parsed, captureStep: "review" };

        if (parsed.doctor_name) {
          updates.captureMeta = {
            ...get().captureMeta,
            doctor: parsed.doctor_name,
            hospital: parsed.hospital_name || "",
            specialty: parsed.specialty || "",
            date: parsed.visit_date || "",
          };
        }
        if (parsed.report_date) {
          updates.captureMeta = {
            ...(updates.captureMeta || get().captureMeta),
            date: parsed.report_date,
          };
        }
        if (parsed.lab_name) {
          updates.captureMeta = {
            ...(updates.captureMeta || get().captureMeta),
            hospital: parsed.lab_name,
          };
        }

        const mismatch = get().checkNameMismatch(parsed);
        if (mismatch) updates.nameMismatch = mismatch;

        // Detect category mismatch for prescriptions
        const hasMeds = (parsed.medications || []).length > 0;
        const hasLabs = (parsed.labs || []).length > 0;

        if (isRx && hasLabs && !hasMeds) {
          updates.categoryMismatch = {
            detected: "lab",
            selected: currentCategory,
            msg: "This looks like a lab report (found test values but no medications).",
          };
        } else {
          updates.categoryMismatch = null;
        }

        set(updates);
      }
    } catch (e) {
      console.error("Extraction:", e);
      set({ captureError: e.message, captureStep: "review" });
    }
    set({ extracting: false });
  },

  checkNameMismatch: (extracted) => {
    const { selectedPatient } = get();
    const reportName = (extracted.patient_name || extracted.name || "").toLowerCase().trim();
    const selectedName = (selectedPatient?.name || "").toLowerCase().trim();
    if (!reportName || !selectedName || reportName.length < 3) return null;
    const reportParts = reportName.split(/\s+/);
    const selectedParts = selectedName.split(/\s+/);
    const hasMatch = reportParts.some(
      (rp) => rp.length > 2 && selectedParts.some((sp) => sp.includes(rp) || rp.includes(sp)),
    );
    if (!hasMatch)
      return {
        reportName: extracted.patient_name || extracted.name,
        selectedName: selectedPatient.name,
      };
    return null;
  },

  saveCapture: async () => {
    const { selectedPatient, currentCategory, extractedData, captureMeta, currentCapture } = get();
    if (!selectedPatient?.id) return;
    set({ loading: true, saveStatus: "Saving..." });

    console.log("Saving capture for patient:", selectedPatient);

    try {
      const isRx = currentCategory === "prescription";
      const isLab = ["blood_test", "thyroid", "lipid", "kidney", "hba1c", "urine"].includes(
        currentCategory,
      );

      const hasMeds = (extractedData?.medications || []).length > 0;
      const hasLabValues = (extractedData?.labs || []).length > 0;

      // Save prescription data if present (regardless of selected category)
      if (hasMeds && extractedData) {
        set({ saveStatus: "Saving prescription..." });
        await api.post(`/api/patients/${selectedPatient.id}/history`, {
          visit_date: captureMeta.date || new Date().toISOString().split("T")[0],
          visit_type: "OPD",
          doctor_name: captureMeta.doctor || extractedData.doctor_name || "",
          specialty: captureMeta.specialty || extractedData.specialty || "",
          hospital_name: captureMeta.hospital || extractedData.hospital_name || "",
          diagnoses: extractedData.diagnoses || [],
          medications: extractedData.medications || [],
          labs: (extractedData.labs || []).map((l) => ({
            test_name: l.test_name,
            result: l.result,
            unit: l.unit,
            flag: l.flag,
            ref_range: l.ref_range,
          })),
          vitals: extractedData.vitals || {},
        });
      }

      // Save lab values — use PATCH cascade (same as /opd and /visit) for proper sync
      if (hasLabValues && extractedData?._rawExtraction) {
        // 3-step flow: POST create doc → POST upload-file → PATCH extracted_data
        set({ saveStatus: "Saving document..." });
        const docR = await api.post(`/api/patients/${selectedPatient.id}/documents`, {
          doc_type: currentCategory,
          title: `${(docCategories.find((c) => c.id === currentCategory)?.label || currentCategory).replace(/^[^\s]+\s/, "")} — ${captureMeta.date || "Today"}`,
          doc_date: captureMeta.date || new Date().toISOString().split("T")[0],
          source: "Companion Upload",
          notes: captureMeta.hospital ? `Lab: ${captureMeta.hospital}` : "",
          extracted_data: extractedData._rawExtraction,
        });

        const docData = docR.data;
        if (currentCapture.base64 && docData.id) {
          set({ saveStatus: "Uploading image..." });
          try {
            await api.post(`/api/documents/${docData.id}/upload-file`, {
              base64: currentCapture.base64,
              mediaType: currentCapture.mediaType || "image/jpeg",
              fileName: currentCapture.fileName || `capture_${Date.now()}.jpg`,
            });
          } catch (uploadErr) {
            console.warn("Image upload failed (doc still saved):", uploadErr);
          }
        }

        // PATCH triggers cascade: lab_results sync, vitals sync, biomarker sync
        if (docData.id) {
          set({ saveStatus: "Syncing labs & vitals..." });
          try {
            await api.patch(`/api/documents/${docData.id}`, {
              extracted_data: extractedData._rawExtraction,
            });
          } catch (patchErr) {
            console.warn("PATCH extracted_data failed:", patchErr);
          }
        }
      } else if (hasLabValues && extractedData?.labs?.length) {
        // Fallback for prescription-extracted labs (no panels format)
        set({ saveStatus: `Saving ${extractedData.labs.length} lab values...` });
        for (const lab of extractedData.labs) {
          await api.post(`/api/patients/${selectedPatient.id}/labs`, {
            test_date: captureMeta.date || new Date().toISOString().split("T")[0],
            test_name: lab.test_name,
            result: lab.result,
            unit: lab.unit,
            flag: lab.flag,
            ref_range: lab.ref_range,
            source: captureMeta.hospital || "companion",
          });
        }
      }

      // Save document for non-lab categories (Rx, imaging, other)
      if (!extractedData?._rawExtraction) {
        set({ saveStatus: "Saving document..." });
        const docR = await api.post(`/api/patients/${selectedPatient.id}/documents`, {
          doc_type: currentCategory,
          title: isRx
            ? `${captureMeta.doctor || "External"} — ${captureMeta.specialty || currentCategory}`
            : `${(docCategories.find((c) => c.id === currentCategory)?.label || currentCategory).replace(/^[^\s]+\s/, "")} — ${captureMeta.date || "Today"}`,
          doc_date: captureMeta.date || new Date().toISOString().split("T")[0],
          source: "Companion Upload",
          notes: captureMeta.doctor ? `Doctor: ${captureMeta.doctor}` : extractedData?.summary || "",
          extracted_data: extractedData || {},
        });

        const docData = docR.data;
        if (currentCapture.base64 && docData.id) {
          set({ saveStatus: "Uploading image..." });
          try {
            await api.post(`/api/documents/${docData.id}/upload-file`, {
              base64: currentCapture.base64,
              mediaType: currentCapture.mediaType || "image/jpeg",
              fileName: currentCapture.fileName || `capture_${Date.now()}.jpg`,
            });
          } catch (uploadErr) {
            console.warn("Image upload failed (doc still saved):", uploadErr);
          }
        }
      }

      set((s) => ({
        saveStatus: null,
        captureCount: s.captureCount + 1,
        currentCapture: null,
        currentCategory: null,
        extractedData: null,
        captureMeta: { doctor: "", hospital: "", specialty: "", date: "" },
        captureStep: "camera",
        captureError: null,
        nameMismatch: null,
        categoryMismatch: null,
      }));
      get().loadPatientData(selectedPatient.id);
    } catch (e) {
      console.error("Save:", e);
      set({ captureError: "Save failed: " + e.message, saveStatus: null });
    }
    set({ loading: false });
  },
}));

export default useCompanionStore;
