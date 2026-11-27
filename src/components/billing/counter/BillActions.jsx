import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  receiptPdfHref,
  useCancelBill,
  useDeleteDraft,
  useSaveDraft,
  useStartBillEdit,
} from "../../../queries/hooks/useBilling";
import useAuthStore from "../../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../../shared/permissions";
import BillEditBar from "./BillEditBar";
import { errorOf } from "../format";
import { claimBadgeText } from "./lineText";
import { balanceOf, finaliseBlockers } from "./finaliseChecks";
import { useOnPaid } from "./paidSignal";
import { useMakeFinal } from "./useMakeFinal";
import RefundDialog from "./RefundDialog";
import PdfViewer, { PdfButton } from "./PdfViewer";

export default function BillActions({
  bill,
  onBill,
  onDeleted,
  onRefunded,
  onPricesChanged,
  schemes,
  needsCategory,
  opening = false,
  form,
  stillOnFloor = false,
  patientName,
}) {
  const final = useMakeFinal({ onBill, onPricesChanged, form });
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const startEdit = useStartBillEdit();
  const [reprint, setReprint] = useState(null);
  const cancel = useCancelBill();
  const deleteDraft = useDeleteDraft();
  const saveDraft = useSaveDraft();
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [note, setNote] = useState(null);
  const [refunding, setRefunding] = useState(false);
  const credited = (bill.credits?.notes?.length ?? 0) > 0;
  const refundWaiting = bill.credits?.request?.status === "pending";
  const cancelling = form.value.cancelReason !== null && bill.status === "final";
  const reason = form.value.cancelReason ?? "";
  const setReason = (next) => form.set("cancelReason", next);

  const blockers = finaliseBlockers(bill, { schemes, needsCategory });
  const paidInFull =
    bill.status === "draft" &&
    bill.bill_type === "invoice" &&
    bill.totals.paid > 0 &&
    balanceOf(bill) === 0;
  const finaliseNow = useRef(null);
  const [offerFinalise, setOfferFinalise] = useState(false);
  useOnPaid(
    bill.id,
    useCallback(() => setOfferFinalise(true), []),
  );

  useEffect(() => {
    if (!offerFinalise || !paidInFull) return;
    finaliseNow.current?.focus();
    setOfferFinalise(false);
  }, [offerFinalise, paidInFull]);
  const badge = claimBadgeText(bill.claim_status, bill.claim_cleared_on);
  const editing = Boolean(bill.editing);
  const mayEdit =
    hasCapability(role, CAPABILITIES.BILLING_EDIT_FINAL) &&
    bill.status === "final" &&
    bill.bill_type === "invoice" &&
    !editing;

  const edit = async () => {
    setError(null);
    setNote(null);
    try {
      onBill(
        await startEdit.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          version: bill.version,
        }),
      );
    } catch (e) {
      setError(errorOf(e, "This bill could not be opened for editing"));
    }
  };

  const save = async () => {
    setError(null);
    try {
      onBill(await saveDraft.mutateAsync({ billId: bill.id, visitId: bill.visit_id }));
      setNote("Draft saved.");
    } catch (e) {
      setError(errorOf(e, "This draft could not be saved"));
    }
  };

  const makeFinal = () => {
    setError(null);
    setNote(null);
    final.makeFinal(bill);
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
      {paidInFull && (
        <div className="bc-unfinal-banner" role="group" aria-label="Paid, not final">
          <div className="bc-unfinal-banner__row">
            <p>
              <strong>Paid in full — not final yet.</strong> Finalising gives it a bill number.
            </p>
            <button
              ref={finaliseNow}
              type="button"
              className="st-btn st-btn-grn"
              disabled={!!blockers.length || final.isPending || opening}
              onClick={makeFinal}
            >
              {final.isPending ? "Finalising…" : "Finalise this bill"}
            </button>
          </div>
          {stillOnFloor && (
            <p>Still on the floor — finalise when they leave if more may be added.</p>
          )}
          {!!blockers.length && <p>Can&apos;t finalise yet: {blockers.join(" ")}</p>}
        </div>
      )}
      {editing && (
        <BillEditBar
          bill={bill}
          patientName={patientName}
          onBill={(saved) => {
            onBill(saved);
            if (!saved.editing && saved.revision_no !== bill.revision_no) {
              setNote(`Bill ${saved.bill_no} updated — revision ${saved.revision_no}.`);
            }
          }}
          onPrint={setReprint}
        />
      )}
      <div className="bc-head__row">
        {badge && <span className="badge b-amb">{badge}</span>}

        {mayEdit && (
          <button
            type="button"
            className="st-btn st-btn-g"
            disabled={startEdit.isPending}
            onClick={edit}
          >
            {startEdit.isPending ? "Opening…" : "Edit bill"}
          </button>
        )}

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

        {bill.status === "draft" && balanceOf(bill) === 0 && (
          <button
            type="button"
            className="st-btn st-btn-grn"
            disabled={!!blockers.length || final.isPending || opening}
            title={blockers.length ? `Can't finalise yet: ${blockers.join(" ")}` : undefined}
            aria-describedby={blockers.length ? `bc-blockers-${bill.id}` : undefined}
            onClick={makeFinal}
          >
            Finalise &amp; print
          </button>
        )}

        {bill.totals.paid > 0 && (
          <PdfButton
            className="st-btn st-btn-g"
            href={receiptPdfHref(bill.id)}
            title={`Receipt ${bill.bill_no || ""}`.trim()}
            fileName={`Receipt_${bill.bill_no || bill.id}.pdf`}
          >
            Print receipt
          </PdfButton>
        )}

        {bill.status === "final" && bill.bill_type === "invoice" && !refundWaiting && !editing && (
          <button
            type="button"
            className="st-btn st-btn-g"
            onClick={() => {
              setError(null);
              setNote(null);
              setRefunding(true);
            }}
          >
            Refund…
          </button>
        )}

        {bill.status === "final" && bill.totals.paid === 0 && !credited && !editing && (
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
        <ul
          id={`bc-blockers-${bill.id}`}
          className="bc-list"
          aria-label="Before this bill can be made final"
        >
          {blockers.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {note && <div className="bc-note">{note}</div>}
      {error && <div className="bc-err">{error}</div>}
      {final.error && <div className="bc-err">{final.error}</div>}

      <PdfViewer pdf={final.printing} onClose={final.closePrinting} />
      <PdfViewer pdf={reprint} onClose={() => setReprint(null)} />

      {refunding && (
        <RefundDialog
          bill={bill}
          onClose={() => setRefunding(false)}
          onSent={() => {
            setRefunding(false);
            setNote("Refund requested — waiting for admin.");
            onRefunded?.();
          }}
        />
      )}

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
