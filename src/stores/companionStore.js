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
  if (!classification?.doc_type) return null;
  const { doc_type, subtype, confidence } = classification;
  const conf = typeof confidence === "number" ? confidence : 0.5;
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
    if (subtype && map[subtype]) return map[subtype];
    return conf >= 0.6 ? "blood_test" : null;
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
    if (subtype && map[subtype]) return map[subtype];
    return conf >= 0.6 ? "other" : null;
  }
  if (doc_type === "discharge") return "other";
  if (doc_type === "other") return "other";
  return null;
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
    classifying: false,
    // Per-file metadata (mirrors the single-capture captureMeta shape).
    meta: { date: "", hospital: "", doctor: "", specialty: "" },
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
    patient_id: extractedLab.patient_on_report?.patient_id || null,
    report_date: extractedLab.report_date || null,
    lab_name: extractedLab.lab_name || null,
    summary: null,
  };
}

function extractPatientFromRaw(raw) {
  if (!raw) return { patient_name: null, patient_id: null };
  if (raw.patient_on_report) {
    return {
      patient_name: raw.patient_on_report.name || null,
      patient_id: raw.patient_on_report.patient_id || null,
    };
  }
  return {
    patient_name: raw.patient_name || null,
    patient_id: raw.patient_id || null,
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

  checkNameMismatch: (extracted) => {
    // Legacy alias — kept for /capture (single) flow; delegates to the new
    // checker but returns only the name-mismatch subset.
    const res = get().checkPatientMismatch(extracted);
    if (!res || !res.mismatchedFields.includes("name")) return null;
    return { reportName: res.reportName, selectedName: res.selectedName };
  },

  checkPatientMismatch: (extracted, patientOverride) => {
    const selectedPatient = patientOverride || get().selectedPatient;
    if (!selectedPatient) return null;

    // Primary check is NAME. If the printed patient name matches the
    // selected patient, the doc is considered safe to attach even if the
    // ID/UHID on the report differs (scanning artifacts, manual edits,
    // multiple IDs per patient). Only flag for review when the name does
    // not match. The ID is still captured and shown in the review modal
    // for context.
    const reportName = (extracted?.patient_name || extracted?.name || "").trim();
    const selectedName = (selectedPatient.name || "").trim();
    const reportId = String(extracted?.patient_id || extracted?.patient_uhid || "").trim();
    const selectedId = String(selectedPatient.file_no || "").trim();

    if (!reportName || !selectedName || reportName.length < 3) return null;

    const rp = reportName.toLowerCase().split(/\s+/);
    const sp = selectedName.toLowerCase().split(/\s+/);
    const nameMatches = rp.some(
      (a) => a.length > 2 && sp.some((b) => b.includes(a) || a.includes(b)),
    );
    if (nameMatches) return null;

    const mismatchedFields = ["name"];
    if (reportId && selectedId) {
      const norm = (x) => x.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (norm(reportId) !== norm(selectedId)) mismatchedFields.push("id");
    }

    return {
      reportName,
      selectedName,
      reportId: reportId || null,
      selectedId: selectedId || null,
      mismatchedFields,
    };
  },

  // ── Fast-save: persist doc + file to server, reset UI, enqueue extraction
  // to the background worker. The user is returned to the camera in ~1-2s.
  saveCapture: async () => {
    const { selectedPatient, currentCategory, captureMeta, currentCapture } = get();
    if (!selectedPatient?.id || !currentCapture || !currentCategory) return;

    set({ loading: true, saveStatus: "Saving..." });

    try {
      const isRx = currentCategory === "prescription";
      const catLabel =
        docCategories.find((c) => c.id === currentCategory)?.label || currentCategory;
      const title = isRx
        ? `${captureMeta.doctor || "External"} — ${captureMeta.specialty || currentCategory}`
        : `${catLabel.replace(/^[^\s]+\s/, "")} — ${captureMeta.date || "Today"}`;
      const noteParts = [];
      if (captureMeta.hospital) noteParts.push(`Hospital:${captureMeta.hospital}`);
      if (captureMeta.doctor) noteParts.push(`Doctor:${captureMeta.doctor}`);
      const notes = noteParts.join("|");

      const docR = await api.post(`/api/patients/${selectedPatient.id}/documents`, {
        doc_type: currentCategory,
        title,
        doc_date: captureMeta.date || new Date().toISOString().split("T")[0],
        source: "Companion Upload",
        notes,
        extracted_data: { extraction_status: "pending" },
      });
      const docId = docR.data?.id;
      if (!docId) throw new Error("Document creation returned no id");

      try {
        await api.post(`/api/documents/${docId}/upload-file`, {
          base64: currentCapture.base64,
          mediaType: currentCapture.mediaType || "image/jpeg",
          fileName: currentCapture.fileName || `capture_${Date.now()}.jpg`,
        });
      } catch (uploadErr) {
        console.warn("Upload failed (doc still created):", uploadErr);
      }

      const task = {
        docId,
        patientId: selectedPatient.id,
        category: currentCategory,
        base64: currentCapture.base64,
        mediaType: currentCapture.mediaType || "image/jpeg",
        fileName: currentCapture.fileName || `capture_${Date.now()}.jpg`,
        meta: { ...captureMeta },
        needsClassify: false,
      };

      set((s) => ({
        loading: false,
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

      queryClient.invalidateQueries({ queryKey: qk.companion.patient(selectedPatient.id) });
      get()._enqueueBg(task);
      toast("Saved — extracting in background", "success");
    } catch (e) {
      console.error("Save:", e);
      set({
        captureError: "Save failed: " + e.message,
        saveStatus: null,
        loading: false,
      });
      toast("Save failed: " + e.message, "error");
    }
  },

  // ── Background extraction queue ──────────────────────────
  // Runs up to _BG_MAX tasks concurrently. Each task extracts data,
  // PATCHes the document on the server, optionally POSTs /history for
  // prescription meds, then clears its pendingExtractions entry.
  pendingExtractions: {},
  _bgQueue: [],
  _bgRunning: 0,
  _BG_MAX: 3,

  _setPending: (docId, updates) =>
    set((s) => ({
      pendingExtractions: {
        ...s.pendingExtractions,
        [docId]: { ...(s.pendingExtractions[docId] || {}), ...updates },
      },
    })),

  _clearPending: (docId) =>
    set((s) => {
      const next = { ...s.pendingExtractions };
      delete next[docId];
      return { pendingExtractions: next };
    }),

  _enqueueBg: (task) => {
    set((s) => ({
      _bgQueue: [...s._bgQueue, task],
      pendingExtractions: {
        ...s.pendingExtractions,
        [task.docId]: {
          status: "extracting",
          phase: task.needsClassify ? "classifying" : "extracting",
          patientId: task.patientId,
          fileName: task.fileName,
          task,
          error: null,
        },
      },
    }));
    get()._drainBg();
  },

  _drainBg: () => {
    while (get()._bgRunning < get()._BG_MAX && get()._bgQueue.length > 0) {
      const next = get()._bgQueue[0];
      set((s) => ({ _bgQueue: s._bgQueue.slice(1), _bgRunning: s._bgRunning + 1 }));
      get()
        ._runExtractionTask(next)
        .catch((e) => console.error("BG task crashed:", e))
        .finally(() => {
          set((s) => ({ _bgRunning: Math.max(0, s._bgRunning - 1) }));
          get()._drainBg();
        });
    }
  },

  _runExtractionTask: async (task) => {
    const { docId, patientId, base64, mediaType, fileName, meta, needsClassify } = task;
    let category = task.category;

    try {
      // Phase 1: classify (multi-capture only, when category wasn't user-picked)
      if (needsClassify) {
        get()._setPending(docId, { phase: "classifying" });
        const { data: cls } = await classifyDocument(base64, normalizeMediaType(mediaType));
        if (cls) {
          const derived = deriveCategory(cls);
          if (derived && derived !== category) {
            try {
              await api.patch(`/api/documents/${docId}`, { doc_type: derived });
              category = derived;
            } catch (e) {
              console.warn(`Doc ${docId} doc_type PATCH failed:`, e);
            }
          }
        }
      }

      // Phase 2: extract (reuses the same helpers used by /opd and /visit)
      get()._setPending(docId, { phase: "extracting", category });
      const item = { base64, mediaType, fileName };
      const { data: extraction, error: extErr } = await get()._extractForItem(item, category);
      if (extErr) throw new Error(extErr);
      if (!extraction) throw new Error("Extraction returned no data");

      // Phase 3: sync to server — history (meds) + PATCH extracted_data
      // BUT: if patient name/id mismatch is detected, short-circuit and
      // leave the doc awaiting user Accept/Reject on the doc card.
      const mismatch = get().checkPatientMismatch(extraction);
      if (mismatch) {
        // Persist mismatch state to the DB so it survives a page refresh.
        // Server PATCH cascade only fires on top-level `panels`/`medications`;
        // nesting them under `pending_payload` keeps the cascade off until
        // the user clicks Accept.
        const reviewWrapper = {
          extraction_status: "mismatch_review",
          mismatch,
          pending_payload: extraction._rawExtraction || extraction,
          pending_meta: meta,
          category,
          file_name: fileName,
          reviewed_at: null,
        };
        try {
          await api.patch(`/api/documents/${docId}`, { extracted_data: reviewWrapper });
        } catch (e) {
          console.warn(`Persist mismatch state failed for doc ${docId}:`, e);
        }

        get()._setPending(docId, {
          status: "mismatch",
          phase: "awaiting_review",
          category,
          mismatch,
          pendingPayload: extraction,
          pendingMeta: meta,
          error: null,
        });
        toast(
          `⚠️ Mismatch on ${fileName || "document"} — review on the document card`,
          "warn",
        );
        queryClient.invalidateQueries({ queryKey: qk.companion.patient(patientId) });
        queryClient.invalidateQueries({ queryKey: ["companion", "mismatchReviews"] });
        return;
      }

      get()._setPending(docId, { phase: "syncing" });

      const hasMeds = (extraction.medications || []).length > 0;
      if (hasMeds) {
        try {
          await api.post(`/api/patients/${patientId}/history`, {
            visit_date:
              meta?.date || extraction.visit_date || new Date().toISOString().slice(0, 10),
            visit_type: "OPD",
            doctor_name: meta?.doctor || extraction.doctor_name || "",
            specialty: meta?.specialty || extraction.specialty || "",
            hospital_name: meta?.hospital || extraction.hospital_name || "",
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
        } catch (e) {
          console.warn(`History POST failed for doc ${docId}:`, e);
        }
      }

      // PATCH triggers server-side lab/vital/medication cascade by document_id.
      const payload = extraction._rawExtraction
        ? { ...extraction._rawExtraction }
        : { ...extraction };
      if (payload.extraction_status === "pending") delete payload.extraction_status;
      await api.patch(`/api/documents/${docId}`, { extracted_data: payload });

      get()._clearPending(docId);
      queryClient.invalidateQueries({ queryKey: qk.companion.patient(patientId) });
    } catch (e) {
      console.error(`BG extraction failed for doc ${docId}:`, e);
      get()._setPending(docId, {
        status: "failed",
        phase: "failed",
        error: e.message || "Extraction failed",
      });
      toast(`Extraction failed for ${fileName || "document"} — retry from patient screen`, "error");
    }
  },

  retryExtraction: (docId) => {
    const entry = get().pendingExtractions[docId];
    if (!entry?.task) {
      toast("Cannot retry — original file is no longer in memory", "error");
      return;
    }
    get()._setPending(docId, {
      status: "extracting",
      phase: entry.task.needsClassify ? "classifying" : "extracting",
      error: null,
    });
    set((s) => ({ _bgQueue: [...s._bgQueue, entry.task] }));
    get()._drainBg();
  },

  // Accept a mismatched document: run the sync phase that was skipped in
  // _runExtractionTask (history POST + PATCH extracted_data), then clear
  // the pending entry. `opts` may be supplied by the UI after reading the
  // doc's extracted_data (used when the page was refreshed and the store
  // no longer has the payload).
  acceptMismatchedExtraction: async (docId, opts = {}) => {
    const entry = get().pendingExtractions[docId];
    const extraction = opts.pendingPayload || entry?.pendingPayload;
    const meta = opts.pendingMeta || entry?.pendingMeta || {};
    const patientId = opts.patientId || entry?.patientId;
    const fileName = opts.fileName || entry?.fileName;

    if (!extraction) {
      toast("Nothing to accept — extraction payload is gone", "error");
      return;
    }

    get()._setPending(docId, { status: "extracting", phase: "syncing", error: null });

    try {
      const hasMeds = (extraction.medications || []).length > 0;
      if (hasMeds) {
        try {
          await api.post(`/api/patients/${patientId}/history`, {
            visit_date:
              meta?.date || extraction.visit_date || new Date().toISOString().slice(0, 10),
            visit_type: "OPD",
            doctor_name: meta?.doctor || extraction.doctor_name || "",
            specialty: meta?.specialty || extraction.specialty || "",
            hospital_name: meta?.hospital || extraction.hospital_name || "",
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
        } catch (e) {
          console.warn(`History POST failed for doc ${docId}:`, e);
        }
      }

      const payload = extraction._rawExtraction
        ? { ...extraction._rawExtraction }
        : { ...extraction };
      if (payload.extraction_status === "pending") delete payload.extraction_status;
      await api.patch(`/api/documents/${docId}`, { extracted_data: payload });

      get()._clearPending(docId);
      if (patientId) {
        queryClient.invalidateQueries({ queryKey: qk.companion.patient(patientId) });
      }
      queryClient.invalidateQueries({ queryKey: ["companion", "mismatchReviews"] });
      toast(`Accepted extraction for ${fileName || "document"}`, "success");
    } catch (e) {
      console.error(`Accept mismatched failed for doc ${docId}:`, e);
      get()._setPending(docId, {
        status: "mismatch",
        phase: "awaiting_review",
        error: e.message || "Accept failed",
      });
      toast(`Failed to accept: ${e.message || "error"}`, "error");
    }
  },

  // Reject a mismatched document: delete the doc row (server cascades to
  // storage cleanup), clear the pending entry, and remove the matching
  // multi-capture item if present.
  rejectMismatchedExtraction: async (docId, opts = {}) => {
    const entry = get().pendingExtractions[docId];
    const patientId = opts.patientId || entry?.patientId;
    const fileName = opts.fileName || entry?.fileName;

    try {
      await api.delete(`/api/documents/${docId}`);
      get()._clearPending(docId);
      set((s) => ({
        multiCapture: {
          ...s.multiCapture,
          items: s.multiCapture.items.filter((it) => it.docId !== docId),
        },
      }));
      if (patientId) {
        queryClient.invalidateQueries({ queryKey: qk.companion.patient(patientId) });
      }
      queryClient.invalidateQueries({ queryKey: ["companion", "mismatchReviews"] });
      toast(`Rejected & deleted ${fileName || "document"}`, "success");
    } catch (e) {
      console.error(`Reject mismatched failed for doc ${docId}:`, e);
      toast(`Failed to reject: ${e.response?.data?.error || e.message}`, "error");
    }
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

  // Per-item category / metadata editors used by the multi-capture preview form.
  multiSetItemCategory: (itemId, category) => get()._patchMultiItem(itemId, { category }),

  multiSetItemMeta: (itemId, patch) =>
    set((s) => ({
      multiCapture: {
        ...s.multiCapture,
        items: s.multiCapture.items.map((it) =>
          it.id === itemId ? { ...it, meta: { ...(it.meta || {}), ...patch } } : it,
        ),
      },
    })),

  // Background classify for all items that don't yet have a category set.
  // Non-blocking: step stays on "preview" so the user can edit while Haiku runs.
  multiAutoClassify: async () => {
    const targets = get().multiCapture.items.filter((it) => !it.category && !it.classifying);
    if (!targets.length) return;
    for (const it of targets) get()._patchMultiItem(it.id, { classifying: true });

    await Promise.allSettled(
      targets.map(async (item) => {
        try {
          const mediaType = normalizeMediaType(item.mediaType);
          const { data, error } = await classifyDocument(item.base64, mediaType);
          // User may have already picked a category while we were classifying —
          // do not overwrite their choice.
          const latest = get().multiCapture.items.find((x) => x.id === item.id);
          if (!latest) return;
          if (latest.category) {
            get()._patchMultiItem(item.id, { classifying: false });
            return;
          }
          if (error || !data) {
            console.warn("Auto-classify returned no data:", error);
            get()._patchMultiItem(item.id, {
              classifying: false,
              classifyError: error || "No classification data",
              category: null,
            });
            return;
          }
          const derived = deriveCategory(data);
          get()._patchMultiItem(item.id, {
            classifying: false,
            classification: data,
            classifyError: null,
            category: derived,
          });
        } catch (e) {
          console.warn("Auto-classify failed:", e);
          get()._patchMultiItem(item.id, {
            classifying: false,
            classifyError: e.message || "Auto-classify failed",
          });
        }
      }),
    );
  },

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
      const pat = extractPatientFromRaw(data);
      return { data: { ...data, patient_name: pat.patient_name, patient_id: pat.patient_id }, error: null };
    }

    if (IMAGING_CATEGORIES.includes(category)) {
      const { data, error } = await extractImaging(item.base64, mediaType);
      if (error) return { data: null, error };
      const d = data || {};
      const pat = extractPatientFromRaw(d);
      return { data: { ...d, patient_name: pat.patient_name, patient_id: pat.patient_id }, error: null };
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
{"patient_name":"","patient_id":"","doc_type":"${category}","findings":"","date":"YYYY-MM-DD","doctor":"","notes":""}`,
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

  // ── Multi save: persist each file + doc record immediately, then enqueue
  // classification + extraction to the background worker. User is returned
  // to the "done" step as soon as all files are saved.
  multiSaveAll: async () => {
    const { selectedPatient, activeAppointmentId, multiCapture } = get();
    if (!selectedPatient?.id) return;

    const pending = multiCapture.items.filter((it) => it.status !== "saved");
    if (!pending.length) return;

    set((s) => ({
      multiCapture: {
        ...s.multiCapture,
        step: "saving",
        saveProgress: { done: 0, total: pending.length, currentLabel: "Uploading files…" },
      },
    }));

    const today = new Date().toISOString().slice(0, 10);
    const tasks = [];
    let done = 0;

    for (const item of pending) {
      get()._patchMultiItem(item.id, { status: "saving", saveError: null });
      try {
        const category = item.category || "other";
        const meta = item.meta || {};
        const isRx = category === "prescription";
        const catLabel = docCategories.find((c) => c.id === category)?.label || category;
        const docDate = meta.date || today;
        const title = isRx
          ? `${meta.doctor || "External"} — ${meta.specialty || category}`
          : `${catLabel.replace(/^[^\s]+\s/, "")} — ${docDate}`;

        const noteParts = [];
        if (activeAppointmentId) noteParts.push(`companion_appt:${activeAppointmentId}`);
        if (meta.hospital) noteParts.push(`Hospital:${meta.hospital}`);
        if (meta.doctor) noteParts.push(`Doctor:${meta.doctor}`);
        const notes = noteParts.join("|");

        const docR = await api.post(`/api/patients/${selectedPatient.id}/documents`, {
          doc_type: category,
          title,
          doc_date: docDate,
          source: "Companion Upload",
          notes,
          extracted_data: { extraction_status: "pending" },
        });
        const docId = docR.data?.id;
        if (!docId) throw new Error("Document creation returned no id");

        try {
          await api.post(`/api/documents/${docId}/upload-file`, {
            base64: item.base64,
            mediaType: item.mediaType || "image/jpeg",
            fileName: item.fileName || `capture_${Date.now()}.jpg`,
          });
        } catch (e) {
          console.warn(`Upload failed for ${item.fileName}:`, e);
        }

        tasks.push({
          docId,
          patientId: selectedPatient.id,
          category,
          base64: item.base64,
          mediaType: item.mediaType || "image/jpeg",
          fileName: item.fileName || `capture_${Date.now()}.jpg`,
          meta,
          // Classification is done in foreground preview now, so bg never needs it.
          needsClassify: false,
        });

        get()._patchMultiItem(item.id, { status: "saved", saveError: null, docId });
      } catch (e) {
        console.error(`Multi save failed for ${item.fileName}:`, e);
        get()._patchMultiItem(item.id, {
          status: "failed",
          saveError: e.response?.data?.error || e.message,
        });
      }
      done += 1;
      set((s) => ({
        multiCapture: {
          ...s.multiCapture,
          saveProgress: { done, total: pending.length, currentLabel: "" },
        },
      }));
    }

    queryClient.invalidateQueries({ queryKey: qk.companion.patient(selectedPatient.id) });
    queryClient.invalidateQueries({ queryKey: qk.companion.appointments(today) });

    for (const task of tasks) get()._enqueueBg(task);

    const items = get().multiCapture.items;
    const savedCount = items.filter((it) => it.status === "saved").length;
    const failedCount = items.filter((it) => it.status === "failed").length;

    set((s) => ({
      multiCapture: {
        ...s.multiCapture,
        step: "done",
        saveProgress: { done: savedCount, total: pending.length, currentLabel: "" },
      },
    }));

    if (savedCount > 0 && failedCount === 0) {
      toast(`Saved ${savedCount} — extracting in background`, "success");
    } else if (savedCount > 0 && failedCount > 0) {
      toast(`Saved ${savedCount}, ${failedCount} failed`, "error");
    } else if (failedCount > 0) {
      toast(`Save failed for ${failedCount} file${failedCount === 1 ? "" : "s"}`, "error");
    }
  },
}));

export default useCompanionStore;
