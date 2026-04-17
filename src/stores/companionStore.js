import { create } from "zustand";
import api from "../services/api.js";
import {
  extractLab,
  extractImaging,
  extractRx,
  isHeic,
  convertHeicToJpeg,
} from "../services/extraction.js";
import { classifyDocument } from "../services/classification.js";
import { toast } from "./uiStore.js";
import { docCategories } from "../companion/constants";
import queryClient from "../queries/client.js";
import { qk } from "../queries/keys.js";

const LAB_CATEGORIES = ["blood_test", "thyroid", "lipid", "kidney", "hba1c", "urine"];
const IMAGING_CATEGORIES = ["xray", "usg", "mri", "dexa", "ecg", "ncs", "eye"];

const deriveCategory = (classification) => {
  if (!classification?.doc_type) return "other";
  const { doc_type, subtype } = classification;
  if (doc_type === "prescription") return "prescription";
  if (doc_type === "lab_report") {
    const map = {
      blood_test: "blood_test",
      thyroid: "thyroid",
      lipid: "lipid",
      kidney: "kidney",
      hba1c: "hba1c",
      urine: "urine",
    };
    return map[subtype] || "blood_test";
  }
  if (doc_type === "imaging") {
    const map = {
      xray: "xray",
      usg: "usg",
      mri: "mri",
      dexa: "dexa",
      ecg: "ecg",
      ncs: "ncs",
      eye: "eye",
    };
    return map[subtype] || "other";
  }
  return "other";
};

const normalizeMediaType = (mediaType) => {
  if (mediaType === "application/pdf") return "application/pdf";
  if (mediaType?.startsWith("image/")) return mediaType;
  return "image/jpeg";
};

