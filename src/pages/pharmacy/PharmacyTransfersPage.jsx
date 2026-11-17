import { ArrowRight } from "lucide-react";
import { useState } from "react";
import FormField from "../../components/ui/FormField";
import ConfirmModal from "../../components/ui/ConfirmModal";
import Pagination from "../../components/ui/Pagination";
import StockLinesEditor, { linesForApi } from "../../components/pharmacy/StockLinesEditor";
import { packUnits } from "../../components/pharmacy/format";
import { requestErrorOf } from "../../components/billing/format";
import { toast } from "../../stores/uiStore";
import { useStockLocations } from "../../queries/hooks/usePharmacyBatches";
import { useCreateTransfer, useTransfers } from "../../queries/hooks/usePharmacyDepartments";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";
import { SelectInput } from "../../components/pharmacy/Fields";
import useUrlState, { asNumber } from "../../hooks/useUrlState";

const when = (value) =>
  new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function NewTransfer({ locations }) {
  const create = useCreateTransfer();
  const main = locations.find((l) => l.kind === "main");
  const [fromId, setFromId] = useState(main ? String(main.id) : "");
  const [toId, setToId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([]);
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const from = locations.find((l) => String(l.id) === fromId);
  const to = locations.find((l) => String(l.id) === toId);

  const problems = {};
  if (!from) problems.from = "Choose where the stock comes from.";
  if (!to) problems.to = "Choose where the stock goes.";
  else if (from && from.id === to.id) problems.to = "Choose a different location.";
  else if (from && from.kind !== "main" && to.kind !== "main")
    problems.to = "Stock moves between the main pharmacy and a department.";
  if (!lines.length) problems.lines = "Add at least one medicine.";
  const errors = touched ? problems : {};

  const changeFrom = (value) => {
    setFromId(value);
    setLines([]);
    if (value === toId) setToId("");
  };

  const review = () => {
    setTouched(true);
    setError("");
    if (!Object.keys(problems).length) setConfirming(true);
  };

  const submit = async () => {
    try {
      const done = await create.mutateAsync({
        from_location_id: from.id,
        to_location_id: to.id,
        notes: notes.trim() || null,
        lines: linesForApi(lines),
      });
      toast(`${done.transfer_no}: stock moved from ${from.name} to ${to.name}.`);
      setLines([]);
      setNotes("");
      setTouched(false);
      setConfirming(false);
    } catch (err) {
      setConfirming(false);
      setError(requestErrorOf(err, "Could not move the stock"));
    }
  };

  return (
    <section className="flow-card" aria-labelledby="ptr-new-title">
      <h2 id="ptr-new-title" className="flow-sec-title">
        Move stock
      </h2>
      <div className="bill-form">
        <FormField label="From" required error={errors.from}>
          <SelectInput
            value={fromId}
            onChange={changeFrom}
            options={[
              { value: "", label: "Choose" },
              ...locations.map((l) => ({ value: String(l.id), label: l.name })),
            ]}
          />
        </FormField>
        <FormField label="To" required error={errors.to}>
          <SelectInput
            value={toId}
            onChange={setToId}
            options={[
              { value: "", label: "Choose" },
              ...locations
                .filter((l) => String(l.id) !== fromId)
                .map((l) => ({ value: String(l.id), label: l.name })),
            ]}
          />
        </FormField>
        <FormField label="Note" className="phv-span-all">
          <input
            className="jb-assign"
            maxLength={300}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </FormField>
      </div>
      <StockLinesEditor
        locationId={from?.id}
        locationName={from?.name}
        lines={lines}
        onChange={setLines}
        disabled={create.isPending}
      />
      {errors.lines || error ? (
        <p className="bill-dialog__error" role="alert">
          {error || errors.lines}
        </p>
      ) : null}
      <div className="phb-checkout__acts">
        <button
          type="button"
          className="flow-btn flow-btn-primary"
          disabled={create.isPending}
          onClick={review}
        >
          Move stock
        </button>
      </div>
      <ConfirmModal
        open={confirming}
        title="Move this stock?"
        variant="primary"
        confirmLabel={create.isPending ? "Moving…" : "Move stock"}
        busy={create.isPending}
        confirmDisabled={create.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={submit}
        message={
          <div className="phb-confirm-body">
            <p>
              From <strong>{from?.name}</strong> to <strong>{to?.name}</strong>
            </p>
            <ul>
              {lines.map((l) => (
                <li key={l.batch_id}>
                  {l.medicine_name} · {l.batch_no} · {packUnits(l.qty_units, l)}
                </li>
              ))}
            </ul>
            <p>The stock moves at once. To undo it, move it back with a new transfer.</p>
          </div>
        }
      />
    </section>
  );
}

function TransferList({ locations }) {
  const [locationId, setLocationId] = useUrlState("location_id", "");
  const [page, setPage] = useUrlState("page", 1, asNumber);
  const [pageSize, setPageSize] = useUrlState("size", 25, asNumber);
  const query = useTransfers({
    ...(locationId ? { location_id: locationId } : {}),
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const rows = query.data?.rows ?? [];
  return (
    <section className="flow-card" aria-labelledby="ptr-list-title">
      <div className="fset__cardhead">
        <h2 id="ptr-list-title" className="flow-sec-title">
          Transfers
        </h2>
        <span className="fset__count">{query.data?.total ?? 0}</span>
      </div>
      <div className="phs-filters">
        <label className="sr-only" htmlFor="ptr-filter" id="ptr-filter-label">
          Show transfers for location
        </label>
        <SelectInput
          id="ptr-filter"
          className="phb-filter-select"
          value={locationId}
          onChange={(value) => {
            setLocationId(value);
            setPage(1);
          }}
          options={[
            { value: "", label: "All locations" },
            ...locations.map((l) => ({ value: String(l.id), label: l.name })),
          ]}
        />
      </div>
      {query.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load transfers. Please try again.</p>
          <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : query.isLoading ? (
        <p className="phs-empty" role="status">
          Loading transfers…
        </p>
      ) : !rows.length ? (
        <p className="phs-empty">No stock has been moved yet.</p>
      ) : (
        <>
          <div className="fset__scroll">
            <table className="flow-table phs-table" aria-label="Stock transfers">
              <thead>
                <tr>
                  <th>Transfer</th>
                  <th>From and to</th>
                  <th className="phs-num">Medicines</th>
                  <th className="phs-num">Units</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Transfer">
                      <span className="phv-mono">{r.transfer_no}</span>
                      <span className="phs-meta">
                        {when(r.issued_at)}
                        {r.issued_by_name ? ` by ${r.issued_by_name}` : ""}
                      </span>
                    </td>
                    <td data-label="From and to">
                      <span className="ptr-route">
                        {r.from_location_name}
                        <ArrowRight size={13} aria-hidden="true" />
                        <span className="sr-only">to</span>
                        {r.to_location_name}
                      </span>
                    </td>
                    <td data-label="Medicines" className="phs-num">
                      {r.line_count}
                    </td>
                    <td data-label="Units" className="phs-num">
                      {r.units}
                    </td>
                    <td data-label="Note">{r.notes ?? "—"}</td>
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
            unit="transfers"
          />
        </>
      )}
    </section>
  );
}

export default function PharmacyTransfersPage() {
  const locations = useStockLocations();
  return (
    <div className="flow-root fset bill-ui phs phb">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Stock transfers</h1>
          <p className="phs-sub">
            Restock a department from the main pharmacy, or take unused stock back. Department stock
            can only be used by that department.
          </p>
        </div>
      </header>
      {locations.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load the locations. Please try again.</p>
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            onClick={() => locations.refetch()}
          >
            Try again
          </button>
        </div>
      ) : locations.isLoading ? (
        <p className="phs-empty" role="status">
          Loading…
        </p>
      ) : locations.data.length < 2 ? (
        <p className="phs-empty">
          Add a department on the Departments page before moving stock to it.
        </p>
      ) : (
        <>
          <NewTransfer locations={locations.data} />
          <TransferList locations={locations.data} />
        </>
      )}
    </div>
  );
}
