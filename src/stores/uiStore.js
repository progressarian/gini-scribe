import { create } from "zustand";
import api from "../services/api.js";
import usePatientStore from "./patientStore.js";
import useVitalsStore from "./vitalsStore.js";
import useClinicalStore from "./clinicalStore.js";
import usePlanStore from "./planStore.js";
import useAuthStore from "./authStore.js";
import useLabStore from "./labStore.js";

let searchTimer = null;
let _toastFn = null;

// Global toast — callable from stores, components, anywhere
export const toast = (message, type = "success", duration = 4000) => {
  if (_toastFn) _toastFn(message, type, duration);
};

// Called once from App to wire up the React toast context
export const setToastFn = (fn) => {
  _toastFn = fn;
};

const useUiStore = create((set, get) => ({
  // ── state ──
  loading: {},
  errors: {},
  saveStatus: "",
  draftSaved: "",
  showSearch: false,
  searchQuery: "",
  searchPeriod: "", // "", "today", "week", "month"
  searchDoctor: "",
  searchDoctorsList: [],
  searchStats: null,
  dbPatients: [],
  searchLoading: false,
  searchPage: 1,
  searchTotalPages: 1,
  searchTotal: 0,
  searchLoadingMore: false,

  // ── simple setters ──
  setLoading: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ loading: valOrFn(state.loading) }));
    } else {
      set({ loading: valOrFn });
    }
  },
  setErrors: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ errors: valOrFn(state.errors) }));
    } else {
      set({ errors: valOrFn });
    }
  },
  setSaveStatus: (val) => set({ saveStatus: val }),
  setDraftSaved: (val) => set({ draftSaved: val }),
  setShowSearch: (val) => set({ showSearch: val }),
  setSearchQuery: (val) => set({ searchQuery: val }),
  setSearchPeriod: (val) => set({ searchPeriod: val }),
  setSearchDoctor: (val) => set({ searchDoctor: val }),
  setSearchDoctorsList: (val) => set({ searchDoctorsList: val }),
  setSearchStats: (val) => set({ searchStats: val }),
  setDbPatients: (val) => set({ dbPatients: val }),

  // ── clearErr ──
  clearErr: (id) => set((state) => ({ errors: { ...state.errors, [id]: null } })),

  // ── searchPatientsDB (paginated, resets to page 1) ──
  searchPatientsDB: async (q, period, doctor, toast) => {
    set({ searchLoading: true });
    try {
      const params = new URLSearchParams({ limit: "30", page: "1" });
      if (q && q.length >= 2) params.set("q", q);
      if (period) params.set("period", period);
      if (doctor) params.set("doctor", doctor);
      const { data: res } = await api.get(`/api/patients?${params}`);
      set({
        dbPatients: res.data || [],
        searchPage: res.page || 1,
        searchTotalPages: res.totalPages || 1,
        searchTotal: res.total || 0,
      });
    } catch (err) {
      if (toast) toast("Patient search failed", "warn");
      set({ dbPatients: [], searchPage: 1, searchTotalPages: 1, searchTotal: 0 });
    }
    set({ searchLoading: false });
  },

  // ── debounced search (for typing) ──
  debouncedSearch: (q, period, doctor) => {
    clearTimeout(searchTimer);
    set({ searchQuery: q });
    searchTimer = setTimeout(() => {
      get().searchPatientsDB(q, period, doctor);
    }, 350);
  },

  // ── loadMorePatients (next page, appends) ──
  loadMorePatients: async () => {
    const { searchPage, searchTotalPages, searchQuery, searchPeriod, searchDoctor } = get();
    if (searchPage >= searchTotalPages) return;
    const nextPage = searchPage + 1;
    set({ searchLoadingMore: true });
    try {
      const params = new URLSearchParams({ limit: "30", page: String(nextPage) });
      if (searchQuery && searchQuery.length >= 2) params.set("q", searchQuery);
      if (searchPeriod) params.set("period", searchPeriod);
      if (searchDoctor) params.set("doctor", searchDoctor);
      const { data: res } = await api.get(`/api/patients?${params}`);
      set((s) => ({
        dbPatients: [...s.dbPatients, ...(res.data || [])],
        searchPage: res.page || nextPage,
        searchTotalPages: res.totalPages || s.searchTotalPages,
        searchTotal: res.total || s.searchTotal,
      }));
    } catch {
      /* silent */
    }
    set({ searchLoadingMore: false });
  },

  // ── openSearch ──
  openSearch: async (toast) => {
    const { showSearch, searchPeriod, searchDoctor, searchPatientsDB } = get();
    const next = !showSearch;
    set({ showSearch: next });
    if (next) {
      searchPatientsDB("", searchPeriod, searchDoctor, toast);
      // Load stats (includes doctor list with patient counts)
      try {
        const { data: stats } = await api.get("/api/stats");
        set({ searchDoctorsList: stats.doctors || [], searchStats: stats });
      } catch (err) {
        if (toast) toast("Failed to load search data", "warn");
      }
    }
  },

  // ── clearSearch ──
  clearSearch: () =>
    set({
      searchQuery: "",
      dbPatients: [],
      searchPage: 1,
      searchTotalPages: 1,
      searchTotal: 0,
    }),

  // ── initFind: called when FindPage mounts ──
  initFind: async () => {
    const { searchQuery, searchPeriod, searchDoctor } = get();
    set({ searchLoading: true });
    try {
      const params = new URLSearchParams({ limit: "30", page: "1" });
      if (searchQuery && searchQuery.length >= 2) params.set("q", searchQuery);
      if (searchPeriod) params.set("period", searchPeriod);
      if (searchDoctor) params.set("doctor", searchDoctor);
      const [pResp, sResp] = await Promise.all([
        api.get(`/api/patients?${params}`),
        api.get("/api/stats"),
      ]);
      const res = pResp.data;
      set({
        dbPatients: res.data || [],
        searchPage: res.page || 1,
        searchTotalPages: res.totalPages || 1,
        searchTotal: res.total || 0,
        searchDoctorsList: sResp.data.doctors || [],
        searchStats: sResp.data,
      });
    } catch {
      /* silent */
    }
    set({ searchLoading: false });
  },

  // ── saveConsultation: persist patient + vitals + clinical data ──
  saveConsultation: async () => {
    const { patient, dbPatientId, savePatient, setPatientFullData } = usePatientStore.getState();
    if (!patient.name?.trim()) return;

    set({ saveStatus: "Saving..." });

    try {
      // 1. Ensure patient is saved in DB
      let patientId = dbPatientId;
      if (!patientId) {
        const result = await savePatient();
        if (result.error) {
          set({ saveStatus: "Save failed" });
          setTimeout(() => set({ saveStatus: "" }), 3000);
          return;
        }
        patientId = result.data?.id;
      }

      // 2. Gather clinical data from stores
      const vitals = useVitalsStore.getState().vitals;
      const { moData, conData, moTranscript, conTranscript, quickTranscript } =
        useClinicalStore.getState();
      const { planEdits, nextVisitDate } = usePlanStore.getState();
      const currentDoctor = useAuthStore.getState().currentDoctor;

      // 3. Save consultation to backend
      const payload = {
        patient: {
          name: patient.name,
          phone: patient.phone || null,
          age: patient.age || null,
          sex: patient.sex || null,
          fileNo: patient.fileNo || null,
          abhaId: patient.abhaId || null,
          healthId: patient.healthId || null,
          aadhaar: patient.aadhaar || null,
          govtId: patient.govtId || null,
          govtIdType: patient.govtIdType || null,
          dob: patient.dob || null,
          address: patient.address || null,
        },
        vitals: vitals || {},
        moData: moData || null,
        conData: conData
          ? {
              ...conData,
              follow_up: {
                ...(conData.follow_up || {}),
                date: nextVisitDate || conData?.follow_up?.date || null,
              },
            }
          : nextVisitDate
            ? { follow_up: { date: nextVisitDate } }
            : null,
        moTranscript: moTranscript || null,
        conTranscript: conTranscript || null,
        quickTranscript: quickTranscript || null,
        moName: currentDoctor?.name || null,
        conName: currentDoctor?.name || null,
        planEdits: planEdits || {},
        moDoctorId: currentDoctor?.doctor_id || null,
        conDoctorId: currentDoctor?.doctor_id || null,
        visitDate: new Date().toISOString().split("T")[0],
      };

      await api.post("/api/consultations", payload);

      // 4. Save any unsaved intake reports
      try {
        await useLabStore.getState().saveAllIntakeReports(patientId);
      } catch {
        /* non-critical */
      }

      // 5. Refresh patient full data
      try {
        const { data: full } = await api.get(`/api/patients/${patientId}`);
        setPatientFullData(full);
      } catch {
        /* non-critical */
      }

      set({ saveStatus: "Saved", draftSaved: "" });
      setTimeout(() => set({ saveStatus: "" }), 3000);
    } catch (e) {
      console.error("Save consultation failed:", e);
      set({ saveStatus: "Save failed" });
      setTimeout(() => set({ saveStatus: "" }), 3000);
    }
  },
}));

export default useUiStore;
