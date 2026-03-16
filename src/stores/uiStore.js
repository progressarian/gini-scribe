import { create } from "zustand";
import api from "../services/api.js";

let searchTimer = null;

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
    const { searchPeriod, searchDoctor } = get();
    set({ searchLoading: true });
    try {
      const params = new URLSearchParams({ limit: "30", page: "1" });
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
}));

export default useUiStore;
