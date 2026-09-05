import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";

const base = "/api/giniflow/triage";

// The whole board for one date. The first load of a future day also BUILDS that
// day's visit rows server-side (18-TRIAGE-BOARD-PLAN.md §3.2b), so it can be
// slower than the poll that follows it — which is why the previous board stays
// on screen rather than blanking.
export function useTriageDay(date, { filter, doctorId, q } = {}) {
  const search = q?.trim() || undefined;
  return useQuery({
    queryKey: [
      "giniflow",
      "triage",
      "day",
      date || "today",
      filter || "",
      doctorId || "",
      search || "",
    ],
    queryFn: async () =>
      (
        await api.get(base, {
          params: {
            ...(date ? { date } : {}),
            ...(filter ? { filter } : {}),
            ...(doctorId ? { doctorId } : {}),
            ...(search ? { q: search } : {}),
          },
        })
      ).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    retry: (count, err) => err?.response?.status !== 401 && count < 2,
    placeholderData: (prev) => prev,
    staleTime: 5_000,
  });
}

// `enabled` because the flow manager board offers the same roster to a
// coordinator but is read by roles without GINIFLOW_TRIAGE — fetching it for
// them would be a 403 on every one of their page loads.
export function useTriageStaff(date, enabled = true) {
  return useQuery({
    queryKey: ["giniflow", "triage", "staff", date || "today"],
    queryFn: async () => (await api.get(`${base}/staff`, { params: date ? { date } : {} })).data,
    enabled,
    staleTime: 5 * 60_000,
  });
}

// Every write invalidates the floor board too: `category` is what its dot, the
// consultant's chip and the MO's close rule all read.
const useTriageAction = (fn) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "triage"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "mo"] });
    },
  });
};

export const useSetCategory = () =>
  useTriageAction(
    async ({ visitId, category }) => (await api.patch(`${base}/${visitId}`, { category })).data,
  );

export const useAssignVisit = () =>
  useTriageAction(
    async ({ visitId, assignedSdId, assignedDoctorId }) =>
      (
        await api.patch(`${base}/${visitId}`, {
          ...(assignedSdId !== undefined ? { assignedSdId } : {}),
          ...(assignedDoctorId !== undefined ? { assignedDoctorId } : {}),
        })
      ).data,
  );

export const useRerunTriage = () =>
  useTriageAction(
    async (date) => (await api.post(`${base}/auto`, {}, { params: date ? { date } : {} })).data,
  );
