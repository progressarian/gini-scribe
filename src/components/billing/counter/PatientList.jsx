import { useEffect, useRef, useState } from "react";
import { COUNTER_BILL_STATE as STATE } from "../../../../shared/billingVocab.js";
import { fromPaise } from "../format";
import { initialsOf } from "./PatientHeader";
import { changeOutcome } from "./ConsultantChange";

const BILL_BADGE = {
  [STATE.NONE]: { tone: "none", label: () => "No bill" },
  [STATE.DRAFT]: { tone: "draft", label: () => "Draft" },
  [STATE.DUE]: { tone: "due", label: (bill) => `${fromPaise(bill.due)} due` },
  [STATE.PAID]: { tone: "paid", label: () => "Paid" },
  [STATE.CLAIM_PENDING]: { tone: "claim", label: () => "CGHS pending" },
  [STATE.CLAIM_CLEARED]: { tone: "paid", label: () => "Cleared" },
};

export function BillBadge({ bill }) {
  const badge = BILL_BADGE[bill?.state] || BILL_BADGE[STATE.NONE];
  return <span className={`bc-badge bc-badge--${badge.tone}`}>{badge.label(bill)}</span>;
}

function Badges({ row }) {
  return (
    <span className="bc-row__badges">
      {row.online && <span className="bc-badge bc-badge--online">Online</span>}
      {row.hints?.newTests > 0 && <span className="bc-badge bc-badge--new">New tests</span>}
      {row.samplesOnly && <span className="bc-badge bc-badge--samples">Samples only</span>}
      <BillBadge bill={row.bill} />
      {row.refundPending && <span className="bc-badge bc-badge--draft">Refund pending</span>}
      {row.payBack > 0 && (
        <span className="bc-badge bc-badge--due">{fromPaise(row.payBack)} to pay back</span>
      )}
      {row.refunded > 0 && <span className="bc-badge bc-badge--claim">Refunded</span>}
    </span>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function hintsOf(hints) {
  if (!hints) return [];
  return [
    hints.newTests > 0 && `${plural(hints.newTests, "new test")} after consultation`,
    hints.consultantChanged && "Consultant changed — fee to settle",
    hints.consultation && "Consultation done — not billed",
    hints.tests > 0 && `${plural(hints.tests, "test")} ordered`,
    hints.notPriced > 0 && `${hints.notPriced} not priced`,
    hints.due > 0 && `${fromPaise(hints.due)} due`,
  ].filter(Boolean);
}

function VisitRow({ row, active, onPick }) {
  const hints = hintsOf(row.hints);
  return (
    <button
      type="button"
      className={`bc-row${active ? " bc-row--on" : ""}`}
      aria-current={active ? "true" : undefined}
      onClick={() => onPick(row.visitId)}
    >
      <span className="bc-avatar" aria-hidden="true">
        {initialsOf(row.name)}
      </span>
      <span className="bc-row__top">
        <span className="bc-row__name">{row.name}</span>
        {row.statusLabel ? <span className="bc-row__status">{row.statusLabel}</span> : null}
      </span>
      {hints.length > 0 && <span className="bc-row__hints">{hints.join(" · ")}</span>}
      <span className="bc-row__meta">
        {row.age}
        {(row.sex || "")[0] || ""} · {row.fileNo || "—"}
      </span>
      <Badges row={row} />
    </button>
  );
}

function ChangeRow({ change, active, onPick }) {
  return (
    <button
      type="button"
      className={`bc-row${active ? " bc-row--on" : ""}`}
      aria-current={active ? "true" : undefined}
      onClick={() => onPick(change.visit_id)}
    >
      <span className="bc-avatar" aria-hidden="true">
        {initialsOf(change.patient.name)}
      </span>
      <span className="bc-row__top">
        <span className="bc-row__name">{change.patient.name}</span>
      </span>
      <span className="bc-row__hints">
        {change.from.name} → {change.to.name} · {changeOutcome(change)}
      </span>
      <span className="bc-row__meta">{change.patient.file_no || "—"}</span>
    </button>
  );
}

function Rows({ rows, visitId, onPick }) {
  return rows.map((row) => (
    <VisitRow key={row.visitId} row={row} active={row.visitId === visitId} onPick={onPick} />
  ));
}

export const counterRows = (data) => [
  ...(data?.toBill || []),
  ...(data?.billed || []),
  ...(data?.waiting || []),
];

function Group({
  id,
  label,
  rows,
  open,
  onToggle,
  empty,
  isLoading,
  visitId,
  onPick,
  toggleRef,
  children,
}) {
  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        className="bc-group bc-group--toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className="bc-group__caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {label}
        <span className="bc-count">{rows.length}</span>
      </button>
      <div id={id} hidden={!open}>
        {isLoading && <div className="bc-list__empty">Loading…</div>}
        {!isLoading && !rows.length && <div className="bc-list__empty">{empty}</div>}
        {children ?? <Rows rows={rows} visitId={visitId} onPick={onPick} />}
      </div>
    </>
  );
}

export default function PatientList({
  data,
  isLoading,
  visitId,
  searching,
  onPick,
  feeChanges = [],
  feeFocus = 0,
}) {
  const toBill = data?.toBill || [];
  const billed = data?.billed || [];
  const waiting = data?.waiting || [];
  const matchToBill = searching && toBill.length > 0;
  const matchBilled = searching && billed.length > 0;
  const matchWaiting = searching && waiting.length > 0;
  const [open, setOpen] = useState({ fees: true, toBill: true, billed: true, waiting: false });
  const feesToggle = useRef(null);

  useEffect(() => {
    if (!feeFocus) return;
    setOpen((was) => ({ ...was, fees: true }));
    feesToggle.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    feesToggle.current?.focus({ preventScroll: true });
  }, [feeFocus]);
  const toggle = (key) => () => setOpen((was) => ({ ...was, [key]: !was[key] }));

  useEffect(() => {
    setOpen((was) => ({ ...was, waiting: matchWaiting }));
  }, [matchWaiting]);

  useEffect(() => {
    if (matchToBill) setOpen((was) => ({ ...was, toBill: true }));
  }, [matchToBill]);

  useEffect(() => {
    if (matchBilled) setOpen((was) => ({ ...was, billed: true }));
  }, [matchBilled]);

  const shared = { isLoading, visitId, onPick };
  return (
    <div className="bc-list__body">
      {feeChanges.length > 0 && (
        <section aria-label="Consultant changes to settle">
          <Group
            id="bc-fee-changes"
            label="Fee to settle"
            rows={feeChanges}
            open={open.fees}
            onToggle={toggle("fees")}
            toggleRef={feesToggle}
            {...shared}
            isLoading={false}
          >
            {feeChanges.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                active={change.visit_id === visitId}
                onPick={onPick}
              />
            ))}
          </Group>
        </section>
      )}
      <Group
        id="bc-to-bill"
        label="Pending bill"
        rows={toBill}
        open={open.toBill}
        onToggle={toggle("toBill")}
        empty="Nobody is waiting for a bill."
        {...shared}
      />
      <Group
        id="bc-billed"
        label="Billed today / Exited"
        rows={billed}
        open={open.billed}
        onToggle={toggle("billed")}
        empty="Nobody billed or exited yet."
        {...shared}
        isLoading={false}
      />
      <Group
        id="bc-waiting"
        label="Nothing to bill yet"
        rows={waiting}
        open={open.waiting}
        onToggle={toggle("waiting")}
        empty="Nobody waiting."
        {...shared}
        isLoading={false}
      />
    </div>
  );
}
