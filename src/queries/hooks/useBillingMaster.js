import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const MASTER = "/api/billing/master";
const SETTINGS = "/api/billing/settings";
const IMPORT = "/api/billing/import";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const billingKeys = {
  all: ["billing"],
  groups: (activeOnly) => ["billing", "groups", activeOnly ? "active" : "all"],
  taxCodes: (activeOnly) => ["billing", "tax-codes", activeOnly ? "active" : "all"],
  items: (filters) => ["billing", "items", filters ?? {}],
  notPriced: () => ["billing", "items", "not-priced"],
  itemChoices: () => ["billing", "items", "choices"],
  priceHistory: (itemId) => ["billing", "items", itemId, "price-history"],
  categories: (activeOnly) => ["billing", "categories", activeOnly ? "active" : "all"],
  categoryRules: (schemeCode, activeOnly) => [
    "billing",
    "category-rules",
    schemeCode ?? "any",
    activeOnly ? "active" : "all",
  ],
  rateGrid: (code, filters) => ["billing", "category-rates", code, filters ?? {}],
  rateHistory: (code, itemId) => ["billing", "category-rates", code, "items", itemId],
  usage: (kind, key) => ["billing", "usage", kind, key],
  settings: () => ["billing", "settings"],
  series: () => ["billing", "series"],
  imports: (page) => ["billing", "imports", page ?? {}],
};

const PRICE_KEYS = [billingKeys.all, ["giniflow"]];
const read = async (url, params) => (await api.get(url, params ? { params } : undefined)).data;
const activeParams = (activeOnly) => (activeOnly ? { activeOnly: "true" } : undefined);
const withoutBlanks = (filters = {}) =>
  Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );

function useBillingMutation(mutationFn, invalidate = [billingKeys.all]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
}

export function useBillingGroups({ activeOnly = false } = {}) {
  return useQuery({
    queryKey: billingKeys.groups(activeOnly),
    queryFn: () => read(`${MASTER}/groups`, activeParams(activeOnly)),
  });
}

export function useCreateBillingGroup() {
  return useBillingMutation(async (body) => (await api.post(`${MASTER}/groups`, body)).data);
}

export function useUpdateBillingGroup() {
  return useBillingMutation(
    async ({ id, ...body }) => (await api.patch(`${MASTER}/groups/${id}`, body)).data,
  );
}

export function useSetBillingGroupActive() {
  return useBillingMutation(
    async ({ id, is_active }) =>
      (await api.put(`${MASTER}/groups/${id}/active`, { is_active })).data,
  );
}

export function useDeleteBillingGroup() {
  return useBillingMutation(async (id) => (await api.delete(`${MASTER}/groups/${id}`)).data);
}

export function useCreateBillingSubgroup() {
  return useBillingMutation(async (body) => (await api.post(`${MASTER}/subgroups`, body)).data);
}

export function useUpdateBillingSubgroup() {
  return useBillingMutation(
    async ({ id, ...body }) => (await api.patch(`${MASTER}/subgroups/${id}`, body)).data,
  );
}

export function useSetBillingSubgroupActive() {
  return useBillingMutation(
    async ({ id, is_active }) =>
      (await api.put(`${MASTER}/subgroups/${id}/active`, { is_active })).data,
  );
}

export function useDeleteBillingSubgroup() {
  return useBillingMutation(async (id) => (await api.delete(`${MASTER}/subgroups/${id}`)).data);
}

export function useBillingTaxCodeOptions({ activeOnly = true } = {}) {
  return useQuery({
    queryKey: [...billingKeys.taxCodes(activeOnly), "options"],
    queryFn: () => read(`${MASTER}/tax-codes`, activeParams(activeOnly)),
  });
}

export function useBillingItems(filters = {}) {
  const params = withoutBlanks(filters);
  return useQuery({
    queryKey: billingKeys.items(params),
    queryFn: () => read(`${MASTER}/items`, params),
    placeholderData: (prev, prevQuery) => {
      const before = prevQuery?.queryKey[2] ?? {};
      return before.groupId === params.groupId && before.subgroupId === params.subgroupId
        ? prev
        : undefined;
    },
  });
}

export function useBillingItemChoices() {
  return useQuery({
    queryKey: billingKeys.itemChoices(),
    queryFn: () => read(`${MASTER}/items/choices`),
  });
}

