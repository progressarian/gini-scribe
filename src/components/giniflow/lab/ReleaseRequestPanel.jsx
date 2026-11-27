import { useState } from "react";
import { useRaiseReleaseRequest } from "../../../queries/hooks/useReportReleases";
import ReleaseNoteDialog from "../ReleaseNoteDialog";
import useAuthStore from "../../../stores/authStore";
import { CAPABILITIES as CAP, hasCapability } from "../../../../shared/permissions";
import { RELEASE_STATUS, RELEASE_STATUS_LABEL } from "../../../../shared/reportRelease.js";

const clock = (value) =>
  value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "";

const TONE = {
  [RELEASE_STATUS.APPROVED]: "rel-panel--ok",
  [RELEASE_STATUS.PENDING]: "rel-panel--wait",
};

function message(request) {
  if (request?.status === RELEASE_STATUS.APPROVED) {
    return "An admin approved releasing this visit's reports before payment. You can upload now; reception still collects the bill.";
  }
  if (request?.status === RELEASE_STATUS.PENDING) {
    return "Waiting for an admin to approve releasing the report. This updates on its own when they answer.";
  }
  if (request?.status === RELEASE_STATUS.REJECTED) {
    return "The release was rejected. The report stays held until reception records the payment.";
  }
  return "This home-collection bill is on credit. The report can't be uploaded until it is paid, unless an admin approves releasing it.";
}

export default function ReleaseRequestPanel({ visitId, patient, request, onToast }) {
  const doctor = useAuthStore((s) => s.currentDoctor);
  const canAsk = hasCapability(doctor, CAP.LAB_REPORT_RELEASE_REQUEST);
  const raise = useRaiseReleaseRequest();
  const [asking, setAsking] = useState(false);
  const status = request?.status ?? null;
  const askable = canAsk && visitId && (!status || status === RELEASE_STATUS.REJECTED);

  return (
    <section
      className={`dp-sec rel-panel ${TONE[status] ?? "rel-panel--held"}`}
      aria-labelledby={`rel-${visitId}`}
    >
      <h3 id={`rel-${visitId}`} className="dp-sec-title">
        💰 Payment pending{status ? ` · ${RELEASE_STATUS_LABEL[status]}` : ""}
      </h3>
      <p className="rel-panel__text">{message(request)}</p>
      {request?.decidedAt ? (
        <p className="rel-panel__meta">
          Answered {clock(request.decidedAt)}
          {request.note ? ` — “${request.note}”` : ""}
        </p>
      ) : null}
      {askable ? (
        <button
          type="button"
          className="st-btn st-btn-g"
          disabled={raise.isPending}
          onClick={() => setAsking(true)}
        >
          {status === RELEASE_STATUS.REJECTED ? "Ask again for release" : "Ask admin to release"}
        </button>
      ) : null}
      {asking ? (
        <ReleaseNoteDialog
          title="Ask to release the report before payment"
          intro="An admin or the lab head decides. If approved, every report for this visit can be uploaded while the bill stays on credit."
          patient={patient}
          label="Why the report is needed before payment"
          required
          submitLabel="Send request"
          pendingLabel="Sending…"
          failText="Could not send the request"
          onSubmit={async (reason) => {
            await raise.mutateAsync({ visit_id: visitId, reason });
            setAsking(false);
            onToast?.(`Release request sent for ${patient.name} — waiting for admin`);
          }}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </section>
  );
}
