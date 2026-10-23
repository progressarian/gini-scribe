import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import api from "../../services/api";
import { qk } from "../../queries/keys";
import { PATIENT_TYPE_LABELS } from "../../../shared/slotCapacity";
import "./DecidedRequests.css";

const storageKey = (doctorId) => `ghm-dismissed-approvals:${doctorId}`;

const readDismissed = (doctorId) => {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey(doctorId)) || "[]"));
  } catch {
    return new Set();
  }
};

const saveDismissed = (doctorId, ids) => {
  try {
    localStorage.setItem(storageKey(doctorId), JSON.stringify([...ids].slice(-300)));
  } catch {
    return;
  }
};

const shortDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const stamp = (ts) =>
  new Date(ts).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

export default function DecidedRequests({ doctorId, onShow }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(doctorId));
  const mine = useQuery({
    queryKey: qk.bookingApprovals.mine,
    queryFn: async () => (await api.get("/api/booking-approvals/mine")).data,
    enabled: !!doctorId,
    refetchInterval: 60_000,
  });

  const open = (mine.data || []).filter((a) => !dismissed.has(a.id));
  if (!open.length) return null;

  const dismiss = (id) => {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    saveDismissed(doctorId, next);
  };

  return (
    <section className="decided" aria-labelledby="decided-title">
      <h2 id="decided-title" className="decided__title">
        Your booking requests: {open.length} decided
      </h2>
      <ul className="decided__list">
        {open.map((a) => {
          const approved = a.status === "approved";
          const type = (PATIENT_TYPE_LABELS[a.patient_type] || "").toLowerCase();
          return (
            <li key={a.id} className={`decided__item decided__item--${a.status}`}>
              <span className="decided__status">
                {approved ? (
                  <CheckCircle2 size={14} aria-hidden="true" />
                ) : (
                  <XCircle size={14} aria-hidden="true" />
                )}
                {approved ? "Approved" : "Rejected"}
              </span>
              <div className="decided__text">
                <strong>{a.patient_name || "—"}</strong>
                <small>
                  {" "}
                  · {a.file_no || "No file no"}
                  {a.phone ? ` · ${a.phone}` : ""}
                </small>
                <div>
                  {a.doctor_name} · {shortDate(a.appointment_date)} · {a.slot_label} · over the{" "}
                  {type} limit of {a.limit}
                </div>
                <div className="decided__next">
                  {approved
                    ? "Tell the patient their slot is confirmed."
                    : a.current_slot
                      ? `Already rebooked at ${a.current_slot}. Tell the patient the new time.`
                      : "Call the patient and book another slot."}
                </div>
                {!approved && a.reason && <div className="decided__reason">Reason: {a.reason}</div>}
                <small className="decided__who">
                  {approved ? "Approved" : "Rejected"} by {a.decided_by || "admin"} ·{" "}
                  {stamp(a.decided_at)}
                </small>
              </div>
              <div className="decided__actions">
                <button type="button" className="decided__show" onClick={() => onShow(a)}>
                  Show in sheet
                </button>
                <button
                  type="button"
                  className="decided__dismiss"
                  onClick={() => dismiss(a.id)}
                  aria-label={`Dismiss ${a.patient_name} ${approved ? "approval" : "rejection"}`}
                >
                  Dismiss
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
