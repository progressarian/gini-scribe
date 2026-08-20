import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

const arr = (v) => (Array.isArray(v) ? v : []);

const idKey = (ids) => [...new Set(ids)].sort((a, b) => a - b).join(",");

export const PAGE_SIZE = 50;

export function useGhmDoctors() {
  return useQuery({
    queryKey: qk.ghm.doctors(),
    queryFn: async () => {
      const { data } = await api.get("/api/ghm-appointments/doctors");
      return arr(data).map((d) => d.doctor_name);
    },
    staleTime: 10 * 60 * 1000,
  });
}

export function useCcAgents() {
  return useQuery({
    queryKey: qk.ghm.ccAgents(),
    queryFn: async () => {
      const { data } = await api.get("/api/cc-calling/agents");
      return arr(data).map((a) => a.name);
    },
    staleTime: 10 * 60 * 1000,
  });
}

export function useGhmList({ buildQuery, enabled = true, keepPrevious = true }) {
  return useInfiniteQuery({
    queryKey: qk.ghm.list(buildQuery(1, PAGE_SIZE).toString()),
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get(`/api/ghm-appointments?${buildQuery(pageParam, PAGE_SIZE)}`);
      return data || {};
    },
    initialPageParam: 1,
    getNextPageParam: (last, pages) =>
      (last?.page || pages.length) < (last?.totalPages || 1)
        ? (last?.page || pages.length) + 1
        : undefined,
    enabled,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    staleTime: 15_000,
  });
}

function useIdBatch(keyFn, url, ids, field) {
  const key = idKey(ids);
  return useQuery({
    queryKey: keyFn(key),
    queryFn: async () => {
      const { data } = await api.post(url, { [field]: key.split(",").map(Number) });
      return data || {};
    },
    enabled: key.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useGhmBiomarkers(patientIds) {
  return useIdBatch(
    qk.ghm.biomarkers,
    "/api/ghm-appointments/biomarkers",
    patientIds,
    "patient_ids",
  );
}

export function useGhmLastMo(patientIds) {
  return useIdBatch(qk.ghm.lastMo, "/api/ghm-appointments/last-mo", patientIds, "patient_ids");
}

export function useCallAttemptCounts(appointmentIds) {
  return useIdBatch(
    qk.ghm.attemptCounts,
    "/api/call-attempts/counts",
    appointmentIds,
    "appointment_ids",
  );
}

export function useCallAttempts(appointmentId) {
  return useQuery({
    queryKey: qk.ghm.callAttempts(appointmentId),
    queryFn: async () => {
      const { data } = await api.get(`/api/call-attempts?appointment_id=${appointmentId}`);
      return arr(data);
    },
  });
}

export function useAppointmentChanges(appointmentId) {
  return useQuery({
    queryKey: qk.ghm.changes(appointmentId),
    queryFn: async () => {
      const { data } = await api.get(`/api/appointment-changes?appointment_id=${appointmentId}`);
      return arr(data);
    },
  });
}

export function useDayAvailability(doctor, date) {
  return useQuery({
    queryKey: qk.ghm.availability(doctor, date),
    queryFn: async () => {
      const { data } = await api.get(
        `/api/availability/day?doctor=${encodeURIComponent(doctor)}&date=${date}`,
      );
      return data?.resolved ? data.slots || [] : null;
    },
    enabled: !!doctor && !!date,
    staleTime: 60_000,
  });
}

export function useDoctorConflicts(date, enabled = true) {
  return useQuery({
    queryKey: qk.ghm.conflicts(date),
    queryFn: async () => {
      const { data } = await api.get(`/api/appointments/conflicts?date=${date}`);
      return arr(data?.conflicts);
    },
    enabled,
  });
}

function useGhmMutation(mutationFn, options = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    ...options,
    onSettled: (...args) => {
      queryClient.invalidateQueries({ queryKey: qk.ghm.all });
      options.onSettled?.(...args);
    },
  });
}

export function usePatchAppointment(listKey, applyOptimistic) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, field, value }) => {
      const { data } = await api.patch(`/api/ghm-appointments/${id}`, { [field]: value });
      return data;
    },
    onMutate: async ({ id, field, value }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData(listKey);
      queryClient.setQueryData(listKey, (old) => applyOptimistic(old, id, field, value));
      return { previous };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(listKey, ctx.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.ghm.all, refetchType: "none" }),
  });
}

export function useCreateAppointment() {
  return useGhmMutation(async (form) => {
    const { data } = await api.post("/api/ghm-appointments", form);
    return data;
  });
}

export function useLogCallAttempt() {
  return useGhmMutation(async (body) => {
    const { data } = await api.post("/api/call-attempts", body);
    return data;
  });
}

export function useDeleteCallAttempt() {
  return useGhmMutation(async (id) => {
    const { data } = await api.delete(`/api/call-attempts/${id}`);
    return data;
  });
}

export function useDeleteAppointmentChange() {
  return useGhmMutation(async (id) => {
    const { data } = await api.delete(`/api/appointment-changes/${id}`);
    return data;
  });
}

export function useReassignAppointment() {
  return useGhmMutation(async ({ appointmentId, body }) => {
    const { data } = await api.put(`/api/appointments/${appointmentId}/reassign`, body);
    return data;
  });
}

// One request for the whole list: `export=1` tells the API to ignore paging and
// return every row the current filters match. Walking pages could also miss or
// repeat rows when the data shifted mid-export.
export function useExportPages(buildQuery, exportPageSize) {
  return useMutation({
    mutationFn: async () => {
      const params = buildQuery(1, exportPageSize);
      params.set("export", "1");
      const { data } = await api.get(`/api/ghm-appointments?${params}`);
      if (data?.truncated) {
        window.alert(
          `This view has ${data.total} rows and the export is capped at ${data.exported}. ` +
            `Narrow it with a filter to get the rest.`,
        );
      }
      return arr(data?.data);
    },
  });
}
