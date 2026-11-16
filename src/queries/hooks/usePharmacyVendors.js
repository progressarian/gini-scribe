import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const BASE = "/api/pharmacy/vendors";

export const vendorKeys = {
  all: ["pharmacy-vendors"],
  list: (params) => ["pharmacy-vendors", "list", params],
  one: (id) => ["pharmacy-vendors", "one", id],
};

export function useVendorList(params) {
  return useQuery({
    queryKey: vendorKeys.list(params),
    queryFn: async () => (await api.get(BASE, { params })).data,
    placeholderData: keepPreviousData,
  });
}

function useVendorMutation(request) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await request(input)).data,
    onSuccess: (vendor) => {
      queryClient.setQueryData(vendorKeys.one(vendor.id), vendor);
      queryClient.invalidateQueries({ queryKey: vendorKeys.all });
    },
  });
}

export const useCreateVendor = () => useVendorMutation((input) => api.post(BASE, input));

export const useUpdateVendor = () =>
  useVendorMutation(({ id, ...input }) => api.put(`${BASE}/${id}`, input));

export const useSetVendorActive = () =>
  useVendorMutation(({ id, is_active }) => api.patch(`${BASE}/${id}/active`, { is_active }));
