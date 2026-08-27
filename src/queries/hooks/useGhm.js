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

// How many charts on one phone number the booking form will offer to choose
// between. Beyond this the desk should search by name or File No instead.
export const PHONE_MATCH_LIMIT = 10;

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

function useIdBatch(keyFn, url, ids, field, options = {}) {
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
    ...options,
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

export function useGhmSlotCounts(dates) {
  const key = [...new Set((dates || []).filter(Boolean))].sort().join(",");
  return useQuery({
    queryKey: qk.ghm.slotCounts(key),
    queryFn: async () => {
      const { data } = await api.get(
        `/api/ghm-appointments/slot-counts?dates=${encodeURIComponent(key)}`,
      );
      return data || {};
    },
    enabled: key.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

// Day-scoped discount-category tallies. Not taken from the list summary, which
// counts only the rows the current filters match — this is the whole day's mix.
export function useCategoryCounts(date) {
  return useQuery({
    queryKey: qk.ghm.categoryCounts(date),
    queryFn: async () => {
      const { data } = await api.get(`/api/ghm-appointments/category-counts?date=${date}`);
      return data?.categories || {};
    },
    enabled: !!date,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useCallAttemptCounts(appointmentIds) {
  return useIdBatch(
    qk.ghm.attemptCounts,
    "/api/call-attempts/counts",
    appointmentIds,
    "appointment_ids",
  );
}

// Who is on a call with which patient right now. Polled, not pushed: the flag
// only has to be fresh enough that a second agent sees it before dialling, and
// it expires server-side, so a short interval is enough.
export function useActiveCalls(appointmentIds) {
  return useIdBatch(
    qk.ghm.activeCalls,
    "/api/ghm-appointments/active-calls",
    appointmentIds,
    "appointment_ids",
    { staleTime: 5_000, refetchInterval: 15_000, refetchOnWindowFocus: true },
  );
}

export function useCallClaim() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["ghm", "active-calls"] });
  const claim = useMutation({
    mutationFn: async (appointmentId) => {
      const { data } = await api.post(`/api/ghm-appointments/${appointmentId}/calling`);
      return data;
    },
    onSettled: invalidate,
  });
  const release = useMutation({
    mutationFn: async (appointmentId) => {
      const { data } = await api.delete(`/api/ghm-appointments/${appointmentId}/calling`);
      return data;
    },
    onSettled: invalidate,
  });
  return { claim, release };
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

export function usePatientByFileNo(fileNo) {
  const trimmed = String(fileNo || "").trim();
  return useQuery({
    queryKey: qk.ghm.patientByFileNo(trimmed),
    queryFn: async () => {
      const { data } = await api.get(`/api/patients?q=${encodeURIComponent(trimmed)}&limit=1`);
      const hit = arr(data?.data)[0];
      return hit && String(hit.file_no || "").toLowerCase() === trimmed.toLowerCase() ? hit : null;
    },
    enabled: trimmed.length >= 3,
    staleTime: 60_000,
  });
}

// A phone number is NOT unique — families share one, and ~24% of patients with
// a number share it with someone. So this returns EVERY chart on the number and
// lets the caller decide; picking the first would book the wrong family member.
export function usePatientsByPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return useQuery({
    queryKey: qk.ghm.patientByPhone(digits),
    queryFn: async () => {
      const { data } = await api.get(
        `/api/patients?q=${encodeURIComponent(digits)}&limit=${PHONE_MATCH_LIMIT}`,
      );
      return arr(data?.data).filter((hit) =>
        [hit?.phone, ...(Array.isArray(hit?.alt_phone) ? hit.alt_phone : [])].some(
          (v) =>
            String(v || "")
              .replace(/\D/g, "")
              .endsWith(digits) && String(v || "").replace(/\D/g, "").length >= 10,
        ),
      );
    },
    enabled: digits.length === 10,
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
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(listKey, ctx.previous);
      // A rejected edit must say why — the optimistic cell has just snapped
      // back on its own otherwise.
      const message = e?.response?.data?.error;
      if (message) window.alert(message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.ghm.all, refetchType: "none" });
      queryClient.invalidateQueries({ queryKey: ["ghm", "category-counts"] });
    },
  });
}

// Patient details corrected after the booking — several fields land together,
// and the server writes them to the appointment and the patient master both.
export function useUpdateAppointmentPatient() {
  return useGhmMutation(async ({ id, ...fields }) => {
    const { data } = await api.patch(`/api/ghm-appointments/${id}`, fields);
    return data;
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
