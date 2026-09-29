export const RECEPTION_PATH = "/giniflow/station/reception";

export const receptionBillHref = (params = {}) =>
  `${RECEPTION_PATH}?${new URLSearchParams({ tab: "bill", ...params })}`;
