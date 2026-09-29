import { useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  billPdfHref,
  receiptPdfHref,
  useCancelBill,
  useDeleteDraft,
  useDeskSettings,
  useFinaliseBill,
  useRereadBill,
  useSaveDraft,
} from "../../../queries/hooks/useBilling";
import { errorOf } from "../format";
import { claimBadgeText } from "./lineText";
import { finaliseBlockers } from "./finaliseChecks";

export default function BillActions({
  bill,
  onBill,
  onDeleted,
  schemes,
  payLater,
  needsCategory,
  form,
}) {
  const { data: settings } = useDeskSettings();
  const finalise = useFinaliseBill();
  const cancel = useCancelBill();
  const reread = useRereadBill();
  const deleteDraft = useDeleteDraft();
  const saveDraft = useSaveDraft();
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [note, setNote] = useState(null);
  const cancelling = form.value.cancelReason !== null && bill.status === "final";
  const reason = form.value.cancelReason ?? "";
  const setReason = (next) => form.set("cancelReason", next);

  const blockers = finaliseBlockers(bill, { schemes, settings, payLater, needsCategory });
  const badge = claimBadgeText(bill.claim_status, bill.claim_cleared_on);

  const save = async () => {
    setError(null);
    try {
      onBill(await saveDraft.mutateAsync({ billId: bill.id, visitId: bill.visit_id }));
      setNote("Draft saved.");
    } catch (e) {
      setError(errorOf(e, "This draft could not be saved"));
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
      form.clear();
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
      form.clear();
    } catch (e) {
      setError(errorOf(e, "This bill could not be cancelled"));
    }
  };

  const erase = async () => {
    setError(null);
    try {
      await deleteDraft.mutateAsync({
        billId: bill.id,
        visitId: bill.visit_id,
        reason: deleting.trim(),
      });
      form.clear();
      setDeleting(null);
      onDeleted();
    } catch (e) {
      setError(errorOf(e, "This draft could not be deleted"));
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
            disabled={saveDraft.isPending}
            onClick={save}
          >
            Save draft
          </button>
        )}

        {bill.status === "draft" && bill.bill_type === "invoice" && (
          <button
            type="button"
            className="st-btn st-btn-red"
            onClick={() => {
              setError(null);
              setNote(null);
              setDeleting("");
            }}
          >
            Delete draft
          </button>
        )}

        {form.dirty && (
          <button
            type="button"
            className="st-btn st-btn-g"
            onClick={() => {
              form.clear();
              setError(null);
              setNote("Form cleared.");
            }}
          >
            Clear form
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
        onCancel={() => form.drop("cancelReason")}
      />

      <ConfirmModal
        open={deleting !== null}
        title="Delete this draft bill?"
        confirmLabel="Delete draft"
        cancelLabel="Keep it"
        busy={deleteDraft.isPending}
        error={error}
        message={
          <label className="bc-field">
            <span className="bc-field__lbl">Why is this draft being deleted? (optional)</span>
            <textarea
              className="bc-field__in"
              rows={2}
              value={deleting ?? ""}
              onChange={(e) => setDeleting(e.target.value)}
            />
          </label>
        }
        onConfirm={erase}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}
