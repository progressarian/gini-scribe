import { useId, useMemo, useState } from "react";
import { Check, Download, Printer, Undo2 } from "lucide-react";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import { CLAIM_BILLS_AT_ONCE, claimSubtotals } from "../../../shared/claimsRegister";
import {
  useClaimsExport,
  useClaimsRegister,
  useClearClaims,
  useUndoClear,
} from "../../queries/hooks/useBillingClaims";
import { toast } from "../../stores/uiStore";
import { fromPaise, moneyTyped, requestErrorOf } from "../../components/billing/format";
import { saveBlob } from "../../components/billing/importText";
import useDialog from "../../components/billing/useDialog";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./billingUi.css";
import "./cghsRegister.css";

const TABS = [
  { key: "pending", label: "Pending" },
  { key: "cleared", label: "Cleared" },
];

const NO_FILTERS = { from: "", to: "", category: "", doctor_id: "", payer: "", reference: "" };

const IST_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const indiaToday = () => IST_DAY.format(new Date());

const paiseOf = (text) => {
  const value = Number(text);
  return text === "" || !Number.isFinite(value) ? null : Math.round(value * 100);
};

const rupeeText = (paise) => (paise / 100).toFixed(2);

const daysText = (days) => (days === 1 ? "1 day" : `${days} days`);

const billsText = (count) => (count === 1 ? "1 bill" : `${count} bills`);

