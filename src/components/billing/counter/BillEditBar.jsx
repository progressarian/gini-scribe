import { useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  billPdfHref,
  useBillEditPreview,
  useDiscardBillEdit,
  useSaveBillEdit,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";

function ChangeList({ title, lines }) {
  if (!lines.length) return null;
  return (
    <div>
      <strong>{title}</strong>
      <ul className="bc-list">
        {lines.map((line) => (
          <li key={line.key}>{line.text}</li>
        ))}
      </ul>
    </div>
  );
}

const lineText = (line) => `${line.name} × ${line.quantity} — ${fromPaise(line.payable)}`;

function ChangeSummary({ preview }) {
  const difference = preview.payable_after - preview.payable_before;
  return (
    <div className="bc-edit-summary">
      <ChangeList
        title="Added"
        lines={preview.added.map((line) => ({ key: line.id, text: lineText(line) }))}
      />
      <ChangeList
        title="Removed"
        lines={preview.removed.map((line) => ({ key: line.id, text: lineText(line) }))}
      />
      <ChangeList
        title="Changed"
        lines={preview.changed.map(({ before, after }) => ({
          key: after.id,
          text: `${after.name}: ${fromPaise(before.payable)} → ${fromPaise(after.payable)}`,
        }))}
      />
      {preview.bill_discount_changed && <p>The additional discount on the bill was changed.</p>}
      <dl className="bc-edit-totals">
        <dt>Total before</dt>
        <dd>{fromPaise(preview.payable_before)}</dd>
        <dt>Total after</dt>
        <dd>{fromPaise(preview.payable_after)}</dd>
        <dt>Difference</dt>
        <dd>
          {difference >= 0 ? "+" : "−"}
          {fromPaise(Math.abs(difference))}
        </dd>
        <dt>Already collected</dt>
        <dd>{fromPaise(preview.paid)}</dd>
        <dt>Due after saving</dt>
        <dd>
          <strong>{fromPaise(preview.due)}</strong>
        </dd>
      </dl>
    </div>
  );
}

export default function BillEditBar({ bill, patientName, onBill, onPrint }) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState(null);
  const save = useSaveBillEdit();
  const discard = useDiscardBillEdit();
  const preview = useBillEditPreview(bill.id, bill.version, { enabled: confirming });
  const busy = save.isPending || discard.isPending;

  const submit = async () => {
    setError(null);
    try {
      const saved = await save.mutateAsync({
        billId: bill.id,
        visitId: bill.visit_id,
        version: bill.version,
        reason: reason.trim(),
      });
      setConfirming(false);
      setReason("");
      onBill(saved);
      onPrint({
        href: billPdfHref(saved.id),
        title: `Bill ${saved.bill_no}`,
        fileName: `Bill_${saved.bill_no}.pdf`,
      });
    } catch (e) {
      setError(errorOf(e, "The changes could not be saved"));
    }
  };

  const drop = async () => {
    setError(null);
    try {
      onBill(
        await discard.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          version: bill.version,
        }),
      );
      setDiscarding(false);
      setReason("");
    } catch (e) {
      setError(errorOf(e, "The edit could not be discarded"));
    }
  };

  return (
    <div className="bc-unfinal-banner" role="group" aria-label="Editing a final bill">
      <div className="bc-unfinal-banner__row">
        <p>
          <strong>Editing bill {bill.bill_no}</strong> — changes are not final until you save them.
          The bill number stays the same.
        </p>
      </div>
      <label className="bc-field">
        <span className="bc-field__lbl">
          Why is this bill being changed? <span aria-hidden="true">*</span>
        </span>
        <textarea
          className="bc-field__in"
          rows={2}
          required
          aria-required="true"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className="bc-head__row">
        <button
          type="button"
          className="st-btn st-btn-g"
          disabled={busy}
          onClick={() => {
            setError(null);
            setDiscarding(true);
          }}
        >
          Discard changes
        </button>
        <button
          type="button"
          className="st-btn st-btn-grn"
          disabled={busy || !reason.trim()}
          title={reason.trim() ? undefined : "Enter why the bill is being changed"}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Save changes…
        </button>
      </div>
      {error && !confirming && !discarding && <div className="bc-err">{error}</div>}

      <ConfirmModal
        open={confirming}
        title={`Save changes to bill ${bill.bill_no}?`}
        variant="primary"
        confirmLabel={save.isPending ? "Saving…" : "Save and print"}
        cancelLabel="Keep editing"
        busy={save.isPending}
        error={error}
        confirmDisabled={!preview.data}
        message={
          <div>
            <p>
              Patient: <strong>{patientName || "—"}</strong> · Bill {bill.bill_no}
            </p>
            {preview.isLoading && <p role="status">Checking the changes…</p>}
            {preview.isError && (
              <p className="bc-err">The changes could not be checked. Close and try again.</p>
            )}
            {preview.data && <ChangeSummary preview={preview.data} />}
            <p>
              The bill keeps number {bill.bill_no} and is marked as revision{" "}
              {(bill.revision_no ?? 0) + 1}. Every earlier print is replaced.
            </p>
          </div>
        }
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
      />

      <ConfirmModal
        open={discarding}
        title={`Discard the changes to bill ${bill.bill_no}?`}
        confirmLabel={discard.isPending ? "Discarding…" : "Discard changes"}
        cancelLabel="Keep editing"
        busy={discard.isPending}
        error={error}
        message="The bill goes back exactly as it was before Edit bill was chosen."
        onConfirm={drop}
        onCancel={() => setDiscarding(false)}
      />
    </div>
  );
}
