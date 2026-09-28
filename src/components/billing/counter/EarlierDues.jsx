import { usePatientDues } from "../../../queries/hooks/useBilling";
import { fromPaise } from "../format";

const agoText = (days) => (days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`);

export default function EarlierDues({ patientId, visitId, billId, onTakePayment }) {
  const { data } = usePatientDues(patientId);
  const earlier = (data || []).filter(
    (due) => due.bill_id !== billId && (!visitId || due.visit_id !== visitId),
  );
  if (!earlier.length) return null;
  return (
    <section className="bc-earlier" aria-label="Earlier dues">
      <ul className="bc-earlier__list">
        {earlier.map((due) => (
          <li key={due.bill_id} className="bc-earlier__row">
            <span>
              Earlier dues: <strong>{fromPaise(due.outstanding)}</strong> on bill {due.bill_no} (
              {agoText(due.days)})
            </span>
            <button
              type="button"
              className="st-btn st-btn-grn"
              aria-label={`Take payment on earlier bill ${due.bill_no}`}
              onClick={() => onTakePayment(due)}
            >
              Take payment
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