export function useBillingNotPriced() {
  return useQuery({
    queryKey: billingKeys.notPriced(),
    queryFn: () => read(`${MASTER}/items/not-priced`),
  });
}

export function useBillingPriceHistory(itemId) {
  return useQuery({
    queryKey: billingKeys.priceHistory(itemId),
    queryFn: () => read(`${MASTER}/items/${itemId}/price-history`),
    enabled: Boolean(itemId),
  });
}

export function useCreateBillingItem() {
  return useBillingMutation(
    async (body) => (await api.post(`${MASTER}/items`, body)).data,
    PRICE_KEYS,
  );
}

export function useUpdateBillingItem() {
  return useBillingMutation(
    async ({ id, ...body }) => (await api.patch(`${MASTER}/items/${id}`, body)).data,
    PRICE_KEYS,
  );
}

export function useSetBillingItemActive() {
  return useBillingMutation(
    async ({ id, is_active }) =>
      (await api.put(`${MASTER}/items/${id}/active`, { is_active })).data,
    PRICE_KEYS,
  );
}

export function useDeleteBillingItem() {
  return useBillingMutation(
    async (id) => (await api.delete(`${MASTER}/items/${id}`)).data,
    PRICE_KEYS,
  );
}

export function useBillingCategories({ activeOnly = false } = {}) {
  return useQuery({
    queryKey: billingKeys.categories(activeOnly),
    queryFn: () => read(`${MASTER}/categories`, activeParams(activeOnly)),
  });
}

const CATEGORY_KEYS = [billingKeys.all, ["patient-schemes"]];

export function useCreateBillingCategory() {
  return useBillingMutation(
    async (body) => (await api.post(`${MASTER}/categories`, body)).data,
    CATEGORY_KEYS,
  );
}

export function useUpdateBillingCategory() {
  return useBillingMutation(
    async ({ code, ...body }) => (await api.patch(`${MASTER}/categories/${code}`, body)).data,
    CATEGORY_KEYS,
  );
}

export function useDeleteBillingCategory() {
  return useBillingMutation(
    async (code) => (await api.delete(`${MASTER}/categories/${code}`)).data,
    CATEGORY_KEYS,
  );
}

export function useBillingCategoryRules({ schemeCode, activeOnly = false } = {}) {
  return useQuery({
    queryKey: billingKeys.categoryRules(schemeCode, activeOnly),
    queryFn: () =>
      read(
        `${MASTER}/category-rules`,
        withoutBlanks({ schemeCode, activeOnly: activeOnly ? "true" : undefined }),
      ),
  });
}

export function useCreateBillingCategoryRule() {
  return useBillingMutation(
    async (body) => (await api.post(`${MASTER}/category-rules`, body)).data,
  );
}

export function useUpdateBillingCategoryRule() {
  return useBillingMutation(
    async ({ id, ...body }) => (await api.patch(`${MASTER}/category-rules/${id}`, body)).data,
  );
}

export function useSetBillingCategoryRuleActive() {
  return useBillingMutation(
    async ({ id, is_active }) =>
      (await api.put(`${MASTER}/category-rules/${id}/active`, { is_active })).data,
  );
}

export function useDeleteBillingCategoryRule() {
  return useBillingMutation(
    async (id) => (await api.delete(`${MASTER}/category-rules/${id}`)).data,
  );
}

export function useBillingRateGrid(code, filters = {}) {
  const params = withoutBlanks(filters);
  return useQuery({
    queryKey: billingKeys.rateGrid(code, params),
    queryFn: () => read(`${MASTER}/category-rates/${code}`, params),
    enabled: Boolean(code),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === code ? prev : undefined),
  });
}

export function useBillingRateHistory(code, itemId) {
  return useQuery({
    queryKey: billingKeys.rateHistory(code, itemId),
    queryFn: () => read(`${MASTER}/category-rates/${code}/items/${itemId}`),
    enabled: Boolean(code && itemId),
  });
}

export function useSaveBillingCategoryRate() {
  return useBillingMutation(
    async (body) => (await api.put(`${MASTER}/category-rates`, body)).data,
    PRICE_KEYS,
  );
}

