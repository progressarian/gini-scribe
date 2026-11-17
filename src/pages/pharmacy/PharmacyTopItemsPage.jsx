import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download } from "lucide-react";
import api from "../../services/api";
import FormField from "../../components/ui/FormField";
import PillGroup from "../../components/pharmacy/Pills";
import { DateInput, SelectInput, optionsOf } from "../../components/pharmacy/Fields";
import Pagination from "../../components/ui/Pagination";
import { downloadFile } from "../../lib/downloadBlob";
import { inr, localDate, showDate } from "../../components/pharmacy/format";
import { toast } from "../../stores/uiStore";
import { useStockLocations } from "../../queries/hooks/usePharmacyBatches";
import { useVendorList } from "../../queries/hooks/usePharmacyVendors";
import { SALE_TYPE_LABEL } from "../../../shared/pharmacyVocab";
import { MEDICINE_TYPES } from "../../../shared/medicineTypes";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";

const GROUPS = [
  { key: "item", label: "Merge suppliers" },
  { key: "vendor", label: "Split by supplier" },
];

const columnsFor = (split) => [
  { key: "medicine_name", label: "Item name" },
  { key: "company", label: "Company" },
  { key: "vendor_name", label: split ? "Supplier" : "Suppliers" },
  { key: "sold_qty", label: "Sales qty", num: true },
  { key: "returned_qty", label: "Return qty", num: true },
  { key: "net_qty", label: "Net sales qty", num: true },
  { key: "sale_amount", label: "Sale amount", num: true, money: true },
  { key: "return_amount", label: "Return amount", num: true, money: true },
  { key: "net_amount", label: "Net sales amount", num: true, money: true },
];

const useTopItems = (params, enabled) =>
  useQuery({
    queryKey: ["pharmacy-reports", "top-items", params],
    queryFn: async () => (await api.get("/api/pharmacy/reports/top-items", { params })).data,
    placeholderData: keepPreviousData,
    enabled,
  });

