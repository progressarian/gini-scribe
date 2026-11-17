import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PackageX } from "lucide-react";
import FormField from "../../components/ui/FormField";
import MasterFormDialog from "../../components/pharmacy/MasterFormDialog";
import { digitsTyped, requestErrorOf } from "../../components/billing/format";
import { inr, packUnits, showDate } from "../../components/pharmacy/format";
import { toast } from "../../stores/uiStore";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import { useStockLocations } from "../../queries/hooks/usePharmacyBatches";
import { useVendorList } from "../../queries/hooks/usePharmacyVendors";
import {
  useCreateVendorReturn,
  useExpiryList,
  useVendorReturns,
} from "../../queries/hooks/usePharmacyDepartments";
import { VENDOR_RETURN_REASON_LABEL } from "../../../shared/pharmacyVocab";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";

const BUCKETS = [
  { key: "all", label: "All" },
  { key: "expired", label: "Expired" },
  { key: "30", label: "Within 30 days" },
  { key: "60", label: "31–60 days" },
  { key: "90", label: "61–90 days" },
];

const leftText = (days) =>
  days < 0
    ? `Expired ${-days} day${days === -1 ? "" : "s"} ago`
    : days === 0
      ? "Expires today"
      : `${days} day${days === 1 ? "" : "s"} left`;

