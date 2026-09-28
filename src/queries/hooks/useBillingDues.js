import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { billingKeys, fileNameOf, readBlobError } from "./useBillingMaster";

const REGISTER = "/api/billing/dues-register";

const cleanParams = (filters) =>
  Object.fromEntries(
    Object.entries(filters ?? {}).filter(([, value]) => value !== "" && value !== null),
  );

export function useDuesRegister(filters) {
  const params = cleanParams(filters);
  return useQuery({
    queryKey: [...billingKeys.dues().slice(0, -1), "register", params],
    queryFn: async () => (await api.get(REGISTER, { params })).data,
    placeholderData: keepPreviousData,
  });
}

export function useDuesExport() {
  return useMutation({
    mutationFn: async (filters) => {
      const response = await api
        .get(`${REGISTER}/export`, { params: cleanParams(filters), responseType: "blob" })
        .catch(readBlobError);
      return { blob: response.data, fileName: fileNameOf(response.headers, "dues.xlsx") };
    },
  });
}
