import { useBatchStock } from "../../queries/hooks/usePharmacyBatches";
import { packUnits } from "./format";

export const useStockOptions = (q) => {
  const search = useBatchStock({ q, filter: "in_stock", limit: 10 }, { enabled: Boolean(q) });
  return { ...search, options: search.data?.rows ?? [] };
};

export const describeStock = (m) =>
  [
    m.code,
    `${packUnits(m.sellable_units, m)} in stock`,
    m.batches[0]?.rack_no && `Rack ${m.batches[0].rack_no}`,
  ]
    .filter(Boolean)
    .join(" · ");
