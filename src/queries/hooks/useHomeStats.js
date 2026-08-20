import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

export default function useHomeStats(date) {
  return useQuery({
    queryKey: qk.home.stats(date || "today"),
    queryFn: async () => {
      const { data } = await api.get("/api/home-stats", date ? { params: { date } } : undefined);
      return data;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
