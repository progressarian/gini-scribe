import { create } from "zustand";
import api from "../services/api.js";

const useVisitStore = create((set, get) => ({
  // ── state ──
  visitActive: false,
  visitId: null,
  activeApptId: null,
  complaints: [],
  complaintText: "",
  fuChecks: {
    medCompliance: "",
    dietExercise: "",
    sideEffects: "",
    newSymptoms: "",
    challenges: "",
  },
  fuExtMeds: [],
  fuNewConditions: [],
  fuMedEdits: {},
  fuNewMeds: [],
  fuPlanSource: null,
  fuShowLastSummary: false,
  fuAbnormalActions: {},
  fuConNotes: "",
  fuMoNotes: "",
  fuPlanGenerated: false,
  appointments: [],
  todayAppointments: [],
  todayApptLoading: false,
  todayApptPage: 1,
  todayApptTotalPages: 1,
  todayApptTotal: 0,
  todayApptLoadingMore: false,
  todayApptDoctor: "",
  showQuickBook: false,
  quickBookPatient: { name: "", file_no: "", phone: "" },
  showBooking: false,
  bookForm: {
    dt: "",
    tm: "",
    ty: "OPD",
    sp: "",
    doc: "",
    notes: "",
    labPickup: "hospital",
    labTests: [],
  },
  editApptId: null,

  // ── simple setters ──
  setVisitActive: (val) => set({ visitActive: val }),
  setVisitId: (val) => set({ visitId: val }),
  setComplaints: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ complaints: valOrFn(state.complaints) }));
    } else {
      set({ complaints: valOrFn });
    }
  },
  setComplaintText: (val) => set({ complaintText: val }),
  setFuChecks: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ fuChecks: valOrFn(state.fuChecks) }));
    } else {
      set({ fuChecks: valOrFn });
    }
  },
  setFuExtMeds: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ fuExtMeds: valOrFn(state.fuExtMeds) }));
    } else {
      set({ fuExtMeds: valOrFn });
    }
  },
  setFuNewConditions: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ fuNewConditions: valOrFn(state.fuNewConditions) }));
    } else {
      set({ fuNewConditions: valOrFn });
    }
  },
  setFuMedEdits: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ fuMedEdits: valOrFn(state.fuMedEdits) }));
    } else {
      set({ fuMedEdits: valOrFn });
    }
  },
  setFuNewMeds: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ fuNewMeds: valOrFn(state.fuNewMeds) }));
    } else {
      set({ fuNewMeds: valOrFn });
    }
  },
  setFuPlanSource: (val) => set({ fuPlanSource: val }),
  setFuShowLastSummary: (val) => set({ fuShowLastSummary: val }),
  setFuAbnormalActions: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ fuAbnormalActions: valOrFn(state.fuAbnormalActions) }));
    } else {
      set({ fuAbnormalActions: valOrFn });
    }
  },
  setFuConNotes: (val) => set({ fuConNotes: val }),
  setFuMoNotes: (val) => set({ fuMoNotes: val }),
  setFuPlanGenerated: (val) => set({ fuPlanGenerated: val }),
  setAppointments: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ appointments: valOrFn(state.appointments) }));
    } else {
      set({ appointments: valOrFn });
    }
  },
  setTodayAppointments: (val) => set({ todayAppointments: val }),
  setTodayApptLoading: (val) => set({ todayApptLoading: val }),
  setTodayApptDoctor: (val) => set({ todayApptDoctor: val }),
  setShowQuickBook: (val) => set({ showQuickBook: val }),
  setQuickBookPatient: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ quickBookPatient: valOrFn(state.quickBookPatient) }));
    } else {
      set({ quickBookPatient: valOrFn });
    }
  },
  setShowBooking: (val) => set({ showBooking: val }),
  setBookForm: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ bookForm: valOrFn(state.bookForm) }));
    } else {
      set({ bookForm: valOrFn });
    }
  },
  setEditApptId: (val) => set({ editApptId: val }),

  // ── actions ──

  // Start a new visit
  // Returns the target tab path ("fu_load" or "intake") so the caller can setTab
  startVisit: (apptId, { isFollowUp, duplicateWarning, dbPatientId } = {}) => {
    if (duplicateWarning && !dbPatientId) return null; // Block visit start when duplicate detected
    const visitId = Date.now().toString();
    const visitType = isFollowUp ? "followup" : "new";
    const targetRoute = isFollowUp ? "/fu-load" : "/intake";
    set({
      visitActive: true,
      visitId,
      activeApptId: apptId || null,
      complaints: [],
      complaintText: "",
    });
    // If starting from appointment, mark it locally
    if (apptId) {
      set((state) => ({
        appointments: state.appointments.map((a) =>
          a.id === apptId ? { ...a, st: "in-progress" } : a,
        ),
      }));
    }
    // Reset follow-up workflow state
    if (isFollowUp) {
      set({
        fuMedEdits: {},
        fuNewMeds: [],
        fuPlanSource: null,
        fuShowLastSummary: false,
        fuAbnormalActions: {},
        fuConNotes: "",
        fuMoNotes: "",
        fuPlanGenerated: false,
      });
    }
    // Persist to DB (fire-and-forget)
    api
      .post("/api/active-visit", {
        patient_id: dbPatientId || null,
        appointment_id: typeof apptId === "number" ? apptId : null,
        visit_type: visitType,
        route: targetRoute,
      })
      .catch(() => {
        /* non-critical */
      });
    return isFollowUp ? "fu_load" : "intake";
  },

  endVisit: (markCompleted) => {
    set({
      visitActive: false,
      visitId: null,
      activeApptId: null,
    });
    // Clear from DB (fire-and-forget)
    api
      .delete(`/api/active-visit${markCompleted ? "?markCompleted=1" : ""}`)
      .catch(() => {
        /* non-critical */
      });
    // Caller should navigate("/")
  },

  // Restore active visit from DB on page load
  restoreVisit: async () => {
    try {
      const { data: av } = await api.get("/api/active-visit");
      if (!av) return null;
      set({
        visitActive: true,
        visitId: av.id?.toString() || Date.now().toString(),
        activeApptId: av.appointment_id || null,
      });
      // Return the visit data so the caller can restore patient + navigate
      return av;
    } catch {
      return null;
    }
  },

  // Update the current route in DB (so refresh lands on the right page)
  updateVisitRoute: (route) => {
    api.put("/api/active-visit", { route }).catch(() => {
      /* non-critical */
    });
  },

  // Booking
  openBooking: (appt) => {
    if (appt) {
      set({
        editApptId: appt.id,
        bookForm: {
          dt: appt.dt || "",
          tm: appt.tm || "",
          ty: appt.ty || "OPD",
          sp: appt.sp || "",
          doc: appt.doc || "",
          notes: appt.notes || "",
        },
        showBooking: true,
      });
    } else {
      set({
        editApptId: null,
        bookForm: { dt: "", tm: "", ty: "OPD", sp: "", doc: "", notes: "" },
        showBooking: true,
      });
    }
  },

  saveBooking: async (toast, { dbPatientId, patient } = {}) => {
    const { editApptId, bookForm } = get();
    const apptData = {
      patient_id: dbPatientId || null,
      patient_name: patient?.name || "",
      file_no: patient?.fileNo || "",
      phone: patient?.phone || "",
      doctor_name: bookForm.doc || "",
      appointment_date: bookForm.dt || new Date().toISOString().split("T")[0],
      time_slot: bookForm.tm || null,
      visit_type: bookForm.ty || "OPD",
      notes: bookForm.notes || null,
    };
    try {
      if (editApptId && typeof editApptId === "number") {
        await api.put(`/api/appointments/${editApptId}`, apptData);
      } else {
        const { data: saved } = await api.post("/api/appointments", apptData);
        // Also add to local per-patient appointments
        set((state) => ({
          appointments: [
            ...state.appointments,
            { id: saved.id || "apt_" + Date.now(), ...state.bookForm, st: "scheduled" },
          ],
        }));
      }
      get().fetchTodayAppointments(toast);
    } catch (e) {
      toast("Appointment saved locally only", "warn");
      // Fallback to local-only
      if (editApptId) {
        set((state) => ({
          appointments: state.appointments.map((a) =>
            a.id === editApptId ? { ...a, ...state.bookForm } : a,
          ),
        }));
      } else {
        set((state) => ({
          appointments: [
            ...state.appointments,
            { id: "apt_" + Date.now(), ...state.bookForm, st: "scheduled" },
          ],
        }));
      }
    }
    set({ showBooking: false });
  },

  cancelAppt: async (id, toast) => {
    set((state) => ({
      appointments: state.appointments.filter((a) => a.id !== id),
    }));
    if (typeof id === "number") {
      try {
        await api.delete(`/api/appointments/${id}`);
        get().fetchTodayAppointments(toast);
      } catch (e) {
        toast("Failed to cancel appointment");
      }
    }
  },

  fetchTodayAppointments: async (toast) => {
    const { todayApptDoctor } = get();
    set({ todayApptLoading: true });
    try {
      const params = new URLSearchParams({ page: "1", limit: "20" });
      if (todayApptDoctor) params.set("doctor", todayApptDoctor);
      const { data: res } = await api.get(`/api/appointments?${params}`);
      set({
        todayAppointments: res.data || [],
        todayApptPage: res.page || 1,
        todayApptTotalPages: res.totalPages || 1,
        todayApptTotal: res.total || 0,
      });
    } catch (e) {
      if (toast) toast("Failed to load appointments", "warn");
    }
    set({ todayApptLoading: false });
  },

  loadMoreAppointments: async () => {
    const { todayApptPage, todayApptTotalPages, todayApptDoctor } = get();
    if (todayApptPage >= todayApptTotalPages) return;
    const nextPage = todayApptPage + 1;
    set({ todayApptLoadingMore: true });
    try {
      const params = new URLSearchParams({ page: String(nextPage), limit: "20" });
      if (todayApptDoctor) params.set("doctor", todayApptDoctor);
      const { data: res } = await api.get(`/api/appointments?${params}`);
      set((s) => ({
        todayAppointments: [...s.todayAppointments, ...(res.data || [])],
        todayApptPage: res.page || nextPage,
        todayApptTotalPages: res.totalPages || s.todayApptTotalPages,
        todayApptTotal: res.total || s.todayApptTotal,
      }));
    } catch {
      /* silent */
    }
    set({ todayApptLoadingMore: false });
  },

  // Reset all visit state
  resetVisit: () => {
    set({
      visitActive: false,
      visitId: null,
      activeApptId: null,
      complaints: [],
      complaintText: "",
      fuChecks: {
        medCompliance: "",
        dietExercise: "",
        sideEffects: "",
        newSymptoms: "",
        challenges: "",
      },
      fuExtMeds: [],
      fuNewConditions: [],
      fuMedEdits: {},
      fuNewMeds: [],
      fuPlanSource: null,
      fuShowLastSummary: false,
      fuAbnormalActions: {},
      fuConNotes: "",
      fuMoNotes: "",
      fuPlanGenerated: false,
      appointments: [],
      todayAppointments: [],
      todayApptLoading: false,
      todayApptPage: 1,
      todayApptTotalPages: 1,
      todayApptTotal: 0,
      todayApptLoadingMore: false,
      todayApptDoctor: "",
      showQuickBook: false,
      quickBookPatient: { name: "", file_no: "", phone: "" },
      showBooking: false,
      bookForm: {
        dt: "",
        tm: "",
        ty: "OPD",
        sp: "",
        doc: "",
        notes: "",
        labPickup: "hospital",
        labTests: [],
      },
      editApptId: null,
    });
  },
}));

export default useVisitStore;