function Filters({ tab, filters, options, onChange }) {
  const set = (key) => (e) => onChange({ ...filters, [key]: e.target.value });
  const id = useId();
  return (
    <div className="cghs-filters" role="group" aria-label="Filters">
      <div className="fset__field">
        <label htmlFor={`${id}-from`}>Bill date from</label>
        <input
          id={`${id}-from`}
          type="date"
          className="jb-assign"
          value={filters.from}
          onChange={set("from")}
        />
      </div>
      <div className="fset__field">
        <label htmlFor={`${id}-to`}>to</label>
        <input
          id={`${id}-to`}
          type="date"
          className="jb-assign"
          value={filters.to}
          onChange={set("to")}
        />
      </div>
      <div className="fset__field">
        <label htmlFor={`${id}-cat`}>Sub-category</label>
        <select
          id={`${id}-cat`}
          className="jb-assign"
          value={filters.category}
          onChange={set("category")}
        >
          <option value="">All</option>
          {(options?.categories ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="fset__field">
        <label htmlFor={`${id}-doc`}>Doctor</label>
        <select
          id={`${id}-doc`}
          className="jb-assign"
          value={filters.doctor_id}
          onChange={set("doctor_id")}
        >
          <option value="">All</option>
          {(options?.doctors ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="fset__field">
        <label htmlFor={`${id}-payer`}>Payer</label>
        <select
          id={`${id}-payer`}
          className="jb-assign"
          value={filters.payer}
          onChange={set("payer")}
        >
          <option value="">All</option>
          {(options?.payers ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {tab === "cleared" ? (
        <div className="fset__field">
          <label htmlFor={`${id}-ref`}>Reference</label>
          <input
            id={`${id}-ref`}
            type="search"
            className="jb-assign"
            placeholder="UTR"
            maxLength={60}
            value={filters.reference}
            onChange={set("reference")}
          />
        </div>
      ) : null}
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini cghs-filters__reset"
        onClick={() => onChange(NO_FILTERS)}
      >
        Clear filters
      </button>
    </div>
  );
}

function ClearDialog({ bills, onClose, onDone }) {
  const clear = useClearClaims();
  const selected = bills.reduce((sum, bill) => sum + bill.claim, 0);
  const payers = [...new Set(bills.map((bill) => bill.payer_name))];
  const tooMany = bills.length > CLAIM_BILLS_AT_ONCE;
  const [receivedOn, setReceivedOn] = useState(indiaToday());
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState(rupeeText(selected));
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const id = useId();

  const received = paiseOf(amount);
  const difference = received === null ? null : received - selected;
  const ready =
    !tooMany &&
    payers.length === 1 &&
    difference === 0 &&
    reference.trim() !== "" &&
    receivedOn !== "" &&
    !clear.isPending;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setError("");
    try {
      const saved = await clear.mutateAsync({
        bill_ids: bills.map((bill) => bill.bill_id),
        received_on: receivedOn,
        reference: reference.trim(),
        amount,
        note: note.trim() || null,
      });
      onDone(`Cleared ${billsText(saved.bills.length)} — reference ${saved.reference}`);
    } catch (err) {
      setError(requestErrorOf(err, "Could not clear the bills"));
    }
  };

  return (
    <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
      <form
        ref={ref}
        className="flow-card bill-dialog cghs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id={titleId} className="bill-dialog__title">
          {bills.length === 1 ? `Mark bill ${bills[0].bill_no} cleared` : "Clear selected bills"}
        </h2>
        <p className="fset__cardsub">
          {billsText(bills.length)} · {fromPaise(selected)} claimed from{" "}
          {payers.length === 1 ? payers[0] : "more than one payer"}.
        </p>
        {payers.length > 1 ? (
          <p className="bill-dialog__error" role="alert">
            These bills are claimed from different payers ({payers.join(", ")}) — clear each payer's
            bills separately.
          </p>
        ) : null}
        {tooMany ? (
          <p className="bill-dialog__error" role="alert">
            One payment can clear at most {CLAIM_BILLS_AT_ONCE} bills — narrow the filters and clear
            this payment in parts, each part under the same reference.
          </p>
        ) : null}
        <div className="bill-form">
          <div className="fset__field">
            <label htmlFor={`${id}-on`}>Date received</label>
            <input
              id={`${id}-on`}
              type="date"
              className="jb-assign"
              max={indiaToday()}
              required
              value={receivedOn}
              onChange={(e) => setReceivedOn(e.target.value)}
            />
          </div>
          <div className="fset__field">
            <label htmlFor={`${id}-ref`}>Reference (UTR)</label>
            <input
              id={`${id}-ref`}
              className="jb-assign"
              maxLength={60}
              required
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <div className="fset__field">
            <label htmlFor={`${id}-amt`}>Amount received (₹)</label>
            <input
              id={`${id}-amt`}
              className="jb-assign"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(moneyTyped(e.target.value))}
            />
          </div>
          <div className="fset__field">
            <label htmlFor={`${id}-note`}>Note</label>
            <textarea
              id={`${id}-note`}
              className="jb-assign"
              rows={2}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <p
          className={`cghs-difference${difference === 0 ? " cghs-difference--ok" : ""}`}
          aria-live="polite"
        >
          {difference === null
            ? "Enter the amount received."
            : difference === 0
              ? "The amount matches the selected claims."
              : `Difference ${fromPaise(Math.abs(difference))} ${difference > 0 ? "more" : "less"} than claimed — CGHS pays each claim in full, so check the amount and the bills chosen.`}
        </p>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bill-dialog__actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="flow-btn flow-btn-primary" disabled={!ready}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

function UndoDialog({ row, onClose, onDone }) {
  const undo = useUndoClear();
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const reasonId = useId();
  const settlement = row.settlement;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const undone = await undo.mutateAsync({ id: settlement.id, reason: reason.trim() });
      onDone(
        `Undone — ${billsText(undone.bills.length)} of reference ${undone.reference} are pending again`,
      );
    } catch (err) {
      setError(requestErrorOf(err, "Could not undo the payment"));
    }
  };

  return (
    <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
      <form
        ref={ref}
        className="flow-card bill-dialog cghs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id={titleId} className="bill-dialog__title">
          Undo payment {settlement.reference}?
        </h2>
        <p className="fset__cardsub">
          Every bill this payment cleared ({fromPaise(settlement.total)} received on{" "}
          {settlement.received_on}) goes back to Pending. Use this only for a wrong entry.
        </p>
        <div className="fset__field">
          <label htmlFor={reasonId}>Reason</label>
          <textarea
            id={reasonId}
            className="jb-assign"
            rows={3}
            maxLength={1000}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bill-dialog__actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="flow-btn flow-btn-red"
            disabled={!reason.trim() || undo.isPending}
          >
            Undo payment
          </button>
        </div>
      </form>
    </div>
  );
}

function BillCell({ row }) {
  return (
    <>
      <strong>{row.bill_no}</strong>
      <div className="dreq__muted">{row.bill_date}</div>
    </>
  );
}

function PatientCell({ row }) {
  return (
    <>
      <strong>{row.patient_name}</strong>
      <div className="dreq__muted">
        {[row.uhid, row.referral_no ? `Referral ${row.referral_no}` : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </>
  );
}

function CategoryCell({ row }) {
  return (
    <>
      {row.category_label ?? "—"}
      <div className="dreq__muted">
        {[row.doctor_name, row.bill_codes.length ? row.bill_codes.join(", ") : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </>
  );
}

function ClaimCell({ row }) {
  return (
    <>
      <strong>{fromPaise(row.claim)}</strong>
      {row.credited ? (
        <div className="dreq__muted">
          {fromPaise(row.billed_claim)} less {fromPaise(row.credited)} credited
        </div>
      ) : null}
    </>
  );
}

function PendingTable({ rows, selected, onToggle, onClearOne }) {
  return (
    <table className="flow-table" aria-label="Pending claims">
      <thead>
        <tr>
          <th className="cghs-pick">
            <span className="cghs-sr">Select</span>
          </th>
          <th>Bill</th>
          <th>Patient</th>
          <th>Sub-category</th>
          <th className="cghs-num">Claim</th>
          <th className="cghs-num">Pending</th>
          <th className="bill-items__actions-head">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.bill_id}>
            <td className="cghs-pick" data-label="">
              <input
                type="checkbox"
                aria-label={`Select bill ${row.bill_no}`}
                checked={selected.has(row.bill_id)}
                onChange={() => onToggle(row.bill_id)}
              />
            </td>
            <td data-label="Bill">
              <BillCell row={row} />
            </td>
            <td data-label="Patient">
              <PatientCell row={row} />
            </td>
            <td data-label="Sub-category">
              <CategoryCell row={row} />
            </td>
            <td data-label="Claim" className="cghs-num">
              <ClaimCell row={row} />
            </td>
            <td data-label="Pending" className="cghs-num">
              {daysText(row.days_pending)}
            </td>
            <td data-label="" className="bill-items__actions">
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                aria-label={`Mark bill ${row.bill_no} cleared`}
                onClick={() => onClearOne(row)}
              >
                <Check size={14} aria-hidden="true" />
                Mark cleared
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ClearedTable({ rows, canUndo, onUndo }) {
  return (
    <table className="flow-table" aria-label="Cleared claims">
      <thead>
        <tr>
          <th>Bill</th>
          <th>Patient</th>
          <th>Sub-category</th>
          <th className="cghs-num">Claim</th>
          <th>Received</th>
          <th>Reference</th>
          <th>Cleared by</th>
          {canUndo ? <th className="bill-items__actions-head">Actions</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.bill_id}>
            <td data-label="Bill">
              <BillCell row={row} />
            </td>
            <td data-label="Patient">
              <PatientCell row={row} />
            </td>
            <td data-label="Sub-category">
              <CategoryCell row={row} />
            </td>
            <td data-label="Claim" className="cghs-num">
              <ClaimCell row={row} />
            </td>
            <td data-label="Received">
              {row.settlement?.received_on}
              <div className="dreq__muted">after {daysText(row.days_pending)}</div>
            </td>
            <td data-label="Reference">
              {row.settlement?.reference}
              {row.settlement?.note ? (
                <div className="dreq__muted">{row.settlement.note}</div>
              ) : null}
            </td>
            <td data-label="Cleared by">{row.settlement?.cleared_by_name ?? ""}</td>
            {canUndo ? (
              <td data-label="" className="bill-items__actions">
                {row.settlement ? (
                  <button
                    type="button"
                    className="flow-btn flow-btn-ghost flow-btn-mini"
                    aria-label={`Undo payment ${row.settlement.reference} for bill ${row.bill_no}`}
                    onClick={() => onUndo(row)}
                  >
                    <Undo2 size={14} aria-hidden="true" />
                    Undo
                  </button>
                ) : null}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PrintablePending({ rows, totals, filters }) {
  const groups = useMemo(() => claimSubtotals(rows), [rows]);
  const scope = [
    filters.from ? `from ${filters.from}` : null,
    filters.to ? `to ${filters.to}` : null,
    filters.payer || null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="cghs-print" aria-hidden="true">
      <h1>CGHS pending claims — {indiaToday()}</h1>
      {scope ? <p>{scope}</p> : null}
      {groups.map((group) => (
        <div key={group.label} className="cghs-print__group">
          <h2>{group.label}</h2>
          {group.doctors.map((doctor) => (
            <table key={doctor.label}>
              <caption>{doctor.label}</caption>
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Date</th>
                  <th>Patient</th>
                  <th>UHID</th>
                  <th>Codes</th>
                  <th>Referral</th>
                  <th>Claim</th>
                </tr>
              </thead>
              <tbody>
                {doctor.rows.map((row) => (
                  <tr key={row.bill_id}>
                    <td>{row.bill_no}</td>
                    <td>{row.bill_date}</td>
                    <td>{row.patient_name}</td>
                    <td>{row.uhid}</td>
                    <td>{row.bill_codes.join(", ")}</td>
                    <td>{row.referral_no ?? ""}</td>
                    <td>{fromPaise(row.claim)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}>
                    {doctor.label} — {billsText(doctor.count)}
                  </td>
                  <td>{fromPaise(doctor.amount)}</td>
                </tr>
              </tfoot>
            </table>
          ))}
          <p className="cghs-print__subtotal">
            {group.label} — {billsText(group.count)} · {fromPaise(group.amount)}
          </p>
        </div>
      ))}
      <p className="cghs-print__total">
        Total — {billsText(totals.count)} · {fromPaise(totals.amount)}
      </p>
    </section>
  );
}

export default function CghsRegisterPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canUndo = hasCapability(role, CAPABILITIES.ADMIN);
  const [tab, setTab] = useState("pending");
  const [filters, setFilters] = useState(NO_FILTERS);
  const [selected, setSelected] = useState(() => new Set());
  const [clearing, setClearing] = useState(null);
  const [undoing, setUndoing] = useState(null);
  const shownFilters = tab === "cleared" ? filters : { ...filters, reference: "" };
  const register = useClaimsRegister(tab, shownFilters);
  const exporting = useClaimsExport();

  const rows = register.data?.rows ?? [];
  const totals = register.data?.totals ?? { count: 0, amount: 0 };
  const chosen = rows.filter((row) => selected.has(row.bill_id));
  const chosenAmount = chosen.reduce((sum, row) => sum + row.claim, 0);
  const allChosen = rows.length > 0 && chosen.length === rows.length;

  const changeFilters = (next) => {
    setFilters(next);
    setSelected(new Set());
  };
  const changeTab = (next) => {
    setTab(next);
    setSelected(new Set());
  };
  const toggle = (billId) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(billId)) next.delete(billId);
      else next.add(billId);
      return next;
    });
  const done = (message) => {
    setClearing(null);
    setUndoing(null);
    setSelected(new Set());
    toast(message, "success");
  };
  const download = async () => {
    try {
      saveBlob(await exporting.mutateAsync({ tab, filters: shownFilters }));
    } catch (err) {
      toast(requestErrorOf(err, "Could not export the list"), "error", 6000);
    }
  };

  return (
    <div className="flow-root fset bill-ui cghs-page">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">CGHS register</h2>
        </div>
        <div className="fset__cardsub">
          Every final bill with an amount claimed from CGHS stays Pending until the payment reaches
          the bank. Clear one bill or tick several and clear them with one payment — the amount must
          equal their claims.
        </div>
        <div className="cghs-tabs" role="tablist" aria-label="Register">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`cghs-tab${tab === t.key ? " cghs-tab--on" : ""}`}
              onClick={() => changeTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Filters
          tab={tab}
          filters={filters}
          options={register.data?.options}
          onChange={changeFilters}
        />
        <div className="cghs-bar">
          <p className="cghs-totals" aria-live="polite">
            <strong>{billsText(totals.count)}</strong> · <strong>{fromPaise(totals.amount)}</strong>{" "}
            {tab === "pending" ? "pending" : "cleared"}
            {register.data?.truncated
              ? ` — showing the first ${rows.length}; narrow the filters to see the rest`
              : ""}
          </p>
          <div className="cghs-bar__actions">
            {tab === "pending" ? (
              <>
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost flow-btn-mini"
                  disabled={!rows.length}
                  onClick={() =>
                    setSelected(allChosen ? new Set() : new Set(rows.map((row) => row.bill_id)))
                  }
                >
                  {allChosen ? "Select none" : "Select all filtered"}
                </button>
                <button
                  type="button"
                  className="flow-btn flow-btn-primary flow-btn-mini"
                  disabled={!chosen.length}
                  onClick={() => setClearing(chosen)}
                >
                  Clear selected
                  {chosen.length ? ` (${chosen.length} · ${fromPaise(chosenAmount)})` : ""}
                </button>
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost flow-btn-mini"
                  disabled={!rows.length || register.data?.truncated}
                  onClick={() => window.print()}
                >
                  <Printer size={14} aria-hidden="true" />
                  Print pending list
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              disabled={exporting.isPending}
              onClick={download}
            >
              <Download size={14} aria-hidden="true" />
              {tab === "pending" ? "Export Pending (.xlsx)" : "Export Cleared (.xlsx)"}
            </button>
          </div>
        </div>
        {register.isLoading ? (
          <div className="fset__cardsub">Loading…</div>
        ) : register.isError ? (
          <div className="fset__cardsub" role="alert">
            {requestErrorOf(register.error, "Could not load the register")}
          </div>
        ) : !rows.length ? (
          <div className="bill-allclear">
            {tab === "pending" ? "No claims are pending here." : "No cleared claims match."}
          </div>
        ) : (
          <div className="fset__scroll fset__scroll--wide">
            {tab === "pending" ? (
              <PendingTable
                rows={rows}
                selected={selected}
                onToggle={toggle}
                onClearOne={(row) => setClearing([row])}
              />
            ) : (
              <ClearedTable rows={rows} canUndo={canUndo} onUndo={setUndoing} />
            )}
          </div>
        )}
      </div>

      {tab === "pending" ? (
        <PrintablePending rows={rows} totals={totals} filters={shownFilters} />
      ) : null}
      {clearing ? (
        <ClearDialog
          key={clearing.map((row) => row.bill_id).join()}
          bills={clearing}
          onClose={() => setClearing(null)}
          onDone={done}
        />
      ) : null}
      {undoing ? <UndoDialog row={undoing} onClose={() => setUndoing(null)} onDone={done} /> : null}
    </div>
  );
}
