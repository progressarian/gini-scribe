import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

// Admin-toggleable floor behaviour (server/services/giniflow/floorSettings.js)
// — one flag so far: whether samples-only patients show on the station
// screens and the coordinator board.
export function useGiniflowFloorSettings() {
  return useQuery({
    queryKey: ["giniflow", "floor-settings"],
    queryFn: async () => (await api.get("/api/giniflow/floor-settings")).data.settings,
    staleTime: 30_000,
  });
}

export function useSetGiniflowFloorSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }) =>
      (await api.patch(`/api/giniflow/floor-settings/${key}`, { value })).data.settings,
    onSuccess: (settings) => {
      queryClient.setQueryData(["giniflow", "floor-settings"], settings);
      // Every station queue and the board read this flag — a flip should be
      // visible the moment it lands, not on the next poll.
      queryClient.invalidateQueries({ queryKey: ["giniflow"] });
    },
  });
}
