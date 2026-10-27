import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../../../services/api.js";
import ConfirmModal from "../../ui/ConfirmModal.jsx";
import ListPager from "../ListPager.jsx";
import { errorText } from "../import/importText.js";

const FILTERS = [
  { key: "pending", label: "Waiting" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "removed", label: "Removed doctors" },
];

const dateText = (v) =>
  v
    ? new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function RemovalRequestsPanel({ onCountChange }) {
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [decide, setDecide] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => setPage(1), [status]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get("/api/crm/removal-requests", { params: { status, page } })
      .then(({ data: body }) => {
        if (cancelled) return;
        setData(body);
        onCountChange?.(body.counts.pending);
      })
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load removal requests.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [status, page, reload]);

  const run = async (url, body, done) => {
    setBusy(true);
    setActionErr(null);
    try {
      await api.post(url, body);
      setDecide(null);
      setNotice(done);
      setReload((n) => n + 1);
    } catch (e) {
      setActionErr(errorText(e, "That did not work. Please try again."));
      setReload((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const openDecide = (row, approve) => {
    setNote("");
    setActionErr(null);
    setDecide({ row, approve });
  };

  return (
    <section className="rmv" aria-label="Removal requests">
      <div className="rep__tabs" role="group" aria-label="Request status">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`rep__tab ${status === f.key ? "rep__tab--on" : ""}`}
            aria-pressed={status === f.key}
            onClick={() => setStatus(f.key)}
          >
            {f.label}
            {f.key === "pending" && data?.counts.pending > 0 && (
              <span className="rep__badge">{data.counts.pending}</span>
            )}
          </button>
        ))}
      </div>

      {notice && (
        <div className="rep__toast" role="status">
          {notice}
        </div>
      )}
      {err && (
        <div className="rep__err" role="alert">
          {err}{" "}
          <button type="button" className="asg__link" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {!err && (
        <ul className="rep__list home__list" aria-busy={loading}>
          {loading &&
            !data &&
            Array.from({ length: 3 }, (_, i) => <li key={i} className="rep__row asg__skeleton" />)}
          {data && data.rows.length === 0 && (
            <li className="rep__empty">
              {status === "pending"
                ? "No removal requests waiting. Requests from your team appear here."
                : status === "removed"
                  ? "No doctors have been removed."
                  : `No ${FILTERS.find((f) => f.key === status).label.toLowerCase()} requests.`}
            </li>
          )}
          {data?.rows.map((r) =>
            status === "removed" ? (
              <li key={r.doctor_id} className="rep__row rmv__row">
                <div className="rep__row-main">
                  <strong>{r.full_name}</strong>
                  <span className="rep__row-sub">
                    {[r.specialty, r.area, r.mobile].filter(Boolean).join(" · ")}
                  </span>
                  <span className="rep__row-sub">
                    Removed {dateText(r.deleted_at)}
                    {r.removed_by_name ? ` by ${r.removed_by_name}` : ""}
                    {r.removed_reason ? ` — ${r.reason_label}` : ""}
                    {r.removed_note ? `: ${r.removed_note}` : ""}
                  </span>
                </div>
                <div className="rep__row-actions">
                  <Link to={`/crm/doctor/${r.doctor_id}`} className="rep__btn rep__btn--sm">
                    Open
                  </Link>
                  <button
                    type="button"
                    className="rep__btn rep__btn--sm"
                    disabled={busy}
                    onClick={() =>
                      run(`/api/crm/doctors/${r.doctor_id}/restore`, {}, `${r.full_name} restored.`)
                    }
                  >
                    Restore
                  </button>
                </div>
              </li>
            ) : (
              <li key={r.id} className="rep__row rmv__row">
                <div className="rep__row-main">
                  <strong>
                    {r.deleted_at ? (
                      r.full_name
                    ) : (
                      <Link to={`/crm/doctor/${r.doctor_id}`} className="rep__name">
                        {r.full_name}
                      </Link>
                    )}
                  </strong>
                  <span className="rep__row-sub">
                    {[r.specialty, r.area, r.mobile, r.owner_name && `Owner ${r.owner_name}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className="rep__row-sub">
                    <span className="rmv__reason">{r.reason_label}</span>
                    {r.note ? `: ${r.note}` : ""} · asked by {r.requested_by_name} on{" "}
                    {dateText(r.created_at)}
                  </span>
                  <span className="rep__row-flags">
                    <span className="rep__flag">{plural(r.visits, "visit")} on record</span>
                    {r.visits_since > 0 && (
                      <span className="rep__flag">
                        {plural(r.visits_since, "visit")} since the request
                      </span>
                    )}
                    {r.open_referrals > 0 && (
                      <span className="rep__flag">{plural(r.open_referrals, "open referral")}</span>
                    )}
                    {r.open_tasks > 0 && (
                      <span className="rep__flag">{plural(r.open_tasks, "open task")}</span>
                    )}
                  </span>
                  {status !== "pending" && (
                    <span className="rep__row-sub">
                      {status === "approved" ? "Approved" : "Rejected"}
                      {r.decided_by_name ? ` by ${r.decided_by_name}` : ""} on{" "}
                      {dateText(r.decided_at)}
                      {r.decision_note ? `: ${r.decision_note}` : ""}
                    </span>
                  )}
                </div>
                {status === "pending" && (
                  <div className="rep__row-actions">
                    <button
                      type="button"
                      className="rep__btn rep__btn--sm"
                      onClick={() => openDecide(r, false)}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="rep__btn rep__btn--sm rmv__approve"
                      onClick={() => openDecide(r, true)}
                    >
                      Approve
                    </button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      <ListPager page={data?.page} pages={data?.pages} loading={loading} onPage={setPage} />

      <ConfirmModal
        open={Boolean(decide)}
        variant={decide?.approve ? "danger" : "primary"}
        title={
          decide?.approve
            ? `Remove ${decide.row.full_name}?`
            : `Reject the request for ${decide?.row.full_name}?`
        }
        cancelLabel="Go back"
        confirmLabel={busy ? "Saving…" : decide?.approve ? "Approve and remove" : "Reject request"}
        onCancel={() => setDecide(null)}
        onConfirm={() =>
          run(
            `/api/crm/removal-requests/${decide.row.id}/${decide.approve ? "approve" : "reject"}`,
            { note },
            decide.approve
              ? `${decide.row.full_name} removed.`
              : `Request for ${decide.row.full_name} rejected.`,
          )
        }
        confirmDisabled={!decide?.approve && !note.trim()}
        busy={busy}
        error={actionErr}
        message={
          decide && (
            <div className="dfm__dialog">
              <p className="dfm__ident">
                <strong>{decide.row.full_name}</strong>
                {` · ${[decide.row.area, decide.row.mobile].filter(Boolean).join(" · ")}`}
              </p>
              {decide.approve ? (
                <p>
                  The doctor leaves {decide.row.owner_name ? `${decide.row.owner_name}'s` : "every"}{" "}
                  list, sheets and coverage now. {plural(decide.row.visits, "past visit")} stay in
                  reports.
                  {decide.row.open_referrals > 0 &&
                    ` ${plural(decide.row.open_referrals, "open referral")} stay linked.`}
                  {decide.row.open_tasks > 0 &&
                    ` ${plural(decide.row.open_tasks, "open task")} will be cancelled.`}{" "}
                  You can restore the doctor later from Removed doctors.
                </p>
              ) : (
                <p>{decide.row.requested_by_name} will see your note on the doctor's page.</p>
              )}
              <label className="dfm__field">
                <span className="dfm__label">
                  Note{decide.approve ? " (optional)" : " for the team member"}
                </span>
                <textarea
                  className="rep__notes"
                  rows={2}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            </div>
          )
        }
      />
    </section>
  );
}
