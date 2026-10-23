import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import api from "../services/api";
import queryClient from "../queries/client";
import { qk } from "../queries/keys";
import { APPROVALS_WAITING_KEY } from "../queries/hooks/useApprovals";
import { toast } from "../stores/uiStore";
import ConfirmModal from "../components/ui/ConfirmModal";
import { PATIENT_TYPE_LABELS } from "../../shared/slotCapacity";
import "./DoctorManagementPage.css";

const ordinal = (n) => {
  const tail = n % 100;
  if (tail >= 11 && tail <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
};

const longDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const stamp = (ts) =>
  ts
    ? new Date(ts).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : "";

const typeText = (t) => (PATIENT_TYPE_LABELS[t] || t).toLowerCase();

const overText = (a) =>
  `${ordinal(a.count + 1)} ${typeText(a.patient_type)} patient · limit ${a.limit}`;

const STATUS = {
  approved: { label: "Approved", tone: "on" },
  rejected: { label: "Rejected", tone: "reject" },
  withdrawn: { label: "Withdrawn", tone: "muted" },
};

function Patient({ a }) {
  return (
    <>
      <strong>{a.patient_name || "—"}</strong>
      <small>
        {" "}
        · {a.file_no || "No file no"}
        {a.health_id ? ` · Health ID ${a.health_id}` : ""}
      </small>
    </>
  );
}

export default function BookingApprovalsPage() {
  const [view, setView] = useState("pending");
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState("");

  const counts = useQuery({
    queryKey: qk.bookingApprovals.count,
    queryFn: async () => (await api.get("/api/booking-approvals/count")).data,
    refetchInterval: 60_000,
  });
  const list = useQuery({
    queryKey: qk.bookingApprovals.list(view),
    queryFn: async () => (await api.get(`/api/booking-approvals?status=${view}`)).data,
    refetchInterval: view === "pending" ? 60_000 : false,
  });

  const done = (message) => {
    toast(message, "success");
    queryClient.invalidateQueries({ queryKey: qk.bookingApprovals.all });
    queryClient.invalidateQueries({ queryKey: APPROVALS_WAITING_KEY });
  };
  const failed = (e) => {
    toast(e.response?.data?.error || "Could not save the decision. Try again.", "error");
    queryClient.invalidateQueries({ queryKey: qk.bookingApprovals.all });
  };

  const approve = useMutation({
    mutationFn: (a) => api.post(`/api/booking-approvals/${a.id}/approve`),
    onSuccess: (_r, a) => done(`${a.patient_name} approved for ${a.slot_label}`),
    onError: failed,
  });
  const reject = useMutation({
    mutationFn: ({ a, why }) => api.post(`/api/booking-approvals/${a.id}/reject`, { reason: why }),
    onSuccess: (_r, { a }) => {
      setRejecting(null);
      setReason("");
      done(`${a.patient_name} rejected — the desk will choose another slot`);
    },
    onError: failed,
  });

  const rows = list.data || [];
  const pendingCount = counts.data?.pending ?? null;

  return (
    <div className="docmgmt docmgmt-embedded">
      <p className="docmgmt-hint">
        Bookings over a slot's patient limit. Approve keeps the booking in its slot; Reject clears
        the slot so the desk picks another.
      </p>

      <div className="docmgmt-filter docmgmt-viewfilter" role="group" aria-label="Show">
        {[
          ["pending", "Pending"],
          ["decided", "Decided (last 30 days)"],
        ].map(([id, label]) => (
          <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>
            {label}
            {id === "pending" && pendingCount != null && (
              <span className="docmgmt-count">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>
      {view === "pending" && counts.data?.overdue > 0 && (
        <p className="docmgmt-note warn" role="status">
          <strong>{counts.data.overdue}</strong> request
          {counts.data.overdue === 1 ? " is" : "s are"} for today or earlier and still undecided —
          they are listed first.
        </p>
      )}

      <div className="docmgmt-panel docmgmt-approvals">
        <table
          className="docmgmt-list"
          aria-label={view === "pending" ? "Pending approvals" : "Decided approvals"}
        >
          <thead>
            <tr>
              <th scope="col">Patient</th>
              <th scope="col">Doctor</th>
              <th scope="col">Date and slot</th>
              <th scope="col">Over the limit</th>
              <th scope="col">Requested</th>
              <th scope="col">
                {view === "pending" ? (
                  <span className="docmgmt-visually-hidden">Actions</span>
                ) : (
                  "Decision"
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan="6" className="docmgmt-empty">
                  Loading…
                </td>
              </tr>
            )}
            {list.isError && (
              <tr>
                <td colSpan="6" className="docmgmt-empty" role="alert">
                  Could not load the approvals. Try again; if it keeps failing, contact an
                  administrator.{" "}
                  <button
                    type="button"
                    className="docmgmt-secondary docmgmt-small"
                    onClick={() => list.refetch()}
                  >
                    Try again
                  </button>
                </td>
              </tr>
            )}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan="6" className="docmgmt-empty">
                  {view === "pending"
                    ? "Nothing waiting. Bookings over a slot's limit appear here."
                    : "No decisions in the last 30 days."}
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <tr key={a.id} className={a.overdue && view === "pending" ? "docmgmt-overdue" : ""}>
                <td>
                  <Patient a={a} />
                </td>
                <td>{a.doctor_name || "—"}</td>
                <td>
                  {longDate(a.appointment_date)}
                  <small> · {a.slot_label}</small>
                  {a.overdue && view === "pending" && (
                    <span className="docmgmt-vstatus docmgmt-vstatus--reject">Overdue</span>
                  )}
                </td>
                <td>
                  {overText(a)}
                  <small className="docmgmt-reasonline">
                    {a.request_reason ? `Reason: ${a.request_reason}` : "No reason given"}
                  </small>
                </td>
                <td>
                  {a.requested_by || "—"}
                  <small> · {stamp(a.requested_at)}</small>
                </td>
                <td className="docmgmt-cell-action">
                  {view === "pending" ? (
                    <div className="docmgmt-rowactions">
                      <button
                        type="button"
                        className="docmgmt-primary docmgmt-small"
                        disabled={approve.isPending || reject.isPending}
                        aria-label={`Approve ${a.patient_name} in ${a.slot_label}`}
                        onClick={() => approve.mutate(a)}
                      >
                        {approve.isPending && approve.variables?.id === a.id
                          ? "Approving…"
                          : "Approve"}
                      </button>
                      <button
                        type="button"
                        className="docmgmt-del"
                        disabled={approve.isPending || reject.isPending}
                        aria-label={`Reject ${a.patient_name} in ${a.slot_label}`}
                        onClick={() => {
                          setReason("");
                          setRejecting(a);
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  ) : (
                    <>
                      <span
                        className={`docmgmt-vstatus docmgmt-vstatus--${STATUS[a.status]?.tone}`}
                      >
                        {STATUS[a.status]?.label || a.status}
                      </span>
                      <small>
                        {" "}
                        {a.decided_by ? `by ${a.decided_by} ` : ""}
                        {stamp(a.decided_at)}
                      </small>
                      {a.reason && <small className="docmgmt-reasonline">{a.reason}</small>}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        open={!!rejecting}
        title={rejecting ? `Reject ${rejecting.patient_name}'s booking?` : ""}
        message={
          rejecting && (
            <div className="docmgmt-confirmbody">
              <p>
                {rejecting.doctor_name} · {longDate(rejecting.appointment_date)} ·{" "}
                {rejecting.slot_label}
                <br />
                {rejecting.file_no || ""}
                {rejecting.health_id ? ` · Health ID ${rejecting.health_id}` : ""} ·{" "}
                {overText(rejecting)}
                {rejecting.request_reason && (
                  <>
                    <br />
                    Desk's reason: {rejecting.request_reason}
                  </>
                )}
              </p>
              <p>
                The booking keeps its date and doctor, but its slot is cleared. It shows "Rejected —
                choose another slot" with your reason until the desk picks a new one.
              </p>
              <label className="docmgmt-reason">
                Reason (required)
                <textarea
                  rows={3}
                  maxLength={300}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Doctor is full; offer 11:30 or tomorrow"
                />
              </label>
            </div>
          )
        }
        confirmLabel="Reject booking"
        cancelLabel="Keep pending"
        confirmDisabled={!reason.trim()}
        busy={reject.isPending}
        onConfirm={() => reject.mutate({ a: rejecting, why: reason.trim() })}
        onCancel={() => !reject.isPending && setRejecting(null)}
      />
    </div>
  );
}
