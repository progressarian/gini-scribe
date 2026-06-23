// React Query hooks for the Patient Flow module. Reads poll on an interval
// (the flow tables live in the main Postgres, which the frontend's Genie
// Supabase realtime client can't see — see FLOW_MANAGEMENT_PLAN.md §6).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

const today = () => new Date().toISOString().split("T")[0];
const errMsg = (err, fallback) =>
  err?.response?.data?.error || err?.response?.data?.message || err?.message || fallback;

// ── Reference data (cached longer — rarely changes) ──
export function useFlowVisitTypes() {
  return useQuery({
    queryKey: qk.flow.visitTypes(),
    queryFn: async () => (await api.get("/api/flow/visit-types")).data,
    staleTime: 5 * 60_000,
  });
}
export function useFlowStepCatalog(all = false) {
  return useQuery({
    queryKey: [...qk.flow.stepCatalog(), all ? "all" : "active"],
    queryFn: async () => (await api.get(`/api/flow/step-catalog${all ? "?all=1" : ""}`)).data,
    staleTime: all ? 0 : 5 * 60_000,
  });
}
export function useFlowTemplate(visitType) {
  return useQuery({
    queryKey: qk.flow.template(visitType),
    queryFn: async () => (await api.get(`/api/flow/templates/${visitType}`)).data,
    enabled: !!visitType,
    staleTime: 5 * 60_000,
  });
}
export function useFlowStaff(role) {
  return useQuery({
    queryKey: qk.flow.staff(role),
    queryFn: async () =>
      (await api.get(`/api/flow/staff${role ? `?role=${encodeURIComponent(role)}` : ""}`)).data,
    staleTime: 5 * 60_000,
  });
}

// ── Live reads (polling) ──
export function useFlowVisits(date = today(), status, options = {}) {
  return useQuery({
    queryKey: qk.flow.visits(date, status),
    queryFn: async () => {
      const params = new URLSearchParams({ date });
      if (status) params.set("status", status);
      return (await api.get(`/api/flow/visits?${params}`)).data;
    },
    refetchInterval: 15_000,
    staleTime: 5_000,
    ...options,
  });
}
export function useFlowVisit(id, options = {}) {
  return useQuery({
    queryKey: qk.flow.visit(id),
    queryFn: async () => (await api.get(`/api/flow/visits/${id}`)).data,
    enabled: !!id,
    refetchInterval: 15_000,
    ...options,
  });
}
export function useFlowQueue(role, date = today(), options = {}) {
  return useQuery({
    queryKey: qk.flow.queue(role, date),
    queryFn: async () => (await api.get(`/api/flow/queue/${role}?date=${date}`)).data,
    enabled: !!role,
    refetchInterval: 10_000,
    staleTime: 3_000,
    ...options,
  });
}
// Active flow visit for the patient currently open in a clinical view.
export function useFlowActiveVisit({ patientDbId, fileNo } = {}, options = {}) {
  return useQuery({
    queryKey: qk.flow.activeVisit(patientDbId, fileNo),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (patientDbId) params.set("patient_db_id", patientDbId);
      if (fileNo) params.set("file_no", fileNo);
      return (await api.get(`/api/flow/active-visit?${params}`)).data;
    },
    enabled: !!(patientDbId || fileNo),
    refetchInterval: 15_000,
    staleTime: 5_000,
    ...options,
  });
}

// Bridge D — flow progress keyed by appointment_id, for OPD/GHM row chips.
export function useFlowByAppointments(date = today(), options = {}) {
  return useQuery({
    queryKey: ["flow", "by-appointments", date],
    queryFn: async () => (await api.get(`/api/flow/by-appointments?date=${date}`)).data,
    refetchInterval: 20_000,
    staleTime: 8_000,
    ...options,
  });
}

// Bridge A — start a flow visit from an existing OPD/GHM appointment.
export function useFlowStartFromAppointment() {
  return useFlowMutation(async (appointmentId) => {
    try {
      return (await api.post(`/api/flow/from-appointment/${appointmentId}`)).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not start flow"));
    }
  });
}

