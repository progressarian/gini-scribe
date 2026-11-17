import { useSearchParams } from "react-router-dom";
import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Pagination from "../ui/Pagination";
import AdjustStockDialog from "./AdjustStockDialog";
import BatchHistoryDialog from "./BatchHistoryDialog";
import { inr, packUnits, showDate } from "./format";
import { SelectInput } from "./Fields";
import PillGroup from "./Pills";
import {
  useBatchStock,
  useBatchSummary,
  useStockLocations,
} from "../../queries/hooks/usePharmacyBatches";
import { STOCK_LEVEL_LABEL } from "../../../shared/pharmacyVocab";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "in_stock", label: "In stock" },
  { key: "out", label: "Out of stock" },
  { key: "low", label: "Below minimum" },
  { key: "over", label: "Above maximum" },
  { key: "near_expiry", label: "Near expiry" },
  { key: "expired", label: "Expired on shelf" },
];

const LEVEL_BADGE = { out: "out", low: "review", over: "review", ok: "ok" };

function Summary({ summary, withCost }) {
  if (!summary) return null;
  const tiles = [
    { label: "Medicines in stock", value: summary.in_stock },
    { label: "Out of stock", value: summary.out_of_stock },
    { label: "Below minimum", value: summary.below_min },
    { label: `Expiring within ${summary.expiry_alert_days} days`, value: summary.near_expiry },
    { label: "Expired on shelf", value: summary.expired },
    { label: "Stock value at MRP", value: inr(summary.mrp_value) },
    ...(withCost ? [{ label: "Stock value at cost", value: inr(summary.cost_value) }] : []),
  ];
  return (
    <dl className="phs-tiles">
      {tiles.map((t) => (
        <div className="phs-tile" key={t.label}>
          <dt>{t.label}</dt>
          <dd>{typeof t.value === "number" ? t.value.toLocaleString("en-IN") : t.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ExpiryCell({ batch, alertDays }) {
  const days = Math.round(
    (new Date(`${batch.expiry_date}T00:00:00`) - new Date(new Date().toDateString())) / 86400000,
  );
  return (
    <>
      {showDate(batch.expiry_date)}
      {batch.expired ? (
        <span className="bill-status phs-badge phs-badge--out phv-badge">Expired</span>
      ) : days <= alertDays ? (
        <span className="bill-status phs-badge phs-badge--review phv-badge">{days} days left</span>
      ) : null}
    </>
  );
}

function Batches({ row, alertDays, withCost, canAdjust, onAdjust, onHistory }) {
  if (!row.batches.length) return <p className="phs-meta bst-nobatch">No batch in stock here.</p>;
  return (
    <table className="flow-table bst-batches" aria-label={`Batches of ${row.name}`}>
      <thead>
        <tr>
          <th>Batch</th>
          <th>Expiry</th>
          <th>Rack</th>
          <th className="phs-num">Stock</th>
          <th className="phs-num">MRP / sale</th>
          {withCost ? <th className="phs-num">Cost</th> : null}
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {row.batches.map((b) => (
          <tr key={b.id} className={b.expired ? "phs-row--out" : ""}>
            <td data-label="Batch" className="phv-mono">
              {b.batch_no}
            </td>
            <td data-label="Expiry">
              <ExpiryCell batch={b} alertDays={alertDays} />
            </td>
            <td data-label="Rack">{b.rack_no ?? <span className="phs-meta">Not set</span>}</td>
            <td data-label="Stock" className="phs-num">
              {packUnits(b.qty_units, row)}
              <span className="phs-meta">
                {b.qty_units} {row.unit_label}
              </span>
            </td>
            <td data-label="MRP / sale" className="phs-num">
              {inr(b.mrp)}
              <span className="phs-meta">Sale {inr(b.sale_rate)}</span>
            </td>
            {withCost ? (
              <td data-label="Cost" className="phs-num">
                {inr(b.purchase_rate)}
                {b.vendor_name ? <span className="phs-meta">{b.vendor_name}</span> : null}
              </td>
            ) : null}
            <td data-label="Actions" className="phv-actions">
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                onClick={() => onHistory(b)}
                aria-label={`History of batch ${b.batch_no}`}
              >
                History
              </button>
              {canAdjust ? (
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost flow-btn-mini"
                  onClick={() => onAdjust(row, b)}
                  aria-label={`Adjust batch ${b.batch_no} of ${row.name}`}
                >
                  Adjust
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function BatchStockPanel({ withCost, canAdjust }) {
  const locations = useStockLocations();
  const [params] = useSearchParams();
  const [locationId, setLocationId] = useState(() => params.get("location_id") ?? "");
  const [search, setSearch] = useState(() => params.get("q") ?? "");
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [filter, setFilter] = useState(() => params.get("filter") || "all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [open, setOpen] = useState(() => new Set());
  const [adjusting, setAdjusting] = useState(null);
  const [historyOf, setHistoryOf] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim().length >= 2 ? search.trim() : "");
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const summary = useBatchSummary(locationId || null);
  const stock = useBatchStock({
    ...(locationId ? { location_id: locationId } : {}),
    ...(q ? { q } : {}),
    filter,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const rows = stock.data?.rows ?? [];
  const location = stock.data?.location;
  const alertDays = stock.data?.expiry_alert_days ?? 90;

  const toggle = (id) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearFilters = () => {
    setSearch("");
    setQ("");
    setFilter("all");
    setPage(1);
  };

  return (
    <div className="phs-panel">
      <div className="bst-location">
        <label htmlFor="bst-location" id="bst-location-label">
          Stock at
        </label>
        <SelectInput
          id="bst-location"
          value={locationId}
          onChange={(value) => {
            setLocationId(value);
            setPage(1);
            setOpen(new Set());
          }}
          options={[
            { value: "", label: "Main pharmacy" },
            ...(locations.data ?? [])
              .filter((l) => l.kind !== "main")
              .map((l) => ({ value: String(l.id), label: l.name })),
          ]}
        />
      </div>

      <Summary summary={summary.data} withCost={withCost} />

      <section className="flow-card" aria-labelledby="bst-title">
        <div className="fset__cardhead">
          <h2 id="bst-title" className="flow-sec-title">
            Medicines at {location?.name ?? "the pharmacy"}
          </h2>
          <span className="fset__count">{stock.data?.total ?? 0}</span>
        </div>
        <div className="phs-filters">
          <label className="sr-only" htmlFor="bst-search">
            Search stock
          </label>
          <input
            id="bst-search"
            type="search"
            className="jb-assign phs-search"
            placeholder="Search by medicine name, code or generic name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <PillGroup
            label="Filter stock"
            value={filter}
            options={FILTERS}
            onChange={(key) => {
              setFilter(key);
              setPage(1);
            }}
          />
        </div>

        {stock.isError ? (
          <div className="phs-empty" role="alert">
            <p>Unable to load stock. Please try again.</p>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => stock.refetch()}
            >
              Try again
            </button>
          </div>
        ) : stock.isLoading ? (
          <p className="phs-empty" role="status">
            Loading stock…
          </p>
        ) : !rows.length ? (
          <div className="phs-empty">
            {q || filter !== "all" ? (
              <>
                <p>No medicines match the current filters.</p>
                <button type="button" className="flow-btn flow-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            ) : (
              <p>
                No stock recorded here yet. Stock arrives through a goods receipt
                {location?.kind === "department" ? " or a transfer from the main pharmacy" : ""}.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="fset__scroll">
              <table className="flow-table phs-table" aria-label={`Stock at ${location?.name}`}>
                <thead>
                  <tr>
                    <th>Medicine</th>
                    <th className="phs-num">Sellable stock</th>
                    <th>Level</th>
                    <th className="phs-num">Min / max</th>
                    <th>Next expiry</th>
                    <th>Batches</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const expanded = open.has(r.medicine_id);
                    return (
                      <Fragment key={r.medicine_id}>
                        <tr className={r.level === "out" ? "phs-row--out" : ""}>
                          <td data-label="Medicine">
                            <span className="phs-item">{r.name}</span>
                            <span className="phs-meta">
                              {r.code} · {r.pack_label} of {r.pack_size} {r.unit_label}
                            </span>
                          </td>
                          <td data-label="Sellable stock" className="phs-num">
                            {packUnits(r.sellable_units, r)}
                            {r.expired_units ? (
                              <span className="phs-meta">
                                + {r.expired_units} expired, not sellable
                              </span>
                            ) : null}
                          </td>
                          <td data-label="Level">
                            <span
                              className={`bill-status phs-badge phs-badge--${LEVEL_BADGE[r.level]}`}
                            >
                              {STOCK_LEVEL_LABEL[r.level]}
                            </span>
                          </td>
                          <td data-label="Min / max" className="phs-num">
                            {r.min_units ?? 0} / {r.max_units ?? "—"}
                          </td>
                          <td data-label="Next expiry">
                            {r.next_expiry ? (
                              showDate(r.next_expiry)
                            ) : (
                              <span className="phs-meta">—</span>
                            )}
                          </td>
                          <td data-label="Batches">
                            <button
                              type="button"
                              className="flow-btn flow-btn-ghost flow-btn-mini bst-toggle"
                              aria-expanded={expanded}
                              aria-controls={`bst-batches-${r.medicine_id}`}
                              onClick={() => toggle(r.medicine_id)}
                            >
                              {expanded ? (
                                <ChevronDown size={14} aria-hidden="true" />
                              ) : (
                                <ChevronRight size={14} aria-hidden="true" />
                              )}
                              {r.batches.length} batch{r.batches.length === 1 ? "" : "es"}
                            </button>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr id={`bst-batches-${r.medicine_id}`} className="bst-detail">
                            <td colSpan={6}>
                              <Batches
                                row={r}
                                alertDays={alertDays}
                                withCost={withCost}
                                canAdjust={canAdjust}
                                onAdjust={(medicine, batch) => setAdjusting({ medicine, batch })}
                                onHistory={setHistoryOf}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={stock.data?.total ?? 0}
              onChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              disabled={stock.isFetching}
              unit="medicines"
            />
          </>
        )}
      </section>

      {adjusting ? (
        <AdjustStockDialog
          medicine={adjusting.medicine}
          batch={adjusting.batch}
          location={location}
          onClose={() => setAdjusting(null)}
        />
      ) : null}
      {historyOf ? (
        <BatchHistoryDialog
          batch={historyOf}
          location={location}
          onClose={() => setHistoryOf(null)}
        />
      ) : null}
    </div>
  );
}
