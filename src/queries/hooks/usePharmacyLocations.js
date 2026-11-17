import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { createMasterHooks } from "./usePharmacyMasters";

const BASE = "/api/pharmacy/locations";
const locations = createMasterHooks(BASE, "pharmacy-locations");

export const locationKeys = {
  ...locations.keys,
  levels: (id, params) => ["pharmacy-locations", "levels", id, params],
};
export const useLocationList = locations.useList;
export const useCreateLocation = locations.useCreate;
export const useUpdateLocation = locations.useUpdate;
export const useSetLocationActive = locations.useSetActive;

export function useLocationLevels(id, params) {
  return useQuery({
    queryKey: locationKeys.levels(id, params),
    queryFn: async () => (await api.get(`${BASE}/${id}/levels`, { params })).data,
    placeholderData: keepPreviousData,
    enabled: Boolean(id),
  });
}

function useLevelMutation(request) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await request(input)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: locationKeys.all }),
  });
}

export const useSaveLevel = () =>
  useLevelMutation(({ locationId, medicineId, min_units, max_units }) =>
    api.put(`${BASE}/${locationId}/levels/${medicineId}`, { min_units, max_units }),
  );

export const useRemoveLevel = () =>
  useLevelMutation(({ locationId, medicineId }) =>
    api.delete(`${BASE}/${locationId}/levels/${medicineId}`),
  );
