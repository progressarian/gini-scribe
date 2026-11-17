import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

export function createMasterHooks(base, key) {
  const keys = {
    all: [key],
    list: (params) => [key, "list", params],
    one: (id) => [key, "one", String(id)],
  };

  const useList = (params, { enabled = true } = {}) =>
    useQuery({
      queryKey: keys.list(params),
      queryFn: async () => (await api.get(base, { params })).data,
      placeholderData: keepPreviousData,
      enabled,
    });

  const useSave = (request) => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: async (input) => (await request(input)).data,
      onSuccess: (record) => {
        queryClient.setQueryData(keys.one(record.id), record);
        queryClient.invalidateQueries({ queryKey: keys.all });
      },
    });
  };

  return {
    keys,
    useList,
    useCreate: () => useSave((input) => api.post(base, input)),
    useUpdate: () => useSave(({ id, ...input }) => api.put(`${base}/${id}`, input)),
    useSetActive: () =>
      useSave(({ id, is_active }) => api.patch(`${base}/${id}/active`, { is_active })),
  };
}