export function useDeleteBillingCategoryRate() {
  return useBillingMutation(
    async ({ scheme_code, service_item_id, valid_from, reopen_previous }) =>
      (
        await api.delete(
          `${MASTER}/category-rates/${scheme_code}/items/${service_item_id}/${valid_from}`,
          reopen_previous === undefined
            ? undefined
            : { params: { reopen_previous: String(reopen_previous) } },
        )
      ).data,
    PRICE_KEYS,
  );
}

export function useBillingUsage(kind, key) {
  return useQuery({
    queryKey: billingKeys.usage(kind, key),
    queryFn: () => read(`${MASTER}/usage/${kind}/${key}`),
    enabled: Boolean(kind && key),
  });
}

export function useBillingSettings() {
  return useQuery({
    queryKey: billingKeys.settings(),
    queryFn: () => read(SETTINGS),
  });
}

export function useUpdateBillingSettings() {
  return useBillingMutation(async (body) => (await api.patch(SETTINGS, body)).data);
}

export function useBillSeries() {
  return useQuery({
    queryKey: billingKeys.series(),
    queryFn: () => read(`${SETTINGS}/series`),
  });
}

export function useSaveBillSeries() {
  return useBillingMutation(async (body) => (await api.put(`${SETTINGS}/series`, body)).data);
}

export function useBillingTaxCodes({ activeOnly = false } = {}) {
  return useQuery({
    queryKey: billingKeys.taxCodes(activeOnly),
    queryFn: () => read(`${SETTINGS}/tax-codes`, activeParams(activeOnly)),
  });
}

export function useCreateBillingTaxCode() {
  return useBillingMutation(async (body) => (await api.post(`${SETTINGS}/tax-codes`, body)).data);
}

export function useUpdateBillingTaxCode() {
  return useBillingMutation(
    async ({ id, ...body }) => (await api.patch(`${SETTINGS}/tax-codes/${id}`, body)).data,
  );
}

export function useSetBillingTaxCodeActive() {
  return useBillingMutation(
    async ({ id, is_active }) =>
      (await api.put(`${SETTINGS}/tax-codes/${id}/active`, { is_active })).data,
  );
}

export function useDeleteBillingTaxCode() {
  return useBillingMutation(async (id) => (await api.delete(`${SETTINGS}/tax-codes/${id}`)).data);
}

const IMPORT_KEYS = [billingKeys.all, ["giniflow"], ["patient-schemes"]];

const fileNameOf = (headers, fallback) => {
  const header = headers?.["content-disposition"] ?? "";
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return header.match(/filename="([^"]+)"/i)?.[1] ?? fallback;
};

const readBlobError = async (e) => {
  const data = e?.response?.data;
  if (data instanceof Blob) {
    try {
      e.response.data = JSON.parse(await data.text());
    } catch {
      e.response.data = {};
    }
  }
  throw e;
};

const sendFile = (url, file, config = {}) =>
  api.post(url, file, {
    ...config,
    params: { fileName: file.name },
    headers: { "Content-Type": XLSX_TYPE },
  });

export function useBillingImportHistory({ limit, offset } = {}) {
  const params = withoutBlanks({ limit, offset });
  return useQuery({
    queryKey: billingKeys.imports(params),
    queryFn: () => read(`${IMPORT}/history`, params),
    placeholderData: (prev) => prev,
  });
}

export function useBillingImportTemplate() {
  return useMutation({
    mutationFn: async () => {
      const response = await api
        .get(`${IMPORT}/template`, { responseType: "blob" })
        .catch(readBlobError);
      return {
        blob: response.data,
        fileName: fileNameOf(response.headers, "gini-billing-template.xlsx"),
      };
    },
  });
}

export function usePreviewBillingImport() {
  return useMutation({
    mutationFn: async (file) => (await sendFile(`${IMPORT}/preview`, file)).data,
  });
}

export function useCommitBillingImport() {
  return useBillingMutation(
    async (file) => (await sendFile(`${IMPORT}/commit`, file)).data,
    IMPORT_KEYS,
  );
}

export function useBillingImportErrorFile() {
  return useMutation({
    mutationFn: async (file) => {
      const response = await sendFile(`${IMPORT}/errors`, file, { responseType: "blob" }).catch(
        readBlobError,
      );
      return {
        blob: response.data,
        fileName: fileNameOf(response.headers, file.name.replace(/\.xlsx$/i, " - errors.xlsx")),
      };
    },
  });
}