function ReturnDialog({ rows, onClose, onDone }) {
  const create = useCreateVendorReturn();
  const vendors = useVendorList({ status: "active", limit: 200 });
  const shared = [...new Set(rows.map((r) => r.vendor_id).filter(Boolean))];
  const [vendorId, setVendorId] = useState(shared.length === 1 ? String(shared[0]) : "");
  const [reason, setReason] = useState(
    rows.some((r) => r.days_left <= 0) ? "expired" : "near_expiry",
  );
  const [vendorRef, setVendorRef] = useState("");
  const [notes, setNotes] = useState("");
  const [qty, setQty] = useState(() =>
    Object.fromEntries(rows.map((r) => [r.batch_id, String(r.qty_units)])),
  );
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");

  const value = rows.reduce(
    (sum, r) => sum + (Number(qty[r.batch_id] || 0) * Number(r.purchase_rate)) / r.pack_size,
    0,
  );
  const problems = {};
  if (!vendorId) problems.vendor = "Choose the vendor taking the stock back.";
  for (const r of rows) {
    const n = Number(qty[r.batch_id] || 0);
    if (!n) problems[r.batch_id] = "Enter at least 1.";
    else if (n > r.qty_units)
      problems[r.batch_id] = `Only ${r.qty_units} ${r.unit_label} in stock.`;
  }
  const errors = touched ? problems : {};

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length) return;
    try {
      const made = await create.mutateAsync({
        vendor_id: Number(vendorId),
        reason,
        vendor_ref: vendorRef.trim() || null,
        notes: notes.trim() || null,
        lines: rows.map((r) => ({ batch_id: r.batch_id, qty_units: Number(qty[r.batch_id]) })),
      });
      toast(
        `${made.return_no}: ${inr(made.total_value)} of stock returned to ${made.vendor_name}.`,
      );
      onDone();
    } catch (err) {
      setError(requestErrorOf(err, "Could not record the vendor return"));
    }
  };

  return (
    <MasterFormDialog
      title="Return to vendor"
      intro={
        <p className="phs-meta">
          The stock leaves the main pharmacy now. Record the vendor&apos;s credit note number when
          you have it.
        </p>
      }
      dirty={Boolean(vendorRef || notes)}
      busy={create.isPending}
      error={error}
      submitLabel={create.isPending ? "Saving…" : `Return stock worth ${inr(value)}`}
      onSubmit={submit}
      onClose={onClose}
    >
      <div className="bill-form">
        <FormField label="Vendor" required error={errors.vendor}>
          <select
            className="jb-assign"
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
          >
            <option value="">Choose</option>
            {(vendors.data?.rows ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Reason" required>
          <select className="jb-assign" value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(VENDOR_RETURN_REASON_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Vendor credit note / reference">
          <input
            className="jb-assign"
            maxLength={60}
            value={vendorRef}
            onChange={(e) => setVendorRef(e.target.value)}
          />
        </FormField>
        <FormField label="Note">
          <input
            className="jb-assign"
            maxLength={300}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </FormField>
      </div>
      <div className="fset__scroll">
        <table className="flow-table phs-table" aria-label="Batches being returned">
          <thead>
            <tr>
              <th>Medicine</th>
              <th>Batch · expiry</th>
              <th className="phs-num">In stock</th>
              <th className="phs-num">Returning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.batch_id}>
                <td data-label="Medicine">{r.medicine_name}</td>
                <td data-label="Batch">
                  <span className="phv-mono">{r.batch_no}</span>
                  <span className="phs-meta">Exp {showDate(r.expiry_date)}</span>
                </td>
                <td data-label="In stock" className="phs-num">
                  {packUnits(r.qty_units, r)}
                </td>
                <td data-label="Returning" className="phs-num">
                  <div className="phb-give">
                    <input
                      className="jb-assign phb-qty"
                      inputMode="numeric"
                      maxLength={6}
                      aria-label={`Returning ${r.medicine_name} batch ${r.batch_no}`}
                      aria-invalid={errors[r.batch_id] ? true : undefined}
                      value={qty[r.batch_id]}
                      onChange={(e) =>
                        setQty({ ...qty, [r.batch_id]: digitsTyped(e.target.value) })
                      }
                    />
                    {errors[r.batch_id] ? (
                      <small className="form-field__error" role="alert">
                        {errors[r.batch_id]}
                      </small>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MasterFormDialog>
  );
}

function RecentReturns() {
  const query = useVendorReturns({ limit: 10 });
  const rows = query.data?.rows ?? [];
  if (!rows.length) return null;
  return (
    <section className="flow-card" aria-labelledby="pex-returns-title">
      <h2 id="pex-returns-title" className="flow-sec-title">
        Recent vendor returns
      </h2>
      <table className="flow-table phs-table" aria-label="Recent vendor returns">
        <thead>
          <tr>
            <th>Return</th>
            <th>Vendor</th>
            <th>Reason</th>
            <th>Vendor reference</th>
            <th className="phs-num">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="Return">
                <span className="phv-mono">{r.return_no}</span>
                <span className="phs-meta">
                  {showDate(String(r.created_at).slice(0, 10))}
                  {r.created_by_name ? ` by ${r.created_by_name}` : ""}
                </span>
              </td>
              <td data-label="Vendor">{r.vendor_name}</td>
              <td data-label="Reason">{VENDOR_RETURN_REASON_LABEL[r.reason]}</td>
              <td data-label="Vendor reference">{r.vendor_ref ?? "—"}</td>
              <td data-label="Value" className="phs-num">
                {inr(r.total_value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function PharmacyExpiryPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canReturn = hasCapability(role, CAPABILITIES.PHARMACY_PURCHASE);
  const [params] = useSearchParams();
  const locations = useStockLocations();
  const [locationId, setLocationId] = useState(() => params.get("location_id") ?? "");
  const [bucket, setBucket] = useState(() => params.get("bucket") ?? "all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(() => new Set());
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim().length >= 2 ? search.trim() : ""), 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = useExpiryList({
    ...(locationId ? { location_id: locationId } : {}),
    bucket,
    ...(q ? { q } : {}),
    limit: 500,
  });
  const rows = query.data?.rows ?? [];
  const main = (locations.data ?? []).find((l) => l.kind === "main");
  const key = (r) => `${r.location_id}:${r.batch_id}`;
  const chosen = rows.filter((r) => picked.has(key(r)));

  const toggle = (r) =>
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(key(r))) next.delete(key(r));
      else next.add(key(r));
      return next;
    });

  return (
    <div className="flow-root fset bill-ui phs phb">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Expiry</h1>
          <p className="phs-sub">
            Stock that has expired or expires within {query.data?.expiry_alert_days ?? 90} days,
            soonest first, with the vendor to call for a return.
          </p>
        </div>
        {canReturn ? (
          <div className="phs-head__acts">
            <button
              type="button"
              className="flow-btn flow-btn-primary phs-upload"
              disabled={!chosen.length}
              onClick={() => setReturning(true)}
            >
              <PackageX size={15} aria-hidden="true" />
              Return to vendor{chosen.length ? ` (${chosen.length})` : ""}
            </button>
          </div>
        ) : null}
      </header>

      <section className="flow-card" aria-labelledby="pex-list-title">
        <div className="fset__cardhead">
          <h2 id="pex-list-title" className="flow-sec-title">
            Batches
          </h2>
          <span className="fset__count">{query.data?.total ?? 0}</span>
          {canReturn ? (
            <span className="phb-due-total phb-sum-total">
              Cost value {inr(query.data?.total_value ?? 0)}
            </span>
          ) : null}
        </div>
        <div className="phs-filters">
          <label className="sr-only" htmlFor="pex-location">
            Location
          </label>
          <select
            id="pex-location"
            className="jb-assign phb-filter-select"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            <option value="">All locations</option>
            {(locations.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="pex-search">
            Search batches
          </label>
          <input
            id="pex-search"
            type="search"
            className="jb-assign phs-search"
            placeholder="Search by medicine, batch or vendor"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="phs-chips" role="group" aria-label="Filter by expiry">
            {BUCKETS.map((b) => (
              <button
                key={b.key}
                type="button"
                className={`phs-chip${bucket === b.key ? " on" : ""}`}
                aria-pressed={bucket === b.key}
                onClick={() => setBucket(b.key)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
        {query.isError ? (
          <div className="phs-empty" role="alert">
            <p>Unable to load the expiry list. Please try again.</p>
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
          <p className="phs-empty">Nothing expired or expiring in this view.</p>
        ) : (
          <div className="fset__scroll">
            <table className="flow-table phs-table" aria-label="Expiring batches">
              <thead>
                <tr>
                  {canReturn ? <th aria-label="Choose" /> : null}
                  <th>Medicine</th>
                  <th>Batch · rack</th>
                  <th>Expiry</th>
                  <th>Location</th>
                  <th className="phs-num">Stock</th>
                  {canReturn ? <th className="phs-num">Cost value</th> : null}
                  <th>Vendor</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const atMain = r.location_id === main?.id;
                  return (
                    <tr key={key(r)} className={r.days_left <= 0 ? "phs-row--out" : ""}>
                      {canReturn ? (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Choose ${r.medicine_name} batch ${r.batch_no} to return`}
                            disabled={!atMain}
                            title={atMain ? undefined : "Move it back to the main pharmacy first"}
                            checked={picked.has(key(r))}
                            onChange={() => toggle(r)}
                          />
                        </td>
                      ) : null}
                      <td data-label="Medicine">{r.medicine_name}</td>
                      <td data-label="Batch">
                        <span className="phv-mono">{r.batch_no}</span>
                        {r.rack_no ? <span className="phs-meta">Rack {r.rack_no}</span> : null}
                      </td>
                      <td data-label="Expiry">
                        {showDate(r.expiry_date)}
                        <span
                          className={`bill-status phs-badge phs-badge--${r.days_left <= 30 ? "out" : "review"}`}
                        >
                          {leftText(r.days_left)}
                        </span>
                      </td>
                      <td data-label="Location">{r.location_name}</td>
                      <td data-label="Stock" className="phs-num">
                        {packUnits(r.qty_units, r)}
                      </td>
                      {canReturn ? (
                        <td data-label="Cost value" className="phs-num">
                          {inr(r.cost_value)}
                        </td>
                      ) : null}
                      <td data-label="Vendor">
                        {r.vendor_name ?? <span className="phs-meta">Not recorded</span>}
                        {r.vendor_phone ? (
                          <span className="phs-meta">
                            {[r.vendor_contact, r.vendor_phone].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canReturn ? <RecentReturns /> : null}

      {returning ? (
        <ReturnDialog
          rows={chosen}
          onClose={() => setReturning(false)}
          onDone={() => {
            setReturning(false);
            setPicked(new Set());
          }}
        />
      ) : null}
    </div>
  );
}
