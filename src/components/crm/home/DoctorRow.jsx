import { useNavigate } from "react-router-dom";
import {
  visitDueStateMeta,
  doctorPriorityMeta,
  visitSlotMeta,
} from "../../../../shared/crmVocab.js";

export default function DoctorRow({ d, showDue, showOwner }) {
  const navigate = useNavigate();
  const due = d.due_state ? visitDueStateMeta(d.due_state) : null;
  const pri = doctorPriorityMeta(d.priority);
  const slot = visitSlotMeta(d.last_visit_slot);
  const monthVisits = d.visits_this_month ?? 0;
  const details = [d.specialty, d.area, d.territory_name].filter(Boolean).join(" · ");
  const nameParam = encodeURIComponent(d.full_name);
  return (
    <li className="rep__row rep__doc">
      <div className="rep__doc-main">
        <div className="rep__doc-head">
          <button
            type="button"
            className="rep__doc-name"
            onClick={() => navigate(`/crm/doctor/${d.doctor_id}`)}
          >
            {d.full_name}
          </button>
          {pri && d.priority !== "unclassified" && (
            <span
              className={`rep__pri rep__pri--${pri.tone} rep__doc-pri`}
              title={`Priority ${pri.label}`}
              aria-label={`Priority ${pri.label}`}
            >
              {pri.short}
            </span>
          )}
        </div>
        <p className="rep__doc-sub">{details || "No details yet"}</p>
        <div className="rep__doc-flags">
          {showDue && due && (
            <span className={`rep__doc-tag rep__due--${due.tone}`}>{due.label}</span>
          )}
          <span
            className={`rep__doc-tag rep__doc-tag--muted rep__visits ${monthVisits ? "rep__visits--some" : ""}`}
            title="Visits logged this month"
          >
            <b>{monthVisits}</b> {monthVisits === 1 ? "visit" : "visits"} this month
          </span>
          {slot && (
            <span
              className="rep__flag rep__doc-tag rep__doc-tag--muted"
              title="Time of the last visit"
            >
              {slot.label}
            </span>
          )}
          {d.profile_complete === false && (
            <span className="rep__doc-tag rep__due--amb">No mobile</span>
          )}
          {d.needs_verification && (
            <span className="rep__doc-tag rep__due--amb">Check details</span>
          )}
          {showOwner && (
            <span className="rep__doc-owner">
              {d.owner_name ? (
                <>
                  Owner <b>{d.owner_name}</b>
                </>
              ) : (
                "Unassigned"
              )}
            </span>
          )}
        </div>
      </div>
      <div className="rep__doc-actions">
        {d.mobile && (
          <a
            className="rep__btn rep__btn--sm rep__doc-btn"
            href={`tel:${d.mobile}`}
            aria-label={`Call ${d.full_name}`}
          >
            Call
          </a>
        )}
        <button
          type="button"
          className="rep__btn rep__btn--sm rep__doc-btn"
          onClick={() => navigate(`/crm/referral/${d.doctor_id}?name=${nameParam}`)}
        >
          Referral
        </button>
        <button
          type="button"
          className="rep__btn rep__btn--primary rep__btn--sm rep__doc-btn"
          onClick={() => navigate(`/crm/visit/${d.doctor_id}?name=${nameParam}`)}
        >
          Log visit
        </button>
      </div>
    </li>
  );
}