const readFileToItem = async (file) => {
  let base64;
  let mediaType;
  let preview;

  if (isHeic(file)) {
    const jpegBase64 = await convertHeicToJpeg(file);
    base64 = jpegBase64;
    mediaType = "image/jpeg";
    preview = `data:image/jpeg;base64,${jpegBase64}`;
  } else {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("File read failed"));
      reader.readAsDataURL(file);
    });
    base64 = dataUrl.split(",")[1];
    mediaType = file.type || "image/jpeg";
    preview = dataUrl;
  }

  return {
    id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    file,
    base64,
    preview,
    mediaType,
    fileName: file.name,
    classification: null,
    category: null,
    extraction: null,
    extractError: null,
    saveError: null,
    expanded: false,
    status: "pending",
  };
};

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
      set({
        patientData: r.data,
        selectedPatient: r.data,
      });
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
        const mediaType =
          currentCapture.mediaType === "application/pdf"
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
          notes: captureMeta.doctor
            ? `Doctor: ${captureMeta.doctor}`
            : extractedData?.summary || "",
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
      // Invalidate the React Query cache for this patient so PatientScreen's
      // hook refetches the newly-saved docs/labs/meds automatically.
      queryClient.invalidateQueries({ queryKey: qk.companion.patient(selectedPatient.id) });
      get().loadPatientData(selectedPatient.id);
    } catch (e) {
      console.error("Save:", e);
      set({ captureError: "Save failed: " + e.message, saveStatus: null });
    }
    set({ loading: false });
  },

  // ── Home tab (appointments | patients) ───────────────────
  homeTab: null,
  setHomeTab: (t) => set({ homeTab: t }),

  // ── Active appointment linkage (companion_appt:<id> in notes) ────
  activeAppointmentId: null,
  setActiveAppointmentId: (id) => set({ activeAppointmentId: id }),

  // ── Multi-Capture ─────────────────────────────────────────
  multiCapture: {
    step: "pick", // 'pick'|'preview'|'classifying'|'extracting'|'review'|'saving'|'done'
    items: [],
    error: null,
    saveProgress: { done: 0, total: 0, currentLabel: "" },
  },

  _patchMultiItem: (itemId, updates) =>
    set((s) => ({
      multiCapture: {
        ...s.multiCapture,
        items: s.multiCapture.items.map((it) => (it.id === itemId ? { ...it, ...updates } : it)),
      },
    })),

  _patchMultiState: (updates) => set((s) => ({ multiCapture: { ...s.multiCapture, ...updates } })),

  multiReset: () =>
    set({
      multiCapture: {
        step: "pick",
        items: [],
        error: null,
        saveProgress: { done: 0, total: 0, currentLabel: "" },
      },
    }),

  multiHandleFilesSelect: async (files) => {
    const arr = Array.from(files || []).filter((f) => {
      if (f.size > 10 * 1024 * 1024) {
        toast(`Skipped ${f.name}: larger than 10MB`, "error");
        return false;
      }
      return true;
    });
    if (!arr.length) return;

    try {
      const newItems = await Promise.all(arr.map(readFileToItem));
      set((s) => ({
        multiCapture: {
          ...s.multiCapture,
          items: [...s.multiCapture.items, ...newItems],
          step: "preview",
          error: null,
        },
      }));
    } catch (e) {
      console.error("Read files:", e);
      set((s) => ({
        multiCapture: { ...s.multiCapture, error: `Failed to read files: ${e.message}` },
      }));
    }
  },

  multiRemoveItem: (itemId) =>
    set((s) => {
      const items = s.multiCapture.items.filter((it) => it.id !== itemId);
      return {
        multiCapture: {
          ...s.multiCapture,
          items,
          step: items.length === 0 ? "pick" : s.multiCapture.step,
        },
      };
    }),

  multiToggleExpand: (itemId) =>
    set((s) => ({
      multiCapture: {
        ...s.multiCapture,
        items: s.multiCapture.items.map((it) =>
          it.id === itemId ? { ...it, expanded: !it.expanded } : it,
        ),
      },
    })),

  _extractForItem: async (item, category) => {
    const mediaType = normalizeMediaType(item.mediaType);

    if (LAB_CATEGORIES.includes(category)) {
      const { data, error } = await extractLab(item.base64, mediaType);
      if (error) return { data: null, error };
      if (!data?.panels?.length) return { data: null, error: "No lab values found" };
      const uiData = labPanelsToFlatLabs(data);
      uiData._rawExtraction = data;
      return { data: uiData, error: null };
    }

    if (category === "prescription") {
      const { data, error } = await extractRx(item.base64, mediaType);
      if (error) return { data: null, error };
      if (!data) return { data: null, error: "No prescription data extracted" };
      return { data, error: null };
    }

    if (IMAGING_CATEGORIES.includes(category)) {
      const { data, error } = await extractImaging(item.base64, mediaType);
      if (error) return { data: null, error };
      return { data: data || {}, error: null };
    }

    // Generic "other" — lightweight inline prompt
    try {
      const isPdf = mediaType === "application/pdf";
      const docBlock = isPdf
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: item.base64 },
          }
        : { type: "image", source: { type: "base64", media_type: mediaType, data: item.base64 } };
      const r = await retryPost("/api/ai/complete", {
        messages: [
          {
            role: "user",
            content: [
              docBlock,
              {
                type: "text",
                text: `Extract key findings from this medical document. Return ONLY valid JSON (no backticks):
{"patient_name":"","doc_type":"${category}","findings":"","date":"YYYY-MM-DD","doctor":"","notes":""}`,
              },
            ],
          },
        ],
        model: "sonnet",
        maxTokens: 1500,
      });
      const text = (r.data.text || "").replace(/```json|```/g, "").trim();
      return { data: JSON.parse(text), error: null };
    } catch (e) {
      return { data: null, error: e.message || "Extraction failed" };
    }
  },

  multiClassifyAll: async () => {
    const items = get().multiCapture.items;
    if (!items.length) return;

    // Phase 1: classify all in parallel (Haiku, cheap & fast)
    set((s) => ({ multiCapture: { ...s.multiCapture, step: "classifying", error: null } }));
    items.forEach((it) => get()._patchMultiItem(it.id, { status: "classifying" }));

    await Promise.allSettled(
      items.map(async (item) => {
        const mediaType = normalizeMediaType(item.mediaType);
        const { data, error } = await classifyDocument(item.base64, mediaType);
        const classification = error
          ? {
              doc_type: "other",
              subtype: null,
              confidence: 0,
              rationale: `Classification unavailable: ${error}`,
            }
          : data;
        const category = deriveCategory(classification);
        get()._patchMultiItem(item.id, {
          classification,
          category,
          status: "classified",
        });
      }),
    );

    // Phase 2: extract in chunks of 3 (Sonnet heavier, avoid 529s)
    set((s) => ({ multiCapture: { ...s.multiCapture, step: "extracting" } }));
    const current = get().multiCapture.items;
    for (let i = 0; i < current.length; i += 3) {
      const chunk = current.slice(i, i + 3);
      await Promise.allSettled(
        chunk.map(async (it) => {
          get()._patchMultiItem(it.id, { status: "extracting" });
          const { data, error } = await get()._extractForItem(it, it.category);
          if (error) {
            get()._patchMultiItem(it.id, { extractError: error, status: "failed" });
          } else {
            get()._patchMultiItem(it.id, {
              extraction: data,
              extractError: null,
              status: "extracted",
            });
          }
        }),
      );
    }

    set((s) => ({ multiCapture: { ...s.multiCapture, step: "review" } }));
  },

  multiOverrideCategory: async (itemId, newCategory) => {
    const item = get().multiCapture.items.find((it) => it.id === itemId);
    if (!item) return;
    get()._patchMultiItem(itemId, {
      category: newCategory,
      status: "extracting",
      extractError: null,
    });
    const { data, error } = await get()._extractForItem(item, newCategory);
    if (error) {
      get()._patchMultiItem(itemId, { extractError: error, status: "failed" });
    } else {
      get()._patchMultiItem(itemId, {
        extraction: data,
        extractError: null,
        status: "extracted",
      });
    }
  },

  multiRetryExtract: async (itemId) => {
    const item = get().multiCapture.items.find((it) => it.id === itemId);
    if (!item) return;
    return get().multiOverrideCategory(itemId, item.category);
  },

  _saveOneMultiItem: async (item, patientId, apptId) => {
    const { category, extraction } = item;
    const date =
      extraction?.report_date ||
      extraction?.visit_date ||
      extraction?.date ||
      new Date().toISOString().slice(0, 10);
    const hospital = extraction?.lab_name || extraction?.hospital_name || "";
    const doctor = extraction?.doctor_name || "";
    const specialty = extraction?.specialty || "";

    const isRx = category === "prescription";
    const isLab = LAB_CATEGORIES.includes(category);
    const hasMeds = (extraction?.medications || []).length > 0;
    const hasLabValues = (extraction?.labs || []).length > 0;
    const catLabel = docCategories.find((c) => c.id === category)?.label || category;

    const noteParts = [];
    if (apptId) noteParts.push(`companion_appt:${apptId}`);
    if (hospital) noteParts.push(`Lab:${hospital}`);
    if (doctor) noteParts.push(`Doctor:${doctor}`);
    const notes = noteParts.join("|");

    // Prescription: save history (medications + diagnoses cascade)
    if (hasMeds) {
      await api.post(`/api/patients/${patientId}/history`, {
        visit_date: date,
        visit_type: "OPD",
        doctor_name: doctor,
        specialty,
        hospital_name: hospital,
        diagnoses: extraction.diagnoses || [],
        medications: extraction.medications || [],
        labs: (extraction.labs || []).map((l) => ({
          test_name: l.test_name,
          result: l.result,
          unit: l.unit,
          flag: l.flag,
          ref_range: l.ref_range,
        })),
        vitals: extraction.vitals || {},
      });
    }

    // Lab with panels: 3-step cascade
    if (isLab && extraction?._rawExtraction) {
      const docR = await api.post(`/api/patients/${patientId}/documents`, {
        doc_type: category,
        title: `${catLabel.replace(/^[^\s]+\s/, "")} — ${date}`,
        doc_date: date,
        source: "Companion Upload",
        notes,
        extracted_data: extraction._rawExtraction,
      });
      const docId = docR.data.id;
      if (docId && item.base64) {
        try {
          await api.post(`/api/documents/${docId}/upload-file`, {
            base64: item.base64,
            mediaType: item.mediaType || "image/jpeg",
            fileName: item.fileName || `capture_${Date.now()}.jpg`,
          });
        } catch (e) {
          console.warn("Upload failed:", e);
        }
        try {
          await api.patch(`/api/documents/${docId}`, {
            extracted_data: extraction._rawExtraction,
          });
        } catch (e) {
          console.warn("PATCH failed:", e);
        }
      }
      return;
    }

    // Fallback: inline labs without panel format
    if (hasLabValues && !extraction?._rawExtraction && !isRx) {
      for (const lab of extraction.labs) {
        await api.post(`/api/patients/${patientId}/labs`, {
          test_date: date,
          test_name: lab.test_name,
          result: lab.result,
          unit: lab.unit,
          flag: lab.flag,
          ref_range: lab.ref_range,
          source: hospital || "companion",
        });
      }
    }

    // Document record for prescription / imaging / other
    const title = isRx
      ? `${doctor || "External"} — ${specialty || category}`
      : `${catLabel.replace(/^[^\s]+\s/, "")} — ${date}`;

    const docR = await api.post(`/api/patients/${patientId}/documents`, {
      doc_type: category,
      title,
      doc_date: date,
      source: "Companion Upload",
      notes,
      extracted_data: extraction || {},
    });
    const docId = docR.data.id;
    if (docId && item.base64) {
      try {
        await api.post(`/api/documents/${docId}/upload-file`, {
          base64: item.base64,
          mediaType: item.mediaType || "image/jpeg",
          fileName: item.fileName || `capture_${Date.now()}.jpg`,
        });
      } catch (e) {
        console.warn("Upload failed:", e);
      }
    }
  },

  multiSaveAll: async () => {
    const { selectedPatient, activeAppointmentId, multiCapture } = get();
    if (!selectedPatient?.id) return;

    // Savable = items with extraction data that haven't been saved yet.
    // Covers first-time saves AND retries of previously-failed saves.
    const pending = multiCapture.items.filter((it) => it.extraction && it.status !== "saved");
    if (!pending.length) return;

    set((s) => ({
      multiCapture: {
        ...s.multiCapture,
        step: "saving",
        saveProgress: { done: 0, total: pending.length, currentLabel: "" },
      },
    }));

    let done = 0;
    for (const item of pending) {
      const catLabel = docCategories.find((c) => c.id === item.category)?.label || item.category;
      set((s) => ({
        multiCapture: {
          ...s.multiCapture,
          saveProgress: { done, total: pending.length, currentLabel: catLabel },
        },
      }));

      try {
        get()._patchMultiItem(item.id, { status: "saving", saveError: null });
        await get()._saveOneMultiItem(item, selectedPatient.id, activeAppointmentId);
        get()._patchMultiItem(item.id, { status: "saved", saveError: null });
      } catch (e) {
        console.error("Multi save item failed:", e);
        get()._patchMultiItem(item.id, {
          status: "failed",
          saveError: e.response?.data?.error || e.message,
        });
      }
      done += 1;
    }

    queryClient.invalidateQueries({ queryKey: qk.companion.patient(selectedPatient.id) });
    const today = new Date().toISOString().slice(0, 10);
    queryClient.invalidateQueries({ queryKey: qk.companion.appointments(today) });

    const items = get().multiCapture.items;
    const savedCount = items.filter((it) => it.status === "saved").length;
    const failedCount = items.filter((it) => it.status === "failed" && it.saveError).length;

    set((s) => ({
      multiCapture: {
        ...s.multiCapture,
        step: failedCount > 0 ? "review" : "done",
        saveProgress: { done: savedCount, total: pending.length, currentLabel: "" },
      },
    }));

    if (failedCount === 0 && savedCount > 0) {
      toast(`Saved ${savedCount} document${savedCount === 1 ? "" : "s"}`, "success");
    } else if (failedCount > 0) {
      toast(`Saved ${savedCount}, ${failedCount} failed — retry in review`, "error");
    }
  },
}));

export default useCompanionStore;
