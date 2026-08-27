import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

const idKey = (ids) => [...new Set(ids)].sort((a, b) => a - b).join(",");

// Batched block status for a list of patients — one request per screen, not
// one per row. A block changes rarely, so the cache is held for 5 minutes.
// The server redacts the reason for roles without ADMIN/CLINICAL_WRITE, so a
// caller never has to think about who is allowed to see what.
export function usePatientBlockStatus(patientIds = []) {
  const ids = patientIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
  const key = idKey(ids);
  return useQuery({
    queryKey: qk.patientBlocks.status(key),
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await api.get("/api/patient-block-status", {
        params: { patient_ids: key },
      });
      return data || {};
    },
  });
}

// One patient — the same endpoint, so the badge works on a detail page too.
export function usePatientBlock(patientId) {
  const q = usePatientBlockStatus(patientId ? [patientId] : []);
  return { ...q, block: q.data?.[Number(patientId)] || null };
}

// Server-paged. Returns the endpoint's { data, total, page, totalPages } shape.
// keepPreviousData holds the current page on screen while the next one loads,
// so clicking Next doesn't blank the table.
export function useBlockedPatients({ q, page = 1, limit = 25 } = {}) {
  return useQuery({
    queryKey: qk.patientBlocks.list({ q: q || "", page, limit }),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data } = await api.get("/api/patient-blocks", {
        params: { page, limit, ...(q ? { q } : {}) },
      });
      return {
        data: Array.isArray(data?.data) ? data.data : [],
        total: data?.total || 0,
        page: data?.page || page,
        totalPages: data?.totalPages || 0,
      };
    },
  });
}

export function usePatientBlockHistory(patientId, enabled = true) {
  return useQuery({
    queryKey: qk.patientBlocks.history(patientId),
    enabled: !!patientId && enabled,
    queryFn: async () => {
      const { data } = await api.get(`/api/patient-blocks/${patientId}/history`);
      return Array.isArray(data) ? data : [];
    },
  });
}

export function useBlockPatient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ patientId, reason_code, note }) => {
      const { data } = await api.post(`/api/patient-blocks/${patientId}`, { reason_code, note });
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.patientBlocks.all }),
  });
}

export function useUnblockPatient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ patientId, note }) => {
      const { data } = await api.delete(`/api/patient-blocks/${patientId}`, { data: { note } });
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.patientBlocks.all }),
  });
}
