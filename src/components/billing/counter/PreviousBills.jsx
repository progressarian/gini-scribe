import { useState } from "react";
import { billPdfHref, creditNotePdfHref } from "../../../queries/hooks/useBilling";
import { fromPaise } from "../format";
import { billStatusText } from "./lineText";
import RefundDialog from "./RefundDialog";
import { PdfButton } from "./PdfViewer";

function Credits({ bill }) {
  const credits = bill.credits;
  if (!credits) return null;
  const waiting = credits.request?.status === "pending";
  if (!credits.notes.length && !waiting) return null;
  return (
    <ul className="bc-refund__credits" aria-label={`Refunds on bill ${bill.bill_no}`}>
      {credits.notes.map((cn) => (
        <li key={cn.id}>
          <PdfButton
            className="bc-linkbtn"
            href={creditNotePdfHref(cn.id)}
            title={`Credit note ${cn.bill_no}`}
            fileName={`CreditNote_${cn.bill_no}.pdf`}
          >
            Refunded {fromPaise(cn.refunded)} on {cn.bill_no}
          </PdfButton>
          {cn.payable !== cn.refunded && (
            <span className="bc-head__meta"> · credited {fromPaise(cn.payable)}</span>
          )}
        </li>
      ))}
      {waiting && <li className="bc-head__meta">Refund requested — waiting for admin</li>}
    </ul>
  );
}

export default function PreviousBills({ bills, onOpen }) {
  const [refunding, setRefunding] = useState(null);
  const shown = bills.filter((b) => b.bill_type !== "credit_note");
  if (!shown.length) return null;

  return (
    <section className="bc-card" aria-label="Earlier bills on this visit">
      <h3 className="bc-card__title">Earlier bills on this visit</h3>
      <div className="ltablewrap bc-stack">
        <table className="ltable" aria-label="Earlier bills">
          <thead>
            <tr>
              <th>Bill</th>
              <th>Status</th>
              <th>Actual</th>
              <th>Discount</th>
              <th>Patient pays</th>
              <th>Paid</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <tr key={b.id}>
                <td data-label="Bill">
                  {b.bill_no || "Not numbered"}
                  <Credits bill={b} />
                </td>
                <td data-label="Status">{billStatusText(b.status)}</td>
                <td data-label="Actual">{fromPaise(b.totals.actual)}</td>
                <td data-label="Discount">{fromPaise(b.totals.discount)}</td>
                <td data-label="Patient pays">{fromPaise(b.totals.payable)}</td>
                <td data-label="Paid">{fromPaise(b.totals.paid)}</td>
                <td data-label="" className="bc-cell-actions">
                  {onOpen && b.status !== "draft" && (
                    <button
                      type="button"
                      className="st-btn st-btn-g"
                      aria-label={`Open bill ${b.bill_no || "draft"}`}
                      onClick={() => onOpen(b)}
                    >
                      Open
                    </button>
                  )}
                  {b.status === "final" && b.credits?.request?.status !== "pending" && (
                    <button
                      type="button"
                      className="st-btn st-btn-g"
                      aria-label={`Refund on bill ${b.bill_no}`}
                      onClick={() => setRefunding(b)}
                    >
                      Refund…
                    </button>
                  )}
                  <PdfButton
                    className="st-btn"
                    href={billPdfHref(b.id)}
                    title={`Bill ${b.bill_no || "draft"}`}
                    fileName={`Bill_${b.bill_no || b.id}.pdf`}
                    aria-label={`Print bill ${b.bill_no || "draft"}`}
                  >
                    Print
                  </PdfButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {refunding && (
        <RefundDialog
          bill={refunding}
          onClose={() => setRefunding(null)}
          onSent={() => setRefunding(null)}
        />
      )}
    </section>
  );
}