export default function PharmacyTopItemsPage() {
  const locations = useStockLocations();
  const vendors = useVendorList({ status: "all", limit: 200 });
  const [from, setFrom] = useState(() => localDate(-29));
  const [to, setTo] = useState(() => localDate());
  const [locationId, setLocationId] = useState("");
  const [saleType, setSaleType] = useState("");
  const [form, setForm] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [group, setGroup] = useState("item");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "net_amount", dir: "desc" });
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

  const badRange = from > to;
  const filters = {
    from,
    to,
    group,
    sort: sort.key,
    dir: sort.dir,
    ...(locationId ? { location_id: locationId } : {}),
    ...(saleType ? { sale_type: saleType } : {}),
    ...(form ? { form } : {}),
    ...(vendorId ? { vendor_id: vendorId } : {}),
    ...(q ? { q } : {}),
  };
  const query = useTopItems(
    { ...filters, limit: pageSize, offset: (page - 1) * pageSize },
    !badRange,
  );
  const rows = query.data?.rows ?? [];
  const columns = columnsFor(group === "vendor");
  const change = (setter) => (value) => {
    setter(value);
    setPage(1);
  };

  const sortBy = (key) => {
    setSort((was) => ({ key, dir: was.key === key && was.dir === "desc" ? "asc" : "desc" }));
    setPage(1);
  };

  const download = async () => {
    setDownloading(true);
    try {
      await downloadFile(
        `/api/pharmacy/reports/top-items.xlsx?${new URLSearchParams(filters).toString()}`,
        "Pharmacy_top_items.xlsx",
      );
    } catch (err) {
      toast(err.message || "The download failed. Try again.", "error");
    } finally {
      setDownloading(false);
    }
  };

  const cell = (r, c) => {
    if (c.money) return inr(r[c.key]);
    if (c.num) return Number(r[c.key]).toLocaleString("en-IN");
    if (c.key === "medicine_name")
      return (
        <>
          {r.medicine_name}
          <span className="phs-meta">{[r.code, r.form].filter(Boolean).join(" · ")}</span>
        </>
      );
    return r[c.key] ?? <span className="phs-meta">Not recorded</span>;
  };

  return (
    <div className="flow-root fset bill-ui phs phb">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Top selling items</h1>
          <p className="phs-sub">
            Quantities and amounts sold, less returns. Units are tablets, ml or pieces as each
            medicine is stocked.
          </p>
        </div>
        <div className="phs-head__acts">
          <button
            type="button"
            className="flow-btn flow-btn-ghost phs-upload"
            disabled={downloading || badRange || !rows.length}
            onClick={download}
          >
            <Download size={15} aria-hidden="true" />
            {downloading ? "Preparing…" : "Download Excel"}
          </button>
        </div>
      </header>

      <section className="flow-card" aria-label="Filters">
        <div className="bill-form ptop-filters">
          <FormField label="From" error={badRange ? "From must be on or before To." : null}>
            <DateInput value={from} maxDate={to} onChange={change(setFrom)} />
          </FormField>
          <FormField label="To">
            <DateInput value={to} maxDate={localDate()} onChange={change(setTo)} />
          </FormField>
          <FormField label="Location">
            <SelectInput
              value={locationId}
              onChange={change(setLocationId)}
              options={[
                { value: "", label: "All locations" },
                ...(locations.data ?? []).map((l) => ({ value: String(l.id), label: l.name })),
              ]}
            />
          </FormField>
          <FormField label="Sale type">
            <SelectInput
              value={saleType}
              onChange={change(setSaleType)}
              options={[{ value: "", label: "All sale types" }, ...optionsOf(SALE_TYPE_LABEL)]}
            />
          </FormField>
          <FormField label="Item type">
            <SelectInput
              value={form}
              onChange={change(setForm)}
              options={[
                { value: "", label: "All types" },
                ...MEDICINE_TYPES.map((f) => ({ value: f, label: f })),
              ]}
            />
          </FormField>
          <FormField label="Supplier">
            <SelectInput
              value={vendorId}
              onChange={change(setVendorId)}
              options={[
                { value: "", label: "All suppliers" },
                ...(vendors.data?.rows ?? []).map((v) => ({ value: String(v.id), label: v.name })),
              ]}
            />
          </FormField>
          <FormField label="Search" className="ptop-search">
            <input
              type="search"
              className="jb-assign"
              placeholder="Item, code, company or supplier"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </FormField>
          <div className="fset__field ptop-group">
            <span aria-hidden="true">Suppliers</span>
            <PillGroup
              label="Same item from different suppliers"
              value={group}
              options={GROUPS}
              onChange={(key) => {
                setGroup(key);
                setPage(1);
              }}
            />
          </div>
        </div>
      </section>

      <section className="flow-card" aria-labelledby="ptop-title">
        <div className="fset__cardhead">
          <h2 id="ptop-title" className="flow-sec-title">
            Items
          </h2>
          <span className="fset__count">{query.data?.total ?? 0}</span>
          {query.data ? (
            <span className="phs-meta">
              {showDate(query.data.from)} to {showDate(query.data.to)}
            </span>
          ) : null}
        </div>
        {query.isError ? (
          <div className="phs-empty" role="alert">
            <p>
              {query.error?.response?.data?.error ?? "Unable to load the report. Please try again."}
            </p>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => query.refetch()}
            >
              Try again
            </button>
          </div>
        ) : query.isLoading ? (
          <p className="phs-empty" role="status">
            Loading…
          </p>
        ) : !rows.length ? (
          <p className="phs-empty">Nothing was sold in this period with these filters.</p>
        ) : (
          <>
            <div className="fset__scroll">
              <table className="flow-table phs-table psl-table" aria-label="Top selling items">
                <thead>
                  <tr>
                    <th>Sr no</th>
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
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.medicine_id}:${r.vendor_id ?? "all"}`}>
                      <td data-label="Sr no">{(page - 1) * pageSize + i + 1}</td>
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          data-label={c.label}
                          className={c.num ? "phs-num" : undefined}
                        >
                          {cell(r, c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="phr-total">
                    <td colSpan={4}>Total (all pages)</td>
                    <td className="phs-num">
                      {query.data.totals.sold_qty.toLocaleString("en-IN")}
                    </td>
                    <td className="phs-num">
                      {query.data.totals.returned_qty.toLocaleString("en-IN")}
                    </td>
                    <td className="phs-num">{query.data.totals.net_qty.toLocaleString("en-IN")}</td>
                    <td className="phs-num">{inr(query.data.totals.sale_amount)}</td>
                    <td className="phs-num">{inr(query.data.totals.return_amount)}</td>
                    <td className="phs-num">{inr(query.data.totals.net_amount)}</td>
                  </tr>
                </tfoot>
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
              unit="items"
            />
          </>
        )}
      </section>
    </div>
  );
}
