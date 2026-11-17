import { useState } from "react";
import { ArrowDown, ArrowUp, Download } from "lucide-react";
import Pagination from "../ui/Pagination";
import { downloadFile } from "../../lib/downloadBlob";
import { inr, packUnits, showDate } from "./format";
import { toast } from "../../stores/uiStore";
import { useStockList, useStockLocations } from "../../queries/hooks/usePharmacyBatches";
import { useVendorList } from "../../queries/hooks/usePharmacyVendors";
import { SelectInput } from "./Fields";
import useUrlState, { useUrlSearch, asNumber, asFlag } from "../../hooks/useUrlState";

const EXPIRY = [
  { key: "all", label: "Any expiry" },
  { key: "expired", label: "Expired" },
  { key: "30", label: "Within 30 days" },
  { key: "90", label: "Within 90 days" },
  { key: "fresh", label: "More than 90 days" },
];

const COLUMNS = [
  { key: "medicine_name", label: "Item name" },
  { key: "form", label: "Type" },
  { key: "vendor_name", label: "Supplier" },
  { key: "unit", label: "Unit", sortable: false },
  { key: "batch_no", label: "Batch no" },
  { key: "expiry_date", label: "Expiry" },
  { key: "qty_units", label: "Stock", num: true },
  { key: "mrp", label: "MRP", num: true },
  { key: "ptr", label: "PTR", num: true, cost: true },
  { key: "lp", label: "LP", num: true, cost: true },
  { key: "margin_pct", label: "Margin %", num: true, cost: true },
  { key: "location_name", label: "Location" },
];

function VendorFilter({ value, onChange }) {
  const vendors = useVendorList({ status: "all", limit: 200 });
  return (
    <>
      <label className="sr-only" htmlFor="psl-vendor" id="psl-vendor-label">
        Supplier
      </label>
      <SelectInput
        id="psl-vendor"
        className="phb-filter-select"
        value={value}
        onChange={onChange}
        options={[
          { value: "", label: "All suppliers" },
          ...(vendors.data?.rows ?? []).map((v) => ({ value: String(v.id), label: v.name })),
        ]}
      />
    </>
  );
}

