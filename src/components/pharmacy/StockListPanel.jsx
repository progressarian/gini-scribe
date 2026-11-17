import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import Pagination from "../ui/Pagination";
import { downloadFile } from "../../lib/downloadBlob";
import { inr, packUnits, showDate } from "./format";
import { toast } from "../../stores/uiStore";
import { useStockList, useStockLocations } from "../../queries/hooks/usePharmacyBatches";
import { useVendorList } from "../../queries/hooks/usePharmacyVendors";

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
      <label className="sr-only" htmlFor="psl-vendor">
        Supplier
      </label>
      <select
        id="psl-vendor"
        className="jb-assign phb-filter-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All suppliers</option>
        {(vendors.data?.rows ?? []).map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </>
  );
}

export default function StockListPanel({ withCost }) {
  const locations = useStockLocations();
  const [locationId, setLocationId] = useState("");
  const [form, setForm] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [expiry, setExpiry] = useState("all");
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "medicine_name", dir: "asc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim().length >= 2 ? search.trim() : "");
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

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
    setSort((was) => ({ key, dir: was.key === key && was.dir === "asc" ? "desc" : "asc" }));
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
        <label className="sr-only" htmlFor="psl-location">
          Location
        </label>
        <select
          id="psl-location"
          className="jb-assign phb-filter-select"
          value={locationId}
          onChange={(e) => reset(setLocationId)(e.target.value)}
        >
          <option value="">All locations</option>
          {(locations.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="psl-type">
          Item type
        </label>
        <select
          id="psl-type"
          className="jb-assign phb-filter-select"
          value={form}
          onChange={(e) => reset(setForm)(e.target.value)}
        >
          <option value="">All types</option>
          {(query.data?.forms ?? []).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {withCost ? <VendorFilter value={vendorId} onChange={reset(setVendorId)} /> : null}
        <label className="sr-only" htmlFor="psl-expiry">
          Expiry
        </label>
        <select
          id="psl-expiry"
          className="jb-assign phb-filter-select"
          value={expiry}
          onChange={(e) => reset(setExpiry)(e.target.value)}
        >
          {EXPIRY.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label}
            </option>
          ))}
        </select>
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
                          <span aria-hidden="true">
                            {sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                          </span>
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
