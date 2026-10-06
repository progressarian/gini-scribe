import { useEffect, useRef, useState } from "react";
import { DEPOSIT_MODE } from "../../../../shared/billingVocab.js";
import { refundReceiptPdfHref, useRefundBoard } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import { refundLegsText, refundModeText } from "./lineText";
import { PdfButton } from "./PdfViewer";

const SEARCH_MIN = 2;

const SECTIONS = [
  {
    key: "to_pay",
    title: "Approved — pay out now",
    empty: "No approved refund is waiting to be paid back.",
  },
  { key: "waiting", title: "Waiting for admin", empty: "No refund request is waiting." },
  { key: "rejected", title: "Rejected", empty: "No refund was rejected in these dates." },
  { key: "paid", title: "Paid back", empty: "No refund was paid back in these dates." },
];

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : "—";

function Amount({ row }) {
  const { credited, paid_back: paidBack, to_pay: toPay, against_balance: offBalance } = row.amounts;
  if (row.group === "rejected") return "—";
  if (row.group === "waiting" && !row.preview) {
    return <span className="bc-head__meta">{row.preview_error || "—"}</span>;
  }
  const kept = row.approved_mode === DEPOSIT_MODE;
  const lead =
    row.group === "paid"
      ? `${fromPaise(paidBack)} ${kept ? "kept as deposit" : "paid back"}`
      : row.group === "waiting"
        ? `${fromPaise(toPay)} to go back`
        : `${fromPaise(toPay)} to pay back`;
  const legs = row.group === "waiting" ? row.preview?.refund.legs : null;
  return (
    <>
      <strong>{lead}</strong>
      <span className="bc-head__meta">
        {" "}
        · credited {fromPaise(credited)}
        {row.group === "to_pay" && paidBack > 0 ? ` · ${fromPaise(paidBack)} paid back` : ""}
        {offBalance > 0 ? ` · ${fromPaise(offBalance)} off what is owed` : ""}
        {legs?.length ? ` · ${refundLegsText(legs, fromPaise)}` : ""}
      </span>
    </>
  );
}

function Mode({ row }) {
  if (!row.approved_mode) return `Asked: ${refundModeText(row.requested_mode)}`;
  const changed = row.approved_mode !== row.requested_mode;
  return (
    <>
      {refundModeText(row.approved_mode)}
      {changed && (
        <span className="bc-head__meta">
          {" "}
          · asked {refundModeText(row.requested_mode)}
          {row.mode_reason ? ` — ${row.mode_reason}` : ""}
        </span>
      )}
    </>
  );
}

function Reason({ row }) {
  const { label, note } = row.reason;
  return (
    <>
      {label || note || "—"}
      {label && note && <span className="bc-head__meta"> — {note}</span>}
      {row.status === "rejected" && (
        <div className="bc-err">
          Rejected by {row.decided_by?.name ?? "the admin"}
          {row.decision_note ? `: ${row.decision_note}` : ""}
        </div>
      )}
    </>
  );
}

function When({ row }) {
  const decided = row.status === "rejected" ? "Rejected" : "Approved";
  const discount = row.kind === "discount";
  return (
    <>
      <div>
        {discount ? "Discount given" : "Asked"} {clock(row.requested_at)} by{" "}
        {row.requested_by?.name ?? "—"}
      </div>
      {row.decided_at && !discount && (
        <div className="bc-head__meta">
          {decided} {clock(row.decided_at)} by {row.decided_by?.name ?? "the admin"}
        </div>
      )}
      {row.paid_at && (
        <div className="bc-head__meta">
          {row.approved_mode === DEPOSIT_MODE ? "Kept as deposit" : "Paid back"}{" "}
          {clock(row.paid_at)}
          {row.paid_by ? ` by ${row.paid_by}` : ""}
        </div>
      )}
    </>
  );
}

function RefundRow({ row, onOpen }) {
  return (
    <tr data-request={row.key}>
      <td data-label="Patient">
        {row.patient.name}
        <span className="bc-head__meta"> · {row.patient.file_no || "—"}</span>
      </td>
      <td data-label="Bill">
        {row.bill_no}
        <span className="bc-head__meta"> · visit {row.visit_date || row.bill_date || "—"}</span>
      </td>
      <td data-label="Credit note">
        {row.credit_note?.bill_no || "—"}
        {row.kind === "discount" && <span className="bc-head__meta"> · discount</span>}
      </td>
      <td data-label="Amount">
        <Amount row={row} />
      </td>
      <td data-label="Mode">
        <Mode row={row} />
      </td>
      <td data-label="Reason">
        <Reason row={row} />
      </td>
      <td data-label="When">
        <When row={row} />
      </td>
      <td data-label="" className="bc-cell-actions">
        <button
          type="button"
          className={`st-btn ${row.group === "to_pay" ? "st-btn-grn" : "st-btn-g"}`}
          aria-label={`Open bill ${row.bill_no}`}
          onClick={() => onOpen(row)}
        >
          {row.group === "to_pay" ? "Open to pay out" : "Open"}
        </button>
        {row.group === "paid" && row.amounts.paid_back > 0 && (
          <PdfButton
            className="st-btn st-btn-g"
            href={refundReceiptPdfHref(row.credit_note.id)}
            title={`Refund receipt ${row.credit_note.bill_no || ""}`.trim()}
            fileName={`RefundReceipt_${row.credit_note.bill_no || row.credit_note.id}.pdf`}
          >
            Print refund receipt
          </PdfButton>
        )}
      </td>
    </tr>
  );
}

