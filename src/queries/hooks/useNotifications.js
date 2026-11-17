import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const KEY = ["notifications"];
const POLL_MS = 60 * 1000;

export function useNotifications({ enabled = true } = {}) {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.get("/api/notifications", { params: { limit: 30 } })).data,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await api.post("/api/notifications/read", input)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}
