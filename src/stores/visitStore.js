import { create } from "zustand";
import api from "../services/api.js";
import useVitalsStore from "./vitalsStore.js";
import useLabStore from "./labStore.js";

const useVisitStore = create((set, get) => ({
  // ── state ──
  visitActive: false,
  visitId: null,
  visitPatientId: null, // tracks which patient the current visit belongs to
  activeApptId: null,
  visitStatus: null, // 'scheduled','in-progress','completed','cancelled','no_show'
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
  setVisitStatus: (val) => set({ visitStatus: val }),
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
      visitPatientId: dbPatientId || null,
      activeApptId: apptId || null,
      visitStatus: "in-progress",
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
        status: "in-progress",
        route: targetRoute,
      })
      .catch(() => {
        /* non-critical */
      });
    return isFollowUp ? "fu_load" : "intake";
  },

  endVisit: (markCompleted) => {
    const { visitPatientId } = get();
    set({
      visitActive: false,
      visitId: null,
      visitPatientId: null,
      activeApptId: null,
      visitStatus: markCompleted ? "completed" : "cancelled",
    });
    // Clear from DB — target this specific patient's visit
    const params = new URLSearchParams();
    if (markCompleted) params.set("markCompleted", "1");
    if (visitPatientId) params.set("patient_id", visitPatientId);
    api.delete(`/api/active-visit?${params}`).catch(() => {
      /* non-critical */
    });
    // Caller should navigate("/")
  },

  // Restore active visit from DB on page load (most recent in-progress visit)
  restoreVisit: async () => {
    try {
      const { data: av } = await api.get("/api/active-visit");
      if (!av) return null;
      set({
        visitActive: true,
        visitId: av.id?.toString() || Date.now().toString(),
        visitPatientId: av.patient_id || null,
        activeApptId: av.appointment_id || null,
        visitStatus: av.status || "in-progress",
      });
      // Restore any saved step data (vitals, fuChecks, etc.)
      if (av.step_data) get().restoreDraft(av.step_data);
      // Return the visit data so the caller can restore patient + navigate
      return av;
    } catch {
      return null;
    }
  },

  // Update the current route in DB (so refresh lands on the right page)
  updateVisitRoute: (route) => {
    const { visitPatientId } = get();
    api.put("/api/active-visit", { route, patient_id: visitPatientId }).catch(() => {
      /* non-critical */
    });
  },

  // Update the visit status
  updateVisitStatus: (status) => {
    const { visitPatientId } = get();
    set({ visitStatus: status });
    api.put("/api/active-visit", { status, patient_id: visitPatientId }).catch(() => {
      /* non-critical */
    });
  },

  // Save draft of all FU step data to the active_visit record in DB.
  // Called on each "Continue" button so data survives page refresh.
  saveDraft: async () => {
    const {
      visitPatientId,
      fuChecks,
      complaints,
      fuExtMeds,
      fuNewConditions,
      fuMedEdits,
      fuNewMeds,
      fuAbnormalActions,
      fuConNotes,
      fuMoNotes,
      fuPlanGenerated,
      fuPlanSource,
      complaintText,
    } = get();
    if (!visitPatientId) return;

    const vitals = useVitalsStore.getState().vitals;
    const { labData, intakeReports } = useLabStore.getState();

    const stepData = {
      vitals,
      labData,
      // Strip base64 from reports to keep payload small
      intakeReports: (intakeReports || []).map(({ base64, ...rest }) => rest),
      fuChecks,
      complaints,
      complaintText,
      fuExtMeds,
      fuNewConditions,
      fuMedEdits,
      fuNewMeds,
      fuAbnormalActions,
      fuConNotes,
      fuMoNotes,
      fuPlanGenerated,
      fuPlanSource,
    };

    try {
      await api.put("/api/active-visit", { step_data: stepData, patient_id: visitPatientId });
    } catch {
      /* non-critical */
    }
  },

  // Restore draft data from an active_visit's step_data into the appropriate stores.
  restoreDraft: (stepData) => {
    if (!stepData || typeof stepData !== "object" || Object.keys(stepData).length === 0) return;

    // Restore vitals
    if (stepData.vitals && Object.values(stepData.vitals).some(Boolean)) {
      useVitalsStore.getState().setVitals(stepData.vitals);
    }
    // Restore lab data
    if (stepData.labData) {
      useLabStore.getState().setLabData(stepData.labData);
    }
    if (stepData.intakeReports?.length) {
      useLabStore.getState().setIntakeReports(stepData.intakeReports);
    }
    // Restore visit store FU state
    const patch = {};
    if (stepData.fuChecks) patch.fuChecks = stepData.fuChecks;
    if (stepData.complaints) patch.complaints = stepData.complaints;
    if (stepData.complaintText) patch.complaintText = stepData.complaintText;
    if (stepData.fuExtMeds) patch.fuExtMeds = stepData.fuExtMeds;
    if (stepData.fuNewConditions) patch.fuNewConditions = stepData.fuNewConditions;
    if (stepData.fuMedEdits) patch.fuMedEdits = stepData.fuMedEdits;
    if (stepData.fuNewMeds) patch.fuNewMeds = stepData.fuNewMeds;
    if (stepData.fuAbnormalActions) patch.fuAbnormalActions = stepData.fuAbnormalActions;
    if (stepData.fuConNotes) patch.fuConNotes = stepData.fuConNotes;
    if (stepData.fuMoNotes) patch.fuMoNotes = stepData.fuMoNotes;
    if (stepData.fuPlanGenerated) patch.fuPlanGenerated = stepData.fuPlanGenerated;
    if (stepData.fuPlanSource) patch.fuPlanSource = stepData.fuPlanSource;
    if (Object.keys(patch).length) set(patch);
  },

  // Sync visit state from backend when switching patients.
  // Queries the backend for an in-progress visit for THIS specific patient.
  // Multiple patients can have concurrent in-progress visits.
  syncVisitForPatient: async (pid) => {
    const clearVisit = {
      visitActive: false,
      visitId: null,
      visitPatientId: null,
      activeApptId: null,
      visitStatus: null,
    };
    if (!pid) {
      set(clearVisit);
      return null;
    }
    try {
      const { data: av } = await api.get(`/api/active-visit?patient_id=${pid}`);
      if (av && av.status === "in-progress") {
        set({
          visitActive: true,
          visitId: av.id?.toString() || Date.now().toString(),
          visitPatientId: Number(pid),
          activeApptId: av.appointment_id || null,
          visitStatus: av.status,
        });
        // Restore any saved step data
        if (av.step_data) get().restoreDraft(av.step_data);
        return av;
      }
      set(clearVisit);
      return null;
    } catch {
      set(clearVisit);
      return null;
    }
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
      visitPatientId: null,
      activeApptId: null,
      visitStatus: null,
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