export default function StockListPanel({ withCost }) {
  const locations = useStockLocations();
  const [locationId, setLocationId] = useUrlState("l_location", "");
  const [form, setForm] = useUrlState("l_type", "");
  const [vendorId, setVendorId] = useUrlState("l_vendor", "");
  const [expiry, setExpiry] = useUrlState("l_expiry", "all");
  const [includeEmpty, setIncludeEmpty] = useUrlState("l_empty", false, asFlag);
  const { search, setSearch, q } = useUrlSearch("l_q", () => setPage(1));
  const [sortKey, setSortKey] = useUrlState("l_sort", "medicine_name");
  const [sortDir, setSortDir] = useUrlState("l_dir", "asc");
  const sort = { key: sortKey, dir: sortDir };
  const [page, setPage] = useUrlState("l_page", 1, asNumber);
  const [pageSize, setPageSize] = useUrlState("l_size", 50, asNumber);
  const [downloading, setDownloading] = useState(false);

  const filters = {
    ...(locationId ? { location_id: locationId } : {}),
    ...(form ? { form } : {}),
    ...(vendorId ? { vendor_id: vendorId } : {}),
    ...(q ? { q } : {}),
    expiry,
    ...(includeEmpty ? { include_empty: "1" } : {}),
    sort: sort.key,
    dir: sort.dir,
  };
  const query = useStockList({ ...filters, limit: pageSize, offset: (page - 1) * pageSize });
  const rows = query.data?.rows ?? [];
  const columns = COLUMNS.filter((c) => withCost || !c.cost);
  const reset = (setter) => (value) => {
    setter(value);
    setPage(1);
  };

  const sortBy = (key) => {
    setSortDir(sort.key === key && sort.dir === "asc" ? "desc" : "asc");
    setSortKey(key);
    setPage(1);
  };

  const download = async () => {
    setDownloading(true);
    try {
      const params = new URLSearchParams(filters).toString();
      await downloadFile(`/api/pharmacy/batches/list.xlsx?${params}`, "Pharmacy_stock_list.xlsx");
    } catch (err) {
      toast(err.message || "The download failed. Try again.", "error");
    } finally {
      setDownloading(false);
    }
  };

  const cell = (r, key) => {
    switch (key) {
      case "form":
        return r.form ?? "—";
      case "vendor_name":
        return r.vendor_name ?? <span className="phs-meta">Not recorded</span>;
      case "unit":
        return `${r.pack_label} of ${r.pack_size} ${r.unit_label}`;
      case "batch_no":
        return (
          <>
            <span className="phv-mono">{r.batch_no}</span>
            {r.rack_no ? <span className="phs-meta">Rack {r.rack_no}</span> : null}
          </>
        );
      case "expiry_date":
        return (
          <>
            {showDate(r.expiry_date)}
            {r.days_left <= 0 ? (
              <span className="bill-status phs-badge phs-badge--out">Expired</span>
            ) : r.days_left <= 90 ? (
              <span className="phs-meta">{r.days_left} days left</span>
            ) : null}
          </>
        );
      case "qty_units":
        return (
          <>
            {packUnits(r.qty_units, r)}
            <span className="phs-meta">
              {r.qty_units} {r.unit_label}
            </span>
          </>
        );
      case "mrp":
      case "ptr":
      case "lp":
        return r[key] === null ? "—" : inr(r[key]);
      case "margin_pct":
        return r.margin_pct === null ? "—" : `${Number(r.margin_pct).toFixed(2)}%`;
      default:
        return r[key];
    }
  };

  return (
    <section className="flow-card" aria-labelledby="psl-title">
      <div className="fset__cardhead">
        <h2 id="psl-title" className="flow-sec-title">
          Stock list
        </h2>
        <span className="fset__count">{query.data?.total ?? 0}</span>
        <button
          type="button"
          className="flow-btn flow-btn-ghost phs-upload psl-download"
          disabled={downloading || !rows.length}
          onClick={download}
        >
          <Download size={15} aria-hidden="true" />
          {downloading ? "Preparing…" : "Download Excel"}
        </button>
      </div>
      {withCost ? (
        <p className="phs-meta">
          PTR is the invoice rate per pack. LP is PTR after the invoice discount, plus GST, spread
          over free packs. Margin % = (MRP − LP) ÷ MRP.
        </p>
      ) : null}
      <div className="phs-filters">
        <label className="sr-only" htmlFor="psl-search">
          Search stock list
        </label>
        <input
          id="psl-search"
          type="search"
          className="jb-assign phs-search"
          placeholder="Search by item, code, batch, supplier or company"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="sr-only" htmlFor="psl-location" id="psl-location-label">
          Location
        </label>
        <SelectInput
          id="psl-location"
          className="phb-filter-select"
          value={locationId}
          onChange={reset(setLocationId)}
          options={[
            { value: "", label: "All locations" },
            ...(locations.data ?? []).map((l) => ({ value: String(l.id), label: l.name })),
          ]}
        />
        <label className="sr-only" htmlFor="psl-type" id="psl-type-label">
          Item type
        </label>
        <SelectInput
          id="psl-type"
          className="phb-filter-select"
          value={form}
          onChange={reset(setForm)}
          options={[
            { value: "", label: "All types" },
            ...(query.data?.forms ?? []).map((f) => ({ value: f, label: f })),
          ]}
        />
        {withCost ? <VendorFilter value={vendorId} onChange={reset(setVendorId)} /> : null}
        <label className="sr-only" htmlFor="psl-expiry" id="psl-expiry-label">
          Expiry
        </label>
        <SelectInput
          id="psl-expiry"
          className="phb-filter-select"
          value={expiry}
          onChange={reset(setExpiry)}
          options={EXPIRY.map((x) => ({ value: x.key, label: x.label }))}
        />
        <label className="fset__check">
          <input
            type="checkbox"
            checked={includeEmpty}
            onChange={(e) => reset(setIncludeEmpty)(e.target.checked)}
          />
          Show empty batches
        </label>
      </div>

      {query.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load the stock list. Please try again.</p>
          <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : query.isLoading ? (
        <p className="phs-empty" role="status">
          Loading the stock list…
        </p>
      ) : !rows.length ? (
        <p className="phs-empty">No batches match these filters.</p>
      ) : (
        <>
          <div className="fset__scroll">
            <table className="flow-table phs-table psl-table" aria-label="Stock list">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className={c.num ? "phs-num" : undefined}
                      aria-sort={
                        sort.key === c.key
                          ? sort.dir === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      {c.sortable === false ? (
                        c.label
                      ) : (
                        <button type="button" className="psl-sort" onClick={() => sortBy(c.key)}>
                          {c.label}
                          {sort.key === c.key ? (
                            sort.dir === "asc" ? (
                              <ArrowUp size={12} className="psl-sort__icon" aria-hidden="true" />
                            ) : (
                              <ArrowDown size={12} className="psl-sort__icon" aria-hidden="true" />
                            )
                          ) : null}
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.location_id}:${r.batch_id}`}
                    className={r.days_left <= 0 ? "phs-row--out" : ""}
                  >
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        data-label={c.label}
                        className={c.num ? "phs-num" : undefined}
                      >
                        {cell(r, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={query.data?.total ?? 0}
            onChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            disabled={query.isFetching}
            unit="batches"
          />
        </>
      )}
    </section>
  );
}