export function useFlowReports(start, end) {
  return useQuery({
    queryKey: qk.flow.reports(start, end),
    queryFn: async () =>
      (await api.get(`/api/flow/reports?start=${start}&end=${end || start}`)).data,
    enabled: !!start,
  });
}

// ── Mutations ── (invalidate the whole flow family so every open view refreshes)
function useFlowMutation(mutationFn) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.flow.all }),
  });
}

export function useFlowCheckin() {
  return useFlowMutation(async (payload) => {
    try {
      return (await api.post("/api/flow/checkin", payload)).data;
    } catch (err) {
      throw new Error(errMsg(err, "Check-in failed"));
    }
  });
}
export function useFlowAdvance() {
  return useFlowMutation(async ({ visitId, step_data, step_id, skip, reason }) => {
    try {
      return (
        await api.post(`/api/flow/visits/${visitId}/advance`, {
          step_data,
          step_id,
          skip,
          reason,
        })
      ).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not advance step"));
    }
  });
}
// Cancel a check-in (started by mistake / patient not present).
export function useFlowCancel() {
  return useFlowMutation(async ({ visitId, reason }) => {
    try {
      return (await api.post(`/api/flow/visits/${visitId}/cancel`, { reason })).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not cancel check-in"));
    }
  });
}
export function useFlowStartStep() {
  return useFlowMutation(async (stepId) => {
    try {
      return (await api.post(`/api/flow/steps/${stepId}/start`)).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not call in patient"));
    }
  });
}
export function useFlowEditDuration() {
  return useFlowMutation(async ({ stepId, new_duration_min }) => {
    try {
      return (await api.patch(`/api/flow/steps/${stepId}/duration`, { new_duration_min })).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not update duration"));
    }
  });
}
export function useFlowReassign() {
  return useFlowMutation(async ({ stepId, ...body }) => {
    try {
      return (await api.patch(`/api/flow/steps/${stepId}/reassign`, body)).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not reassign"));
    }
  });
}
export function useFlowAddStep() {
  return useFlowMutation(async ({ visitId, ...body }) => {
    try {
      return (await api.post(`/api/flow/visits/${visitId}/steps`, body)).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not add step"));
    }
  });
}
export function useFlowReorderSteps() {
  return useFlowMutation(async ({ visitId, order }) => {
    try {
      return (await api.post(`/api/flow/visits/${visitId}/reorder`, { order })).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not reorder steps"));
    }
  });
}
export function useFlowRemoveStep() {
  return useFlowMutation(async (arg) => {
    // Accepts either a bare stepId (back-compat) or { stepId, reason }.
    const { stepId, reason } = typeof arg === "object" && arg !== null ? arg : { stepId: arg };
    try {
      return (
        await api.delete(`/api/flow/steps/${stepId}`, {
          data: reason ? { reason } : undefined,
        })
      ).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not remove step"));
    }
  });
}

// ── Admin settings ──
export function useFlowEditVisitType() {
  return useFlowMutation(async ({ id, ...body }) => {
    try {
      return (await api.patch(`/api/flow/visit-types/${id}`, body)).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not update benchmark"));
    }
  });
}
export function useFlowEditCatalog() {
  return useFlowMutation(async ({ id, ...body }) => {
    try {
      return (await api.patch(`/api/flow/step-catalog/${id}`, body)).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not update step"));
    }
  });
}
export function useFlowCreateCatalogStep() {
  return useFlowMutation(async (body) => {
    try {
      return (await api.post("/api/flow/step-catalog", body)).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not create step"));
    }
  });
}
export function useFlowDeleteCatalogStep() {
  return useFlowMutation(async (id) => {
    try {
      return (await api.delete(`/api/flow/step-catalog/${id}`)).data;
    } catch (err) {
      throw new Error(errMsg(err, "Could not delete step"));
    }
  });
}
