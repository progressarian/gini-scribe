import { useCallback, useId, useRef, useState } from "react";
import ConfirmModal from "../ui/ConfirmModal";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import { PATIENT_TYPE_LABELS } from "../../../shared/slotCapacity";
import "./booking.css";

const typeText = (t) => (PATIENT_TYPE_LABELS[t] || t).toLowerCase();

export const REASON_MAX = 300;

export function useCanApproveBookings() {
  const doctor = useAuthStore((s) => s.currentDoctor);
  return hasCapability(doctor, CAPABILITIES.BOOKING_APPROVE);
}

export function useOverLimitConfirm() {
  const canApprove = useCanApproveBookings();
  const [ask, setAsk] = useState(null);
  const [reason, setReason] = useState("");
  const resolver = useRef(null);
  const reasonId = useId();

  const confirm = useCallback((slot, { doctorName, patientName } = {}) => {
    if (!slot?.over_limit) return Promise.resolve({ reason: "" });
    return new Promise((resolve) => {
      resolver.current = resolve;
      setReason("");
      setAsk({ slot, doctorName, patientName });
    });
  }, []);

  const finish = (answer) => {
    resolver.current?.(answer);
    resolver.current = null;
    setAsk(null);
  };

  const over = ask?.slot.over_limit;
  const trimmed = reason.trim();
  const dialog = (
    <ConfirmModal
      open={!!ask}
      variant="primary"
      title={
        ask ? `${ask.slot.slot_label} is full for ${typeText(over.patient_type)} patients` : ""
      }
      message={
        ask && (
          <div className="overlimit-body">
            <p>
              {ask.doctorName ? `${ask.doctorName} · ` : ""}
              The limit is {over.limit} {typeText(over.patient_type)} patient
              {over.limit === 1 ? "" : "s"} per slot, and {over.count}{" "}
              {over.count === 1 ? "is" : "are"} already booked.
              {ask.patientName ? ` ${ask.patientName} would be one more.` : ""}
            </p>
            <p>
              {canApprove
                ? "Book it over the limit? It is approved straight away under your name."
                : "If you book it, the booking is saved in this slot and sent to an admin for approval. It shows Pending approval until they decide; if they reject it, you will need to choose another slot."}
            </p>
            <label className="overlimit-reason" htmlFor={reasonId}>
              Why does the patient need this slot?
              {canApprove ? " (optional)" : " (required)"}
            </label>
            <textarea
              id={reasonId}
              className="overlimit-reason__input"
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Patient can only come at this time because of work; travelling from Shimla"
              aria-required={!canApprove}
              autoFocus
            />
            <small className="overlimit-reason__count">
              {reason.length}/{REASON_MAX}
            </small>
          </div>
        )
      }
      confirmLabel={canApprove ? "Book over the limit" : "Book and send for approval"}
      cancelLabel="Choose another slot"
      confirmDisabled={!canApprove && !trimmed}
      onConfirm={() => finish({ reason: trimmed })}
      onCancel={() => finish(false)}
    />
  );

  return { confirm, dialog, canApprove, open: !!ask };
}
