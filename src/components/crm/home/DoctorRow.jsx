import { useNavigate } from "react-router-dom";
import { visitDueStateMeta, doctorPriorityMeta } from "../../../../shared/crmVocab.js";

export default function DoctorRow({ d, showDue }) {
  const navigate = useNavigate();
  const due = d.due_state ? visitDueStateMeta(d.due_state) : null;
  const pri = doctorPriorityMeta(d.priority);
  return (
    <li className="rep__row">
      <div className="rep__row-main">
        <strong>
          <button className="rep__name" onClick={() => navigate(`/crm/doctor/${d.doctor_id}`)}>
            {d.full_name}
          </button>
          {pri && d.priority !== "unclassified" && (
            <span className={`rep__pri rep__pri--${pri.tone}`}>{pri.short}</span>
          )}
        </strong>
        <span className="rep__row-sub">
          {[d.specialty, d.area, d.territory_name].filter(Boolean).join(" · ") || "No details yet"}
        </span>
        <span className="rep__row-flags">
          {showDue && due && <span className={`rep__due rep__due--${due.tone}`}>{due.label}</span>}
          {d.profile_complete === false && <span className="rep__flag">No mobile</span>}
          {d.needs_verification && <span className="rep__flag">Check details</span>}
        </span>
      </div>
      <div className="rep__row-actions">
        {d.mobile && (
          <a className="rep__call" href={`tel:${d.mobile}`} aria-label={`Call ${d.full_name}`}>
            Call
          </a>
        )}
        <button
          className="rep__btn rep__btn--sm"
          onClick={() =>
            navigate(`/crm/referral/${d.doctor_id}?name=${encodeURIComponent(d.full_name)}`)
          }
        >
          Referral
        </button>
        <button
          className="rep__btn rep__btn--primary rep__btn--sm"
          onClick={() =>
            navigate(`/crm/visit/${d.doctor_id}?name=${encodeURIComponent(d.full_name)}`)
          }
        >
          Log visit
        </button>
      </div>
    </li>
  );
}
