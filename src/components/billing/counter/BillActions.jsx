import { useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  billPdfHref,
  receiptPdfHref,
  useCancelBill,
  useDeskSettings,
  useFinaliseBill,
  useRereadBill,
} from "../../../queries/hooks/useBilling";
import { errorOf } from "../format";
import { claimBadgeText } from "./lineText";
import { finaliseBlockers } from "./finaliseChecks";

export default function BillActions({ bill, onBill, schemes, payLater }) {
  const { data: settings } = useDeskSettings();
  const finalise = useFinaliseBill();
  const cancel = useCancelBill();
  const reread = useRereadBill();
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const blockers = finaliseBlockers(bill, { schemes, settings, payLater });
  const badge = claimBadgeText(bill.claim_status);

  const save = async () => {
    setError(null);
    try {
      onBill(await reread.mutateAsync({ billId: bill.id }));
      setNote("Draft saved.");
    } catch (e) {
      setError(errorOf(e, "This bill could not be read again"));
    }
  };

  const makeFinal = async () => {
    setError(null);
    setNote(null);
    const printing = window.open("", "_blank");
    if (printing) printing.opener = null;
    try {
      const made = await finalise.mutateAsync({
        billId: bill.id,
        visitId: bill.visit_id,
        version: bill.version,
        ...(payLater ? { pay_later: true } : {}),
      });
      onBill(made);
      if (printing) printing.location.replace(billPdfHref(made.id));
      else window.open(billPdfHref(made.id), "_blank", "noopener");
    } catch (e) {
      printing?.close();
      const version = e?.response?.data?.version;
      setError(
        errorOf(e, "This bill could not be made final") +
          (version ? ` (it is now version ${version})` : ""),
      );
      if (version) {
        try {
          onBill(await reread.mutateAsync({ billId: bill.id }));
        } catch {
          setError("This bill changed and could not be read again — open it again");
        }
      }
    }
  };

  const drop = async () => {
    setError(null);
    try {
      onBill(
        await cancel.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          reason: reason.trim(),
        }),
      );
      setCancelling(false);
      setReason("");
    } catch (e) {
      setError(errorOf(e, "This bill could not be cancelled"));
    }
  };

  return (
    <section className="bc-card bc-actions" aria-label="Bill actions">
      <div className="bc-head__row">
        {badge && <span className="badge b-amb">{badge}</span>}

        {bill.status === "draft" && (
          <button
            type="button"
            className="st-btn st-btn-g"
            disabled={reread.isPending}
            onClick={save}
          >
            Save draft
          </button>
        )}

        {bill.status === "draft" && (
          <button
            type="button"
            className="st-btn st-btn-grn"
            disabled={!!blockers.length || finalise.isPending}
            onClick={makeFinal}
          >
            Finalise &amp; print
          </button>
        )}

        {bill.totals.paid > 0 && (
          <a
            className="st-btn st-btn-g"
            href={receiptPdfHref(bill.id)}
            target="_blank"
            rel="noreferrer"
          >
            Print receipt
          </a>
        )}

        {bill.status === "final" && bill.totals.paid === 0 && (
          <button
            type="button"
            className="st-btn st-btn-red"
            onClick={() => {
              setError(null);
              setReason("");
              setCancelling(true);
            }}
          >
            Cancel unpaid bill
          </button>
        )}
      </div>

      {!!blockers.length && bill.status === "draft" && (
        <ul className="bc-list" aria-label="Before this bill can be made final">
          {blockers.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {note && <div className="bc-note">{note}</div>}
      {error && <div className="bc-err">{error}</div>}

      <ConfirmModal
        open={cancelling}
        title={`Cancel ${bill.bill_no || "this bill"}?`}
        confirmLabel="Cancel bill"
        cancelLabel="Keep it"
        busy={cancel.isPending}
        error={error}
        confirmDisabled={!reason.trim()}
        message={
          <label className="bc-field">
            <span className="bc-field__lbl">Why is this bill being cancelled?</span>
            <textarea
              className="bc-field__in"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        }
        onConfirm={drop}
        onCancel={() => setCancelling(false)}
      />
    </section>
  );
}
