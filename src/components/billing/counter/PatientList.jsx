import { useEffect, useState } from "react";
import { COUNTER_BILL_STATE as STATE } from "../../../../shared/billingVocab.js";
import { fromPaise } from "../format";

const BILL_BADGE = {
  [STATE.NONE]: { tone: "none", label: () => "No bill" },
  [STATE.DRAFT]: { tone: "draft", label: () => "Draft" },
  [STATE.DUE]: { tone: "due", label: (bill) => `${fromPaise(bill.due)} due` },
  [STATE.PAID]: { tone: "paid", label: () => "Paid" },
  [STATE.CLAIM_PENDING]: { tone: "claim", label: () => "CGHS pending" },
  [STATE.CLAIM_CLEARED]: { tone: "paid", label: () => "Cleared" },
};

function Badges({ row }) {
  const bill = BILL_BADGE[row.bill?.state] || BILL_BADGE[STATE.NONE];
  return (
    <span className="bc-row__badges">
      {row.online && <span className="bc-badge bc-badge--online">Online</span>}
      {row.samplesOnly && <span className="bc-badge bc-badge--samples">Samples only</span>}
      <span className={`bc-badge bc-badge--${bill.tone}`}>{bill.label(row.bill)}</span>
    </span>
  );
}

function VisitRow({ row, active, onPick }) {
  return (
    <button
      type="button"
      className={`bc-row${active ? " bc-row--on" : ""}`}
      aria-current={active ? "true" : undefined}
      onClick={() => onPick(row.visitId)}
    >
      <span className="bc-row__top">
        <span className="bc-row__name">{row.name}</span>
        {row.statusLabel ? <span className="bc-row__status">{row.statusLabel}</span> : null}
      </span>
      <span className="bc-row__meta">
        {row.age}
        {(row.sex || "")[0] || ""} · {row.fileNo || "—"}
      </span>
      <Badges row={row} />
    </button>
  );
}

function Rows({ rows, visitId, onPick }) {
  return rows.map((row) => (
    <VisitRow key={row.visitId} row={row} active={row.visitId === visitId} onPick={onPick} />
  ));
}

export default function PatientList({ data, isLoading, visitId, searching, onPick }) {
  const onFloor = data?.onFloor || [];
  const left = data?.left || [];
  const notArrived = data?.notArrived || [];
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(searching);
  }, [searching]);

  return (
    <div className="bc-list__body">
      <div className="bc-group">
        On the floor<span className="bc-count">{onFloor.length}</span>
      </div>
      {isLoading && <div className="bc-list__empty">Loading…</div>}
      {!isLoading && !onFloor.length && <div className="bc-list__empty">Nobody on the floor.</div>}
      <Rows rows={onFloor} visitId={visitId} onPick={onPick} />

      {left.length > 0 && (
        <>
          <div className="bc-group">
            Left today<span className="bc-count">{left.length}</span>
          </div>
          <Rows rows={left} visitId={visitId} onPick={onPick} />
        </>
      )}

      <button
        type="button"
        className="bc-group bc-group--toggle"
        aria-expanded={open}
        aria-controls="bc-not-arrived"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="bc-group__caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        Not arrived<span className="bc-count">{notArrived.length}</span>
      </button>
      <div id="bc-not-arrived" hidden={!open}>
        {!notArrived.length && <div className="bc-list__empty">Nobody waiting to arrive.</div>}
        <Rows rows={notArrived} visitId={visitId} onPick={onPick} />
      </div>
    </div>
  );
}
