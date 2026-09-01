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

// The export can carry more rows than the table has loaded, so it asks for the
// last-seen consultant itself instead of reading the visible page's cache. Sent
// in chunks — one id list per request keeps the query planner off a huge array.
const LAST_MO_CHUNK = 200;

export async function fetchLastMo(patientIds) {
  const ids = [...new Set((patientIds || []).filter((id) => Number.isInteger(id)))];
  const out = {};
  for (let i = 0; i < ids.length; i += LAST_MO_CHUNK) {
    const { data } = await api.post("/api/ghm-appointments/last-mo", {
      patient_ids: ids.slice(i, i + LAST_MO_CHUNK),
    });
    Object.assign(out, data || {});
  }
  return out;
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
  const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.ghm.any.activeCalls });
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

// `keys` is the set of query prefixes this write actually changes — nothing
// else is touched, and only mounted queries refetch. The doctor and CC-agent
// lists are deliberately never in it: no appointment edit changes them.
function useGhmMutation(mutationFn, keys, options = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    ...options,
    onSettled: (...args) => {
      for (const queryKey of keys)
        queryClient.invalidateQueries({ queryKey, refetchType: "active" });
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
      // The optimistic cell is already correct, so the list is only marked
      // stale — it refetches on the next focus, not under the edit.
      queryClient.invalidateQueries({ queryKey: qk.ghm.any.list, refetchType: "none" });
      queryClient.invalidateQueries({
        queryKey: qk.ghm.any.categoryCounts,
        refetchType: "active",
      });
    },
  });
}

// Patient details corrected after the booking — several fields land together,
// and the server writes them to the appointment and the patient master both.
export function useUpdateAppointmentPatient() {
  return useGhmMutation(
    async ({ id, ...fields }) => {
      const { data } = await api.patch(`/api/ghm-appointments/${id}`, fields);
      return data;
    },
    [qk.ghm.any.list, qk.ghm.any.categoryCounts, qk.ghm.any.slotCounts, qk.ghm.any.changes],
  );
}

export function useCreateAppointment() {
  return useGhmMutation(
    async (form) => {
      const { data } = await api.post("/api/ghm-appointments", form);
      return data;
    },
    [
      qk.ghm.any.list,
      qk.ghm.any.slotCounts,
      qk.ghm.any.categoryCounts,
      qk.ghm.any.availability,
      qk.ghm.any.conflicts,
    ],
  );
}

// The attempt is mirrored onto the appointment's call columns and clears the
// "calling now" claim, so the day list and the claim flag move with it.
export function useLogCallAttempt() {
  return useGhmMutation(
    async (body) => {
      const { data } = await api.post("/api/call-attempts", body);
      return data;
    },
    [qk.ghm.any.attemptCounts, qk.ghm.any.callAttempts, qk.ghm.any.activeCalls, qk.ghm.any.list],
  );
}

export function useDeleteCallAttempt() {
  return useGhmMutation(
    async (id) => {
      const { data } = await api.delete(`/api/call-attempts/${id}`);
      return data;
    },
    [qk.ghm.any.attemptCounts, qk.ghm.any.callAttempts, qk.ghm.any.list],
  );
}

export function useDeleteAppointmentChange() {
  return useGhmMutation(
    async (id) => {
      const { data } = await api.delete(`/api/appointment-changes/${id}`);
      return data;
    },
    [qk.ghm.any.changes],
  );
}

export function useReassignAppointment() {
  return useGhmMutation(
    async ({ appointmentId, body }) => {
      const { data } = await api.put(`/api/appointments/${appointmentId}/reassign`, body);
      return data;
    },
    [qk.ghm.any.list, qk.ghm.any.conflicts, qk.ghm.any.changes],
  );
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
