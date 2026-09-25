export const reportFileName = (key, { from, to }) =>
  `billing-${String(key).replace(/_/g, "-")}-${from || "start"}-to-${to}.xlsx`;
