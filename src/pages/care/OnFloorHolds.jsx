import { useState } from "react";
import { Phone } from "lucide-react";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";
import useAuthStore from "../../stores/authStore";
import { toast } from "../../stores/uiStore";
import { useOnFloorHolds } from "../../queries/hooks/useCareFollowups";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import { HoldDoneDialog, HoldSkipDialog } from "./FollowupDialogs";

const callHref = (phone) => `tel:${String(phone).replace(/\D/g, "")}`;

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : "";

function Referrals({ row }) {
  if (!row.referrals.length) return <span className="muted">Referral</span>;
  return row.referrals.map((r, i) => (
    <div key={`${r.target}-${i}`} className="cfu-what">
      {r.target}
      {r.where ? <span className="muted"> · at {r.where}</span> : null}
    </div>
  ));
}

function PatientCell({ row }) {
  return (
    <div className="pcell">
      <span className="pcell__name">{row.name}</span>
      {row.phone ? (
        <a className="pcell__ph" href={callHref(row.phone)} title={`Call ${row.name}`}>
          <Phone size={12} aria-hidden="true" />
          {row.phone}
        </a>
      ) : null}
      <span className="pcell__file">
        {row.fileNo || "no file no"}
        {row.age ? ` · ${row.age}${(row.sex || "")[0] || ""}` : ""}
        {row.doctorName ? ` · ${row.doctorName}` : ""}
      </span>
    </div>
  );
}

export default function OnFloorHolds() {
  useGiniflowLive();
  const { data, isLoading, isError, refetch } = useOnFloorHolds();
  const canSkip = hasCapability(
    useAuthStore((st) => st.currentDoctor),
    CAPABILITIES.CARE_HOLD_SKIP,
  );
  const [dialog, setDialog] = useState(null);
  const waiting = data?.waiting || [];
  const done = data?.done || [];

  if (data && !data.ready) return null;

  const close = (message) => {
    setDialog(null);
    toast(message, "success");
  };

  return (
    <section className="flow-card bill-stack cfu-floor" aria-labelledby="cfu-floor-title">
      <div className="cfu-floor__head">
        <h2 id="cfu-floor-title" className="cfu-floor__title">
          On the floor now — waiting for you
          <span className="cfu-floor__count">{waiting.length}</span>
        </h2>
        <p className="cfu__sub">
          {data?.blocking
            ? "Referred today and still in the building. The Rx desk explains the prescription only after you press Done."
            : "Referred today and still in the building. Press Done once you have seen them."}
        </p>
      </div>

      {isLoading && <div className="cfu__skeleton" aria-busy="true" />}
      {isError && (
        <div className="cfu-floor__empty" role="alert">
          Could not load the patients waiting for you.{" "}
          <button type="button" className="flow-btn flow-btn-ghost" onClick={() => refetch()}>
            Try again
          </button>
        </div>
      )}
      {data && !waiting.length && (
        <div className="cfu-floor__empty">Nobody referred is waiting for you right now.</div>
      )}

      {waiting.length > 0 && (
        <div className="tbl-wrap cfu-sheet">
          <table className="tbl" aria-label="Referred patients waiting for the Care Coordinator">
            <thead>
              <tr>
                <th className="tl" style={{ minWidth: 220 }}>
                  Patient
                </th>
                <th className="tl" style={{ minWidth: 240 }}>
                  Referred to
                </th>
                <th className="tl" style={{ minWidth: 160 }}>
                  Where now
                </th>
                <th style={{ minWidth: 90 }}>Waiting</th>
                <th style={{ minWidth: 220 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((row) => (
                <tr key={row.visitId} className="tbl__row">
                  <td>
                    <PatientCell row={row} />
                  </td>
                  <td className="tl">
                    <Referrals row={row} />
                  </td>
                  <td className="tl">{row.statusLabel}</td>
                  <td className="tc">{row.minutes}m</td>
                  <td>
                    <div className="cfu-actions">
                      <button
                        type="button"
                        className="flow-btn flow-btn-primary flow-btn-mini"
                        aria-label={`Done with ${row.name} — send to the Rx desk`}
                        onClick={() => setDialog({ kind: "done", row })}
                      >
                        Done — send to Rx desk
                      </button>
                      {canSkip && (
                        <button
                          type="button"
                          className="flow-btn flow-btn-ghost flow-btn-mini"
                          aria-label={`Send ${row.name} on without the Care Coordinator`}
                          onClick={() => setDialog({ kind: "skip", row })}
                        >
                          Skip
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {done.length > 0 && (
        <details className="cfu-floor__done">
          <summary>Sent on today ({done.length})</summary>
          <ul>
            {done.map((row) => (
              <li key={row.visitId}>
                <strong>{row.name}</strong> · {row.fileNo || "no file no"} ·{" "}
                {row.holdStatus === "skipped" ? "Sent on without you" : row.decisionLabel}
                {row.note ? ` — ${row.note}` : ""}
                <span className="muted">
                  {" "}
                  · {row.doneBy || "System"} {clock(row.doneAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {dialog?.kind === "done" && (
        <HoldDoneDialog row={dialog.row} onClose={() => setDialog(null)} onDone={close} />
      )}
      {dialog?.kind === "skip" && (
        <HoldSkipDialog row={dialog.row} onClose={() => setDialog(null)} onDone={close} />
      )}
    </section>
  );
}
