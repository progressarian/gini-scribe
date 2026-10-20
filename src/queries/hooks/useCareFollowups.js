import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const BASE = "/api/care-followups";
export const CARE_FOLLOWUPS_KEY = ["care-followups"];

const clean = (filters) =>
  Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== "" && v != null));

export function useCareFollowups(filters) {
  return useQuery({
    queryKey: [...CARE_FOLLOWUPS_KEY, "list", clean(filters)],
    queryFn: async () => (await api.get(BASE, { params: clean(filters) })).data,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useCareFollowup(id) {
  return useQuery({
    queryKey: [...CARE_FOLLOWUPS_KEY, "item", id],
    queryFn: async () => (await api.get(`${BASE}/${id}`)).data,
    enabled: Boolean(id),
  });
}

function useAction(path) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) => (await api.post(`${BASE}/${id}/${path}`, body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CARE_FOLLOWUPS_KEY }),
  });
}

export const useLogFollowupCall = () => useAction("call");
export const useCloseFollowup = () => useAction("outcome");
export const useMarkFollowupBooked = () => useAction("booked");
export const useReopenFollowup = () => useAction("reopen");

export function useCollectFollowupDay() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (day) => (await api.post(`${BASE}/day`, { day })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CARE_FOLLOWUPS_KEY }),
  });
}

export function useRefreshFollowups() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post(`${BASE}/refresh`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CARE_FOLLOWUPS_KEY }),
  });
}