function Section({ section, rows, count, more, open, onToggle, onOpen }) {
  const id = `bc-refunds-${section.key}`;
  return (
    <section className="bc-card" aria-labelledby={`${id}-head`}>
      <h3 className="bc-card__title" id={`${id}-head`}>
        <button
          type="button"
          className="bc-group bc-group--toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          <span className="bc-group__caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          {section.title}
          <span className="bc-count">{count}</span>
        </button>
      </h3>
      <div id={id} hidden={!open}>
        {!rows.length && <div className="empty-note">{section.empty}</div>}
        {!!rows.length && (
          <div className="ltablewrap bc-stack">
            <table className="ltable" aria-label={section.title}>
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Bill</th>
                  <th>Credit note</th>
                  <th>Amount</th>
                  <th>Mode</th>
                  <th>Reason</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <RefundRow key={row.key} row={row} onOpen={onOpen} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more && (
          <p className="bc-head__meta">
            Showing the first {rows.length} of {count} — search or narrow the dates to see the rest.
          </p>
        )}
      </div>
    </section>
  );
}

const NO_FILTERS = {};

export function approvedRefundText(rows) {
  const total = fromPaise(rows.reduce((sum, row) => sum + row.amounts.to_pay, 0));
  if (rows.length === 1) {
    return rows[0].kind === "discount"
      ? `Discount to pay back for ${rows[0].patient.name} — ${total}`
      : `Refund approved for ${rows[0].patient.name} — ${total} to pay back`;
  }
  return `${rows.length} refunds and discounts to pay back — ${total}`;
}

export function useRefundsToPay(enabled, onApproved) {
  const { data } = useRefundBoard(NO_FILTERS, { enabled });
  const seen = useRef(null);
  const told = useRef(onApproved);
  told.current = onApproved;
  const rows = data?.groups.to_pay;

  useEffect(() => {
    if (!rows) return;
    const fresh = seen.current ? rows.filter((row) => !seen.current.has(row.key)) : [];
    seen.current = new Set(rows.map((row) => row.key));
    if (fresh.length) told.current(fresh);
  }, [rows]);

  return data?.counts.to_pay ?? 0;
}

const filtersOf = (q, from, to) =>
  Object.fromEntries(
    Object.entries({ q: q.length >= SEARCH_MIN ? q : "", from, to }).filter(([, v]) => v),
  );

export default function RefundsBoard({ onOpen }) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState({ to_pay: true, waiting: false, rejected: false, paid: false });
  const { data, isLoading, error } = useRefundBoard(filtersOf(q, from, to));
  const counts = data?.counts;

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!data?.q || !counts) return;
    setOpen((was) =>
      Object.fromEntries(SECTIONS.map(({ key }) => [key, was[key] || counts[key] > 0])),
    );
  }, [data?.q, counts?.to_pay, counts?.waiting, counts?.rejected, counts?.paid]);

  const toggle = (key) => () => setOpen((was) => ({ ...was, [key]: !was[key] }));

  return (
    <div className="bc-refunds">
      <section className="bc-card" aria-label="Find refunds">
        <h3 className="bc-card__title">Refunds</h3>
        {data && (
          <p className="bc-head__meta" aria-live="polite" data-testid="refunds-to-pay-total">
            {counts.to_pay === 1 ? "1 refund" : `${counts.to_pay} refunds`} to pay back ·{" "}
            {fromPaise(data.to_pay_total)} · {counts.waiting} waiting for admin
          </p>
        )}
        <div className="bc-head__row bc-refunds__filters">
          <label className="bc-field">
            <span className="bc-field__lbl">Search</span>
            <input
              className="bc-field__in"
              type="search"
              aria-label="Search refunds"
              value={search}
              placeholder="Name, file no, bill or CN no…"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="bc-field">
            <span className="bc-field__lbl">Rejected / paid back from</span>
            <input
              className="bc-field__in"
              type="date"
              value={from || data?.from || ""}
              max={to || data?.to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="bc-field">
            <span className="bc-field__lbl">to</span>
            <input
              className="bc-field__in"
              type="date"
              value={to || data?.to || ""}
              min={from || data?.from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <p className="bc-head__meta">
          The dates pick which rejected and paid-back refunds show; approved and waiting ones always
          show.
        </p>
        {isLoading && <div className="empty-note">Loading…</div>}
        {error && <div className="bc-err">{errorOf(error, "The refunds could not be read")}</div>}
      </section>
      {data &&
        SECTIONS.map((section) => (
          <Section
            key={section.key}
            section={section}
            rows={data.groups[section.key]}
            count={counts[section.key]}
            more={data.more[section.key]}
            open={open[section.key]}
            onToggle={toggle(section.key)}
            onOpen={onOpen}
          />
        ))}
    </div>
  );
}
